import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Context,
  OpenAIEmbedding,
  type Embedding,
  type VectorDatabase,
} from '@zilliz/claude-context-core';
import { NullVectorDatabase } from './nullVectorDb';
import { LanceDBVectorDatabase } from './lancedb-vectordb';
import { bumpRunningChunks } from './indexingState';

const TAKESHICC_DIR = '.takeshicc';
const LANCEDB_DIR = `${TAKESHICC_DIR}/lancedb`;
const GITIGNORE_ENTRY = `${TAKESHICC_DIR}/`;

// `Context.findIgnoreFiles` greedily picks up every `.<name>ignore` file in
// the workspace root and merges them into the indexer's ignore set. That's
// fine for `.gitignore`, but `.vscodeignore` is a vsce-packaging file that
// commonly globs out `src/**` and `test/**` — so the indexer ends up
// excluding the whole codebase. Skip it. Other ignore files (.gitignore,
// .contextignore, .npmignore, …) still flow through unchanged.
patchSkipVscodeignore();

export interface EmbeddingSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super(
      'takeshicc: embedding API key is not set. Configure ' +
        '`takeshicc.embedding.apiKey` (and optionally `baseURL` / `model`) in VS Code settings.'
    );
    this.name = 'EmbeddingNotConfiguredError';
  }
}

/**
 * Read embedding settings from VS Code config. The apiKey is required; baseURL
 * and model fall back to the package.json defaults.
 */
export function readEmbeddingSettings(): EmbeddingSettings {
  const cfg = vscode.workspace.getConfiguration('takeshicc.embedding');
  return {
    apiKey: cfg.get<string>('apiKey', '').trim(),
    baseURL: cfg.get<string>('baseURL', 'https://api.openai.com/v1').trim(),
    model: cfg.get<string>('model', 'text-embedding-3-small').trim(),
  };
}

function buildEmbedding(settings: EmbeddingSettings): Embedding {
  if (!settings.apiKey) throw new EmbeddingNotConfiguredError();
  return new OpenAIEmbedding({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    model: settings.model,
  });
}

/**
 * Lazy, settings-driven Context factory. Rebuilds the Context whenever the
 * embedding settings change so a fresh API key / model takes effect without
 * a window reload.
 *
 * Defaults to a LanceDB backend rooted at `<workspace>/.takeshicc/lancedb`.
 * Falls back to NullVectorDatabase when no workspace folder is open so
 * the MCP server still loads cleanly. Override via setVectorDatabaseFactory().
 */
export class ContextFactory implements vscode.Disposable {
  private context: Context | null = null;
  private currentVectorDatabase: VectorDatabase | null = null;
  private lastSettingsKey: string | null = null;
  private vectorDatabaseFactory: () => VectorDatabase = defaultVectorDatabaseFactory;
  private readonly configSub: vscode.Disposable;

  constructor() {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('takeshicc.embedding')) {
        this.context = null;
        this.lastSettingsKey = null;
      }
    });
  }

  /**
   * Replace the vector-database factory. Future Context instances will be
   * constructed with the new backend; the current cached Context is dropped.
   */
  setVectorDatabaseFactory(factory: () => VectorDatabase): void {
    this.vectorDatabaseFactory = factory;
    this.context = null;
    this.lastSettingsKey = null;
  }

  /**
   * Returns a Context built from current settings. Throws
   * EmbeddingNotConfiguredError if the API key is missing.
   */
  get(): Context {
    const settings = readEmbeddingSettings();
    const key = `${settings.apiKey ? 'set' : 'unset'}|${settings.baseURL}|${settings.model}`;
    if (this.context && this.lastSettingsKey === key) return this.context;
    const vectorDatabase = this.vectorDatabaseFactory();
    this.currentVectorDatabase = vectorDatabase;
    this.context = new Context({
      embedding: buildEmbedding(settings),
      vectorDatabase,
    });
    this.lastSettingsKey = key;
    return this.context;
  }

  /**
   * Authoritative on-disk counts for a workspace's collection — used to
   * seed the indexing-state baseline when the in-memory map has nothing
   * (cold activation against an existing index from a prior session).
   *
   * Returns `null` when the embedding API key isn't configured, the
   * collection doesn't exist yet, or the row-count query fails. Callers
   * treat null as "unknown" and fall back to whatever they had.
   *
   * Files come from a distinct-relativePath query; chunks from
   * `getCollectionRowCount`. Both run once per cold start, against an
   * embedded local DB — cost is negligible.
   */
  async getDiskCounts(
    workspaceRoot: string
  ): Promise<{ files: number; chunks: number } | null> {
    let context: Context;
    try {
      context = this.get();
    } catch {
      return null;
    }
    const db = this.currentVectorDatabase;
    if (!db) return null;
    const collection = context.getCollectionName(workspaceRoot);
    try {
      if (!(await db.hasCollection(collection))) return null;
      const chunks = await db.getCollectionRowCount(collection);
      if (chunks < 0) return null;
      const rows = await db.query(collection, '', ['relativePath'], 100_000);
      const files = new Set(
        rows.map((r) => r.relativePath as string).filter(Boolean)
      ).size;
      return { files, chunks };
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.configSub.dispose();
    this.context = null;
    this.currentVectorDatabase = null;
  }
}

/**
 * Build the workspace-scoped LanceDB backend. Without a workspace folder
 * there's no obvious place to persist files, so fall back to the null DB
 * (which surfaces a clear "not configured" error on first use).
 */
function defaultVectorDatabaseFactory(): VectorDatabase {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return new NullVectorDatabase();
  void ensureGitignore(workspaceRoot);
  return new LanceDBVectorDatabase({
    uri: path.join(workspaceRoot, LANCEDB_DIR),
    // Live chunk-count tracking: every successful insert / delete bumps
    // the running indexingState entry for this workspace. No-op when
    // nothing is running.
    onChunkChange: (delta) => bumpRunningChunks(workspaceRoot, delta),
  });
}

/**
 * Append `.takeshicc/` to the workspace `.gitignore` so the local LanceDB
 * files don't get committed. Idempotent: skips if the entry is already
 * present (treating any line that, after stripping a leading `/` and
 * trailing `/`, equals `.takeshicc` as a match — covers `.takeshicc`,
 * `.takeshicc/`, `/.takeshicc`, `/.takeshicc/`).
 *
 * Only acts when the workspace looks like a git checkout (`.git` exists)
 * so we don't materialize a `.gitignore` in non-git directories.
 * Best-effort: any failure (permission denied, etc.) is silently swallowed.
 */
/**
 * Wrap `Context.prototype.findIgnoreFiles` once so its returned list never
 * includes `.vscodeignore`. Idempotent — re-imports of this module won't
 * stack wrappers (the sentinel uses `Symbol.for`, so it's stable across
 * module instances).
 */
function patchSkipVscodeignore(): void {
  const flag = Symbol.for('takeshicc.skipVscodeignore');
  const proto = Context.prototype as unknown as Record<PropertyKey, unknown>;
  if (proto[flag]) return;

  const original = proto['findIgnoreFiles'];
  if (typeof original !== 'function') return;

  proto['findIgnoreFiles'] = async function patched(
    this: Context,
    codebasePath: string
  ): Promise<string[]> {
    const files = (await (original as (p: string) => Promise<string[]>).call(
      this,
      codebasePath
    )) ?? [];
    return files.filter((f) => path.basename(f) !== '.vscodeignore');
  };
  proto[flag] = true;
}

async function ensureGitignore(workspaceRoot: string): Promise<void> {
  try {
    try {
      await fs.stat(path.join(workspaceRoot, '.git'));
    } catch {
      return;
    }

    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    let existing = '';
    try {
      existing = await fs.readFile(gitignorePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }

    const alreadyIgnored = existing.split(/\r?\n/).some((line) => {
      const trimmed = line.trim().replace(/^\//, '').replace(/\/$/, '');
      return trimmed === TAKESHICC_DIR;
    });
    if (alreadyIgnored) return;

    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const block = `${prefix}# Added by takeshicc — local LanceDB index for code search.\n${GITIGNORE_ENTRY}\n`;
    await fs.appendFile(gitignorePath, block, 'utf8');
  } catch {
    // Best-effort. Failing to update .gitignore must not block indexing.
  }
}
