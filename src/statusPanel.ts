// A minimal webview panel showing the shared server's idle/busy state and the
// active chat id. The webview can't open sockets itself, so it rides the
// extension's existing pipe connection: SharedServerConnection.onState ->
// postMessage -> webview DOM.

import * as vscode from 'vscode';
import { SharedServerConnection, StateMessage } from './sharedServer';

export class StatusPanel {
  private static current: StatusPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(server: SharedServerConnection): void {
    if (StatusPanel.current) {
      StatusPanel.current.panel.reveal();
      return;
    }
    StatusPanel.current = new StatusPanel(server);
  }

  private constructor(server: SharedServerConnection) {
    this.panel = vscode.window.createWebviewPanel(
      'takeshicc.status',
      'Claude Status',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = StatusPanel.html(this.panel.webview);

    this.disposables.push(
      server.onState((s) => this.render(s)),
      // The webview asks for state once its script is live (postMessage sent
      // before then would be lost).
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m && m.type === 'ready') {
          this.render(server.lastState);
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private render(s: StateMessage): void {
    void this.panel.webview.postMessage(s);
  }

  private dispose(): void {
    StatusPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private static html(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; margin: 0; gap: 14px;
  }
  #dot { width: 56px; height: 56px; border-radius: 50%; background: #888; }
  body[data-state="idle"] #dot { background: #3fb950; }
  body[data-state="busy"] #dot { background: #d29922; animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  #state { font-size: 1.7rem; font-weight: 600; letter-spacing: 0.06em; }
  #topic { opacity: 0.7; font-size: 0.85rem; font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body data-state="idle">
  <div id="dot"></div>
  <div id="state">—</div>
  <div id="topic">no active chat</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    const state = m.state === 'busy' ? 'busy' : 'idle';
    document.body.dataset.state = state;
    document.getElementById('state').textContent = state.toUpperCase();
    document.getElementById('topic').textContent = m.topic ? ('chat ' + m.topic) : 'no active chat';
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
