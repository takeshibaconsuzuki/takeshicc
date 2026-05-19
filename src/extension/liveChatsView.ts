import * as vscode from 'vscode';
import type { LiveChatsMessage } from '../common/protocol';
import type { ServerClient } from './ServerClient';
import { ReconnectingStream } from './reconnectingStream';
import { contentSecurityPolicy, nonce } from './webviewHtml';

type WebviewMessage = { type: 'ready' };

export class LiveChatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'takeshicc.liveChatsView';

  private view?: vscode.WebviewView;
  private readonly stream: ReconnectingStream<LiveChatsMessage>;

  constructor(getServerClient: () => ServerClient | undefined) {
    // The server (re)sends a full `snapshot` on every connect, so the webview
    // owns the list and the provider just forwards frames — no host-side copy.
    this.stream = new ReconnectingStream<LiveChatsMessage>(
      (onMessage) => getServerClient()?.streamLiveChats(onMessage),
      (message) => void this.view?.webview.postMessage(message),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'ready') {
        this.stream.start();
      }
    });
    webviewView.onDidDispose(() => this.stream.stop());
  }

  private html(): string {
    const scriptNonce = nonce();
    const styleNonce = nonce();
    const csp = contentSecurityPolicy(scriptNonce, styleNonce);

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
    let chats = [];

    function render() {
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

    function apply(message) {
      if (message.type === 'snapshot') {
        chats = message.chats;
      } else if (message.type === 'updated') {
        chats = chats
          .filter((chat) => chat.chatId !== message.chat.chatId)
          .concat(message.chat)
          .sort((a, b) => a.chatId.localeCompare(b.chatId));
      } else if (message.type === 'removed') {
        chats = chats.filter((chat) => chat.chatId !== message.chatId);
      } else {
        return;
      }
      render();
    }

    window.addEventListener('message', (event) => apply(event.data));

    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
