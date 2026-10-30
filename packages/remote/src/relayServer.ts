import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import { WebSocketServer } from 'ws';
import { authenticateServer } from '../../protocol/src/auth.js';
import { Multiplexer } from '../../protocol/src/multiplexer.js';
import { identifier, MAX_FRAME, MAX_STREAMS, messageOf, port, streamId, TIMEOUT_MS, VERSION, type Endpoint, type SessionCredentials } from '../../protocol/src/types.js';

interface Listener { server: net.Server; port: number; streams: Set<number> }

export class RelayServer extends EventEmitter {
  readonly agentId = randomUUID();
  readonly ports = new Map<string, Listener>();
  private readonly server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME + 5, perMessageDeflate: false });
  private readonly pending = new Map<number, NodeJS.Timeout>();
  private readonly httpSockets = new Set<net.Socket>();
  private mux?: Multiplexer;
  private nextId = 1;
  private disposed = false;
  private claimed = false;
  private operations: Promise<void> = Promise.resolve();
  private queuedRequests = 0;
  private disposePromise?: Promise<void>;
  private readonly lease: NodeJS.Timeout;

  constructor(readonly auth: SessionCredentials) {
    super();
    this.lease = setTimeout(() => { void this.dispose(); }, 60_000);
    this.lease.unref();
    this.server.on('connection', socket => {
      if (this.httpSockets.size >= 8) { socket.destroy(); return; }
      this.httpSockets.add(socket);
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
      socket.once('close', () => this.httpSockets.delete(socket));
    });
    this.server.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {});
      if (this.disposed || this.claimed || this.wss.clients.size >= 4 || request.headers.origin) { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, ws => {
        ws.on('error', () => {});
        void authenticateServer(ws, auth, this.agentId).then(() => {
          if (this.disposed || this.claimed) { ws.terminate(); return; }
          this.claimed = true;
          clearTimeout(this.lease);
          (socket as net.Socket).setTimeout(0);
          this.mux = new Multiplexer(ws, message => this.receiveControl(message));
          this.mux.on('streamClosed', (id: number) => {
            clearTimeout(this.pending.get(id)); this.pending.delete(id);
            for (const listener of this.ports.values()) listener.streams.delete(id);
          });
          this.mux.on('fault', error => this.emit('diagnostic', messageOf(error)));
          this.mux.once('closed', () => { void this.dispose(); });
        }).catch(() => ws.terminate());
      });
    });
    this.server.on('error', error => this.emit('diagnostic', messageOf(error)));
  }

  async listen(): Promise<Endpoint> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address() as net.AddressInfo;
    return { url: `http://127.0.0.1:${address.port}/`, agentId: this.agentId, version: VERSION };
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposePromise ?? Promise.resolve();
    this.disposed = true;
    clearTimeout(this.lease);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.mux?.dispose();
    for (const ws of this.wss.clients) ws.terminate();
    for (const socket of this.httpSockets) socket.destroy();
    this.disposePromise = (async () => {
      // An in-flight listen must finish before final cleanup, or it could leave an orphan listener.
      await this.operations.catch(() => {});
      await Promise.all([...this.ports.keys()].map(id => this.remove(id)));
      await new Promise<void>(resolve => this.server.close(() => resolve()));
      this.wss.close();
      this.emit('disposed');
    })();
    return this.disposePromise;
  }

  private receiveControl(msg: Record<string, unknown>): void {
    if (msg.type === 'open-ok' && streamId(msg.streamId)) {
      clearTimeout(this.pending.get(msg.streamId)); this.pending.delete(msg.streamId);
      this.mux?.start(msg.streamId);
    } else if (msg.type === 'open-error' && streamId(msg.streamId)) {
      this.mux?.reset(msg.streamId);
    } else if (msg.type === 'request' && identifier(msg.requestId)) {
      if (++this.queuedRequests > MAX_STREAMS) throw new Error('Too many pending operations');
      const requestId = msg.requestId;
      this.operations = this.operations.then(async () => {
        if (this.disposed) return;
        try {
          if (!identifier(msg.ruleId)) throw new Error('Invalid rule ID');
          if (msg.action === 'add' && port(msg.remotePort)) await this.add(msg.ruleId, msg.remotePort);
          else if (msg.action === 'remove') await this.remove(msg.ruleId);
          else throw new Error('Invalid rule request');
          if (!this.disposed) this.mux?.control({ type: 'response', requestId, ok: true });
        } catch (error) {
          if (!this.disposed) this.mux?.control({ type: 'response', requestId, ok: false, error: messageOf(error) });
        }
      }).finally(() => { this.queuedRequests--; });
    } else throw new Error('Unexpected relay control message');
  }

  private async add(id: string, remotePort: number): Promise<void> {
    const existing = this.ports.get(id);
    if (existing) {
      if (existing.port !== remotePort) throw new Error('Stop this rule before changing its port');
      return;
    }
    if (this.ports.size >= MAX_STREAMS) throw new Error('Rule limit reached');
    const listener: Listener = { port: remotePort, streams: new Set(), server: net.createServer({ allowHalfOpen: true }) };
    listener.server.on('connection', socket => {
      socket.on('error', () => {});
      const mux = this.mux;
      if (this.disposed || !mux || mux.closed || mux.streams.size >= MAX_STREAMS || this.nextId > 0xffffffff) { socket.destroy(); return; }
      const connectionId = this.nextId++;
      listener.streams.add(connectionId);
      mux.attach(connectionId, socket, false);
      const timer = setTimeout(() => mux.reset(connectionId), TIMEOUT_MS);
      timer.unref(); this.pending.set(connectionId, timer);
      mux.control({ type: 'open', streamId: connectionId, ruleId: id });
    });
    await new Promise<void>((resolve, reject) => {
      listener.server.once('error', reject);
      listener.server.listen(remotePort, '127.0.0.1', () => { listener.server.off('error', reject); resolve(); });
    });
    listener.server.on('error', error => this.emit('diagnostic', messageOf(error)));
    this.ports.set(id, listener);
  }

  private async remove(id: string): Promise<void> {
    const listener = this.ports.get(id);
    if (!listener) return;
    this.ports.delete(id);
    const closed = new Promise<void>(resolve => listener.server.close(() => resolve()));
    for (const stream of listener.streams) this.mux?.reset(stream);
    await closed;
  }
}
