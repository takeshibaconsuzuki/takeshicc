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
import { HistoricalChatMetadata, LiveChatMetadata } from '../server/protocol';

// Connection status the view renders around the chat list.
//   'connecting' — server resolution still in flight (initial state)
//   'off'        — server feature disabled for this workspace
//   'ready'      — connected; `chats` holds the latest snapshot
//   'error'      — connected-but-fetch-failed; `detail` explains
type ViewStatus = 'connecting' | 'off' | 'ready' | 'error';

// The ext -> webview message contract. The webview replies with a single
// { type: 'ready' } once its script has loaded and can receive state, a
// { type: 'reveal', chatId } when a revealable live-chat row is clicked, a
// { type: 'resume', chatId } when a historical-chat row is clicked, and a
// { type: 'newChat' } when the New Chat button is pressed.
interface ViewState {
  status: ViewStatus;
  chats: LiveChatMetadata[];
  // chatIds the extension can reveal — bound to a terminal in this window.
  // Rows in this set render as clickable; clicking focuses their terminal.
  revealable: string[];
  // Past (non-live) chats for this worktree. Every row is clickable; clicking
  // resumes the chat in a new terminal.
  historical: HistoricalChatMetadata[];
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
    historical: [],
  };

  // log: diagnostics channel. onReveal: invoked with the chatId of a clicked
  // revealable live-chat row, so the extension can focus that chat's terminal.
  // onResume: invoked with the chatId, display label and mtime of a clicked
  // historical-chat row, so the extension can spawn a terminal that resumes it
  // and render it identically while it is optimistically live. onNewChat:
  // invoked when the New Chat button is pressed, so the extension can spawn a
  // fresh `claude` terminal — no synthetic row; it surfaces on its own once the
  // session's first UserPromptSubmit hook binds it.
  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly onReveal: (chatId: string) => void,
    private readonly onResume: (
      chatId: string,
      summary: string,
      mTime: number,
    ) => void,
    private readonly onNewChat: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(
      (msg: {
        type?: string;
        chatId?: string;
        summary?: string;
        mTime?: number;
      }) => {
        // The webview signals it is ready to receive state; reply with
        // whatever we have (it may have arrived before the view resolved).
        if (msg?.type === 'ready') {
          this.post();
        } else if (msg?.type === 'reveal' && typeof msg.chatId === 'string') {
          this.onReveal(msg.chatId);
        } else if (msg?.type === 'resume' && typeof msg.chatId === 'string') {
          this.onResume(
            msg.chatId,
            typeof msg.summary === 'string' ? msg.summary : '',
            typeof msg.mTime === 'number' ? msg.mTime : Date.now(),
          );
        } else if (msg?.type === 'newChat') {
          this.onNewChat();
        }
      },
    );

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  // Push a fresh chat snapshot: the live chats, the set of chatIds that can be
  // revealed, and the historical (past, non-live) chats for this worktree.
  update(
    chats: LiveChatMetadata[],
    revealable: Set<string>,
    historical: HistoricalChatMetadata[],
  ): void {
    this.state = {
      status: 'ready',
      chats,
      revealable: [...revealable],
      historical,
    };
    this.post();
  }

  // The server feature is disabled for this workspace (no config entry, not a
  // repo, etc.) — there is nothing to show.
  setOff(): void {
    this.state = { status: 'off', chats: [], revealable: [], historical: [] };
    this.post();
  }

  // Connected, but the chat snapshot could not be fetched.
  setError(detail: string): void {
    this.log.appendLine(`Takeshicc: live chats unavailable — ${detail}`);
    this.state = {
      status: 'error',
      chats: [],
      revealable: [],
      historical: [],
      detail,
    };
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
  /* The New Chat button sits above both chat sections, always visible. */
  #toolbar {
    padding: 8px 12px;
  }
  #new-chat {
    width: 100%;
    padding: 4px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  #new-chat:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .section-header {
    padding: 6px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* The Historical section sits below the Live one; a top border and extra
     space mark the divide. Hidden outright until there is something to show. */
  #hist-header {
    margin-top: 6px;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    padding-top: 12px;
  }
  .empty {
    padding: 10px 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }
  /* A chat list is a 3-column grid: state, title+tail, mtime. Each row is a
     subgrid spanning all three columns so cells line up across rows while the
     row stays a single hover/click target. Rows are top-aligned: column 2 can
     be multi-line (summary + tail), so the dot and mtime sit on its first
     line (the summary) rather than floating against the whole block. */
  .chat-grid {
    display: grid;
    grid-template-columns: auto 1fr auto;
  }
  .row {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: start;
    gap: 8px;
    padding: 6px 12px;
  }
  .row.revealable {
    cursor: pointer;
  }
  .row.revealable:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    /* Row is top-aligned; nudge the dot down to center it on the summary's
       first line (line-height 1.4em, dot 8px). */
    margin-top: calc(0.7em - 4px);
    border-radius: 50%;
    background: var(--vscode-charts-green, #89d185);
  }
  /* Busy: swap the green idle dot for a spinning ring. */
  .dot.busy {
    background: none;
    box-sizing: border-box;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  /* Historical chats are not live — a hollow, dimmed dot, no colour. */
  .dot.historical {
    background: none;
    box-sizing: border-box;
    border: 1px solid var(--vscode-descriptionForeground);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Column 2: the summary with its tail stacked beneath. min-width:0 lets the
     ellipsising children clip to the 1fr track instead of widening it. */
  .cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    display: block;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mtime {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    line-height: 1.4;
    white-space: nowrap;
    text-align: right;
  }
  /* The tail preview: the server's last-N transcript text lines for a live
     chat, stacked under the summary inside the title column. One ellipsised
     line per entry keeps the block exactly N rows tall; clipping works because
     the enclosing .cell is min-width:0. */
  .tail {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    line-height: 1.35;
  }
  .tail-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
</head>
<body>
<div id="toolbar">
  <button id="new-chat" type="button">New Chat</button>
</div>
<div id="live-header" class="section-header"></div>
<div id="live-root" class="chat-grid"></div>
<div id="hist-header" class="section-header"></div>
<div id="hist-root" class="chat-grid"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const liveRoot = document.getElementById('live-root');
  const liveHeader = document.getElementById('live-header');
  const histRoot = document.getElementById('hist-root');
  const histHeader = document.getElementById('hist-header');

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

  // Column 2: the summary, with the recent-text tail (if any) stacked beneath
  // it — one ellipsised line per entry. textContent (never innerHTML):
  // transcript text is untrusted. The full, untruncated tail is appended to
  // the row tooltip. Shared by live rows (server-supplied tail) and historical
  // rows (tail read client-side via the Claude Agent SDK).
  function cellEl(row, labelText, tailArr) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = labelText;
    cell.appendChild(title);
    if (Array.isArray(tailArr) && tailArr.length) {
      const tail = document.createElement('div');
      tail.className = 'tail';
      for (const line of tailArr) {
        const el = document.createElement('div');
        el.className = 'tail-line';
        el.textContent = line;
        tail.appendChild(el);
      }
      cell.appendChild(tail);
      row.title += '\\n\\n' + tailArr.join('\\n');
    }
    return cell;
  }

  function chatEl(chat, revealable) {
    const row = document.createElement('div');
    row.className = revealable ? 'row revealable' : 'row';

    // The title cell is the chat's summary (its session title / summary / first
    // prompt), falling back to the raw id until the server resolves one. The
    // tooltip carries the full, untruncated label plus that raw id.
    const labelText = chat.summary || chat.chatId;
    const tip = chat.summary
      ? chat.summary + '\\n' + chat.chatId
      : chat.chatId;
    row.title = revealable
      ? 'Click to focus this chat\\u2019s terminal\\n' + tip
      : tip;
    if (revealable) {
      row.addEventListener('click', function () {
        vscode.postMessage({ type: 'reveal', chatId: chat.chatId });
      });
    }

    // Column 1: state — a coloured idle dot or a busy spinner.
    const dot = document.createElement('span');
    dot.className = 'dot' + (chat.state === 'busy' ? ' busy' : '');
    row.appendChild(dot);

    // Column 2: summary + recent-text tail.
    row.appendChild(cellEl(row, labelText, chat.tail));

    // Column 3: mtime, rendered as a relative time.
    const mtime = document.createElement('span');
    mtime.className = 'mtime';
    mtime.textContent = relTime(chat.mTime);
    row.appendChild(mtime);

    return row;
  }

  // A historical-chat row. Always clickable — clicking resumes the chat in a
  // new terminal. Column 1 is a dimmed, hollow dot (the chat is not live).
  function histEl(chat) {
    const row = document.createElement('div');
    row.className = 'row revealable';

    const labelText = chat.summary || chat.chatId;
    const tip = chat.summary
      ? chat.summary + '\\n' + chat.chatId
      : chat.chatId;
    row.title = 'Click to resume this chat in a new terminal\\n' + tip;
    row.addEventListener('click', function () {
      vscode.postMessage({
        type: 'resume',
        chatId: chat.chatId,
        summary: chat.summary,
        mTime: chat.mTime,
      });
    });

    const dot = document.createElement('span');
    dot.className = 'dot historical';
    row.appendChild(dot);

    // Column 2: summary + recent-text tail (read client-side via the SDK).
    row.appendChild(cellEl(row, labelText, chat.tail));

    const mtime = document.createElement('span');
    mtime.className = 'mtime';
    mtime.textContent = relTime(chat.mTime);
    row.appendChild(mtime);

    return row;
  }

  // Render the Live Chats section. Returns nothing — fills liveHeader/liveRoot.
  function renderLive(state) {
    liveRoot.replaceChildren();
    liveHeader.textContent = '';

    if (state.status === 'connecting') {
      liveRoot.appendChild(emptyEl('Connecting to the server\\u2026'));
      return;
    }
    if (state.status === 'off') {
      liveRoot.appendChild(
        emptyEl('Server feature is off for this workspace.')
      );
      return;
    }
    if (state.status === 'error') {
      liveRoot.appendChild(
        emptyEl(
          'Could not reach the server.' +
            (state.detail ? ' ' + state.detail : '')
        )
      );
      return;
    }

    const chats = (state.chats || []).slice().sort((a, b) => b.mTime - a.mTime);
    if (chats.length === 0) {
      liveRoot.appendChild(emptyEl('No live chats.'));
      return;
    }
    const revealable = new Set(state.revealable || []);
    liveHeader.textContent =
      chats.length + (chats.length === 1 ? ' live chat' : ' live chats');
    for (const chat of chats) {
      liveRoot.appendChild(chatEl(chat, revealable.has(chat.chatId)));
    }
  }

  // Render the Historical Chats section. Shown only once connected; hidden
  // outright (header and all) for the connecting/off/error states.
  function renderHistorical(state) {
    histRoot.replaceChildren();
    histHeader.textContent = '';

    if (state.status !== 'ready') {
      histHeader.style.display = 'none';
      return;
    }
    histHeader.style.display = '';

    const chats =
      (state.historical || []).slice().sort((a, b) => b.mTime - a.mTime);
    if (chats.length === 0) {
      histRoot.appendChild(emptyEl('No historical chats.'));
      return;
    }
    histHeader.textContent =
      chats.length +
      (chats.length === 1 ? ' historical chat' : ' historical chats');
    for (const chat of chats) {
      histRoot.appendChild(histEl(chat));
    }
  }

  function render(state) {
    renderLive(state);
    renderHistorical(state);
  }

  document.getElementById('new-chat').addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
  });

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
