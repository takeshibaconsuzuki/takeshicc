// Resolves the "group identity" of a workspace folder: the canonical main
// worktree path of the git repo containing it. All worktrees of one repo
// resolve to the same key, so they share a single server.

import * as path from 'path';
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

// Returns the canonical main-worktree path of the git repo containing
// `workspaceFolderFsPath`, or undefined to bail (not a git repo, bare repo,
// git not installed).
export async function resolveGitGroup(
  workspaceFolderFsPath: string,
  log: Logger,
): Promise<string | undefined> {
  // A single command: both info options print, on consecutive lines.
  // --path-format=absolute requires git >= 2.31.
  const args = [
    '-C',
    workspaceFolderFsPath,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--is-bare-repository',
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
      log.appendLine(`Takeshicc: ${workspaceFolderFsPath} is not a git repository — server feature off.`);
    }
    return undefined;
  }

  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) {
    log.appendLine(`Takeshicc: unexpected git rev-parse output — server feature off.`);
    return undefined;
  }
  const gitCommonDir = lines[0];
  const isBare = lines[1];

  // The real guard: a bare repo has no main worktree.
  if (isBare === 'true') {
    log.appendLine(`Takeshicc: ${workspaceFolderFsPath} is a bare git repository — server feature off.`);
    return undefined;
  }
  // Belt-and-suspenders: a bare repo's common dir does not end in `.git`.
  if (!/[\\/]\.git$/.test(gitCommonDir)) {
    log.appendLine(`Takeshicc: git common dir "${gitCommonDir}" is not a worktree .git — server feature off.`);
    return undefined;
  }

  // --git-common-dir points at the shared `.git` even from a linked worktree,
  // so its parent is the main worktree.
  const mainWorktree = canonicalizePath(path.dirname(gitCommonDir));
  log.appendLine(`Takeshicc: resolved main worktree -> ${mainWorktree}`);
  return mainWorktree;
}
