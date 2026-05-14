import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

const execFileP = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree. */
  path: string;
  /** Short branch name, or null if the worktree is detached. */
  branch: string | null;
  /** True if this is the main worktree (the original clone). */
  isMain: boolean;
}

export interface WorktreeRepo {
  /** Absolute path to the main worktree (the original clone). */
  repoRoot: string;
  /** All worktrees, including the main one. */
  worktrees: Worktree[];
  /** Local branches available as a base for a new worktree. */
  branches: string[];
  /** Branch currently checked out in the workspace, if any. */
  currentBranch: string | null;
}

export class WorktreeService {
  private readonly changeEmitter: vscode.EventEmitter<void>;
  readonly onDidChange: vscode.Event<void>;
  private cache: WorktreeRepo | null = null;
  private cacheAt = 0;
  private readonly CACHE_MS = 5_000;

  constructor(
    private readonly workspaceRoot: string | undefined,
    eventEmitter: vscode.EventEmitter<void>,
    private readonly log?: vscode.OutputChannel
  ) {
    this.changeEmitter = eventEmitter;
    this.onDidChange = eventEmitter.event;
  }

  /**
   * Returns full repo state for the workspace. Returns null if the workspace
   * isn't a git repository (or git isn't installed). Cached for ~5s so a burst
   * of hook events doesn't spawn a fresh `git` subprocess per event.
   */
  async getRepo(force = false): Promise<WorktreeRepo | null> {
    const now = Date.now();
    if (!force && now - this.cacheAt < this.CACHE_MS) return this.cache;
    this.cache = await this.fetchRepo();
    this.cacheAt = now;
    return this.cache;
  }

  private async fetchRepo(): Promise<WorktreeRepo | null> {
    if (!this.workspaceRoot) return null;
    let repoRoot: string;
    try {
      const { stdout } = await execFileP(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: this.workspaceRoot }
      );
      repoRoot = stdout.trim().replace(/\//g, path.sep);
    } catch (err) {
      this.log?.appendLine(`worktrees: not a git repo — ${(err as Error).message}`);
      return null;
    }

    const [worktrees, branches, currentBranch] = await Promise.all([
      this.listWorktrees(repoRoot),
      this.listBranches(repoRoot),
      this.getCurrentBranch(repoRoot),
    ]);
    return { repoRoot, worktrees, branches, currentBranch };
  }

  private async listWorktrees(repoRoot: string): Promise<Worktree[]> {
    const { stdout } = await execFileP(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: repoRoot }
    );
    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> = {};
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        current = { path: normalize(line.slice('worktree '.length)) };
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        current.branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        current.branch = null;
      } else if (line === '') {
        if (current.path) {
          worktrees.push({
            path: current.path,
            branch: current.branch ?? null,
            isMain: worktrees.length === 0,
          });
        }
        current = {};
      }
    }
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
        isMain: worktrees.length === 0,
      });
    }
    return worktrees;
  }

  private async listBranches(repoRoot: string): Promise<string[]> {
    const { stdout } = await execFileP(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { cwd: repoRoot }
    );
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private async getCurrentBranch(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: repoRoot }
      );
      const ref = stdout.trim();
      return ref === 'HEAD' ? null : ref;
    } catch {
      return null;
    }
  }

  /**
   * Create a worktree at `dir`. If `name` is empty it defaults to `baseBranch`,
   * which is always an existing branch — so the worktree checks out that
   * branch directly. Otherwise: if `name` matches an existing local branch,
   * check it out (`baseBranch` is ignored — git won't let two branches share
   * a name); else create a new branch `name` off `baseBranch`.
   *
   * Returns the resolved branch name (the input `name` trimmed, or `baseBranch`
   * if `name` was empty) so callers can feed it to {@link runBootstrap}.
   *
   * Throws on git failure (e.g. dir exists, branch already checked out elsewhere).
   */
  async create(params: {
    name: string;
    baseBranch: string;
    dir: string;
  }): Promise<{ branch: string }> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace open');
    }
    const { baseBranch, dir } = params;
    if (!dir.trim()) throw new Error('Worktree directory is required');
    if (!baseBranch.trim()) throw new Error('Base branch is required');

    const name = params.name.trim() || baseBranch;
    const repo = await this.getRepo();
    const branchExists = repo?.branches.includes(name) ?? false;
    const args = branchExists
      ? ['worktree', 'add', dir, name]
      : ['worktree', 'add', '-b', name, dir, baseBranch];

    this.log?.appendLine(
      `worktrees: create name=${name} base=${baseBranch} dir=${dir} ` +
        `mode=${branchExists ? 'checkout-existing' : 'new-branch'}`
    );
    try {
      await execFileP('git', args, { cwd: this.workspaceRoot });
    } catch (err) {
      throw new Error(detailFromError(err) || 'git worktree add failed');
    }
    this.cacheAt = 0;
    this.changeEmitter.fire();
    return { branch: name };
  }

  /**
   * Run `command` (post-substitution) in `dir` via the system shell. Intended
   * for the per-worktree bootstrap step — kept separate from {@link create}
   * so callers can run it async after the create-worktree modal has closed.
   * Throws with a short summary including the last few output lines on
   * non-zero exit; otherwise resolves silently. Output streams to `log`.
   */
  async runBootstrap(params: {
    command: string;
    dir: string;
    newBranch: string;
    baseBranch: string;
  }): Promise<void> {
    const tpl = params.command.trim();
    if (!tpl) return;
    const command = substituteTemplate(tpl, {
      new_branch: params.newBranch,
      worktree_path: params.dir,
      base_branch: params.baseBranch,
    });
    this.log?.appendLine(`worktrees: bootstrap (cwd=${params.dir}) → ${command}`);
    await runShellCommand(command, params.dir, this.log);
  }

  /**
   * Remove a worktree directory and (if `branch` is provided) delete its
   * local branch. `force=true` adds `--force` to `worktree remove` so
   * uncommitted changes / untracked files are discarded. The branch delete
   * always uses `-D` — we assume a squash-merge workflow where feature
   * branches are never "fully merged" by git's reachability check.
   *
   * If the worktree directory is already gone (manual delete, prior partial
   * removal), the missing path is treated as success and we run
   * `git worktree prune` to clean stale metadata before deleting the branch.
   */
  async remove(params: {
    path: string;
    branch: string | null;
    force: boolean;
  }): Promise<void> {
    if (!this.workspaceRoot) throw new Error('No workspace open');
    const { path: wtPath, branch, force } = params;
    if (!wtPath.trim()) throw new Error('Worktree path is required');

    this.log?.appendLine(
      `worktrees: remove path=${wtPath} branch=${branch ?? '-'} force=${force}`
    );

    const exists = await pathExists(wtPath);
    if (exists) {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(wtPath);
      try {
        await execFileP('git', args, { cwd: this.workspaceRoot });
      } catch (err) {
        throw new Error(detailFromError(err) || 'git worktree remove failed');
      }
    } else {
      // Stale metadata may still reference the path — clean it before the
      // branch delete so git doesn't complain that the branch is checked out
      // in a worktree.
      await execFileP('git', ['worktree', 'prune'], {
        cwd: this.workspaceRoot,
      }).catch(() => undefined);
    }

    if (branch) {
      // Always -D: squash-merge workflows leave the feature branch's commits
      // unreachable from main, so `git branch -d` would refuse even after the
      // PR has landed. The worktree directory is gone by this point anyway.
      try {
        await execFileP('git', ['branch', '-D', branch], {
          cwd: this.workspaceRoot,
        });
      } catch (err) {
        const detail = detailFromError(err);
        throw new Error(
          'Worktree removed; branch delete failed' +
            (detail ? ': ' + detail : '')
        );
      }
    }

    this.cacheAt = 0;
    this.changeEmitter.fire();
  }

  /** Notify listeners that worktrees may have changed (e.g. after manual refresh). */
  notifyChanged(): void {
    this.cacheAt = 0;
    this.changeEmitter.fire();
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function detailFromError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  return (e.stderr || e.message || '').trim();
}

function normalize(p: string): string {
  return path.normalize(p.trim());
}

/**
 * Replace `{name}` placeholders with values from `vars`. `{{` and `}}` escape
 * literal braces. Unknown placeholders are left intact so the failure surfaces
 * in the shell rather than silently producing an empty string.
 */
export function substituteTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, key) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
  });
}

/**
 * Run `command` via the system shell (cmd.exe on Windows, /bin/sh on Unix),
 * streaming stdout/stderr line-by-line to `log`. Resolves on exit code 0,
 * rejects with a short summary otherwise. Captured stderr is included in
 * the rejection message so the caller can show it to the user.
 *
 * Uses `spawn(..., { shell: true })` rather than `exec()` so we resolve on
 * the child's `exit` event (process terminated) rather than `close` (all
 * stdio handles closed) — on Windows, handle closure can lag the actual
 * process exit by tens of seconds when an AV/Defender scan is in progress
 * on the spawned binary, leaving the user staring at a "still running"
 * lock for a `sleep 5` that already terminated.
 */
function runShellCommand(
  command: string,
  cwd: string,
  log: vscode.OutputChannel | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    log?.appendLine(`worktrees: spawn t=0ms`);
    const child = spawn(command, { cwd, shell: true });
    const tail: string[] = [];
    const pushTail = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > 10) tail.shift();
        log?.appendLine(`worktrees:   ${line}`);
      }
    };
    child.stdout?.on('data', (d) => pushTail(String(d)));
    child.stderr?.on('data', (d) => pushTail(String(d)));
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      log?.appendLine(`worktrees: spawn error t=${Date.now() - t0}ms — ${err.message}`);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      log?.appendLine(
        `worktrees: child exit t=${Date.now() - t0}ms code=${code} signal=${signal ?? '-'}`
      );
      if (code === 0) {
        resolve();
        return;
      }
      const reason =
        signal != null
          ? `terminated by signal ${signal}`
          : `exited with code ${code}`;
      const summary = tail.slice(-5).join(' | ');
      reject(new Error(summary ? `${reason} — ${summary}` : reason));
    });
  });
}
