import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import type WebSocket from 'ws';
import { connectAuthenticated } from '../../protocol/src/auth.js';
import { Multiplexer } from '../../protocol/src/multiplexer.js';
import { identifier, MAX_STREAMS, streamId, TIMEOUT_MS, validRule, type Endpoint, type Rule, type SessionCredentials } from '../../protocol/src/types.js';

interface Request { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class LocalTunnel extends EventEmitter {
  readonly rules = new Map<string, Rule>();
  readonly connections = new Map<number, string>();
  readonly mux: Multiplexer;
  private readonly requests = new Map<string, Request>();
  private readonly connecting = new Map<number, net.Socket>();
  private lastStreamId = 0;

  private constructor(ws: WebSocket) {
    super();
    this.mux = new Multiplexer(ws, msg => this.receiveControl(msg));
    this.mux.on('streamClosed', (id: number) => { this.connections.delete(id); });
    this.mux.on('peerReset', (id: number) => this.connecting.get(id)?.destroy());
    this.mux.on('fault', error => this.emit('diagnostic', error));
    this.mux.once('closed', () => {
      for (const socket of this.connecting.values()) socket.destroy();
      this.connecting.clear(); this.connections.clear();
      for (const req of this.requests.values()) { clearTimeout(req.timer); req.reject(new Error('Relay disconnected')); }
      this.requests.clear(); this.emit('closed');
    });
  }

  static async connect(endpoint: Endpoint, auth: SessionCredentials): Promise<LocalTunnel> {
    return new LocalTunnel(await connectAuthenticated(endpoint, auth));
  }

  async add(rule: Rule): Promise<void> {
    if (!validRule(rule)) throw new Error('Invalid forwarding rule');
    this.rules.set(rule.id, rule);
    try { await this.request({ action: 'add', ruleId: rule.id, remotePort: rule.remotePort }); }
    catch (error) { this.rules.delete(rule.id); throw error; }
  }

  async remove(id: string): Promise<void> {
    this.rules.delete(id);
    for (const [stream, ruleId] of this.connections) {
      if (ruleId === id) { this.connecting.get(stream)?.destroy(); this.mux.reset(stream); }
    }
    await this.request({ action: 'remove', ruleId: id });
  }

  dispose(): void { this.mux.dispose(); }

  private request(message: object): Promise<void> {
    if (this.mux.closed) return Promise.reject(new Error('Relay disconnected'));
    if (this.requests.size >= MAX_STREAMS) return Promise.reject(new Error('Too many pending requests'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId); reject(new Error('Remote operation timed out')); this.dispose();
      }, TIMEOUT_MS);
      this.requests.set(requestId, { resolve, reject, timer });
      try { this.mux.control({ ...message, type: 'request', requestId }); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); }
    });
  }

  private receiveControl(msg: Record<string, unknown>): void {
    if (msg.type === 'response' && identifier(msg.requestId)) {
      const request = this.requests.get(msg.requestId);
      if (!request) return;
      this.requests.delete(msg.requestId); clearTimeout(request.timer);
      if (msg.ok === true) request.resolve();
      else request.reject(new Error(typeof msg.error === 'string' ? msg.error.slice(0, 500) : 'Remote operation failed'));
    } else if (msg.type === 'open' && streamId(msg.streamId) && identifier(msg.ruleId)) {
      this.open(msg.streamId, msg.ruleId);
    } else throw new Error('Unexpected local control message');
  }

  private open(id: number, ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (id <= this.lastStreamId) throw new Error('Reused connection ID');
    this.lastStreamId = id;
    if (!rule || this.connections.size >= MAX_STREAMS || this.connections.has(id)) {
      this.mux.control({ type: 'open-error', streamId: id }); return;
    }
    const socket = net.createConnection({ host: rule.localHost, port: rule.localPort, allowHalfOpen: true });
    this.connecting.set(id, socket); this.connections.set(id, ruleId);
    socket.pause();
    const timer = setTimeout(() => socket.destroy(new Error('Local connection timed out')), TIMEOUT_MS);
    const failed = (error: Error) => {
      if (!this.connecting.has(id)) return;
      clearTimeout(timer); this.connecting.delete(id); this.connections.delete(id);
      if (!this.mux.closed) this.mux.control({ type: 'open-error', streamId: id });
      this.emit('targetError', ruleId, error.message);
    };
    socket.on('error', failed);
    socket.once('close', () => { clearTimeout(timer); this.connecting.delete(id); this.connections.delete(id); });
    socket.once('connect', () => {
      clearTimeout(timer);
      if (this.mux.closed || !this.rules.has(ruleId)) { socket.destroy(); return; }
      this.connecting.delete(id);
      this.mux.control({ type: 'open-ok', streamId: id });
      this.mux.attach(id, socket);
      this.emit('targetConnected', ruleId);
    });
  }
}
