import { execFile } from 'node:child_process';
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
   * Create a new worktree at `dir` with a new branch `name` based on `baseBranch`.
   * Throws on git failure (e.g. branch exists, dir exists).
   */
  async create(params: {
    name: string;
    baseBranch: string;
    dir: string;
  }): Promise<void> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace open');
    }
    const { name, baseBranch, dir } = params;
    if (!name.trim()) throw new Error('Branch name is required');
    if (!dir.trim()) throw new Error('Worktree directory is required');
    if (!baseBranch.trim()) throw new Error('Base branch is required');

    this.log?.appendLine(
      `worktrees: create name=${name} base=${baseBranch} dir=${dir}`
    );
    try {
      await execFileP(
        'git',
        ['worktree', 'add', '-b', name, dir, baseBranch],
        { cwd: this.workspaceRoot }
      );
    } catch (err) {
      throw new Error(detailFromError(err) || 'git worktree add failed');
    }
    this.cacheAt = 0;
    this.changeEmitter.fire();
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
