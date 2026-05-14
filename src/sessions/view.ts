import * as vscode from 'vscode';
import { SessionService } from './service';
import { TerminalTracker } from '../terminals';
import { HookStateMachine } from '../hooks/stateMachine';
import { mapHookStatus, type SessionStatus } from './statusResolver';
import { formatRelativeTime } from './time';
import { TailCache } from './tail';

const SLOW_TICK_MS = 30_000;
// Claude fires Stop/idle_prompt before the JSONL is fully flushed; an
// immediate re-read returns a transcript that's missing the assistant's
// final message(s). Delay the green-transition tail refresh to give the
// write a chance to land. The 30s timer will eventually pick up anything
// still in flight after this.
const GREEN_REFRESH_DELAY_MS = 750;

interface RowState {
  sessionId: string;
  status: SessionStatus;
  topic: string;
  tail: string;
  timeLabel: string;
}

interface ViewState {
  rows: RowState[];
  tailLines: number;
  empty: string | null;
}

/**
 * Webview-backed Sessions sidebar. A grid of rows: status icon, topic + tail
 * (last message excerpt, lighter shade), and a right-aligned time. The
 * tail is clamped to a configurable number of lines via CSS
 * `-webkit-line-clamp` (`takeshicc.sessions.tailLines`, default 2).
 *
 * Two refresh paths:
 *   - **fast path** (hook events): re-derive status/time from cached
 *     session list + cached tails. No disk I/O.
 *   - **slow path** (tracker changes, 30s timer, config change): force a
 *     fresh `listSessions` and re-read tail JSONLs for any session whose
 *     `lastModified` advanced.
 */
export class SessionsWebviewViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = 'takeshicc.sessions';

  private view: vscode.WebviewView | undefined;
  private readonly tailCache: TailCache;
  private readonly subs: vscode.Disposable[] = [];
  private slowTimer: NodeJS.Timeout | undefined;
  private delayedSlowTimer: NodeJS.Timeout | undefined;
  private pushQueued = false;
  private slowQueued = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: SessionService,
    tracker: TerminalTracker,
    private readonly hookStates: HookStateMachine,
    workspaceRoot: string | undefined,
    private readonly openSessionCommand: string,
    private readonly log: vscode.OutputChannel
  ) {
    this.tailCache = new TailCache(workspaceRoot, log);
    this.subs.push(
      tracker.onDidChange(() => {
        this.log.appendLine('sessions: tracker change → scheduleRefresh(slow=true)');
        this.scheduleRefresh(true);
      }),
      // Status icon updates immediately via the fast path. On a "green"
      // transition (Stop / StopFailure / idle_prompt) the assistant just
      // wrote new content, but Claude's JSONL flush often lags the hook
      // by a few hundred ms — so *also* schedule a delayed slow refresh
      // to re-read the tail once the write has landed.
      hookStates.onDidChange((state) => {
        const turnedGreen =
          state?.status === 'idle' || state?.status === 'awaiting_input';
        this.log.appendLine(
          `sessions: hook change status=${state?.status ?? 'cleared'} ` +
            `session=${state ? state.sessionId.slice(0, 8) : '-'} → ` +
            `scheduleRefresh(slow=false)${turnedGreen ? ' + delayed slow' : ''}`
        );
        this.scheduleRefresh(false);
        if (turnedGreen) this.scheduleDelayedSlowRefresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('takeshicc.sessions.tailLines')) {
          this.log.appendLine('sessions: tailLines config change → scheduleRefresh(slow=true)');
          this.scheduleRefresh(true);
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'open' && typeof msg.sessionId === 'string') {
        void vscode.commands.executeCommand(this.openSessionCommand, msg.sessionId);
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      if (this.slowTimer) {
        clearInterval(this.slowTimer);
        this.slowTimer = undefined;
      }
    });

    void this.pushState(true);
    if (!this.slowTimer) {
      this.slowTimer = setInterval(() => void this.pushState(true), SLOW_TICK_MS);
    }
  }

  /** Public entry — forces a slow refresh (matches the old TreeView refresh). */
  async refresh(): Promise<void> {
    await this.pushState(true);
  }

  /**
   * Coalesce a burst of incoming events into a single pushState. Hook events
   * can come in clumps (UserPromptSubmit + PreToolUse + Notification within
   * milliseconds); each would otherwise queue its own pushState. The slow
   * flag is sticky for the current burst — if *any* event in the burst asks
   * for slow, we honor it.
   */
  private scheduleRefresh(slow: boolean): void {
    if (slow) this.slowQueued = true;
    if (this.pushQueued) {
      this.log.appendLine(`sessions: scheduleRefresh coalesced slow=${slow} slowQueued=${this.slowQueued}`);
      return;
    }
    this.pushQueued = true;
    queueMicrotask(() => {
      const wasSlow = this.slowQueued;
      this.pushQueued = false;
      this.slowQueued = false;
      void this.pushState(wasSlow);
    });
  }

  /**
   * Defer a slow refresh by ~750ms so the JSONL flush that lags Claude's
   * Stop hook has time to land before we re-read. Subsequent green
   * transitions reset the timer — multiple Stops in flight collapse to a
   * single delayed re-read.
   */
  private scheduleDelayedSlowRefresh(): void {
    if (this.delayedSlowTimer) clearTimeout(this.delayedSlowTimer);
    this.delayedSlowTimer = setTimeout(() => {
      this.delayedSlowTimer = undefined;
      this.log.appendLine('sessions: delayed slow refresh firing (post-green)');
      this.scheduleRefresh(true);
    }, GREEN_REFRESH_DELAY_MS);
  }

  private async pushState(slow: boolean): Promise<void> {
    const view = this.view;
    if (!view) return;
    const tailLines = readTailLines();
    const t0 = Date.now();
    const sessions = await this.service.list(slow);
    const listMs = Date.now() - t0;
    this.log.appendLine(
      `sessions: pushState slow=${slow} list=${sessions.length} listMs=${listMs} tailLines=${tailLines}`
    );
    const sorted = sessions.slice().sort((a, b) => b.lastModified - a.lastModified);
    const rows: RowState[] = [];
    for (const s of sorted) {
      const topic =
        s.customTitle?.trim() || s.summary?.trim() || s.sessionId.slice(0, 8);
      const hook = this.hookStates.get(s.sessionId);
      const status: SessionStatus = hook ? mapHookStatus(hook.status) : 'inactive';
      // Fast path = cacheOnly. The status icon may change every hook
      // event, but we only re-read tails on slow paths (delayed-from-green,
      // tracker change, 30s timer, config change). Avoids the
      // partial-flush flicker right after a Stop hook.
      const tail = await this.tailCache.get(s.sessionId, s.lastModified, tailLines, !slow);
      rows.push({
        sessionId: s.sessionId,
        status,
        topic,
        tail,
        timeLabel: formatRelativeTime(s.lastModified),
      });
    }
    const state: ViewState = {
      rows,
      tailLines,
      empty: rows.length === 0 ? 'No sessions yet' : null,
    };
    void view.webview.postMessage({ type: 'state', state });
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    if (this.slowTimer) {
      clearInterval(this.slowTimer);
      this.slowTimer = undefined;
    }
    if (this.delayedSlowTimer) {
      clearTimeout(this.delayedSlowTimer);
      this.delayedSlowTimer = undefined;
    }
  }
}

function readTailLines(): number {
  return vscode.workspace
    .getConfiguration('takeshicc.sessions')
    .get<number>('tailLines', 2);
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = randomNonce();
  const csp =
    `default-src 'none'; ` +
    `style-src 'nonce-${nonce}'; ` +
    `script-src 'nonce-${nonce}'; ` +
    `img-src ${webview.cspSource} data:;`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  body { padding: 4px 0; }
  .empty {
    padding: 8px 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .row {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr) auto;
    column-gap: 8px;
    align-items: start;
    padding: 6px 12px;
    cursor: pointer;
    user-select: none;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .status {
    width: 10px;
    height: 10px;
    margin-top: 4px;
    box-sizing: border-box;
  }
  .status.awaiting {
    background: var(--vscode-charts-green, #89d185);
    border-radius: 50%;
  }
  .status.awaiting_permission {
    background: var(--vscode-charts-yellow, #cca700);
    border-radius: 50%;
  }
  .status.busy {
    border: 2px solid var(--vscode-charts-orange, #d18616);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .col-mid { min-width: 0; }
  .topic {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tail {
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
    margin-top: 2px;
  }
  .tail-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tail:empty { display: none; }
  .time {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    white-space: nowrap;
    margin-top: 1px;
  }
</style>
</head>
<body>
<div id="list" role="list"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');

  function render(state) {
    list.innerHTML = '';
    if (!state.rows.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = state.empty || 'No sessions';
      list.appendChild(e);
      return;
    }
    for (const r of state.rows) {
      const row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      row.dataset.sessionId = r.sessionId;

      const status = document.createElement('div');
      status.className = 'status ' + r.status;
      row.appendChild(status);

      const mid = document.createElement('div');
      mid.className = 'col-mid';
      const topic = document.createElement('div');
      topic.className = 'topic';
      topic.textContent = r.topic;
      mid.appendChild(topic);
      if (r.tail && state.tailLines > 0) {
        const tail = document.createElement('div');
        tail.className = 'tail';
        for (const line of r.tail.split('\\n')) {
          const lineEl = document.createElement('div');
          lineEl.className = 'tail-line';
          lineEl.textContent = line;
          tail.appendChild(lineEl);
        }
        mid.appendChild(tail);
      }
      row.appendChild(mid);

      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = r.timeLabel;
      row.appendChild(time);

      const open = () => vscode.postMessage({ type: 'open', sessionId: r.sessionId });
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });

      list.appendChild(row);
    }
  }

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (data && data.type === 'state') render(data.state);
  });
</script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let n = '';
  for (let i = 0; i < 32; i++) {
    n += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return n;
}
