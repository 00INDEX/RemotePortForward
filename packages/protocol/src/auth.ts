import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { record, TIMEOUT_MS, VERSION, type Endpoint, type SessionCredentials } from './types.js';

export function credentials(ownerId = randomUUID()): SessionCredentials {
  return { ownerId, sessionId: randomUUID(), secret: randomBytes(32).toString('hex') };
}

function nonce(): string { return randomBytes(32).toString('hex'); }
function validNonce(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function proof(key: string, role: string, sessionId: string, agentId: string, serverNonce: string, clientNonce: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify([VERSION, role, sessionId, agentId, serverNonce, clientNonce])).digest('hex');
}
function equalProof(received: unknown, expected: string): boolean {
  return validNonce(received) && timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

export function parseControl(data: RawData, binary: boolean): Record<string, unknown> {
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (binary || buffer.byteLength > 16 * 1024) throw new Error('Invalid control message');
  const value: unknown = JSON.parse(buffer.toString());
  if (!record(value)) throw new Error('Invalid control message');
  return value;
}

export function authenticateServer(ws: WebSocket, auth: SessionCredentials, agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const challenge = nonce();
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', fail); };
    const fail = (error: Error) => { cleanup(); ws.terminate(); reject(error); };
    const onClose = () => fail(new Error('Authentication connection closed'));
    const timer = setTimeout(() => fail(new Error('Authentication timed out')), TIMEOUT_MS);
    const onMessage = (data: RawData, binary: boolean) => {
      try {
        const msg = parseControl(data, binary);
        if (msg.type !== 'authenticate' || !validNonce(msg.nonce)
          || !equalProof(msg.proof, proof(auth.secret, 'client', auth.sessionId, agentId, challenge, msg.nonce))) {
          throw new Error('Authentication failed');
        }
        ws.send(JSON.stringify({ type: 'authenticated', proof: proof(auth.secret, 'server', auth.sessionId, agentId, challenge, msg.nonce) }));
        cleanup();
        resolve();
      } catch (error) { fail(error instanceof Error ? error : new Error('Authentication failed')); }
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', fail);
    ws.send(JSON.stringify({ type: 'challenge', version: VERSION, sessionId: auth.sessionId, agentId, nonce: challenge }));
  });
}

export function connectAuthenticated(endpoint: Endpoint, auth: SessionCredentials): Promise<WebSocket> {
  if (endpoint.version !== VERSION) return Promise.reject(new Error('Component versions do not match. Update both extensions.'));
  const url = new URL(endpoint.url);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    return Promise.reject(new Error('Unsupported relay URL'));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint.url, { perMessageDeflate: false, maxPayload: 64 * 1024 + 5, handshakeTimeout: TIMEOUT_MS, followRedirects: false });
    let challenge: string | undefined;
    const clientNonce = nonce();
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', fail); };
    const fail = (error: Error) => { cleanup(); ws.on('error', () => {}); ws.terminate(); reject(error); };
    const onClose = () => fail(new Error('Relay closed during authentication'));
    const timer = setTimeout(() => fail(new Error('Relay handshake timed out')), TIMEOUT_MS);
    const onMessage = (data: RawData, binary: boolean) => {
      try {
        const msg = parseControl(data, binary);
        if (!challenge) {
          if (msg.type !== 'challenge' || msg.version !== VERSION || msg.sessionId !== auth.sessionId
            || msg.agentId !== endpoint.agentId || !validNonce(msg.nonce)) throw new Error('Unexpected relay identity');
          challenge = msg.nonce;
          ws.send(JSON.stringify({ type: 'authenticate', nonce: clientNonce,
            proof: proof(auth.secret, 'client', auth.sessionId, endpoint.agentId, challenge, clientNonce) }));
        } else {
          if (msg.type !== 'authenticated' || !equalProof(msg.proof,
            proof(auth.secret, 'server', auth.sessionId, endpoint.agentId, challenge, clientNonce))) throw new Error('Relay identity verification failed');
          cleanup(); resolve(ws);
        }
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid handshake')); }
    };
    ws.on('message', onMessage);
    ws.once('error', fail);
    ws.once('close', onClose);
  });
}
