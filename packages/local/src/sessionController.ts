import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { credentials } from '../../protocol/src/auth.js';
import { addressOf, identifier, messageOf, parseAddress, port, record, validRule, VERSION, type Endpoint, type Rule, type RuleView, type SessionCredentials, type Snapshot } from '../../protocol/src/types.js';
import { LocalTunnel } from './localTunnel.js';
import { ProcessLookup } from './processLookup.js';

export class SessionController implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.changes.event;
  private readonly rules = new Map<string, RuleView>();
  private readonly desired = new Set<string>();
  private readonly ownerId = randomUUID();
  private tunnel?: LocalTunnel;
  private auth?: SessionCredentials;
  private queue: Promise<unknown> = Promise.resolve();
  private retry?: NodeJS.Timeout;
  private retryCount = 0;
  private session = 'Disconnected';
  private message = '';
  private disposed = false;
  private readonly processes = new ProcessLookup();
  readonly supported = vscode.env.uiKind === vscode.UIKind.Desktop && vscode.env.remoteName === 'ssh-remote';

  constructor(private readonly context: vscode.ExtensionContext, readonly log: vscode.OutputChannel) {
    const saved: unknown = context.workspaceState.get('rules', []);
    if (Array.isArray(saved)) {
      for (const entry of saved.slice(0, 64)) {
        const rule = record(entry) ? { ...entry, localHost: entry.localHost ?? '127.0.0.1' } : entry;
        if (validRule(rule)) this.rules.set(rule.id, { ...rule, status: 'stopped', connections: 0 });
      }
    }
  }

  get snapshot(): Snapshot {
    const counts = new Map<string, number>();
    for (const id of this.tunnel?.connections.values() ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    return {
      supported: this.supported && vscode.workspace.isTrusted, session: this.session,
      message: !this.supported ? 'Connect to a Remote-SSH workspace to forward a local port.' : this.message,
      rules: [...this.rules.values()].map(rule => ({ ...rule, connections: counts.get(rule.id) ?? 0 })),
    };
  }

  async restore(): Promise<void> {
    if (!this.supported) return;
    for (const rule of this.rules.values()) if (rule.autoStart) await this.start(rule.id).catch(() => {});
  }

  add(address: string, remotePort: number): Promise<void> {
    return this.run(async () => {
      this.assertSupported();
      const target = parseAddress(address);
      if (!port(remotePort)) throw new Error('Enter a remote port between 1024 and 65535.');
      if (this.rules.size >= 64) throw new Error('The maximum is 64 forwarding rules.');
      if ([...this.rules.values()].some(rule => rule.remotePort === remotePort)) throw new Error('That remote port already has a rule.');
      const rule: RuleView = { id: randomUUID(), localHost: target.host, localPort: target.port, remotePort, label: '', autoStart: false, status: 'stopped', connections: 0 };
      this.rules.set(rule.id, rule); await this.save(); this.emit();
      this.refreshProcesses();
      await this.startRule(rule);
    });
  }

  start(id: string): Promise<void> { return this.run(async () => this.startRule(this.getRule(id))); }
  stop(id: string): Promise<void> { return this.run(async () => this.stopRule(this.getRule(id))); }
  remove(id: string): Promise<void> {
    return this.run(async () => { await this.stopRule(this.getRule(id)); this.rules.delete(id); await this.save(); this.emit(); });
  }
  rename(id: string, label: string): Promise<void> {
    return this.run(async () => { this.getRule(id).label = label.trim().slice(0, 80); await this.save(); this.emit(); });
  }
  setAutoStart(id: string, enabled: boolean): Promise<void> {
    return this.run(async () => { this.getRule(id).autoStart = enabled; await this.save(); this.emit(); });
  }
  changeAddress(id: string, address: string): Promise<void> {
    return this.run(async () => {
      const target = parseAddress(address), rule = this.getRule(id), restart = this.desired.has(id);
      await this.stopRule(rule);
      rule.localHost = target.host; rule.localPort = target.port;
      delete rule.process; delete rule.processDetail;
      await this.save(); this.refreshProcesses();
      if (restart) await this.startRule(rule);
      this.emit();
    });
  }
  changeRemotePort(id: string, value: number): Promise<void> {
    return this.run(async () => {
      if (!port(value)) throw new Error('Enter a port between 1024 and 65535.');
      if ([...this.rules.values()].some(rule => rule.id !== id && rule.remotePort === value)) throw new Error('That remote port already has a rule.');
      const rule = this.getRule(id); const restart = this.desired.has(id);
      await this.stopRule(rule); rule.remotePort = value; await this.save();
      if (restart) await this.startRule(rule);
      this.emit();
    });
  }
  stopAll(): Promise<void> {
    return this.run(async () => {
      clearTimeout(this.retry); this.retry = undefined;
      for (const rule of this.rules.values()) await this.stopRule(rule);
      this.tunnel?.dispose(); this.tunnel = undefined;
      this.session = 'Disconnected'; this.emit();
    });
  }
  rule(id: string): RuleView | undefined { return this.rules.get(id); }
  refreshProcesses(): void {
    if (this.disposed) return;
    for (const rule of this.rules.values()) {
      const address = addressOf(rule);
      void this.processes.get(rule).then(info => {
        if (this.disposed || this.rules.get(rule.id) !== rule || addressOf(rule) !== address) return;
        if (rule.process !== info.name || rule.processDetail !== info.detail) {
          rule.process = info.name; rule.processDetail = info.detail; this.emit();
        }
      });
    }
  }

  dispose(): void {
    this.disposed = true; clearTimeout(this.retry); this.desired.clear();
    this.tunnel?.dispose(); this.release(this.auth); this.changes.dispose();
  }

  private run(action: () => Promise<void>): Promise<void> {
    const result = this.queue.catch(() => {}).then(async () => {
      if (this.disposed) return;
      try { this.message = ''; await action(); }
      catch (error) { this.message = messageOf(error); this.log.appendLine(this.message); this.emit(); throw error; }
    });
    this.queue = result; return result;
  }

  private assertSupported(): void {
    if (!this.supported) throw new Error('Open a desktop Remote-SSH workspace first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before forwarding local services.');
  }

  private async connect(): Promise<LocalTunnel> {
    this.assertSupported();
    if (this.tunnel && !this.tunnel.mux.closed) return this.tunnel;
    this.session = 'Connecting'; this.emit();
    const auth = credentials(this.ownerId); this.auth = auth;
    let timer: NodeJS.Timeout | undefined;
    try {
      const preparation = vscode.commands.executeCommand<unknown>('_remotePortForward.prepare', auth);
      let expired = false;
      void preparation.then(() => { if (expired || this.disposed) this.release(auth); }, () => {});
      const endpoint = await Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Remote component did not respond. Check that Remote Ports is installed on the SSH host.')); }, 20_000); }),
      ]);
      if (!record(endpoint) || endpoint.version !== VERSION || typeof endpoint.url !== 'string' || !identifier(endpoint.agentId)) {
        throw new Error('The remote component is incompatible. Install matching versions on both sides.');
      }
      const tunnel = await LocalTunnel.connect(endpoint as unknown as Endpoint, auth);
      if (this.disposed) { tunnel.dispose(); throw new Error('Forwarding was cancelled'); }
      this.tunnel = tunnel; this.retryCount = 0;
      tunnel.on('diagnostic', error => this.log.appendLine(messageOf(error)));
      tunnel.on('targetError', (id: string, message: string) => { const rule = this.rules.get(id); if (rule) { rule.error = `Local service: ${message}`; this.emit(); } });
      tunnel.on('targetConnected', (id: string) => { const rule = this.rules.get(id); if (rule) { delete rule.error; this.emit(); } });
      tunnel.once('closed', () => {
        if (this.tunnel !== tunnel || this.disposed) return;
        this.tunnel = undefined;
        this.session = 'Disconnected';
        for (const rule of this.rules.values()) if (this.desired.has(rule.id)) rule.status = 'starting';
        this.message = 'Connection lost. Existing TCP connections have closed.';
        this.emit(); this.scheduleReconnect();
      });
      this.session = 'Connected'; this.message = ''; this.emit();
      this.log.appendLine('Authenticated to the current remote workspace.');
      return tunnel;
    } catch (error) {
      this.release(auth); this.session = 'Disconnected';
      const text = messageOf(error);
      this.log.appendLine(`Session connection failed: ${text}`);
      throw new Error(text.includes('not found') ? 'Install Remote Ports on the SSH host, then try again.' : text, { cause: error });
    } finally { clearTimeout(timer); }
  }

  private async startRule(rule: RuleView): Promise<void> {
    if (rule.status === 'listening') return;
    this.desired.add(rule.id); rule.status = 'starting'; delete rule.error; this.emit();
    try {
      const tunnel = await this.connect();
      await tunnel.add(rule);
      rule.status = 'listening'; this.log.appendLine(`Listening remotely on 127.0.0.1:${rule.remotePort} → ${addressOf(rule)}`);
    } catch (error) {
      rule.status = 'error'; rule.error = messageOf(error); this.desired.delete(rule.id); throw error;
    } finally { this.emit(); }
  }

  private async stopRule(rule: RuleView): Promise<void> {
    this.desired.delete(rule.id);
    if (!this.desired.size) { clearTimeout(this.retry); this.retry = undefined; }
    if (this.tunnel?.rules.has(rule.id) && !this.tunnel.mux.closed) {
      try { await this.tunnel.remove(rule.id); }
      catch (error) { this.tunnel?.dispose(); this.message = `${messageOf(error)}. Remote listeners are released when the lease expires (up to 30 seconds).`; }
    }
    rule.status = 'stopped'; rule.connections = 0; delete rule.error; this.emit();
  }

  private scheduleReconnect(): void {
    if (!this.desired.size || this.disposed || this.retry) return;
    if (this.retryCount >= 5) {
      this.session = 'Disconnected'; this.message = 'Reconnection failed. Start a port to retry.';
      for (const rule of this.rules.values()) if (this.desired.has(rule.id)) rule.status = 'error';
      this.desired.clear(); this.emit(); return;
    }
    this.session = 'Reconnecting'; this.emit();
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.run(async () => {
        if (!this.desired.size) return;
        try {
          const tunnel = await this.connect();
          for (const id of [...this.desired]) {
            const rule = this.getRule(id);
            try { await tunnel.add(rule); rule.status = 'listening'; delete rule.error; }
            catch (error) { rule.status = 'error'; rule.error = messageOf(error); this.desired.delete(id); }
          }
          this.emit();
        } catch (error) { this.message = messageOf(error); this.scheduleReconnect(); }
      }).catch(() => {});
    }, Math.min(1000 * 2 ** this.retryCount++, 16_000) + Math.random() * 250);
  }

  private release(auth?: SessionCredentials): void {
    if (auth) void vscode.commands.executeCommand('_remotePortForward.release', auth.ownerId, auth.sessionId).then(undefined, () => {});
  }
  private getRule(id: string): RuleView {
    const rule = this.rules.get(id); if (!rule) throw new Error('This forwarding rule no longer exists.'); return rule;
  }
  private async save(): Promise<void> {
    const rules: Rule[] = [...this.rules.values()].map(({ id, localHost, localPort, remotePort, label, autoStart }) => ({ id, localHost, localPort, remotePort, label, autoStart }));
    await this.context.workspaceState.update('rules', rules);
  }
  private emit(): void { if (!this.disposed) this.changes.fire(this.snapshot); }
}
