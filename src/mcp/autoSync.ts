import * as path from 'path';
import * as vscode from 'vscode';
import { ContextFactory, EmbeddingNotConfiguredError } from './context';
import { indexingStates, isBusy } from './indexingState';

const DEBOUNCE_MS = 10_000;
const RETRY_BACKOFF_MS = 5_000;
// Brief grace period after activation before the catch-up sync kicks in,
// so other activation work (hook server, MCP register, sidebar) has room.
const ACTIVATION_DELAY_MS = 3_000;

// Cheap pre-filter: skip changes under these path fragments before paying
// the cost of asking the synchronizer to diff. The Context's own
// supportedExtensions / ignorePatterns will filter again at sync time, but
// short-circuiting here keeps noisy directories from waking the sync up.
const SKIP_PATH_FRAGMENTS = [
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}.git${path.sep}`,
  `${path.sep}dist${path.sep}`,
  `${path.sep}out${path.sep}`,
  `${path.sep}build${path.sep}`,
  `${path.sep}.takeshicc${path.sep}`,
  `${path.sep}.vscode-test${path.sep}`,
  `${path.sep}coverage${path.sep}`,
];

/**
 * Watch the workspace for file changes and incrementally update the index
 * by calling `Context.reindexByChange`. Behavior:
 *
 * - On activation, schedules one catch-up sync (~3s in) to absorb edits
 *   made while the window was closed (branch switch, git pull, etc).
 * - Watcher debounces ~10s; multiple changes coalesce into a single sync.
 * - Skips when an `index_codebase` or another sync is already in flight,
 *   re-arming after a short backoff.
 * - Skips when no index exists for the workspace yet — auto-sync only
 *   maintains an existing index, it doesn't create one (avoids quietly
 *   spending embedding-API tokens the first time the user enables a key).
 * - Skips when the embedding API key isn't configured (same reasoning).
 * - Honors `takeshicc.search.autoSync` (default true).
 *
 * In-flight syncs use the same `phase: 'running'` state as a manual
 * `index_codebase`, with `currentFiles` / `currentChunks` updated live —
 * file count derived from the diff (`prior + added − removed`), chunk
 * count bumped by the LanceDB insert / delete hook. On success we write
 * a fresh `completed` snapshot with the new totals so both code paths
 * leave the state map in identical shape.
 */
export class AutoSync implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private pending = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly factory: ContextFactory,
    private readonly log: vscode.OutputChannel
  ) {
    if (!isEnabled()) {
      this.log.appendLine('autoSync: disabled by takeshicc.search.autoSync');
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.fsPath === workspaceRoot
    );
    if (!folder) {
      this.log.appendLine(
        `autoSync: workspaceRoot ${workspaceRoot} not in workspaceFolders, skipping`
      );
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.scheduleIfRelevant(uri.fsPath)),
      watcher.onDidChange((uri) => this.scheduleIfRelevant(uri.fsPath)),
      watcher.onDidDelete((uri) => this.scheduleIfRelevant(uri.fsPath))
    );

    this.log.appendLine(`autoSync: watching ${workspaceRoot}`);

    // Catch up on edits made while the extension was inactive (window
    // closed, branch switch, git pull). Same guards as the watcher path —
    // bails if no index exists or no API key is configured.
    this.pending = true;
    this.scheduleFlush(ACTIVATION_DELAY_MS);
  }

  private scheduleIfRelevant(filePath: string): void {
    if (SKIP_PATH_FRAGMENTS.some((fragment) => filePath.includes(fragment))) return;
    this.pending = true;
    this.scheduleFlush(DEBOUNCE_MS);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delayMs);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (!this.pending) return;
    this.pending = false;

    if (isBusy(this.workspaceRoot)) {
      // Don't race with index_codebase or a previous sync — re-arm.
      this.pending = true;
      this.scheduleFlush(RETRY_BACKOFF_MS);
      return;
    }

    let context;
    try {
      context = this.factory.get();
    } catch (err) {
      // No embedding key configured — silently skip; auto-sync isn't
      // supposed to nag the user about API setup.
      if (err instanceof EmbeddingNotConfiguredError) return;
      this.log.appendLine(`autoSync: factory failed — ${(err as Error).message}`);
      return;
    }

    try {
      const exists = await context.hasIndex(this.workspaceRoot);
      if (!exists) {
        // No index yet — don't auto-create one. The user runs index_codebase
        // first to opt in to embedding-API spend.
        return;
      }

      // Seed running state from the prior completed snapshot so live
      // counts decrement / increment from a real baseline instead of zero.
      // On cold activation there's no in-memory baseline — pull
      // authoritative counts off disk so a no-op sync doesn't overwrite
      // the state with `{ 0, 0 }`.
      let prior = indexingStates.get(this.workspaceRoot);
      let priorFiles = 0;
      let priorChunks = 0;
      if (prior?.phase === 'completed') {
        priorFiles = prior.indexedFiles;
        priorChunks = prior.totalChunks;
      } else {
        const counts = await this.factory.getDiskCounts(this.workspaceRoot);
        if (counts) {
          priorFiles = counts.files;
          priorChunks = counts.chunks;
          prior = {
            phase: 'completed',
            finishedAt: Date.now(),
            indexedFiles: counts.files,
            totalChunks: counts.chunks,
            status: 'completed',
          };
          indexingStates.set(this.workspaceRoot, prior);
        }
      }
      const startedAt = Date.now();
      this.log.appendLine(`autoSync: starting ${this.workspaceRoot}`);
      indexingStates.set(this.workspaceRoot, {
        phase: 'running',
        startedAt,
        progress: { phase: 'syncing', current: 0, total: 0, percentage: 0 },
        currentFiles: priorFiles,
        currentChunks: priorChunks,
      });
      const result = await context.reindexByChange(this.workspaceRoot, (progress) => {
        const cur = indexingStates.get(this.workspaceRoot);
        const currentChunks = cur?.phase === 'running' ? cur.currentChunks : priorChunks;
        const currentFiles = cur?.phase === 'running' ? cur.currentFiles : priorFiles;
        indexingStates.set(this.workspaceRoot, {
          phase: 'running',
          startedAt,
          progress,
          currentFiles,
          currentChunks,
        });
      });
      const finishedAt = Date.now();
      const finalFiles = priorFiles + result.added - result.removed;
      const cur = indexingStates.get(this.workspaceRoot);
      const finalChunks = cur?.phase === 'running' ? cur.currentChunks : priorChunks;
      indexingStates.set(this.workspaceRoot, {
        phase: 'completed',
        finishedAt,
        indexedFiles: finalFiles,
        totalChunks: finalChunks,
        status: 'completed',
      });
      this.log.appendLine(
        `autoSync: completed ${this.workspaceRoot} in ${finishedAt - startedAt}ms — ` +
          `+${result.added} ~${result.modified} -${result.removed} (now ${finalFiles} files, ${finalChunks} chunks)`
      );
    } catch (err) {
      const message = (err as Error).message;
      this.log.appendLine(`autoSync: FAILED ${this.workspaceRoot} — ${message}`);
      indexingStates.set(this.workspaceRoot, {
        phase: 'failed',
        finishedAt: Date.now(),
        error: message,
      });
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('takeshicc.search')
    .get<boolean>('autoSync', true);
}
