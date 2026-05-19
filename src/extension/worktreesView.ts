import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errMsg } from '../common/errMsg';
import { COMMANDS } from './commands';
import {
  canonicalizePath,
  parseWorktreeList,
  type GitMetadata,
  type WorktreeListEntry,
} from '../common/gitUtils';
import {
  type LiveChat,
  type LiveChatsMessage,
  type InstanceEventsMessage,
  MISSING_WORKTREE_FIELDS_ERROR,
  type WorktreeJob,
  type WorktreeJobsMessage,
} from '../common/protocol';
import type {
  InstanceEventsStream,
  LiveChatsStream,
  ServerClient,
  WorktreeJobsStream,
} from './ServerClient';

// Base reconnect delay for the active-jobs stream while the view is alive;
// backs off exponentially up to the max so a server that can't be reached
// doesn't spin a tight wake loop.
const STREAM_RECONNECT_MS = 2_000;
const STREAM_RECONNECT_MAX_MS = 30_000;
// Coalesces list refreshes triggered by SSE events (each refresh shells out to
// git).
const REFRESH_COALESCE_MS = 300;

interface WorktreeEntry extends WorktreeListEntry {
  registered?: boolean;
  // The worktree exists on disk but its bootstrap command is still running
  // (a server job is in flight for this path).
  bootstrapping?: boolean;
  // The server has accepted a deletion job for this path.
  deleting?: boolean;
}

interface WorktreesState {
  worktrees: WorktreeEntry[];
  branches: string[];
  currentBranch?: string;
  groupId: string;
  worktreePrefix: string;
  liveChats: LiveChat[];
  error?: string;
}

type OutboundMessage =
  | { type: 'state'; state: WorktreesState }
  | { type: 'liveChats'; chats: LiveChat[] }
  | { type: 'createStarted' }
  | { type: 'createResult'; ok: boolean; error?: string }
  | { type: 'createDetached' }
  | { type: 'deleteStarted' }
  | { type: 'deleteResult'; ok: boolean; error?: string }
  | { type: 'deleteCancelled' }
  | { type: 'openResult'; ok: false; error: string };

interface CreateWorktreeMessage {
  type: 'create';
  branchName: string;
  baseBranch: string;
  worktreePath: string;
}

interface OpenWorktreeMessage {
  type: 'open';
  worktreePath: string;
}

interface DeleteWorktreeMessage {
  type: 'delete';
  worktreePath: string;
  // The row's displayed label, shown in the confirm dialog. The server
  // re-derives the branch authoritatively before deleting.
  label: string;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | CreateWorktreeMessage
  | OpenWorktreeMessage
  | DeleteWorktreeMessage;

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseBranches(stdout: string): string[] {
  return Array.from(
    new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => {
          const [branch, symref = ''] = line.trimEnd().split(' ');
          return symref.length === 0 ? branch : '';
        })
        .filter((branch) => branch.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(`~${path.sep}`.length));
  }
  return inputPath;
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export class WorktreesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'takeshicc.worktreesView';

  private view?: vscode.WebviewView;

  // Persistent SSE subscriptions and their lifecycle. `streamStopped` gates
  // (re)connection so a disposed view stops reconnecting.
  private jobStream?: WorktreeJobsStream;
  private instanceStream?: InstanceEventsStream;
  private chatStream?: LiveChatsStream;
  private jobReconnectTimer?: NodeJS.Timeout;
  private instanceReconnectTimer?: NodeJS.Timeout;
  private chatReconnectTimer?: NodeJS.Timeout;
  private jobReconnectAttempts = 0;
  private instanceReconnectAttempts = 0;
  private chatReconnectAttempts = 0;
  private refreshTimer?: NodeJS.Timeout;
  private streamStopped = true;
  // The job the create form is currently showing as in-progress.
  private currentJobId?: string;
  // Canonical paths of worktrees whose server job is still in flight, derived
  // from the /worktree-jobs stream. `refresh()` flags matching list rows so
  // every window shows a spinner while a worktree bootstraps.
  private bootstrappingPaths = new Set<string>();
  private deletingPaths = new Set<string>();
  // Canonical paths of worktrees with a live VS Code window, derived from the
  // /instance-events stream.
  private registeredPaths = new Set<string>();
  private currentDeleteJobIds = new Set<string>();
  private liveChats: LiveChat[] = [];

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly getServerClient: () => ServerClient | undefined,
    private readonly gitMetadata: GitMetadata,
    private readonly groupId: string,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.streamStopped = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      this.streamStopped = true;
      this.jobStream?.stop();
      this.instanceStream?.stop();
      this.chatStream?.stop();
      this.jobStream = undefined;
      this.instanceStream = undefined;
      this.chatStream = undefined;
      if (this.jobReconnectTimer) {
        clearTimeout(this.jobReconnectTimer);
        this.jobReconnectTimer = undefined;
      }
      if (this.instanceReconnectTimer) {
        clearTimeout(this.instanceReconnectTimer);
        this.instanceReconnectTimer = undefined;
      }
      if (this.chatReconnectTimer) {
        clearTimeout(this.chatReconnectTimer);
        this.chatReconnectTimer = undefined;
      }
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.refresh();
      this.ensureEventStreams();
      // The webview was (re)created empty; if a create is still in flight,
      // show it as in-progress again (completion arrives via the stream).
      if (this.currentJobId) {
        void this.post({ type: 'createStarted' });
      }
      return;
    }

    if (message.type === 'refresh') {
      await this.refresh();
      this.ensureEventStreams();
      return;
    }

    if (message.type === 'create') {
      await this.createWorktree(message);
      return;
    }

    if (message.type === 'open') {
      await this.openWorktree(message.worktreePath);
      return;
    }

    if (message.type === 'delete') {
      await this.deleteWorktree(message.worktreePath, message.label);
    }
  }

  private ensureEventStreams(): void {
    this.ensureJobStream();
    this.ensureInstanceStream();
    this.ensureChatStream();
  }

  private ensureJobStream(): void {
    if (this.streamStopped || this.jobStream) {
      return;
    }
    const serverClient = this.getServerClient();
    if (!serverClient) {
      this.scheduleJobStreamReconnect();
      return;
    }
    const handle = serverClient.streamWorktreeJobs((message) => this.onJobStreamMessage(message));
    this.jobStream = handle;
    handle.done
      .catch(() => undefined)
      .finally(() => {
        if (this.jobStream === handle) {
          this.jobStream = undefined;
        }
        this.scheduleJobStreamReconnect();
      });
  }

  private ensureInstanceStream(): void {
    if (this.streamStopped || this.instanceStream) {
      return;
    }
    const serverClient = this.getServerClient();
    if (!serverClient) {
      this.scheduleInstanceStreamReconnect();
      return;
    }
    const handle = serverClient.streamInstanceEvents((message) =>
      this.onInstanceStreamMessage(message),
    );
    this.instanceStream = handle;
    handle.done
      .catch(() => undefined)
      .finally(() => {
        if (this.instanceStream === handle) {
          this.instanceStream = undefined;
        }
        this.scheduleInstanceStreamReconnect();
      });
  }

  private ensureChatStream(): void {
    if (this.streamStopped || this.chatStream) {
      return;
    }
    const serverClient = this.getServerClient();
    if (!serverClient) {
      this.scheduleChatStreamReconnect();
      return;
    }
    const handle = serverClient.streamLiveChats((message) => this.onChatStreamMessage(message));
    this.chatStream = handle;
    handle.done
      .catch(() => undefined)
      .finally(() => {
        if (this.chatStream === handle) {
          this.chatStream = undefined;
        }
        this.scheduleChatStreamReconnect();
      });
  }

  private scheduleJobStreamReconnect(): void {
    if (this.streamStopped || this.jobReconnectTimer) {
      return;
    }
    const delay = Math.min(
      STREAM_RECONNECT_MS * 2 ** this.jobReconnectAttempts,
      STREAM_RECONNECT_MAX_MS,
    );
    this.jobReconnectAttempts++;
    this.jobReconnectTimer = setTimeout(() => {
      this.jobReconnectTimer = undefined;
      this.ensureJobStream();
    }, delay);
    this.jobReconnectTimer.unref?.();
  }

  private scheduleInstanceStreamReconnect(): void {
    if (this.streamStopped || this.instanceReconnectTimer) {
      return;
    }
    const delay = Math.min(
      STREAM_RECONNECT_MS * 2 ** this.instanceReconnectAttempts,
      STREAM_RECONNECT_MAX_MS,
    );
    this.instanceReconnectAttempts++;
    this.instanceReconnectTimer = setTimeout(() => {
      this.instanceReconnectTimer = undefined;
      this.ensureInstanceStream();
    }, delay);
    this.instanceReconnectTimer.unref?.();
  }

  private scheduleChatStreamReconnect(): void {
    if (this.streamStopped || this.chatReconnectTimer) {
      return;
    }
    const delay = Math.min(
      STREAM_RECONNECT_MS * 2 ** this.chatReconnectAttempts,
      STREAM_RECONNECT_MAX_MS,
    );
    this.chatReconnectAttempts++;
    this.chatReconnectTimer = setTimeout(() => {
      this.chatReconnectTimer = undefined;
      this.ensureChatStream();
    }, delay);
    this.chatReconnectTimer.unref?.();
  }

  // Coalesces list refreshes that fan out from SSE events. A refresh shells out
  // to two git commands, and every subscriber sees every job/instance event.
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_COALESCE_MS);
    this.refreshTimer.unref?.();
  }

  private onInstanceStreamMessage(message: InstanceEventsMessage): void {
    this.instanceReconnectAttempts = 0;

    if (message.type === 'snapshot') {
      this.registeredPaths = new Set(
        message.instances.map((instance) => canonicalizePath(instance.worktreePath)),
      );
    } else if (message.type === 'registered') {
      this.registeredPaths.add(canonicalizePath(message.instance.worktreePath));
    } else {
      this.registeredPaths.delete(canonicalizePath(message.instance.worktreePath));
    }
    this.scheduleRefresh();
  }

  private onJobStreamMessage(message: WorktreeJobsMessage): void {
    // Any frame proves a healthy connection — reset the reconnect backoff.
    this.jobReconnectAttempts = 0;

    if (message.type === 'snapshot') {
      // Authoritative set of in-flight worktrees (covers a reconnect that
      // missed `created`/`done` frames). Refresh so rows pick up / drop the
      // spinner accordingly.
      this.bootstrappingPaths = new Set(
        message.jobs
          .filter((job) => job.operation === 'create')
          .map((job) => canonicalizePath(job.worktreePath)),
      );
      this.deletingPaths = new Set(
        message.jobs
          .filter((job) => job.operation === 'delete')
          .map((job) => canonicalizePath(job.worktreePath)),
      );
      this.scheduleRefresh();
      this.adoptFromSnapshot(message.jobs);
      return;
    }

    if (message.type === 'created') {
      // `git worktree add` landed the worktree (possibly from a sibling
      // window); its bootstrap is still running. List it now, flagged
      // in-progress, on every window.
      this.bootstrappingPaths.add(canonicalizePath(message.worktreePath));
      this.scheduleRefresh();
      return;
    }

    if (message.type === 'deleting') {
      this.deletingPaths.add(canonicalizePath(message.worktreePath));
      this.scheduleRefresh();
      return;
    }

    // message.type === 'done' — the create (incl. bootstrap) or delete job
    // finished; clear its spinner and refresh to reflect the final state.
    if (message.operation === 'create') {
      this.bootstrappingPaths.delete(canonicalizePath(message.worktreePath));
    } else {
      this.deletingPaths.delete(canonicalizePath(message.worktreePath));
    }
    this.scheduleRefresh();
    if (message.operation === 'delete') {
      if (!this.currentDeleteJobIds.delete(message.jobId)) {
        return;
      }
      if (message.status === 'ok') {
        void this.post({ type: 'deleteResult', ok: true });
      } else {
        void this.post({ type: 'deleteResult', ok: false, error: message.error });
        this.notifyDeleteFailure(message.error);
      }
      return;
    }

    if (message.jobId !== this.currentJobId) {
      return;
    }
    this.currentJobId = undefined;
    if (message.status === 'ok') {
      void this.post({ type: 'createResult', ok: true });
    } else {
      void this.post({ type: 'createResult', ok: false, error: message.error });
      this.notifyCreateFailure(message.error);
    }
  }

  private onChatStreamMessage(message: LiveChatsMessage): void {
    this.chatReconnectAttempts = 0;

    if (message.type === 'snapshot') {
      this.liveChats = message.chats;
    } else {
      const next = this.liveChats.filter((chat) => chat.chatId !== message.chat.chatId);
      next.push(message.chat);
      this.liveChats = next.sort((a, b) => a.chatId.localeCompare(b.chatId));
    }
    void this.post({ type: 'liveChats', chats: this.liveChats });
  }

  private adoptFromSnapshot(jobs: WorktreeJob[]): void {
    const jobIds = jobs.map((job) => job.jobId);
    if (this.currentJobId) {
      if (jobIds.includes(this.currentJobId)) {
        // Still running — re-show progress (a stream reconnect or a webview
        // that lost its state).
        void this.post({ type: 'createStarted' });
        return;
      }
      // It finished while we were disconnected, so we missed the result. The
      // list refresh (scheduled by the snapshot handler) shows whatever
      // landed; detail is in the server log.
      this.currentJobId = undefined;
      void this.post({ type: 'createDetached' });
      return;
    }

    // No tracked job (fresh host / reload): adopt the most recent active one
    // so its progress shows after a reload.
    const running = [...jobs].reverse().find((job) => job.operation === 'create')?.jobId;
    if (running) {
      this.currentJobId = running;
      void this.post({ type: 'createStarted' });
    }
  }

  // Bootstrap output is not streamed; on failure point the user at the server
  // log, which has the full git/bootstrap output.
  private notifyCreateFailure(error: string): void {
    this.log.appendLine(`Takeshicc: could not create worktree — ${error}`);
    void vscode.window
      .showErrorMessage(`Takeshicc: could not create worktree — ${error}`, 'Open Server Log')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand(COMMANDS.openServerLog);
        }
      });
  }

  private notifyDeleteFailure(error: string): void {
    this.log.appendLine(`Takeshicc: could not delete worktree — ${error}`);
    void vscode.window
      .showErrorMessage(`Takeshicc: could not delete worktree — ${error}`, 'Open Server Log')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand(COMMANDS.openServerLog);
        }
      });
  }

  private async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const myWorktreePath = this.gitMetadata.worktreePath;

    try {
      const [worktreesStdout, branchesStdout] = await Promise.all([
        runGit(['worktree', 'list', '--porcelain'], myWorktreePath),
        runGit(
          ['for-each-ref', '--format=%(refname:short) %(symref)', 'refs/heads', 'refs/remotes'],
          myWorktreePath,
        ),
      ]);
      // gitMetadata.worktreePath is already canonical (resolveGitMetadata).
      const worktrees = parseWorktreeList(worktreesStdout)
        .map((worktree) => ({ worktree, canonical: canonicalizePath(worktree.path) }))
        .filter(({ canonical }) => canonical !== myWorktreePath)
        .map(({ worktree, canonical }) => ({
          ...worktree,
          registered: this.registeredPaths.has(canonical),
          bootstrapping: this.bootstrappingPaths.has(canonical),
          deleting: this.deletingPaths.has(canonical),
        }));

      await this.postState({
        worktrees,
        branches: parseBranches(branchesStdout),
        currentBranch: this.gitMetadata.currentBranch,
        groupId: this.groupId,
        worktreePrefix: this.worktreePrefix(),
        liveChats: this.liveChats,
      });
    } catch (err) {
      await this.postState({
        worktrees: [],
        branches: [],
        currentBranch: this.gitMetadata.currentBranch,
        groupId: this.groupId,
        worktreePrefix: this.worktreePrefix(),
        liveChats: this.liveChats,
        error: this.fail('Could not load worktrees', err),
      });
    }
  }

  private worktreePrefix(): string {
    return vscode.workspace
      .getConfiguration('takeshicc')
      .get<string>('worktreePrefix', '~/worktrees')
      .trim();
  }

  private worktreeBootstrapCommand(): string {
    return vscode.workspace
      .getConfiguration('takeshicc')
      .get<string>('worktreeBootstrapCommand', '')
      .trim();
  }

  private async createWorktree(message: CreateWorktreeMessage): Promise<void> {
    if (!this.view) {
      return;
    }

    const branchName = message.branchName.trim();
    const baseBranch = message.baseBranch.trim();
    const inputPath = message.worktreePath.trim();
    if (!branchName || !baseBranch || !inputPath) {
      await this.post({
        type: 'createResult',
        ok: false,
        error: MISSING_WORKTREE_FIELDS_ERROR,
      });
      return;
    }

    const myWorktreePath = this.gitMetadata.worktreePath;

    try {
      const serverClient = this.getServerClient();
      if (!serverClient) {
        throw new Error('Takeshicc server is not connected.');
      }

      const expandedPath = expandHome(inputPath);
      const resolvedPath = path.isAbsolute(expandedPath)
        ? expandedPath
        : path.resolve(path.dirname(myWorktreePath), expandedPath);

      const jobId = await serverClient.createWorktree({
        branchName,
        baseBranch,
        worktreePath: resolvedPath,
        bootstrapCommand: this.worktreeBootstrapCommand(),
      });
      // Completion arrives over the persistent /worktree-jobs stream
      // (onJobStreamMessage), so this returns once the job is started.
      this.currentJobId = jobId;
      this.ensureEventStreams();
      await this.post({ type: 'createStarted' });
    } catch (err) {
      await this.post({
        type: 'createResult',
        ok: false,
        error: this.fail('Could not create worktree', err),
      });
    }
  }

  private async openWorktree(worktreePath: string): Promise<void> {
    if (!worktreePath) {
      return;
    }

    try {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
        forceNewWindow: true,
      });
    } catch (err) {
      await this.post({
        type: 'openResult',
        ok: false,
        error: this.fail('Could not open worktree', err),
      });
    }
  }

  private async deleteWorktree(worktreePath: string, label: string): Promise<void> {
    if (!worktreePath) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete worktree "${label}" and its branch? This cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      await this.post({ type: 'deleteCancelled' });
      return;
    }

    try {
      const serverClient = this.getServerClient();
      if (!serverClient) {
        throw new Error('Takeshicc server is not connected.');
      }
      if (this.registeredPaths.has(canonicalizePath(worktreePath))) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
          forceNewWindow: true,
        });
      }
      const jobId = await serverClient.deleteWorktree({ worktreePath });
      this.currentDeleteJobIds.add(jobId);
      this.deletingPaths.add(canonicalizePath(worktreePath));
      this.ensureEventStreams();
      this.scheduleRefresh();
      await this.post({ type: 'deleteStarted' });
    } catch (err) {
      await this.post({
        type: 'deleteResult',
        ok: false,
        error: this.fail('Could not delete worktree', err),
      });
    }
  }

  private async postState(state: WorktreesState): Promise<void> {
    await this.post({ type: 'state', state });
  }

  private async post(message: OutboundMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  // Logs the failure and returns the user-facing message to surface in the UI.
  private fail(context: string, err: unknown): string {
    const message = `${context}: ${errMsg(err)}`;
    this.log.appendLine(`Takeshicc: ${message}`);
    return message;
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
      --gap: 12px;
      --border: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      --modal-top: 0px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: var(--gap);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    button,
    input {
      font: inherit;
    }

    .primary-button,
    .secondary-button {
      width: 100%;
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 5px 10px;
      cursor: pointer;
    }

    .primary-button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .primary-button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .current-worktree {
      position: relative;
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      z-index: 2;
    }

    .current-worktree-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
    }

    .current-worktree-branch {
      min-width: 0;
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .live-chats {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }

    .live-chats-title {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .live-chat-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .live-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 24px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 6px;
      background: var(--vscode-sideBar-background);
    }

    .live-chat-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }

    .live-chat-state {
      min-width: 42px;
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 10px;
      line-height: 16px;
      text-align: center;
      text-transform: uppercase;
    }

    .live-chat-state.idle {
      color: var(--vscode-testing-iconPassed, #73c991);
      background: rgba(115, 201, 145, 0.14);
    }

    .live-chat-state.busy {
      color: var(--vscode-testing-iconQueued, #cca700);
      background: rgba(204, 167, 0, 0.16);
    }

    .secondary-button {
      width: auto;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .secondary-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .modal {
      position: fixed;
      inset: var(--modal-top) 0 0;
      display: none;
      align-items: stretch;
      justify-content: stretch;
      background: rgba(0, 0, 0, 0.42);
      padding: 10px;
      z-index: 1;
    }

    .modal.open {
      display: flex;
    }

    .dialog {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      overflow: hidden;
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }

    .dialog-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }

    .icon-button {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-icon-foreground);
      background: transparent;
      cursor: pointer;
    }

    .icon-button:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .dialog-body {
      display: grid;
      grid-template-rows: minmax(120px, 1fr) auto;
      gap: 14px;
      min-height: 0;
      padding: 12px;
      overflow: auto;
    }

    /* Fills its grid track and lets the list (not the whole body) scroll, so
       a long worktree list never bleeds into the create form below. */
    .worktrees-section {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .section-title {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-sideBarTitle-foreground);
      text-transform: uppercase;
    }

    .worktree-search {
      margin-bottom: 8px;
    }

    .worktree-list {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      margin: 0;
      padding: 0;
      list-style: none;
      overflow-y: auto;
    }

    .worktree-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 28px;
      gap: 0;
      align-items: stretch;
    }

    .worktree-row.deleting {
      pointer-events: none;
    }

    .worktree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px 0 0 6px;
      padding: 8px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      text-align: left;
      cursor: pointer;
    }

    .worktree-item:disabled,
    .delete-worktree:disabled {
      cursor: default;
      opacity: 0.7;
    }

    .worktree-item:not(:disabled):hover {
      background: var(--vscode-list-hoverBackground);
    }

    .worktree-item:not(:disabled):focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .worktree-branch {
      min-width: 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .registered-indicator {
      flex: 0 0 auto;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed, #73c991);
      box-shadow: 0 0 0 2px rgba(115, 201, 145, 0.22);
    }

    .bootstrapping-spinner {
      flex: 0 0 auto;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    .delete-worktree {
      align-self: stretch;
      width: 28px;
      height: auto;
      border: 1px solid var(--border);
      border-left: 0;
      border-radius: 0 6px 6px 0;
      background: var(--vscode-sideBar-background);
    }

    .delete-worktree:not(:disabled):hover {
      color: var(--vscode-errorForeground);
      background: var(--vscode-list-hoverBackground);
    }

    .delete-worktree:disabled:hover,
    .worktree-row.deleting .worktree-item,
    .worktree-row.deleting .delete-worktree {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      outline: none;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .muted {
      color: var(--vscode-descriptionForeground);
    }

    .form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    input {
      width: 100%;
      min-height: 28px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 4px 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .select {
      position: relative;
    }

    .select-button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-height: 28px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 4px 6px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      text-align: left;
      cursor: pointer;
    }

    .select-button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .select-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .select-caret {
      flex: 0 0 auto;
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--vscode-descriptionForeground);
      transition: transform 80ms ease;
    }

    .select.open .select-caret {
      transform: rotate(180deg);
    }

    .select-list {
      position: absolute;
      top: calc(100% - 1px);
      left: 0;
      right: 0;
      display: none;
      max-height: 160px;
      margin: 0;
      padding: 2px 0;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 0 0 4px 4px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.24);
      list-style: none;
      overflow-y: auto;
      z-index: 2;
    }

    .select.open .select-button {
      border-radius: 4px 4px 0 0;
    }

    .select.open .select-list {
      display: block;
    }

    /* The popup is absolutely positioned and so clipped by the modal's
       overflow ancestors. Opened from the bottom-anchored form it would land
       in that clipped region (reachable only by scrolling the whole body);
       flipping it above the button keeps it inside the visible dialog. */
    .select.drop-up .select-list {
      top: auto;
      bottom: calc(100% - 1px);
      border-radius: 4px 4px 0 0;
    }

    .select.drop-up.open .select-button {
      border-radius: 0 0 4px 4px;
    }

    .select-option {
      width: 100%;
      border: 0;
      border-radius: 0;
      padding: 5px 8px;
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
      overflow-wrap: anywhere;
    }

    .select-option:hover,
    .select-option:focus {
      color: var(--vscode-list-hoverForeground, var(--vscode-dropdown-foreground));
      background: var(--vscode-list-hoverBackground);
      outline: none;
    }

    .status {
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }

    .status.error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div id="currentWorktree" class="current-worktree" aria-label="Current worktree branch">
    <div class="current-worktree-label">Branch</div>
    <div id="currentBranch" class="current-worktree-branch">Loading...</div>
  </div>
  <section class="live-chats" aria-labelledby="liveChatsTitle">
    <h2 id="liveChatsTitle" class="live-chats-title">Live chats</h2>
    <ul id="liveChats" class="live-chat-list"></ul>
  </section>
  <button id="open" class="primary-button" type="button">Worktrees</button>

  <div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="title">
    <div class="dialog">
      <header class="dialog-header">
        <h1 id="title" class="dialog-title">Worktrees</h1>
        <button id="close" class="icon-button" type="button" aria-label="Close">x</button>
      </header>
      <main class="dialog-body">
        <section class="worktrees-section">
          <h2 class="section-title">List of worktrees</h2>
          <label class="worktree-search">
            Search worktrees
            <input id="worktreeSearch" type="search" autocomplete="off">
          </label>
          <ul id="worktrees" class="worktree-list"></ul>
        </section>
        <section>
          <h2 class="section-title">Create worktree</h2>
          <form id="form" class="form">
            <label>
              New branch name
              <input id="branchName" name="branchName" autocomplete="off" required>
            </label>
            <label>
              Base branch
              <div id="branchSelect" class="select">
                <button
                  id="branchSelectButton"
                  class="select-button"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                >
                  <span id="branchSelectValue" class="select-value">Select branch</span>
                  <span class="select-caret" aria-hidden="true"></span>
                </button>
                <ul id="branchOptions" class="select-list" role="listbox"></ul>
              </div>
              <input id="baseBranch" name="baseBranch" type="hidden" required>
            </label>
            <label>
              Worktree path
              <input id="worktreePath" name="worktreePath" autocomplete="off" required>
            </label>
            <button id="create" class="primary-button" type="submit">Create</button>
            <div id="status" class="status" role="status"></div>
          </form>
        </section>
      </main>
    </div>
  </div>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const openButton = document.getElementById('open');
    const currentWorktree = document.getElementById('currentWorktree');
    const currentBranchLabel = document.getElementById('currentBranch');
    const liveChatsList = document.getElementById('liveChats');
    const closeButton = document.getElementById('close');
    const modal = document.getElementById('modal');
    const form = document.getElementById('form');
    const createButton = document.getElementById('create');
    const worktreeSearch = document.getElementById('worktreeSearch');
    const worktrees = document.getElementById('worktrees');
    const branchSelect = document.getElementById('branchSelect');
    const branchSelectButton = document.getElementById('branchSelectButton');
    const branchSelectValue = document.getElementById('branchSelectValue');
    const branchOptions = document.getElementById('branchOptions');
    const branchName = document.getElementById('branchName');
    const baseBranch = document.getElementById('baseBranch');
    const worktreePath = document.getElementById('worktreePath');
    const status = document.getElementById('status');
    let allWorktrees = [];
    let worktreesError = '';
    let availableBranches = [];
    let currentBranch = '';
    let groupId = '';
    let worktreePrefix = '';
    let liveChats = [];
    let worktreePathWasManual = false;
    let isUpdatingWorktreePath = false;

    function setStatus(message, isError = false) {
      status.textContent = message || '';
      status.classList.toggle('error', isError);
    }

    function setBusy(isBusy) {
      createButton.disabled = isBusy;
      createButton.textContent = isBusy ? 'Creating...' : 'Create';
    }

    function currentBranchText() {
      return currentBranch || 'Detached HEAD';
    }

    function updateModalTop() {
      const rect = currentWorktree.getBoundingClientRect();
      document.documentElement.style.setProperty('--modal-top', Math.ceil(rect.bottom + 8) + 'px');
    }

    function openModal() {
      updateModalTop();
      modal.classList.add('open');
      requestAnimationFrame(() => worktreeSearch.focus());
      setStatus('Loading...');
      vscode.postMessage({ type: 'refresh' });
    }

    function closeModal() {
      modal.classList.remove('open');
      closeBranchSelect();
    }

    function openBranchSelect() {
      // Popup max-height (160) + its border/padding. If it won't fit below
      // but there's more room above, open upward so the modal's overflow
      // doesn't clip it.
      const POPUP_HEIGHT = 168;
      const rect = branchSelectButton.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropUp = spaceBelow < POPUP_HEIGHT && rect.top > spaceBelow;
      branchSelect.classList.toggle('drop-up', dropUp);
      branchSelect.classList.add('open');
      branchSelectButton.setAttribute('aria-expanded', 'true');
    }

    function closeBranchSelect() {
      branchSelect.classList.remove('open');
      branchSelectButton.setAttribute('aria-expanded', 'false');
    }

    function setBaseBranch(branch) {
      baseBranch.value = branch;
      branchSelectValue.textContent = branch || 'Select branch';
      closeBranchSelect();
    }

    function joinPathParts(parts) {
      return parts
        .filter((part) => part.length > 0)
        .map((part, index) =>
          index === 0 ? part.replace(/[\\\\/]+$/, '') : part.replace(/^[\\\\/]+|[\\\\/]+$/g, ''),
        )
        .join('/');
    }

    function defaultWorktreePath() {
      const newBranchName = branchName.value.trim();
      if (!newBranchName) {
        return '';
      }
      return joinPathParts([worktreePrefix, groupId, newBranchName]);
    }

    function setWorktreePath(value) {
      isUpdatingWorktreePath = true;
      worktreePath.value = value;
      isUpdatingWorktreePath = false;
    }

    function updateAutomaticWorktreePath() {
      if (!branchName.value.trim()) {
        worktreePathWasManual = false;
        setWorktreePath('');
        return;
      }
      if (!worktreePathWasManual) {
        setWorktreePath(defaultWorktreePath());
      }
    }

    function worktreeLabel(item) {
      if (item.bare) return 'Bare repository';
      if (item.detached) return 'Detached HEAD';
      return item.branch || 'Unknown branch';
    }

    function matchesWorktreeQuery(item, query) {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (!normalizedQuery) {
        return true;
      }

      return worktreeLabel(item).toLocaleLowerCase().includes(normalizedQuery);
    }

    function renderWorktrees() {
      worktrees.textContent = '';
      const query = worktreeSearch.value;
      const visibleWorktrees = allWorktrees.filter((item) => matchesWorktreeQuery(item, query));

      if (allWorktrees.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = worktreesError || 'No worktrees found.';
        worktrees.appendChild(empty);
        return;
      }

      if (visibleWorktrees.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'No worktrees match your search.';
        worktrees.appendChild(empty);
        return;
      }

      for (const item of visibleWorktrees) {
        const listItem = document.createElement('li');
        listItem.className = 'worktree-row';
        listItem.classList.toggle('deleting', Boolean(item.deleting));
        const row = document.createElement('button');
        row.className = 'worktree-item';
        row.type = 'button';
        row.title = item.path;
        row.disabled = Boolean(item.deleting);
        row.addEventListener('click', () => {
          closeModal();
          vscode.postMessage({ type: 'open', worktreePath: item.path });
        });

        const branch = document.createElement('div');
        branch.className = 'worktree-branch';
        branch.textContent = worktreeLabel(item);

        row.append(branch);
        if (item.bootstrapping || item.deleting) {
          const spinner = document.createElement('span');
          spinner.className = 'bootstrapping-spinner';
          spinner.title = item.deleting ? 'Deleting' : 'Bootstrapping';
          spinner.setAttribute('aria-label', item.deleting ? 'Deleting' : 'Bootstrapping');
          spinner.setAttribute('role', 'status');
          row.appendChild(spinner);
        }
        if (item.registered) {
          const indicator = document.createElement('span');
          indicator.className = 'registered-indicator';
          indicator.title = 'Registered';
          indicator.setAttribute('aria-label', 'Registered');
          row.appendChild(indicator);
        }

        const deleteButton = document.createElement('button');
        deleteButton.className = 'icon-button delete-worktree';
        deleteButton.type = 'button';
        deleteButton.textContent = '×';
        deleteButton.title = 'Delete worktree';
        deleteButton.setAttribute('aria-label', 'Delete worktree');
        deleteButton.disabled = Boolean(item.bootstrapping || item.deleting);
        deleteButton.addEventListener('click', () => {
          vscode.postMessage({
            type: 'delete',
            worktreePath: item.path,
            label: worktreeLabel(item),
          });
        });

        listItem.append(row, deleteButton);
        worktrees.appendChild(listItem);
      }
    }

    function renderLiveChats() {
      liveChatsList.textContent = '';

      if (liveChats.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'No live chats.';
        liveChatsList.appendChild(empty);
        return;
      }

      for (const chat of liveChats) {
        const row = document.createElement('li');
        row.className = 'live-chat-row';
        row.title = chat.chatId;

        const id = document.createElement('span');
        id.className = 'live-chat-id';
        id.textContent = chat.chatId;

        const state = document.createElement('span');
        state.className = 'live-chat-state ' + chat.state;
        state.textContent = chat.state;

        row.append(id, state);
        liveChatsList.appendChild(row);
      }
    }

    function renderState(state) {
      branchOptions.textContent = '';
      allWorktrees = state.worktrees;
      worktreesError = state.error || '';
      availableBranches = state.branches;
      currentBranch = state.currentBranch || '';
      liveChats = state.liveChats || [];
      currentBranchLabel.textContent = currentBranchText();
      currentBranchLabel.title = currentBranchText();
      updateModalTop();
      groupId = state.groupId || '';
      worktreePrefix = state.worktreePrefix || '';
      updateAutomaticWorktreePath();

      for (const branch of state.branches) {
        const option = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'select-option';
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.textContent = branch;
        button.addEventListener('click', () => setBaseBranch(branch));
        option.appendChild(button);
        branchOptions.appendChild(option);
      }

      if (!state.branches.includes(baseBranch.value)) {
        const defaultBranch = state.branches.includes(currentBranch)
          ? currentBranch
          : state.branches[0] || '';
        setBaseBranch(defaultBranch);
      }

      renderWorktrees();
      renderLiveChats();

      setBusy(false);
      setStatus(state.error || '');
    }

    openButton.addEventListener('click', openModal);
    closeButton.addEventListener('click', closeModal);
    window.addEventListener('resize', updateModalTop);
    new ResizeObserver(updateModalTop).observe(currentWorktree);
    worktreeSearch.addEventListener('input', renderWorktrees);
    branchName.addEventListener('input', updateAutomaticWorktreePath);
    worktreePath.addEventListener('input', () => {
      if (!isUpdatingWorktreePath) {
        worktreePathWasManual = true;
      }
    });
    branchSelectButton.addEventListener('click', () => {
      if (branchSelect.classList.contains('open')) {
        closeBranchSelect();
      } else {
        openBranchSelect();
      }
    });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });
    document.addEventListener('click', (event) => {
      if (!branchSelect.contains(event.target)) {
        closeBranchSelect();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (branchSelect.classList.contains('open')) {
          closeBranchSelect();
        } else {
          closeModal();
        }
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setBusy(true);
      setStatus('Creating...');
      vscode.postMessage({
        type: 'create',
        branchName: document.getElementById('branchName').value,
        baseBranch: document.getElementById('baseBranch').value,
        worktreePath: worktreePath.value,
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        renderState(message.state);
      }
      if (message.type === 'liveChats') {
        liveChats = message.chats || [];
        renderLiveChats();
      }
      if (message.type === 'createStarted') {
        setBusy(true);
        setStatus('Creating worktree...');
      }
      if (message.type === 'createResult') {
        setBusy(false);
        if (message.ok) {
          form.reset();
          worktreePathWasManual = false;
          updateAutomaticWorktreePath();
          setBaseBranch(
            availableBranches.includes(currentBranch) ? currentBranch : availableBranches[0] || '',
          );
          setStatus('Worktree created.');
        } else {
          setStatus(message.error, true);
        }
      }
      if (message.type === 'createDetached') {
        setBusy(false);
        setStatus('Stopped tracking the worktree job; the list has been refreshed.');
      }
      if (message.type === 'openResult' && !message.ok) {
        setStatus(message.error, true);
      }
      if (message.type === 'deleteStarted') {
        setStatus('Deleting worktree...');
      }
      if (message.type === 'deleteResult') {
        if (message.ok) {
          setStatus('Worktree deleted.');
        } else {
          setStatus(message.error, true);
        }
      }
      if (message.type === 'deleteCancelled') {
        setStatus('');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
