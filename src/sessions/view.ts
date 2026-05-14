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
    if (m.type === 'deleteWorktree') {
      const params = m as { path?: unknown; branch?: unknown; force?: unknown };
      if (typeof params.path === 'string') {
        void this.handleDeleteWorktree(
          params.path,
          typeof params.branch === 'string' ? params.branch : null,
          params.force === true
        );
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

  private async handleDeleteWorktree(
    p: string,
    branch: string | null,
    force: boolean
  ): Promise<void> {
    const view = this.view;
    try {
      await this.worktrees.remove({ path: p, branch, force });
      this.log.appendLine(`sessions: deleteWorktree OK path=${p}`);
      view?.webview.postMessage({ type: 'deleteWorktreeResult', ok: true });
      // If the deleted worktree was selected, fall back to whatever pushState
      // picks (typically the main worktree).
      if (this.state.getSelectedWorktree() === p) {
        this.state.setSelectedWorktree('');
      }
      await this.pushState(true);
    } catch (err) {
      const message = (err as Error).message;
      this.log.appendLine(`sessions: deleteWorktree FAILED — ${message}`);
      view?.webview.postMessage({
        type: 'deleteWorktreeResult',
        ok: false,
        error: message,
      });
    }
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
  .header .spacer { flex: 0 0 4px; }
  .header select {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    padding: 2px 4px;
    font: inherit;
    border-radius: 2px;
  }
  .header select[disabled] { opacity: 0.4; }
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
    width: min(360px, calc(100% - 24px));
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
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
  <button id="btn-create-worktree" title="Create Worktree" aria-label="Create Worktree">⎘</button>
  <span class="spacer"></span>
  <select id="worktree-select" title="Worktree"></select>
  <button id="btn-delete-worktree" title="Delete Worktree" aria-label="Delete Worktree">🗑</button>
</div>
<div id="list" class="list" role="list"></div>
<div id="modal-backdrop" class="modal-backdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <h2 id="modal-title">Create Worktree</h2>
    <label for="wt-name">New branch name (leave empty to check out base)</label>
    <input id="wt-name" type="text" autocomplete="off" spellcheck="false" />
    <label for="wt-base">Base branch</label>
    <select id="wt-base"></select>
    <label for="wt-dir">Worktree directory</label>
    <input id="wt-dir" type="text" autocomplete="off" spellcheck="false" />
    <div id="wt-error" class="error" role="alert"></div>
    <div class="actions">
      <button id="wt-cancel">Cancel</button>
      <button id="wt-create" class="primary">Create</button>
    </div>
  </div>
</div>
<div id="del-backdrop" class="modal-backdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="del-title">
    <h2 id="del-title">Delete Worktree</h2>
    <div id="del-summary" style="font-size: 0.9em; color: var(--vscode-descriptionForeground); word-break: break-all;"></div>
    <div id="del-error" class="error" role="alert"></div>
    <div class="actions">
      <button id="del-cancel">Cancel</button>
      <button id="del-confirm" class="primary">Delete</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const btnNewChat = document.getElementById('btn-new-chat');
  const btnCreateWt = document.getElementById('btn-create-worktree');
  const btnDeleteWt = document.getElementById('btn-delete-worktree');
  const wtSelect = document.getElementById('worktree-select');
  const modal = document.getElementById('modal-backdrop');
  const wtName = document.getElementById('wt-name');
  const wtBase = document.getElementById('wt-base');
  const wtDir = document.getElementById('wt-dir');
  const wtError = document.getElementById('wt-error');
  const wtCancel = document.getElementById('wt-cancel');
  const wtCreate = document.getElementById('wt-create');
  const delModal = document.getElementById('del-backdrop');
  const delSummary = document.getElementById('del-summary');
  const delError = document.getElementById('del-error');
  const delCancel = document.getElementById('del-cancel');
  const delConfirm = document.getElementById('del-confirm');
  /** Worktree being deleted; populated when the delete modal opens. */
  let delTarget = null;
  /** True once a non-force delete has failed — the next click runs with force. */
  let delForce = false;

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

  function renderHeader(state) {
    wtSelect.innerHTML = '';
    if (!state.hasRepo || state.worktrees.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = state.hasRepo ? 'No worktrees' : 'Not a git repo';
      wtSelect.appendChild(opt);
      wtSelect.disabled = true;
      btnCreateWt.disabled = !state.hasRepo;
      btnDeleteWt.disabled = true;
      return;
    }
    for (const w of state.worktrees) {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = w.label;
      if (w.path === state.selectedWorktree) opt.selected = true;
      wtSelect.appendChild(opt);
    }
    wtSelect.disabled = false;
    btnCreateWt.disabled = false;
    // You can't delete the main worktree (git refuses) — disable the button.
    const sel = state.worktrees.find((w) => w.path === state.selectedWorktree);
    btnDeleteWt.disabled = !sel || sel.isMain;
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

  function openModal() {
    if (!lastState.hasRepo) return;
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

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => wtName.focus(), 0);
  }

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function openDeleteModal() {
    const sel = (lastState.worktrees || []).find(
      (w) => w.path === lastState.selectedWorktree
    );
    if (!sel || sel.isMain) return;
    delTarget = sel;
    delForce = false;
    delError.textContent = '';
    delConfirm.textContent = 'Delete';
    delConfirm.disabled = false;
    const branchPart = sel.branch ? ' (branch: ' + sel.branch + ')' : '';
    delSummary.textContent =
      'Remove ' + sel.path + branchPart + '. The branch will also be deleted.';
    delModal.classList.add('open');
    delModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => delCancel.focus(), 0);
  }

  function closeDeleteModal() {
    delModal.classList.remove('open');
    delModal.setAttribute('aria-hidden', 'true');
    delTarget = null;
  }

  btnNewChat.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  btnCreateWt.addEventListener('click', openModal);
  btnDeleteWt.addEventListener('click', openDeleteModal);
  wtSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'selectWorktree', path: wtSelect.value });
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
    else if (delModal.classList.contains('open')) { ev.preventDefault(); closeDeleteModal(); }
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

  delCancel.addEventListener('click', closeDeleteModal);
  delModal.addEventListener('click', (ev) => {
    if (ev.target === delModal) closeDeleteModal();
  });
  delConfirm.addEventListener('click', () => {
    if (!delTarget) return;
    delError.textContent = '';
    delConfirm.disabled = true;
    vscode.postMessage({
      type: 'deleteWorktree',
      path: delTarget.path,
      branch: delTarget.branch,
      force: delForce,
    });
  });

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data) return;
    if (data.type === 'state') render(data.state);
    else if (data.type === 'createWorktreeResult') {
      if (data.ok) {
        closeModal();
      } else {
        wtError.textContent = data.error || 'Failed to create worktree';
        wtCreate.disabled = false;
      }
    }
    else if (data.type === 'deleteWorktreeResult') {
      if (data.ok) {
        closeDeleteModal();
      } else {
        delError.textContent = data.error || 'Failed to delete worktree';
        // Promote subsequent attempt to a force delete so the user can
        // override uncommitted changes / unmerged branches with one click.
        delForce = true;
        delConfirm.textContent = 'Force Delete';
        delConfirm.disabled = false;
      }
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
