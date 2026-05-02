import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MCP_PATH, MCP_SOURCE_TAG, MCP_TOKEN_HEADER } from './server';

export const SERVER_NAME = 'takeshicc';

export interface McpRegisterParams {
  port: number;
  token: string;
  workspaceRoot: string;
}

export interface McpUnregisterParams {
  workspaceRoot: string;
}

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/**
 * Merge our MCP server entry into ~/.claude.json under
 * `projects.<workspaceRoot>.mcpServers.takeshicc`. Other entries (sibling
 * MCP servers, unrelated project metadata, top-level Claude Code settings)
 * are preserved. Each activation rotates the port and token, so the entry
 * is always overwritten with fresh values.
 *
 * Returns the path written. Throws if the existing file isn't valid JSON —
 * we refuse to overwrite what might be the user's work.
 */
export async function registerMcpServer(params: McpRegisterParams): Promise<string> {
  const file = path.join(os.homedir(), '.claude.json');
  const existing = await readJson(file);
  const key = normalizeProjectKey(params.workspaceRoot);
  const pruned = pruneStaleVariants(existing, key);
  const merged = mergeMcp(pruned, params.port, params.token, key);
  await fs.writeFile(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return file;
}

export async function unregisterMcpServer(params: McpUnregisterParams): Promise<void> {
  const file = path.join(os.homedir(), '.claude.json');
  let existing: Json;
  try {
    existing = await readJson(file);
  } catch {
    return;
  }
  if (existing === null) return;
  const key = normalizeProjectKey(params.workspaceRoot);
  const pruned = pruneStaleVariants(existing, key);
  const cleaned = removeMcp(pruned, key);
  await fs.writeFile(file, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
}

/**
 * Claude Code keys `projects` in `~/.claude.json` by the cwd it was started
 * in. On Windows that's an uppercase drive letter and forward slashes (e.g.
 * `E:/Devel/proj`), but VS Code's `workspaceFolders[0].uri.fsPath` returns
 * `e:\Devel\proj` — lowercase drive, backslashes. Writing under the VS Code
 * form means Claude Code never finds our entry. Normalize to the Claude
 * Code convention so the key matches.
 */
export function normalizeProjectKey(workspaceRoot: string): string {
  if (process.platform !== 'win32') return workspaceRoot;
  let out = workspaceRoot.replace(/\\/g, '/');
  if (/^[a-z]:/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/**
 * Remove our entry from any project key that normalizes to `canonicalKey`
 * but isn't equal to it — i.e., stale entries written by older builds under
 * the wrong path form. Sibling MCP servers under those keys are preserved.
 * Exported for unit tests.
 */
export function pruneStaleVariants(settings: Json, canonicalKey: string): Json {
  if (!isObject(settings)) return settings;
  if (!isObject(settings.projects)) return settings;
  let result: Json = settings;
  for (const k of Object.keys(settings.projects)) {
    if (k === canonicalKey) continue;
    if (normalizeProjectKey(k) !== canonicalKey) continue;
    result = removeMcp(result, k);
  }
  return result;
}

/**
 * Pure merge. Exported for unit tests. Sets
 * `projects[workspaceRoot].mcpServers.takeshicc` to a fresh entry pointing
 * at the current loopback port; preserves any sibling servers and other
 * project metadata.
 */
export function mergeMcp(
  settings: Json,
  port: number,
  token: string,
  workspaceRoot: string
): { [key: string]: Json } {
  const root = isObject(settings) ? { ...settings } : {};
  const projects = isObject(root.projects) ? { ...root.projects } : {};
  const project = isObject(projects[workspaceRoot]) ? { ...projects[workspaceRoot] } : {};
  const servers = isObject(project.mcpServers) ? { ...project.mcpServers } : {};
  servers[SERVER_NAME] = makeEntry(port, token);
  project.mcpServers = servers;
  projects[workspaceRoot] = project;
  root.projects = projects;
  return root;
}

/**
 * Pure remove. Exported for unit tests. Deletes only our entry under
 * `projects[workspaceRoot].mcpServers.takeshicc`; sibling servers and
 * unrelated project / top-level keys are untouched.
 */
export function removeMcp(settings: Json, workspaceRoot: string): Json {
  if (!isObject(settings)) return settings;
  const root = { ...settings };
  if (!isObject(root.projects)) return root;
  const projects = { ...root.projects };
  const project = projects[workspaceRoot];
  if (!isObject(project)) return root;
  if (!isObject(project.mcpServers)) return root;
  const servers = { ...project.mcpServers };
  if (!isOurEntry(servers[SERVER_NAME])) return root;
  delete servers[SERVER_NAME];
  const updatedProject: { [key: string]: Json } = { ...project };
  if (Object.keys(servers).length === 0) delete updatedProject.mcpServers;
  else updatedProject.mcpServers = servers;
  projects[workspaceRoot] = updatedProject;
  root.projects = projects;
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
