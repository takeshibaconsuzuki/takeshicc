// Typed schema + defaults for the user-maintained global config at
// ~/.takeshicc/config.json. Maps a canonical main-worktree path to a
// { port, idleTimeoutMs } group.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { canonicalizePath } from './gitGroup';

export const CONFIG_PATH = path.join(os.homedir(), '.takeshicc', 'config.json');

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
export type ResolvedGroup = z.infer<typeof GroupSchema>; // { port, idleTimeoutMs }

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

// Canonicalizes the query key and every config key before matching, so config
// keys and resolved group keys compare exactly. Defaults are already applied
// by ConfigSchema.parse.
export function lookupGroup(groupKey: string): ResolvedGroup | undefined {
  const config = readConfig();
  const wanted = canonicalizePath(groupKey);
  for (const [key, group] of Object.entries(config.groups)) {
    if (canonicalizePath(key) === wanted) {
      return group;
    }
  }
  return undefined;
}

// Opens CONFIG_PATH in an editor, scaffolding an empty config first if it does
// not yet exist — the command is most useful before any config is written.
export async function openConfig(): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      await fs.promises.writeFile(
        CONFIG_PATH,
        '{\n  "groups": {}\n}\n',
        'utf8',
      );
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(CONFIG_PATH),
    );
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Takeshicc: could not open ${CONFIG_PATH} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
