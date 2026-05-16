// Registers the local server as a Claude Code HTTP hook.
//
// Runs once per activation, right after the client connects. It writes an
// `http` hook into the workspace's `.claude/settings.local.json` for every
// event in HOOK_REGISTER_EVENTS, so Claude Code POSTs every lifecycle event
// to the server's /update-chat-state endpoint.
//
// The write is idempotent: prior takeshicc hooks (identified by the endpoint
// path, so a changed port self-heals) are stripped before the current hook is
// re-added, and the file is only rewritten when its contents actually change.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HOST, HOOK_REGISTER_EVENTS, ROUTES } from '../server/protocol';

// A single hook entry inside a hook block's `hooks` array.
interface HookEntry {
  type?: string;
  url?: string;
  [k: string]: unknown;
}

// A hook block: an optional matcher plus the entries it triggers.
interface HookBlock {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

// True for a hook entry this extension owns — any http hook pointing at the
// /update-chat-state endpoint, regardless of host/port (so a stale port is
// replaced rather than duplicated).
function isOurHook(entry: HookEntry): boolean {
  return (
    entry?.type === 'http' &&
    typeof entry.url === 'string' &&
    entry.url.endsWith(ROUTES.updateChatState)
  );
}

export async function registerHooks(
  workspacePath: string,
  port: number,
  log: vscode.OutputChannel,
): Promise<void> {
  const url = `http://${HOST}:${port}${ROUTES.updateChatState}`;
  const settingsPath = path.join(workspacePath, '.claude', 'settings.local.json');

  let raw: string | undefined;
  let settings: Record<string, unknown> = {};
  try {
    raw = await fs.promises.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Unreadable or malformed file — leave it untouched rather than risk
      // clobbering user settings; the hook just stays unregistered.
      log.appendLine(
        `Takeshicc: cannot use ${settingsPath} (${(err as Error).message}); ` +
          `skipping hook registration.`,
      );
      return;
    }
  }

  const existing = settings.hooks;
  const allHooks: Record<string, HookBlock[]> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, HookBlock[]>)
      : {};
  settings.hooks = allHooks;

  for (const event of HOOK_REGISTER_EVENTS) {
    const blocks = Array.isArray(allHooks[event]) ? allHooks[event] : [];

    // Strip our prior hook from every block, then drop blocks left empty.
    const cleaned = blocks
      .map((block) => {
        if (!Array.isArray(block?.hooks)) {
          return block;
        }
        return { ...block, hooks: block.hooks.filter((h) => !isOurHook(h)) };
      })
      .filter((block) => !Array.isArray(block?.hooks) || block.hooks.length > 0);

    cleaned.push({ hooks: [{ type: 'http', url }] });
    allHooks[event] = cleaned;
  }

  const next = JSON.stringify(settings, null, 2) + '\n';
  if (next === raw) {
    return; // already registered with this port — nothing to write
  }

  try {
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, next, 'utf8');
    log.appendLine(`Takeshicc: registered HTTP hook ${url} in ${settingsPath}.`);
  } catch (err) {
    log.appendLine(
      `Takeshicc: could not write ${settingsPath} — ${(err as Error).message}.`,
    );
  }
}
