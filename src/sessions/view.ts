import * as vscode from 'vscode';
import { SessionService } from './service';
import { TerminalTracker } from '../terminals';
import { HookStateMachine } from '../hooks/stateMachine';
import { mapHookStatus, type SessionStatus } from './statusResolver';
import { formatRelativeTime } from './time';
import { TailCache } from './tail';
import type { WorktreeService, Worktree } from '../worktrees/service';

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
  branch: string | null;
  tail: string;
  timeLabel: string;
}

interface WorktreeOption {
  path: string;
  label: string;
  branch: string | null;
  isMain: boolean;
}

interface ViewState {
  rows: RowState[];
  tailLines: number;
  empty: string | null;
  worktrees: WorktreeOption[];
  selectedWorktree: string | null;
  branches: string[];
  defaultBase: string | null;
  parentDir: string | null;
  hasRepo: boolean;
}

/**
 * Webview-backed Sessions sidebar. A header bar with [new chat] [create
 * worktree] [worktree dropdown], followed by a grid of session rows. The
 * worktree dropdown selection controls which directory `claude` is spawned
 * in when New Chat is pressed — both via this button and the global
 * `takeshicc.newChat` command.
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
    private readonly workspaceRoot: string | undefined,
    private readonly openSessionCommand: string,
    private readonly worktrees: WorktreeService,
    private readonly state: {
      getSelectedWorktree(): string;
      setSelectedWorktree(p: string): void;
    },
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
      this.worktrees.onDidChange(() => {
        this.log.appendLine('sessions: worktrees change → scheduleRefresh(slow=true)');
        this.scheduleRefresh(true);
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
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
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

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'open' && typeof (m as { sessionId?: unknown }).sessionId === 'string') {
      void vscode.commands.executeCommand(
        this.openSessionCommand,
        (m as { sessionId: string }).sessionId
      );
      return;
    }
    if (m.type === 'newChat') {
      void vscode.commands.executeCommand('takeshicc.newChat');
      return;
    }
    if (m.type === 'selectWorktree' && typeof (m as { path?: unknown }).path === 'string') {
      const p = (m as { path: string }).path;
      this.log.appendLine(`sessions: selectWorktree → ${p}`);
      this.state.setSelectedWorktree(p);
      this.scheduleRefresh(false);
      return;
    }
    if (m.type === 'createWorktree') {
      const params = m as { name?: unknown; baseBranch?: unknown; dir?: unknown };
      if (
        typeof params.name === 'string' &&
        typeof params.baseBranch === 'string' &&
        typeof params.dir === 'string'
      ) {
        void this.handleCreateWorktree(params.name, params.baseBranch, params.dir);
      }
      return;
    }
    if (m.type === 'deleteWorktrees') {
      const params = m as { items?: unknown; force?: unknown };
      if (Array.isArray(params.items)) {
        const items: { path: string; branch: string | null }[] = [];
        for (const raw of params.items) {
          if (raw && typeof raw === 'object') {
            const it = raw as { path?: unknown; branch?: unknown };
            if (typeof it.path === 'string') {
              items.push({
                path: it.path,
                branch: typeof it.branch === 'string' ? it.branch : null,
              });
            }
          }
        }
        void this.handleDeleteWorktrees(items, params.force === true);
      }
      return;
    }
    if (m.type === 'refreshWorktrees') {
      this.scheduleRefresh(true);
      return;
    }
  }

  private async handleCreateWorktree(
    name: string,
    baseBranch: string,
    dir: string
  ): Promise<void> {
    const view = this.view;
    try {
      await this.worktrees.create({ name, baseBranch, dir });
      this.log.appendLine(`sessions: createWorktree OK name=${name}`);
      view?.webview.postMessage({ type: 'createWorktreeResult', ok: true, path: dir });
      this.state.setSelectedWorktree(dir);
      await this.pushState(true);
    } catch (err) {
      const message = (err as Error).message;
      this.log.appendLine(`sessions: createWorktree FAILED — ${message}`);
      view?.webview.postMessage({
        type: 'createWorktreeResult',
        ok: false,
        error: message,
      });
    }
  }

  private async handleDeleteWorktrees(
    items: { path: string; branch: string | null }[],
    force: boolean
  ): Promise<void> {
    const view = this.view;
    const succeeded: string[] = [];
    const failures: { path: string; error: string }[] = [];
    for (const it of items) {
      try {
        await this.worktrees.remove({ path: it.path, branch: it.branch, force });
        succeeded.push(it.path);
        this.log.appendLine(`sessions: deleteWorktree OK path=${it.path}`);
      } catch (err) {
        const message = (err as Error).message;
        this.log.appendLine(`sessions: deleteWorktree FAILED path=${it.path} — ${message}`);
        failures.push({ path: it.path, error: message });
      }
    }
    if (succeeded.length && succeeded.includes(this.state.getSelectedWorktree())) {
      this.state.setSelectedWorktree('');
    }
    view?.webview.postMessage({
      type: 'deleteWorktreesResult',
      succeeded,
      failures,
    });
    if (succeeded.length) await this.pushState(true);
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
    const [sessions, repo] = await Promise.all([
      this.service.list(slow),
      this.worktrees.getRepo(slow),
    ]);
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
        branch: s.gitBranch?.trim() || null,
        tail,
        timeLabel: formatRelativeTime(s.lastModified),
      });
    }

    const worktreeOpts: WorktreeOption[] = (repo?.worktrees ?? []).map((w) =>
      toOption(w, repo?.repoRoot)
    );
    const selected = this.state.getSelectedWorktree();
    const state: ViewState = {
      rows,
      tailLines,
      empty: rows.length === 0 ? 'No sessions yet' : null,
      worktrees: worktreeOpts,
      selectedWorktree: worktreeOpts.some((w) => w.path === selected)
        ? selected
        : (worktreeOpts[0]?.path ?? null),
      branches: repo?.branches ?? [],
      defaultBase: repo?.currentBranch ?? null,
      parentDir: repo ? parentOf(repo.repoRoot) : null,
      hasRepo: !!repo,
    };
    // Reconcile: if the previously-selected worktree disappeared, fall back
    // to the new selection so subsequent commands see a valid path.
    if (state.selectedWorktree && state.selectedWorktree !== selected) {
      this.state.setSelectedWorktree(state.selectedWorktree);
    }
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

function toOption(w: Worktree, repoRoot: string | undefined): WorktreeOption {
  const base = w.isMain
    ? (repoRoot ? basename(repoRoot) : basename(w.path))
    : basename(w.path);
  const branchSuffix = w.branch ? ` (${w.branch})` : ' (detached)';
  return {
    path: w.path,
    label: base + branchSuffix,
    branch: w.branch,
    isMain: w.isMain,
  };
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx === -1 ? norm : norm.slice(0, idx);
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
  body { padding: 0; }
  .header {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  .header button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    padding: 3px 6px;
    cursor: pointer;
    font: inherit;
    border-radius: 3px;
    line-height: 1;
  }
  .header button:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .header button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .header button[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .header #btn-worktree {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    padding: 2px 6px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .header #btn-worktree .wt-label {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .header #btn-worktree .wt-caret {
    flex: 0 0 auto;
    opacity: 0.7;
  }
  .list { padding: 4px 0; }
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
  .branch {
    font-size: 0.85em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 1px;
  }
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

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: none;
    z-index: 10;
  }
  .modal-backdrop.open { display: flex; align-items: flex-start; justify-content: center; }
  .modal {
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder));
    border-radius: 4px;
    padding: 12px;
    margin-top: 40px;
    width: min(420px, calc(100% - 24px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
  .modal hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    margin: 14px 0 4px;
  }
  .modal .section-title {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 6px 0 4px;
  }
  .modal .wt-search {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font: inherit;
    border-radius: 2px;
    margin-bottom: 8px;
  }
  .modal .wt-list {
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 2px;
    max-height: 320px;
    overflow-y: auto;
  }
  .modal .wt-list:empty::before {
    content: 'No worktrees match';
    display: block;
    padding: 8px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .wt-row {
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: 8px;
    align-items: center;
    padding: 5px 8px;
    cursor: pointer;
    user-select: none;
  }
  .wt-row:hover { background: var(--vscode-list-hoverBackground); }
  .wt-row .wt-row-label {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wt-row.selected .wt-row-label-text {
    color: var(--vscode-textLink-foreground);
    font-weight: 600;
  }
  .wt-row-delete {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    opacity: 0.55;
  }
  .wt-row:hover .wt-row-delete { opacity: 0.95; }
  .wt-row-delete:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .wt-row-delete.force {
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
    opacity: 1;
  }
  .modal .wt-expand {
    width: 100%;
    margin-top: 6px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
    padding: 4px 6px;
    cursor: pointer;
    font: inherit;
    border-radius: 2px;
  }
  .modal .wt-expand:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .modal .wt-delete-error {
    color: var(--vscode-errorForeground);
    font-size: 0.85em;
    margin-top: 6px;
    white-space: pre-wrap;
  }
  .modal h2 {
    margin: 0 0 8px;
    font-size: 1em;
    font-weight: 600;
  }
  .modal label {
    display: block;
    font-size: 0.9em;
    margin-top: 8px;
    color: var(--vscode-descriptionForeground);
  }
  .modal input, .modal select {
    width: 100%;
    box-sizing: border-box;
    margin-top: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font: inherit;
    border-radius: 2px;
  }
  .modal .error {
    color: var(--vscode-errorForeground);
    font-size: 0.85em;
    margin-top: 8px;
    white-space: pre-wrap;
    min-height: 1em;
  }
  .modal .actions {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .modal .actions button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    border-radius: 2px;
  }
  .modal .actions button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .modal .actions button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .modal .actions button[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
</head>
<body>
<div class="header" role="toolbar">
  <button id="btn-new-chat" title="New Chat" aria-label="New Chat">＋</button>
  <button id="btn-worktree" title="Worktree" aria-label="Worktree" aria-haspopup="dialog">
    <span class="wt-label">Worktree</span>
    <span class="wt-caret" aria-hidden="true">▾</span>
  </button>
</div>
<div id="list" class="list" role="list"></div>
<div id="modal-backdrop" class="modal-backdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <h2 id="modal-title">Worktree</h2>
    <input id="wt-search" class="wt-search" type="text" placeholder="Search worktrees" autocomplete="off" spellcheck="false" />
    <div id="wt-list" class="wt-list" role="list"></div>
    <button id="wt-expand" class="wt-expand" type="button" hidden></button>
    <div id="wt-delete-error" class="wt-delete-error" role="alert"></div>

    <hr />
    <div class="section-title">Create new worktree</div>
    <label for="wt-name">New branch name (leave empty to check out base)</label>
    <input id="wt-name" type="text" autocomplete="off" spellcheck="false" />
    <label for="wt-base">Base branch</label>
    <select id="wt-base"></select>
    <label for="wt-dir">Worktree directory</label>
    <input id="wt-dir" type="text" autocomplete="off" spellcheck="false" />
    <div id="wt-error" class="error" role="alert"></div>
    <div class="actions">
      <button id="wt-cancel">Close</button>
      <button id="wt-create" class="primary">Create</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const btnNewChat = document.getElementById('btn-new-chat');
  const btnWorktree = document.getElementById('btn-worktree');
  const btnWorktreeLabel = btnWorktree.querySelector('.wt-label');
  const modal = document.getElementById('modal-backdrop');
  const wtSearch = document.getElementById('wt-search');
  const wtListEl = document.getElementById('wt-list');
  const wtExpand = document.getElementById('wt-expand');
  const wtDeleteError = document.getElementById('wt-delete-error');
  const wtName = document.getElementById('wt-name');
  const wtBase = document.getElementById('wt-base');
  const wtDir = document.getElementById('wt-dir');
  const wtError = document.getElementById('wt-error');
  const wtCancel = document.getElementById('wt-cancel');
  const wtCreate = document.getElementById('wt-create');

  const LIST_CAP = 10;
  /** When true, render all matches; otherwise cap at LIST_CAP. */
  let expanded = false;
  /** Paths whose previous non-force delete failed; the next click on that row's
   *  icon retries with force=true. Cleared on success. */
  const forcePending = new Set();

  let lastState = {
    branches: [],
    defaultBase: null,
    parentDir: null,
    hasRepo: false,
    worktrees: [],
    selectedWorktree: null,
  };
  let userEditedDir = false;

  function branchColor(name) {
    // FNV-1a-ish 32-bit hash → hue in [0, 360). Saturation/lightness chosen
    // to stay legible on both light and dark VS Code themes.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const hue = h % 360;
    return 'hsl(' + hue + ', 70%, 50%)';
  }

  function joinPath(parent, name) {
    if (!parent) return name;
    const sep = parent.includes('\\\\') ? '\\\\' : '/';
    const trimmed = parent.replace(/[\\\\/]+$/, '');
    const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-');
    return trimmed + sep + safeName;
  }

  function renderRows(state) {
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
      if (r.branch) {
        const branch = document.createElement('div');
        branch.className = 'branch';
        branch.textContent = r.branch;
        branch.style.color = branchColor(r.branch);
        mid.appendChild(branch);
      }
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

  function worktreeButtonLabel(state) {
    if (!state.hasRepo) return 'Not a git repo';
    if (!state.worktrees || state.worktrees.length === 0) return 'No worktrees';
    const sel = state.worktrees.find((w) => w.path === state.selectedWorktree);
    if (!sel) return 'No worktrees';
    return sel.branch || '(detached)';
  }

  function renderHeader(state) {
    btnWorktreeLabel.textContent = worktreeButtonLabel(state);
    // The button stays enabled if there's a repo (so the user can create a
    // worktree even when none exist yet).
    btnWorktree.disabled = !state.hasRepo;
  }

  function render(state) {
    lastState = {
      branches: state.branches,
      defaultBase: state.defaultBase,
      parentDir: state.parentDir,
      hasRepo: state.hasRepo,
      worktrees: state.worktrees,
      selectedWorktree: state.selectedWorktree,
    };
    renderHeader(state);
    renderRows(state);
  }

  function filteredWorktrees() {
    const q = wtSearch.value.trim().toLowerCase();
    const all = lastState.worktrees || [];
    if (!q) return all;
    return all.filter((w) => {
      const branch = (w.branch || '').toLowerCase();
      const label = (w.label || '').toLowerCase();
      const path = (w.path || '').toLowerCase();
      return branch.includes(q) || label.includes(q) || path.includes(q);
    });
  }

  function renderWorktreeList() {
    wtListEl.innerHTML = '';
    const filtered = filteredWorktrees();
    const hiddenCount = expanded ? 0 : Math.max(0, filtered.length - LIST_CAP);
    const visible = expanded ? filtered : filtered.slice(0, LIST_CAP);

    for (const w of visible) {
      const row = document.createElement('div');
      row.className = 'wt-row';
      row.setAttribute('role', 'listitem');
      if (w.path === lastState.selectedWorktree) row.classList.add('selected');

      const label = document.createElement('div');
      label.className = 'wt-row-label';
      const labelText = document.createElement('span');
      labelText.className = 'wt-row-label-text';
      labelText.textContent = w.branch || w.label || w.path;
      label.appendChild(labelText);
      row.appendChild(label);

      if (w.isMain) {
        // Main worktree can't be deleted (git refuses) — empty cell preserves alignment.
        row.appendChild(document.createElement('span'));
      } else {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'wt-row-delete';
        del.textContent = '❌';
        const isForce = forcePending.has(w.path);
        if (isForce) del.classList.add('force');
        del.title = isForce
          ? 'Previous delete failed. Click to force delete (discards uncommitted changes).'
          : 'Delete worktree';
        del.setAttribute('aria-label', del.title);
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          triggerDelete(w);
        });
        row.appendChild(del);
      }

      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectWorktree', path: w.path });
        closeModal();
      });

      wtListEl.appendChild(row);
    }

    if (hiddenCount > 0) {
      wtExpand.hidden = false;
      wtExpand.textContent = 'Expand all (' + hiddenCount + ' more)';
    } else {
      wtExpand.hidden = true;
    }
  }

  function triggerDelete(w) {
    if (w.isMain) return;
    const force = forcePending.has(w.path);
    wtDeleteError.textContent = '';
    vscode.postMessage({
      type: 'deleteWorktrees',
      items: [{ path: w.path, branch: w.branch }],
      force,
    });
  }

  function openModal() {
    if (!lastState.hasRepo) return;
    expanded = false;
    forcePending.clear();
    wtSearch.value = '';
    wtDeleteError.textContent = '';

    userEditedDir = false;
    wtName.value = '';
    wtError.textContent = '';
    wtCreate.disabled = false;
    wtBase.innerHTML = '';
    for (const b of lastState.branches) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === lastState.defaultBase) opt.selected = true;
      wtBase.appendChild(opt);
    }
    wtDir.value = joinPath(lastState.parentDir, lastState.defaultBase || 'worktree');

    renderWorktreeList();

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => wtSearch.focus(), 0);
  }

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  btnNewChat.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  btnWorktree.addEventListener('click', openModal);

  wtSearch.addEventListener('input', () => {
    expanded = false;
    renderWorktreeList();
  });
  wtExpand.addEventListener('click', () => {
    expanded = true;
    renderWorktreeList();
  });

  function autofillDir() {
    if (userEditedDir) return;
    const base = wtName.value || wtBase.value || 'worktree';
    wtDir.value = joinPath(lastState.parentDir, base);
  }
  wtName.addEventListener('input', autofillDir);
  wtBase.addEventListener('change', autofillDir);
  wtDir.addEventListener('input', () => { userEditedDir = true; });
  wtCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (modal.classList.contains('open')) { ev.preventDefault(); closeModal(); }
  });
  wtCreate.addEventListener('click', () => {
    const name = wtName.value.trim();
    const baseBranch = wtBase.value;
    const dir = wtDir.value.trim();
    if (!dir) { wtError.textContent = 'Worktree directory is required'; return; }
    if (!baseBranch) { wtError.textContent = 'Base branch is required'; return; }
    wtError.textContent = '';
    wtCreate.disabled = true;
    vscode.postMessage({ type: 'createWorktree', name, baseBranch, dir });
  });

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data) return;
    if (data.type === 'state') {
      render(data.state);
      if (modal.classList.contains('open')) {
        // Drop force-pending entries for worktrees that disappeared.
        const valid = new Set((lastState.worktrees || []).map((w) => w.path));
        for (const p of Array.from(forcePending)) if (!valid.has(p)) forcePending.delete(p);
        renderWorktreeList();
      }
    }
    else if (data.type === 'createWorktreeResult') {
      if (data.ok) {
        closeModal();
      } else {
        wtError.textContent = data.error || 'Failed to create worktree';
        wtCreate.disabled = false;
      }
    }
    else if (data.type === 'deleteWorktreesResult') {
      for (const p of data.succeeded || []) forcePending.delete(p);
      const failures = data.failures || [];
      if (failures.length > 0) {
        for (const f of failures) forcePending.add(f.path);
        wtDeleteError.textContent = failures
          .map((f) => f.error)
          .join('\\n');
      } else {
        wtDeleteError.textContent = '';
      }
      renderWorktreeList();
    }
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
