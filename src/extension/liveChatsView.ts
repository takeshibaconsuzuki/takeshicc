// The "Live Chats" webview view — a sidebar panel that renders the live chat
// metadata reported by the per-repo server.
//
// Data flow is one-directional: the extension owns the state and pushes it to
// the webview via postMessage; the webview is a pure render target that never
// fetches anything itself. Today the extension calls update() once, right
// after it connects to the server. When the server moves to push-based state
// updates, each pushed snapshot just becomes another update() call — the
// webview side needs no change.

import * as vscode from 'vscode';
import { LiveChatMetadata } from '../server/protocol';

// Connection status the view renders around the chat list.
//   'connecting' — server resolution still in flight (initial state)
//   'off'        — server feature disabled for this workspace
//   'ready'      — connected; `chats` holds the latest snapshot
//   'error'      — connected-but-fetch-failed; `detail` explains
type ViewStatus = 'connecting' | 'off' | 'ready' | 'error';

// The ext -> webview message contract. The webview replies with a single
// { type: 'ready' } once its script has loaded and can receive state, and a
// { type: 'reveal', chatId } when a revealable row is clicked.
interface ViewState {
  status: ViewStatus;
  chats: LiveChatMetadata[];
  // chatIds the extension can reveal — bound to a terminal in this window.
  // Rows in this set render as clickable; clicking focuses their terminal.
  revealable: string[];
  detail?: string;
}

export class LiveChatsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'takeshicc.liveChats';

  private view?: vscode.WebviewView;

  // The latest state. Held so a view resolved (or re-resolved, after being
  // hidden) after data arrived still gets the current snapshot via the
  // 'ready' handshake.
  private state: ViewState = {
    status: 'connecting',
    chats: [],
    revealable: [],
  };

  // log: diagnostics channel. onReveal: invoked with the chatId of a clicked
  // revealable row, so the extension can focus that chat's terminal.
  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly onReveal: (chatId: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(
      (msg: { type?: string; chatId?: string }) => {
        // The webview signals it is ready to receive state; reply with
        // whatever we have (it may have arrived before the view resolved).
        if (msg?.type === 'ready') {
          this.post();
        } else if (msg?.type === 'reveal' && typeof msg.chatId === 'string') {
          this.onReveal(msg.chatId);
        }
      },
    );

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  // Push a fresh chat snapshot plus the set of chatIds that can be revealed.
  update(chats: LiveChatMetadata[], revealable: Set<string>): void {
    this.state = { status: 'ready', chats, revealable: [...revealable] };
    this.post();
  }

  // The server feature is disabled for this workspace (no config entry, not a
  // repo, etc.) — there is nothing to show.
  setOff(): void {
    this.state = { status: 'off', chats: [], revealable: [] };
    this.post();
  }

  // Connected, but the chat snapshot could not be fetched.
  setError(detail: string): void {
    this.log.appendLine(`Takeshicc: live chats unavailable — ${detail}`);
    this.state = { status: 'error', chats: [], revealable: [], detail };
    this.post();
  }

  // Send the current state to the webview, if one is resolved.
  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', ...this.state });
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
  body {
    padding: 0;
    margin: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #header {
    padding: 6px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .empty {
    padding: 10px 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }
  .chat {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
  }
  .chat.revealable {
    cursor: pointer;
  }
  .chat.revealable:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
  }
  .dot.busy {
    background: var(--vscode-charts-green, #89d185);
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }
  .id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .sub {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
</style>
</head>
<body>
<div id="header"></div>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const header = document.getElementById('header');

  function relTime(ms) {
    const delta = Date.now() - ms;
    if (delta < 5000) return 'just now';
    const s = Math.floor(delta / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function emptyEl(text) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = text;
    return el;
  }

  function chatEl(chat, revealable) {
    const row = document.createElement('div');
    row.className = revealable ? 'chat revealable' : 'chat';
    row.title = revealable
      ? 'Click to focus this chat\\u2019s terminal'
      : chat.chatId;
    if (revealable) {
      row.addEventListener('click', function () {
        vscode.postMessage({ type: 'reveal', chatId: chat.chatId });
      });
    }

    const dot = document.createElement('span');
    dot.className = 'dot' + (chat.state === 'busy' ? ' busy' : '');
    row.appendChild(dot);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = chat.chatId;
    meta.appendChild(id);

    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = chat.state + ' \\u00b7 ' + relTime(chat.mTime);
    meta.appendChild(sub);

    row.appendChild(meta);
    return row;
  }

  function render(state) {
    root.replaceChildren();
    header.textContent = '';

    if (state.status === 'connecting') {
      root.appendChild(emptyEl('Connecting to the server\\u2026'));
      return;
    }
    if (state.status === 'off') {
      root.appendChild(
        emptyEl('Server feature is off for this workspace.')
      );
      return;
    }
    if (state.status === 'error') {
      root.appendChild(
        emptyEl(
          'Could not reach the server.' +
            (state.detail ? ' ' + state.detail : '')
        )
      );
      return;
    }

    const chats = (state.chats || []).slice().sort((a, b) => b.mTime - a.mTime);
    if (chats.length === 0) {
      root.appendChild(emptyEl('No live chats.'));
      return;
    }
    const revealable = new Set(state.revealable || []);
    header.textContent =
      chats.length + (chats.length === 1 ? ' live chat' : ' live chats');
    for (const chat of chats) {
      root.appendChild(chatEl(chat, revealable.has(chat.chatId)));
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      render(event.data);
    }
  });

  // Tell the extension we can receive state now.
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
