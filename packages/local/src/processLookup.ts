import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { addressOf, type Rule } from '../../protocol/src/types.js';

const execute = promisify(execFile);
export interface ProcessInfo { name: string; detail: string }
interface ListenerProcess { pid: string; command: string; address: string }

function parseLsof(text: string): ListenerProcess[] {
  const result: ListenerProcess[] = [];
  let pid = '', command = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { pid = line.slice(1); command = ''; }
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && pid && command) result.push({ pid, command, address: line.slice(1) });
  }
  return result;
}

function listenerMatches(address: string, hosts: string[], port: number): boolean {
  const suffix = `:${port}`;
  if (!address.endsWith(suffix)) return false;
  const host = address.slice(0, -suffix.length).replace(/^\[|\]$/g, '');
  return host === '*' || host === '0.0.0.0' || host === '::' || hosts.includes(host);
}

/** Process discovery runs only on this computer, never by logging into a LAN device. */
export class ProcessLookup {
  private readonly cache = new Map<string, { expires: number; result: Promise<ProcessInfo> }>();
  private active = 0;
  private waiting: Array<() => void> = [];

  get(rule: Rule): Promise<ProcessInfo> {
    const key = addressOf(rule), cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (this.waiting.length >= 64) return Promise.resolve({ name: 'Unavailable', detail: 'Process lookup is busy; it will retry on the next refresh.' });
    const result = new Promise<ProcessInfo>(resolve => {
      const run = () => {
        this.active++;
        void this.find(rule).catch(() => ({ name: 'Unavailable', detail: 'The OS did not provide listener process information.' })).then(resolve).finally(() => {
          this.active--; this.waiting.shift()?.();
        });
      };
      if (this.active < 2) run(); else this.waiting.push(run);
    });
    const entry = { expires: Number.POSITIVE_INFINITY, result };
    this.cache.set(key, entry);
    void result.finally(() => { entry.expires = Date.now() + 5000; });
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  private async find(rule: Rule): Promise<ProcessInfo> {
    let hosts = [rule.localHost];
    if (!isIP(rule.localHost)) {
      let timer: NodeJS.Timeout | undefined;
      try {
        hosts = (await Promise.race([lookup(rule.localHost, { all: true }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 1500); })])).map(item => item.address);
      } finally { clearTimeout(timer); }
    }
    const local = new Set(['127.0.0.1', '::1', ...Object.values(networkInterfaces()).flatMap(items => items?.map(item => item.address) ?? [])]);
    if (!hosts.every(host => local.has(host) || host.startsWith('127.'))) {
      return { name: 'Remote device', detail: 'The target is on another device. Its processes cannot be queried from this computer.' };
    }
    if (process.platform === 'win32') {
      const script = `Get-NetTCPConnection -State Listen -LocalPort ${rule.localPort} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [PSCustomObject]@{pid=$_.OwningProcess;command=$p.ProcessName;address=($_.LocalAddress + ':${rule.localPort}')} } | ConvertTo-Json -Compress`;
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 2500, maxBuffer: 64 * 1024, windowsHide: true });
      if (!stdout.trim()) return { name: 'Not listening', detail: 'No visible local listener was found.' };
      const parsed = JSON.parse(stdout); const rows: ListenerProcess[] = (Array.isArray(parsed) ? parsed : [parsed]);
      return this.describe(rows.filter(row => listenerMatches(row.address, hosts, rule.localPort)));
    }
    try {
      const { stdout } = await execute('lsof', ['-nP', `-iTCP:${rule.localPort}`, '-sTCP:LISTEN', '-Fpcn'], { timeout: 2000, maxBuffer: 64 * 1024 });
      return this.describe(parseLsof(stdout).filter(row => listenerMatches(row.address, hosts, rule.localPort)));
    } catch (error) {
      if (process.platform === 'linux') {
        const { stdout } = await execute('ss', ['-H', '-lntp', `sport = :${rule.localPort}`], { timeout: 2000, maxBuffer: 64 * 1024 });
        const rows: ListenerProcess[] = [];
        for (const line of stdout.split('\n')) {
          const address = line.trim().split(/\s+/)[3] ?? '';
          for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) rows.push({ command: match[1]!, pid: match[2]!, address });
        }
        if (stdout.trim() && !rows.length) return { name: 'Unavailable', detail: 'A listener exists, but this user cannot read its process information.' };
        return this.describe(rows.filter(row => listenerMatches(row.address, hosts, rule.localPort)));
      }
      if ((error as { code?: unknown }).code === 1) return { name: 'Not listening', detail: 'No visible local listener was found; OS permissions may limit discovery.' };
      throw error;
    }
  }

  private describe(rows: ListenerProcess[]): ProcessInfo {
    if (!rows.length) return { name: 'Not listening', detail: 'No matching local listener was found; OS permissions may limit discovery.' };
    const names = [...new Set(rows.map(row => `${row.command} (${row.pid})`))];
    return { name: names.join(', '), detail: names.join('\n') };
  }
}
