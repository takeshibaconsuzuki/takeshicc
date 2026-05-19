import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_HTTP_HOOK_EVENTS, HOST, ROUTES } from '../common/protocol';
import { isJsonObject } from '../common/json';

const HOOK_TIMEOUT_SECONDS = 2;

type JsonObject = Record<string, unknown>;

function settingsPath(worktreePath: string): string {
  return path.join(worktreePath, '.claude', 'settings.local.json');
}

function hookUrl(port: number): string {
  return `http://${HOST}:${port}${ROUTES.claudeUpdateChatState}`;
}

function isTakeshiccClaudeHook(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.type === 'http' &&
    typeof value.url === 'string' &&
    value.url.endsWith(ROUTES.claudeUpdateChatState) &&
    // We always write `HOST`, but a user (or an older build) may have written
    // `localhost`; recognize both so prune doesn't orphan stale entries.
    (value.url.startsWith(`http://${HOST}:`) || value.url.startsWith('http://localhost:'))
  );
}

function readSettings(filePath: string): { settings: JsonObject; raw: string | undefined } {
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: {}, raw: undefined };
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return { settings: parsed, raw };
}

function pruneTakeshiccHooks(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const pruned: unknown[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      pruned.push(entry);
      continue;
    }
    const hooks = Array.isArray(entry.hooks)
      ? entry.hooks.filter((hook) => !isTakeshiccClaudeHook(hook))
      : entry.hooks;
    if (Array.isArray(hooks) && hooks.length === 0) {
      continue;
    }
    pruned.push({ ...entry, hooks });
  }
  return pruned;
}

export function mergeClaudeHttpHooks(worktreePath: string, port: number): boolean {
  const filePath = settingsPath(worktreePath);
  const { settings, raw } = readSettings(filePath);
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {};
  const url = hookUrl(port);
  const httpHook = { type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS };

  for (const eventName of CLAUDE_HTTP_HOOK_EVENTS) {
    hooks[eventName] = [...pruneTakeshiccHooks(hooks[eventName]), { hooks: [httpHook] }];
  }
  settings.hooks = hooks;

  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if (raw === next) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}
