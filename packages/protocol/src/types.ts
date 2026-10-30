export const VERSION = 1;
export const MAX_STREAMS = 64;
export const MAX_FRAME = 64 * 1024;
export const WINDOW = 256 * 1024;
export const MAX_BUFFERED = 16 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;

export interface Rule {
  id: string;
  localHost: string;
  localPort: number;
  remotePort: number;
  label: string;
  autoStart: boolean;
}

export interface RuleView extends Rule {
  status: 'stopped' | 'starting' | 'listening' | 'error';
  connections: number;
  error?: string;
  process?: string;
  processDetail?: string;
}

export interface Snapshot {
  supported: boolean;
  session: string;
  message: string;
  rules: RuleView[];
}

export interface SessionCredentials {
  ownerId: string;
  sessionId: string;
  secret: string;
}

export interface Endpoint {
  url: string;
  agentId: string;
  version: number;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function port(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

export function targetPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

export function parseAddress(value: string): { host: string; port: number } {
  let input = value.trim();
  if (/^\d+$/.test(input)) input = `127.0.0.1:${input}`;
  try {
    const url = new URL(`tcp://${input}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const number = Number(url.port);
    if (!host || !targetPort(number) || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== '/') || /[\s/\\]/.test(host) || input.includes('://') || input.endsWith('/')) throw new Error();
    return { host, port: number };
  } catch { throw new Error('Enter an address such as 127.0.0.1:3000, 192.168.1.20:8080, or [::1]:3000.'); }
}

export function addressOf(rule: Pick<Rule, 'localHost' | 'localPort'>): string {
  return `${rule.localHost.includes(':') ? `[${rule.localHost}]` : rule.localHost}:${rule.localPort}`;
}

export function suggestedRemotePort(localPort: number): number {
  return localPort >= 1024 ? localPort : 10000 + localPort;
}

export function streamId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validCredentials(value: unknown): value is SessionCredentials {
  return record(value) && identifier(value.ownerId) && identifier(value.sessionId)
    && typeof value.secret === 'string' && /^[a-f0-9]{64}$/.test(value.secret);
}

export function validRule(value: unknown): value is Rule {
  if (!record(value) || !identifier(value.id) || typeof value.localHost !== 'string' || !targetPort(value.localPort) || !port(value.remotePort)
    || typeof value.label !== 'string' || value.label.length > 80 || typeof value.autoStart !== 'boolean') return false;
  try { return parseAddress(addressOf(value as unknown as Rule)).host === value.localHost; } catch { return false; }
}
