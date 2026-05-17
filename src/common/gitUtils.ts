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
import { Logger } from './logger';

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
  return `group:${pathId(mainWorktreePath)}`;
}

export function instanceIdFor(worktreePath: string): string {
  return `instance:${pathId(worktreePath)}`;
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
}

// Returns this workspace folder's GitMetadata, or undefined to bail (not a
// git repo, bare repo, git not installed).
export async function resolveGitMetadata(
  workspaceFolderFsPath: string,
  log: Logger,
): Promise<GitMetadata | undefined> {
  // One command; the options print on consecutive lines in argument order.
  // --show-toplevel is kept last so it does not shift the bare-repo guards
  // (a bare repo prints an empty top-level, which the filter drops).
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

  let stdout: string;
  try {
    ({ stdout } = await runGit(args, workspaceFolderFsPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.appendLine('Takeshicc: git not found on PATH — server feature disabled.');
    } else {
      // Non-zero exit (incl. "fatal: not a git repository") -> bail.
      log.appendLine(
        `Takeshicc: ${workspaceFolderFsPath} is not a git repository — server feature off.`,
      );
    }
    return undefined;
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    log.appendLine(`Takeshicc: unexpected git rev-parse output — server feature off.`);
    return undefined;
  }
  const gitCommonDir = lines[0];
  const isBare = lines[1];

  // The real guard: a bare repo has no main worktree.
  if (isBare === 'true') {
    log.appendLine(
      `Takeshicc: ${workspaceFolderFsPath} is a bare git repository — server feature off.`,
    );
    return undefined;
  }
  // Belt-and-suspenders: a bare repo's common dir does not end in `.git`.
  if (!/[\\/]\.git$/.test(gitCommonDir)) {
    log.appendLine(
      `Takeshicc: git common dir "${gitCommonDir}" is not a worktree .git — server feature off.`,
    );
    return undefined;
  }
  // Non-bare repos always print a top-level on the third line.
  if (lines.length < 3) {
    log.appendLine(`Takeshicc: git rev-parse did not report a worktree root — server feature off.`);
    return undefined;
  }

  // --git-common-dir is the shared `.git` even from a linked worktree, so its
  // parent is the main worktree (group key). --show-toplevel is this working
  // tree's own root, distinct per linked worktree and subdirectory-proof.
  const mainWorktreePath = canonicalizePath(path.dirname(gitCommonDir));
  const worktreePath = canonicalizePath(lines[2]);
  log.appendLine(
    `Takeshicc: resolved main-worktree ${mainWorktreePath}, current worktree ${worktreePath}`,
  );
  return { mainWorktreePath, worktreePath };
}
