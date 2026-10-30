import * as vscode from 'vscode';
import { messageOf, validCredentials } from '../../protocol/src/types.js';
import { RelayServer } from './relayServer.js';

const sessions = new Map<string, RelayServer>();
let preparation: Promise<unknown> = Promise.resolve();

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Remote Ports — Relay');
  context.subscriptions.push(log);
  context.subscriptions.push(vscode.commands.registerCommand('_remotePortForward.prepare', (value: unknown) => {
    const task = preparation.catch(() => {}).then(async () => {
      if (!vscode.workspace.isTrusted || !vscode.env.remoteName) throw new Error('Open a trusted Remote-SSH workspace first.');
      if (!validCredentials(value)) throw new Error('Invalid session request');
      await sessions.get(value.ownerId)?.dispose();
      sessions.delete(value.ownerId);
      if (sessions.size >= 8) throw new Error('Too many forwarding sessions');
      const relay = new RelayServer(value);
      sessions.set(value.ownerId, relay);
      relay.on('diagnostic', text => log.appendLine(String(text)));
      relay.once('disposed', () => { if (sessions.get(value.ownerId) === relay) sessions.delete(value.ownerId); });
      try {
        log.appendLine('Preparing a remote relay listener.');
        const endpoint = await relay.listen();
        const uri = await vscode.env.asExternalUri(vscode.Uri.parse(endpoint.url));
        log.appendLine('Prepared a forwarding session.');
        return { ...endpoint, url: uri.toString(true) };
      } catch (error) {
        await relay.dispose();
        log.appendLine(`Session preparation failed: ${messageOf(error)}`);
        throw error;
      }
    });
    preparation = task;
    return task;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('_remotePortForward.release', async (ownerId: unknown, sessionId: unknown) => {
    if (typeof ownerId !== 'string' || typeof sessionId !== 'string') return;
    const relay = sessions.get(ownerId);
    if (relay?.auth.sessionId === sessionId) await relay.dispose();
  }));
  context.subscriptions.push({ dispose: () => { for (const relay of sessions.values()) void relay.dispose(); } });
}

export async function deactivate(): Promise<void> {
  await preparation.catch(() => {});
  await Promise.all([...sessions.values()].map(relay => relay.dispose()));
}
