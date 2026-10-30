import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { identifier, messageOf, parseAddress, port, record, suggestedRemotePort } from '../../protocol/src/types.js';
import type { SessionController } from './sessionController.js';

export class PortsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;
  private lastProcessRefresh = 0;
  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: SessionController) {
    this.disposables.push(controller.onDidChange(() => this.refresh()));
    this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    const nonce = randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist/portsTable.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist/portsTable.css'));
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><main id="app"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.disposables.push(webview.onDidReceiveMessage(message => {
      void this.handle(message).catch(error => {
        this.controller.log.appendLine(messageOf(error));
        void webview.postMessage({ type: 'error', message: messageOf(error) });
      });
    }));
    this.disposables.push(view.onDidChangeVisibility(() => this.refresh()));
  }

  async promptAdd(): Promise<void> {
    const local = await vscode.window.showInputBox({ title: 'Forward an Address', prompt: 'A service reachable from your computer, including a LAN device', placeHolder: '192.168.1.20:8080', validateInput: value => { try { parseAddress(value); return undefined; } catch (error) { return messageOf(error); } } });
    if (local === undefined) return;
    const remote = await vscode.window.showInputBox({ title: 'Forwarded Port', prompt: 'Listen on this port on the remote machine (127.0.0.1)', value: String(suggestedRemotePort(parseAddress(local).port)), validateInput: validatePort });
    if (remote === undefined) return;
    await this.controller.add(local, Number(remote));
  }

  dispose(): void { clearInterval(this.timer); for (const disposable of this.disposables) disposable.dispose(); }
  private refresh(): void {
    if (this.view?.visible) {
      if (Date.now() - this.lastProcessRefresh > 5000) { this.lastProcessRefresh = Date.now(); this.controller.refreshProcesses(); }
      void this.view.webview.postMessage({ type: 'snapshot', snapshot: this.controller.snapshot });
    }
  }
  private async handle(message: unknown): Promise<void> {
    if (!record(message) || typeof message.type !== 'string') return;
    if (message.type === 'ready') { this.refresh(); return; }
    if (message.type === 'add' && typeof message.address === 'string' && port(message.remotePort)) {
      await this.controller.add(message.address, message.remotePort); return;
    }
    if (message.type === 'logs') { this.controller.log.show(); return; }
    if (!identifier(message.id)) return;
    const id = message.id;
    switch (message.type) {
      case 'start': await this.controller.start(id); break;
      case 'stop': await this.controller.stop(id); break;
      case 'remove': await this.controller.remove(id); break;
      case 'rename': if (typeof message.label === 'string') await this.controller.rename(id, message.label); break;
      case 'remotePort': if (port(message.port)) await this.controller.changeRemotePort(id, message.port); break;
      case 'address': if (typeof message.address === 'string') await this.controller.changeAddress(id, message.address); break;
      case 'autoStart': if (typeof message.enabled === 'boolean') await this.controller.setAutoStart(id, message.enabled); break;
      case 'copy': {
        const rule = this.controller.rule(id);
        if (rule) {
          const text = message.kind === 'address' ? `127.0.0.1:${rule.remotePort}` : String(rule.remotePort);
          await vscode.env.clipboard.writeText(text);
          void this.view?.webview.postMessage({ type: 'copied', id, text });
        }
        break;
      }
    }
  }
}

function validatePort(value: string): string | undefined {
  return /^\d+$/.test(value) && port(Number(value)) ? undefined : 'Enter a port between 1024 and 65535.';
}
