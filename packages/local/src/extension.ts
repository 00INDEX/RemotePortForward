import * as vscode from 'vscode';
import { messageOf } from '../../protocol/src/types.js';
import { SessionController } from './sessionController.js';
import { PortsView } from './portsView.js';

let controller: SessionController | undefined;
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Remote Ports');
  const session = new SessionController(context, log); controller = session;
  const view = new PortsView(context.extensionUri, session);
  const safely = (task: () => Promise<void>) => async () => {
    try { await task(); } catch (error) { void vscode.window.showErrorMessage(messageOf(error)); }
  };
  context.subscriptions.push(log, session, view,
    vscode.window.registerWebviewViewProvider('remotePortForward.ports', view),
    vscode.commands.registerCommand('remotePortForward.add', safely(() => view.promptAdd())),
    vscode.commands.registerCommand('remotePortForward.stopAll', safely(() => session.stopAll())),
    vscode.commands.registerCommand('remotePortForward.logs', () => log.show()),
  );
  void session.restore();
}
export function deactivate(): void { controller?.dispose(); controller = undefined; }
