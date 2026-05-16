// Registers the local server as a set of Claude Code hooks.
//
// Runs once per activation, right after the client connects. It writes hooks
// into the workspace's `.claude/settings.local.json` for every event in
// HOOK_REGISTER_EVENTS:
//
//   - every event gets an `http` hook so Claude Code POSTs it to the server's
//     /update-chat-state endpoint;
//   - UserPromptSubmit additionally gets a `command` hook running the reporter
//     (see src/reporter), which forwards the same payload plus the Claude
//     process's ancestor PIDs — letting the extension tie the chat to the VS
//     Code terminal hosting it.
//
// The reporter is platform-split, because the hook process must itself be a
// walkable ancestor of the terminal:
//   - Windows: out/reporter.ps1, run directly by powershell.exe (exec form).
//     PowerShell is spawned straight by Claude, so its ancestor chain to the
//     terminal is intact. A Node/Electron child would not be — Windows'
//     Electron bootstrap re-spawns and orphans it, severing the chain.
//   - elsewhere: out/reporter.js, run under VS Code's Electron binary in Node
//     mode (ELECTRON_RUN_AS_NODE), since `node` may not be on PATH.
//
// The write is idempotent: prior takeshicc hooks — the http hook (identified
// by endpoint path, so a changed port self-heals) and the reporter command
// hook — are stripped before the current ones are re-added, and the file is
// only rewritten when its contents actually change.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HOST, HOOK_REGISTER_EVENTS, ROUTES } from '../server/protocol';

// The event the reporter command hook is registered on. UserPromptSubmit
// rather than SessionStart: SessionStart fires only when a session is created,
// so it never reaches a session that was already running when these hooks were
// registered. UserPromptSubmit fires every turn — re-reporting is harmless
// (the ancestor PIDs are stable for the session's life and the extension
// ignores a chat it has already bound), and it reaches running sessions too.
const REPORTER_EVENT = 'UserPromptSubmit';

// A single hook entry inside a hook block's `hooks` array.
interface HookEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: unknown[];
  shell?: string;
  [k: string]: unknown;
}

// A hook block: an optional matcher plus the entries it triggers.
interface HookBlock {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

// True for a hook entry this extension owns: the http hook pointing at the
// /update-chat-state endpoint (matched by path, regardless of host/port, so a
// stale port is replaced rather than duplicated) or the reporter command hook
// (matched by the reporter bundle's filename, in either `command` or `args`).
// Both are stripped before the current pair is re-added — and matching the
// reporter loosely means earlier shell-form registrations self-heal too.
function isOurHook(entry: HookEntry): boolean {
  if (
    entry?.type === 'http' &&
    typeof entry.url === 'string' &&
    entry.url.endsWith(ROUTES.updateChatState)
  ) {
    return true;
  }
  if (entry?.type !== 'command') {
    return false;
  }
  const mentionsReporter = (v: unknown): boolean =>
    typeof v === 'string' &&
    (v.includes('reporter.js') || v.includes('reporter.ps1'));
  return (
    mentionsReporter(entry.command) ||
    (Array.isArray(entry.args) && entry.args.some(mentionsReporter))
  );
}

export async function registerHooks(
  workspacePath: string,
  port: number,
  outDir: string,
  log: vscode.OutputChannel,
): Promise<void> {
  const url = `http://${HOST}:${port}${ROUTES.updateChatState}`;
  // Windows: an exec-form hook runs powershell.exe (always on PATH) directly
  // on out/reporter.ps1 — no wrapping shell, and the script does the ancestor
  // walk itself. Elsewhere: a shell-form hook runs out/reporter.js under VS
  // Code's Electron binary with ELECTRON_RUN_AS_NODE set (single-quoted paths;
  // `sh` is always present).
  const reporterEntry: HookEntry =
    process.platform === 'win32'
      ? {
          type: 'command',
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(outDir, 'reporter.ps1'),
            String(port),
          ],
        }
      : {
          type: 'command',
          command:
            `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' ` +
            `'${path.join(outDir, 'reporter.js')}' ${port}`,
        };
  const reporterDesc =
    process.platform === 'win32'
      ? `powershell.exe -File ${path.join(outDir, 'reporter.ps1')} ${port}`
      : (reporterEntry.command ?? '');
  const settingsPath = path.join(
    workspacePath,
    '.claude',
    'settings.local.json',
  );

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
      .filter(
        (block) => !Array.isArray(block?.hooks) || block.hooks.length > 0,
      );

    const entries: HookEntry[] = [{ type: 'http', url }];
    if (event === REPORTER_EVENT) {
      entries.push({ ...reporterEntry });
    }
    cleaned.push({ hooks: entries });
    allHooks[event] = cleaned;
  }

  const next = JSON.stringify(settings, null, 2) + '\n';
  if (next === raw) {
    log.appendLine(
      `Takeshicc: hooks already current in ${settingsPath}; ` +
        `${REPORTER_EVENT} reporter: ${reporterDesc}`,
    );
    return; // already registered with this port — nothing to write
  }

  try {
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.promises.writeFile(settingsPath, next, 'utf8');
    log.appendLine(
      `Takeshicc: registered hooks in ${settingsPath} — http ${url}; ` +
        `${REPORTER_EVENT} reporter: ${reporterDesc}`,
    );
  } catch (err) {
    log.appendLine(
      `Takeshicc: could not write ${settingsPath} — ${(err as Error).message}.`,
    );
  }
}
