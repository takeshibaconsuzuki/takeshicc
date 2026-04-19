import * as fs from 'fs/promises';
import * as path from 'path';
import { TOKEN_HEADER, type HookEventName } from './server';

const SOURCE_TAG = 'source=takeshicc';

const EVENTS: HookEventName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

export interface HookInstallParams {
  workspaceRoot: string;
  port: number;
  token: string;
}

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/**
 * Merge our hook entries into `.claude/settings.local.json`. Existing entries
 * from the user or other tools are preserved. Our entries are tagged with a
 * sentinel in the URL so uninstall can find and remove them cleanly.
 *
 * The file contains a rotating port and secret, so the project's `.gitignore`
 * should exclude `.claude/settings.local.json` — Claude Code does not add
 * that rule automatically despite the `.local.json` suffix.
 *
 * Returns the path written. Throws if the existing file isn't valid JSON —
 * we refuse to overwrite what might be the user's work.
 */
export async function installHooks(params: HookInstallParams): Promise<string> {
  const { workspaceRoot, port, token } = params;
  const claudeDir = path.join(workspaceRoot, '.claude');
  const file = path.join(claudeDir, 'settings.local.json');
  await fs.mkdir(claudeDir, { recursive: true });
  const existing = await readJson(file);
  const merged = mergeHooks(existing, port, token);
  await fs.writeFile(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return file;
}

export async function uninstallHooks(workspaceRoot: string): Promise<void> {
  const file = path.join(workspaceRoot, '.claude', 'settings.local.json');
  let existing: Json;
  try {
    existing = await readJson(file);
  } catch {
    return;
  }
  if (existing === null) return;
  const cleaned = removeHooks(existing);
  await fs.writeFile(file, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
}

/**
 * Pure merge. Exported for unit tests. Replaces any previous takeshicc entries
 * for each event with a fresh entry (new port, new token).
 */
export function mergeHooks(
  settings: Json,
  port: number,
  token: string
): { [key: string]: Json } {
  const root = isObject(settings) ? { ...settings } : {};
  const hooks = isObject(root.hooks) ? { ...root.hooks } : {};
  for (const event of EVENTS) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : [];
    const filtered = arr.filter((m) => !isOurMatcher(m));
    filtered.push(makeMatcher(port, token));
    hooks[event] = filtered;
  }
  root.hooks = hooks;
  return root;
}

/**
 * Pure remove. Exported for unit tests. Strips only entries tagged with our
 * source sentinel; anything else the user added is left alone.
 */
export function removeHooks(settings: Json): Json {
  if (!isObject(settings)) return settings;
  const root = { ...settings };
  if (!isObject(root.hooks)) return root;
  const hooks = { ...root.hooks };
  for (const event of EVENTS) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((m) => !isOurMatcher(m));
    if (filtered.length > 0) hooks[event] = filtered;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) {
    delete root.hooks;
  } else {
    root.hooks = hooks;
  }
  return root;
}

function makeMatcher(port: number, token: string): Json {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/hook?${SOURCE_TAG}`,
        headers: { [TOKEN_HEADER]: token },
      },
    ],
  };
}

function isOurMatcher(matcher: Json): boolean {
  if (!isObject(matcher)) return false;
  const hs = Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return hs.some(
    (h) =>
      isObject(h) && typeof h.url === 'string' && h.url.includes(SOURCE_TAG)
  );
}

function isObject(x: Json | undefined): x is { [key: string]: Json } {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

async function readJson(file: string): Promise<Json> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  if (text.trim() === '') return null;
  return JSON.parse(text) as Json;
}
