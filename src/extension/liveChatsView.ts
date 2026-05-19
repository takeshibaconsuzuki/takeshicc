import * as vscode from 'vscode';
import type { LiveChat, LiveChatsMessage } from '../common/protocol';
import type { LiveChatsStream, ServerClient } from './ServerClient';

const STREAM_RECONNECT_MS = 2_000;
const STREAM_RECONNECT_MAX_MS = 30_000;

type OutboundMessage = { type: 'state'; chats: LiveChat[] };
type WebviewMessage = { type: 'ready' };

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export class LiveChatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'takeshicc.liveChatsView';

  private view?: vscode.WebviewView;
  private stream?: LiveChatsStream;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private streamStopped = true;
  private chats: LiveChat[] = [];

  constructor(private readonly getServerClient: () => ServerClient | undefined) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.streamStopped = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready') {
        void this.postState();
        this.ensureStream();
      }
    });
    webviewView.onDidDispose(() => {
      this.streamStopped = true;
      this.stream?.stop();
      this.stream = undefined;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    });
  }

  private ensureStream(): void {
    if (this.streamStopped || this.stream) {
      return;
    }
    const serverClient = this.getServerClient();
    if (!serverClient) {
      this.scheduleReconnect();
      return;
    }
    const handle = serverClient.streamLiveChats((message) => this.onStreamMessage(message));
    this.stream = handle;
    handle.done
      .catch(() => undefined)
      .finally(() => {
        if (this.stream === handle) {
          this.stream = undefined;
        }
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.streamStopped || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      STREAM_RECONNECT_MS * 2 ** this.reconnectAttempts,
      STREAM_RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureStream();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onStreamMessage(message: LiveChatsMessage): void {
    this.reconnectAttempts = 0;

    if (message.type === 'snapshot') {
      this.chats = message.chats;
    } else {
      const next = this.chats.filter((chat) => chat.chatId !== message.chat.chatId);
      next.push(message.chat);
      this.chats = next.sort((a, b) => a.chatId.localeCompare(b.chatId));
    }
    void this.postState();
  }

  private async postState(): Promise<void> {
    await this.post({ type: 'state', chats: this.chats });
  }

  private async post(message: OutboundMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private html(): string {
    const scriptNonce = nonce();
    const styleNonce = nonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${styleNonce}'`,
      `script-src 'nonce-${scriptNonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${styleNonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    .chat-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 28px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 7px;
      background: var(--vscode-sideBar-background);
    }

    .chat-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }

    .chat-state {
      min-width: 42px;
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 10px;
      line-height: 16px;
      text-align: center;
      text-transform: uppercase;
    }

    .chat-state.idle {
      color: var(--vscode-testing-iconPassed, #73c991);
      background: rgba(115, 201, 145, 0.14);
    }

    .chat-state.busy {
      color: var(--vscode-testing-iconQueued, #cca700);
      background: rgba(204, 167, 0, 0.16);
    }

    .muted {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <ul id="chats" class="chat-list"></ul>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const chatsList = document.getElementById('chats');

    function render(chats) {
      chatsList.textContent = '';

      if (chats.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'No live chats.';
        chatsList.appendChild(empty);
        return;
      }

      for (const chat of chats) {
        const row = document.createElement('li');
        row.className = 'chat-row';
        row.title = chat.chatId;

        const id = document.createElement('span');
        id.className = 'chat-id';
        id.textContent = chat.chatId;

        const state = document.createElement('span');
        state.className = 'chat-state ' + chat.state;
        state.textContent = chat.state;

        row.append(id, state);
        chatsList.appendChild(row);
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        render(message.chats || []);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
