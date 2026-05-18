// Path/git identity utilities shared by both sides. A workspace folder
// resolves to two canonical paths — its repo's *main* worktree (the shared
// group key; every linked worktree of a repo resolves to it, so they share
// one server) and *this* working tree's own root (distinct per linked
// worktree, subdirectory-proof — the per-instance identity) — and
// `groupIdFor`/`instanceIdFor` hash either into the namespaced opaque id
// that addresses it.

import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';

// Canonicalizes a filesystem path so config keys and resolved keys compare
// exactly: path.resolve, normalize separators to '/', lowercase a Windows
// drive letter. Applied identically on both sides (here and in config.ts).
export function canonicalizePath(p: string): string {
  let resolved = path.resolve(p).replace(/\\/g, '/');
  resolved = resolved.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
  return resolved;
}

// Short sha256 hex of an already-canonical path (resolveGitMetadata is the
// sole canonicalizer). Private: a bare hash collides across namespaces (a
// main-worktree instance vs its group), so ids are minted only through the
// namespaced helpers below.
function pathId(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 12);
}

export function groupIdFor(mainWorktreePath: string): string {
  return `group_${pathId(mainWorktreePath)}`;
}

export function instanceIdFor(worktreePath: string): string {
  return `instance_${pathId(worktreePath)}`;
}

export interface WorktreeListEntry {
  // Path exactly as `git worktree list --porcelain` reported it — not
  // canonicalized, since callers compare via canonicalizePath where needed.
  path: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
}

// Parses `git worktree list --porcelain` output. A blank line ends a record;
// in practice only a checked-out local branch emits `branch refs/heads/…`,
// detached emits `detached`, and the bare main worktree emits `bare`.
export function parseWorktreeList(stdout: string): WorktreeListEntry[] {
  const worktrees: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) {
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), detached: false, bare: false };
      worktrees.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }

  return worktrees;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout });
      }
    });
  });
}

export interface GitMetadata {
  // Canonical main-worktree path. Identical for the main worktree and every
  // linked worktree of the repo, so it serves as the shared group key.
  mainWorktreePath: string;
  // Canonical root of *this* working tree (linked or main), stable no matter
  // which subdirectory was opened. The per-instance identity.
  worktreePath: string;
  // Current branch for this worktree. Undefined when HEAD is detached.
  currentBranch?: string;
}

// Returns this workspace folder's GitMetadata. Throws when the path cannot be
// resolved as a non-bare git worktree.
export async function resolveGitMetadata(workspaceFolderFsPath: string): Promise<GitMetadata> {
  // One command for the required identity; the options print on consecutive
  // lines in argument order. --show-toplevel is kept last so it does not shift
  // the bare-repo guards (a bare repo prints an empty top-level, which the
  // filter drops).
  // --path-format=absolute requires git >= 2.31.
  const args = [
    '-C',
    workspaceFolderFsPath,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--is-bare-repository',
    '--show-toplevel',
  ];

  // Independent of the rev-parse parsing below, so spawn it concurrently. Kept
  // a separate process rather than folded into the rev-parse: `rev-parse
  // --abbrev-ref HEAD` exits non-zero on an unborn branch, which would abort
  // all metadata resolution; `branch --show-current` stays empty + exit 0.
  const branchPromise = runGit(
    ['-C', workspaceFolderFsPath, 'branch', '--show-current'],
    workspaceFolderFsPath,
  )
    .then((r) => r.stdout.trim() || undefined)
    .catch(() => undefined);

  let stdout: string;
  try {
    ({ stdout } = await runGit(args, workspaceFolderFsPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('git not found on PATH', { cause: err });
    }
    throw new Error(`${workspaceFolderFsPath} is not a git repository`, { cause: err });
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error('unexpected git rev-parse output');
  }
  const gitCommonDir = lines[0];
  const isBare = lines[1];

  // The real guard: a bare repo has no main worktree.
  if (isBare === 'true') {
    throw new Error(`${workspaceFolderFsPath} is a bare git repository`);
  }
  // Belt-and-suspenders: a bare repo's common dir does not end in `.git`.
  if (!/[\\/]\.git$/.test(gitCommonDir)) {
    throw new Error(`git common dir "${gitCommonDir}" is not a worktree .git`);
  }
  // Non-bare repos always print a top-level on the third line.
  if (lines.length < 3) {
    throw new Error('git rev-parse did not report a worktree root');
  }

  // --git-common-dir is the shared `.git` even from a linked worktree, so its
  // parent is the main worktree (group key). --show-toplevel is this working
  // tree's own root, distinct per linked worktree and subdirectory-proof.
  const mainWorktreePath = canonicalizePath(path.dirname(gitCommonDir));
  const worktreePath = canonicalizePath(lines[2]);

  return { mainWorktreePath, worktreePath, currentBranch: await branchPromise };
}
