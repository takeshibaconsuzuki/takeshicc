import * as fs from 'fs';
import * as path from 'path';
import { HOST, ROUTES } from '../common/protocol';

const HOOK_TIMEOUT_SECONDS = 2;

// Claude Code's SessionStart and Setup hooks are command/mcp_tool-only, and
// WorktreeCreate replaces Claude's default worktree creation behavior. The
// server still handles those events if delivered, but activation should only
// install passive HTTP observers.
const CLAUDE_HTTP_HOOK_EVENTS = [
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function settingsPath(worktreePath: string): string {
  return path.join(worktreePath, '.claude', 'settings.local.json');
}

function hookUrl(port: number): string {
  return `http://${HOST}:${port}${ROUTES.claudeUpdateChatState}`;
}

function isTakeshiccClaudeHook(value: unknown): boolean {
  return (
    isObject(value) &&
    value.type === 'http' &&
    typeof value.url === 'string' &&
    value.url.endsWith(ROUTES.claudeUpdateChatState) &&
    (value.url.startsWith(`http://${HOST}:`) || value.url.startsWith('http://localhost:'))
  );
}

function readSettings(filePath: string): JsonObject {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function pruneTakeshiccHooks(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const pruned: unknown[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
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
  const settings = readSettings(filePath);
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const url = hookUrl(port);
  const httpHook = { type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS };

  for (const eventName of CLAUDE_HTTP_HOOK_EVENTS) {
    hooks[eventName] = [...pruneTakeshiccHooks(hooks[eventName]), { hooks: [httpHook] }];
  }
  settings.hooks = hooks;

  const next = `${JSON.stringify(settings, null, 2)}\n`;
  let current: string | undefined;
  try {
    current = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  if (current === next) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}
