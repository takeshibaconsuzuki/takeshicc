import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MCP_PATH, MCP_SOURCE_TAG, MCP_TOKEN_HEADER } from './server';

export const SERVER_NAME = 'takeshicc';

export interface McpRegisterParams {
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
 * Merge our MCP server entry into ~/.claude.json under `mcpServers.takeshicc`.
 * Other entries (user-added MCP servers, top-level Claude Code settings) are
 * preserved. Each activation rotates the port and token, so the entry is
 * always overwritten with fresh values.
 *
 * Returns the path written. Throws if the existing file isn't valid JSON —
 * we refuse to overwrite what might be the user's work.
 */
export async function registerMcpServer(params: McpRegisterParams): Promise<string> {
  const file = path.join(os.homedir(), '.claude.json');
  const existing = await readJson(file);
  const merged = mergeMcp(existing, params.port, params.token);
  await fs.writeFile(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return file;
}

export async function unregisterMcpServer(): Promise<void> {
  const file = path.join(os.homedir(), '.claude.json');
  let existing: Json;
  try {
    existing = await readJson(file);
  } catch {
    return;
  }
  if (existing === null) return;
  const cleaned = removeMcp(existing);
  await fs.writeFile(file, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
}

/**
 * Pure merge. Exported for unit tests. Sets `mcpServers.takeshicc` to a fresh
 * entry pointing at the current loopback port; preserves any sibling servers.
 */
export function mergeMcp(
  settings: Json,
  port: number,
  token: string
): { [key: string]: Json } {
  const root = isObject(settings) ? { ...settings } : {};
  const servers = isObject(root.mcpServers) ? { ...root.mcpServers } : {};
  servers[SERVER_NAME] = makeEntry(port, token);
  root.mcpServers = servers;
  return root;
}

/**
 * Pure remove. Exported for unit tests. Deletes only our entry; sibling
 * servers and unrelated top-level keys are untouched.
 */
export function removeMcp(settings: Json): Json {
  if (!isObject(settings)) return settings;
  const root = { ...settings };
  if (!isObject(root.mcpServers)) return root;
  const servers = { ...root.mcpServers };
  if (!isOurEntry(servers[SERVER_NAME])) return root;
  delete servers[SERVER_NAME];
  if (Object.keys(servers).length === 0) delete root.mcpServers;
  else root.mcpServers = servers;
  return root;
}

function makeEntry(port: number, token: string): Json {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}${MCP_PATH}?${MCP_SOURCE_TAG}`,
    headers: { [MCP_TOKEN_HEADER]: token },
  };
}

function isOurEntry(entry: Json | undefined): boolean {
  return (
    isObject(entry) &&
    typeof entry.url === 'string' &&
    entry.url.includes(MCP_SOURCE_TAG)
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
