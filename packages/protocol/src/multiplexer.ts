import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { parseControl } from './auth.js';
import { MAX_BUFFERED, MAX_FRAME, MAX_STREAMS, WINDOW } from './types.js';

const DATA = 1, CREDIT = 2, FIN = 3, RESET = 4;
interface Stream {
  socket: Socket;
  credit: number;
  receiveCredit: number;
  active: boolean;
  sentFin: boolean;
  receivedFin: boolean;
  pumping: boolean;
}

/** One bounded flow-control window per TCP stream; no business data crosses commands RPC. */
export class Multiplexer extends EventEmitter {
  readonly streams = new Map<number, Stream>();
  closed = false;
  private lastPong = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private scheduled = false;

  constructor(readonly ws: WebSocket, onControl: (message: Record<string, unknown>) => void | Promise<void>) {
    super();
    ws.on('message', (data, binary) => {
      try {
        if (binary) this.receive(data);
        else Promise.resolve(onControl(parseControl(data, false))).catch(error => this.fail(error));
      } catch (error) { this.fail(error); }
    });
    ws.on('error', error => this.fail(error));
    ws.once('close', (code, reason) => {
      if (!this.closed) this.emit('fault', new Error(`Transport closed (${code}) ${reason.toString().slice(0, 80)}`));
      this.shutdown();
    });
    ws.on('pong', () => { this.lastPong = Date.now(); });
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 30_000) this.fail(new Error('Relay heartbeat timed out'));
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 10_000);
    this.heartbeat.unref();
  }

  control(value: object): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error('Relay is disconnected');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 16 * 1024) throw new Error('Control message is too large');
    if (this.ws.bufferedAmount > MAX_BUFFERED) throw new Error('Transport queue limit exceeded');
    this.ws.send(text, error => { if (error) this.fail(error); });
  }

  attach(id: number, socket: Socket, active = true): void {
    if (this.closed || this.streams.has(id) || this.streams.size >= MAX_STREAMS) throw new Error('Connection limit reached');
    socket.setNoDelay(true);
    socket.pause();
    const state: Stream = { socket, credit: active ? WINDOW : 0, receiveCredit: WINDOW, active, sentFin: false, receivedFin: false, pumping: false };
    this.streams.set(id, state);
    socket.on('readable', () => this.pump(id, state));
    socket.once('end', () => {
      state.sentFin = true;
      this.frame(FIN, id);
    });
    socket.on('error', () => this.reset(id));
    socket.once('close', () => {
      if (this.streams.get(id) !== state) return;
      this.streams.delete(id);
      if (!state.sentFin || !state.receivedFin) this.frame(RESET, id);
      this.emit('streamClosed', id);
    });
    this.pump(id, state);
  }

  start(id: number): void {
    const state = this.streams.get(id);
    if (!state || state.active) return;
    state.active = true; state.credit = WINDOW;
    this.pump(id, state);
  }

  reset(id: number, notify = true): void {
    const state = this.streams.get(id);
    if (!state) return;
    this.streams.delete(id);
    if (notify) this.frame(RESET, id);
    state.socket.destroy();
    this.emit('streamClosed', id);
  }

  dispose(): void { this.shutdown(); this.ws.terminate(); }

  private frame(type: number, id: number, payload?: Buffer): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.allocUnsafe(5 + (payload?.length ?? 0));
    frame[0] = type; frame.writeUInt32BE(id, 1);
    payload?.copy(frame, 5);
    this.ws.send(frame, { binary: true, compress: false }, error => {
      if (error) this.fail(error);
      else this.schedulePumps();
    });
  }

  private pump(id: number, state: Stream): void {
    if (state.pumping || !state.active || this.closed || state.socket.destroyed) return;
    state.pumping = true;
    // One frame per turn preserves fairness between simultaneous small and large flows.
    const size = Math.min(state.socket.readableLength, MAX_FRAME, state.credit);
    if (size > 0 && this.ws.bufferedAmount < MAX_BUFFERED / 2) {
      const chunk = state.socket.read(size) as Buffer | null;
      if (chunk) {
        state.credit -= chunk.length;
        this.frame(DATA, id, chunk);
        this.schedulePumps();
      }
    } else if (state.socket.readableLength === 0) {
      state.socket.read(0);
    }
    state.pumping = false;
  }

  private schedulePumps(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      for (const [id, stream] of this.streams) this.pump(id, stream);
    });
  }

  private receive(raw: RawData): void {
    const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (data.length < 5 || data.length > MAX_FRAME + 5) throw new Error('Invalid data frame');
    const type = data[0], id = data.readUInt32BE(1);
    if (!id || ![DATA, CREDIT, FIN, RESET].includes(type!)) throw new Error('Invalid frame type');
    if (type === RESET) {
      if (data.length !== 5) throw new Error('Invalid reset');
      this.emit('peerReset', id);
      this.reset(id, false);
      return;
    }
    const state = this.streams.get(id);
    if (!state) return; // Frames already in flight after a reset are harmless.
    if (type === DATA) {
      const payload = data.subarray(5);
      if (state.receivedFin || payload.length === 0 || payload.length > state.receiveCredit) throw new Error('Receive window exceeded');
      state.receiveCredit -= payload.length;
      state.socket.write(payload, () => {
        if (this.closed || this.streams.get(id) !== state) return;
        state.receiveCredit += payload.length;
        const credit = Buffer.allocUnsafe(4); credit.writeUInt32BE(payload.length);
        this.frame(CREDIT, id, credit);
      });
    } else if (type === CREDIT) {
      if (data.length !== 9) throw new Error('Invalid credit');
      const credit = data.readUInt32BE(5);
      if (!credit || state.credit + credit > WINDOW) throw new Error('Send window exceeded');
      state.credit += credit;
      this.pump(id, state);
    } else if (type === FIN) {
      if (data.length !== 5 || state.receivedFin) throw new Error('Invalid EOF');
      state.receivedFin = true;
      state.socket.end();
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.emit('fault', error);
    this.dispose();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const id of [...this.streams.keys()]) this.reset(id, false);
    this.emit('closed');
  }
}
