// Registers this extension's hooks into the workspace's
// `.claude/settings.local.json` so Claude Code reports turn lifecycle to the
// shared server.
//
// We use native HTTP hooks (`"type": "http"`): Claude Code POSTs the event
// JSON straight to our server — no shell command, no curl, no cross-shell
// quoting, identical on every platform. Every event posts to the SAME
// endpoint; the server discriminates on `hook_event_name` in the body.
//
// settings.local.json is auto-gitignored by Claude Code and takes precedence
// over settings.json. Note: for non-permission settings the scopes override
// rather than merge — if you also keep `hooks` in settings.json, the local
// file's hooks shadow them.

import * as vscode from 'vscode';
import { HOOK_HTTP_PORT } from './shared';

// Events Claude Code should send to the server. The server only acts on the
// ones it recognises (UserPromptSubmit, Stop); add an event here to have it
// start receiving that event too.
const EVENTS = ['UserPromptSubmit', 'Stop'] as const;
// The single endpoint every registered event posts to.
const HOOK_URL = `http://127.0.0.1:${HOOK_HTTP_PORT}/hook`;

/** True for hook entries this extension wrote. */
function isOurHook(h: any): boolean {
  return !!h && typeof h === 'object' && h.url === HOOK_URL;
}

function hookEntry(): unknown {
  return { hooks: [{ type: 'http', url: HOOK_URL, timeout: 5 }] };
}

export async function registerClaudeHooks(log: vscode.OutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return; // No workspace — nothing to wire up.
  }
  const dir = vscode.Uri.joinPath(folder.uri, '.claude');
  const file = vscode.Uri.joinPath(dir, 'settings.local.json');

  let originalText = '';
  let json: any = {};
  try {
    originalText = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    json = JSON.parse(originalText || '{}');
  } catch {
    json = {}; // Missing or unparseable — start fresh.
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    json = {};
  }
  if (typeof json.hooks !== 'object' || json.hooks === null || Array.isArray(json.hooks)) {
    json.hooks = {};
  }

  for (const event of EVENTS) {
    const existing: any[] = Array.isArray(json.hooks[event]) ? json.hooks[event] : [];
    // Drop any entry we wrote before, then append a current one.
    const kept = existing.filter((entry) => {
      const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
      return !hooks.some(isOurHook);
    });
    kept.push(hookEntry());
    json.hooks[event] = kept;
  }

  const newText = JSON.stringify(json, null, 2) + '\n';
  if (newText === originalText) {
    return; // Already current — avoid needless writes / file-watcher churn.
  }
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(file, Buffer.from(newText, 'utf8'));
  log.appendLine(`Registered Claude Code hooks in ${file.fsPath}`);
}
