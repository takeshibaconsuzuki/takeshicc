// Typed schema + defaults for the user-maintained global config at
// ~/.takeshicc/config.json. Maps a canonical main-worktree path to a
// { port, idleTimeoutMs } group.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { canonicalizePath, groupIdFor, GitMetadata } from './gitUtils';

export const TAKESHICC_DIR = path.join(os.homedir(), '.takeshicc');
export const CONFIG_PATH = path.join(TAKESHICC_DIR, 'config.json');

// Per-port server log under TAKESHICC_DIR: written by the detached server,
// opened by the openServerLog command.
export function serverLogPath(port: number): string {
  return path.join(TAKESHICC_DIR, `server-${port}.log`);
}

const GroupSchema = z.object({
  // .min(1024): privileged ports fail to bind with EACCES (not EADDRINUSE),
  // which would push the client into the crash-retry loop — reject up front.
  port: z.number().int().min(1024).max(65535),
  // .min(5_000): below this, HEARTBEAT_MS (idleTimeoutMs / 3) drops under the
  // 5_000 ms IDLE_CHECK_MS and the server can idle-exit under a live client.
  idleTimeoutMs: z.number().int().min(5_000).default(60_000),
});

const ConfigSchema = z.object({
  groups: z.record(z.string(), GroupSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// The on-disk group enriched by lookupGroup into this workspace's full
// resolved identity. mainWorktreePath stays the human-authored config key
// and diagnostic; groupId is the opaque routing token.
export type ResolvedGroup = z.infer<typeof GroupSchema> & {
  groupId: string;
  mainWorktreePath: string;
  worktreePath: string;
};

// Reads CONFIG_PATH. Missing file -> defaults (the normal "feature off" state,
// no notification). Malformed JSON / schema violation -> throws with zod's
// message; the caller surfaces an error notification since it is a
// user-maintained file.
export function readConfig(): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ConfigSchema.parse({});
    }
    throw err;
  }
  return ConfigSchema.parse(JSON.parse(raw));
}

// Matches user-authored config keys (canonicalized) against the
// already-canonical meta.mainWorktreePath, then enriches the hit into the
// full resolved identity.
export function lookupGroup(meta: GitMetadata): ResolvedGroup | undefined {
  const config = readConfig();
  const wanted = meta.mainWorktreePath; // already canonical (resolveGitMetadata)
  for (const [key, group] of Object.entries(config.groups)) {
    if (canonicalizePath(key) === wanted) {
      return {
        ...group,
        groupId: groupIdFor(wanted),
        mainWorktreePath: wanted,
        worktreePath: meta.worktreePath,
      };
    }
  }
  return undefined;
}
