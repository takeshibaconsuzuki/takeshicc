import { z } from 'zod';
import type * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AstCodeSplitter,
  LangChainCodeSplitter,
  type SemanticSearchResult,
} from '@zilliz/claude-context-core';
import { ContextFactory, EmbeddingNotConfiguredError } from './context';
import { type IndexingState, indexingStates } from './indexingState';

// -- Tool descriptions ------------------------------------------------------
//
// Originally these mirrored @zilliz/claude-context-mcp@0.1.11 verbatim. We've
// since deviated — the workspace path is fixed at server construction, so the
// `path` argument is gone and the descriptions are rewritten to match.

export const INDEX_CODEBASE_DESCRIPTION = `
Index the active workspace to enable semantic search using a configurable code splitter.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already-indexed workspace and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;

export const SEARCH_CODE_DESCRIPTION = `
Search the indexed workspace using natural language queries.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the workspace is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the workspace before searching again.
`;

export const CLEAR_INDEX_DESCRIPTION = 'Clear the search index for the active workspace.';

export const GET_INDEXING_STATUS_DESCRIPTION =
  'Get the current indexing status of the active workspace. Shows progress percentage while indexing and completion status when finished.';

// -- Input schemas ----------------------------------------------------------

const indexInput = {
  force: z
    .boolean()
    .default(false)
    .describe('Force re-indexing even if already indexed'),
  splitter: z
    .enum(['ast', 'langchain'])
    .default('ast')
    .describe(
      "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting"
    ),
  customExtensions: z
    .array(z.string())
    .default([])
    .describe(
      "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added"
    ),
  ignorePatterns: z
    .array(z.string())
    .default([])
    .describe(
      "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])"
    ),
};

const searchInput = {
  query: z.string().describe('Natural language query to search for in the codebase'),
  limit: z
    .number()
    .max(50)
    .default(10)
    .describe('Maximum number of results to return'),
  extensionFilter: z
    .array(z.string())
    .default([])
    .describe(
      "Optional: List of file extensions to filter results. (e.g., ['.ts','.py'])."
    ),
};

const clearInput = {} as const;
const statusInput = {} as const;

class NoWorkspaceError extends Error {
  constructor() {
    super(
      'takeshicc: no workspace folder is open in this VS Code window — claude-context tools have no codebase to operate on.'
    );
    this.name = 'NoWorkspaceError';
  }
}

// -- Tool registration ------------------------------------------------------

/**
 * Register the four claude-context tools. The active workspace is fixed at
 * server-construction time and used for every call — agents don't need to
 * pass a path. If `workspaceRoot` is undefined (no folder open), each tool
 * returns a clear error rather than crashing.
 *
 * `log` receives one line at the start and end of every indexing /
 * clear-index call so the output channel shows the full lifecycle.
 */
export function registerContextTools(
  server: McpServer,
  factory: ContextFactory,
  workspaceRoot: string | undefined,
  log: vscode.OutputChannel
): void {
  server.registerTool(
    'index_codebase',
    { description: INDEX_CODEBASE_DESCRIPTION, inputSchema: indexInput },
    async (args) => {
      try {
        const root = requireWorkspace(workspaceRoot);
        const existing = indexingStates.get(root);
        if (existing?.phase === 'running') {
          return text(
            `Indexing already in progress for ${root} ` +
              `(${existing.progress.percentage}%). Use get_indexing_status to monitor.`
          );
        }

        const context = factory.get();

        if (args.splitter === 'langchain') {
          context.updateSplitter(new LangChainCodeSplitter());
        } else {
          context.updateSplitter(new AstCodeSplitter());
        }
        if (args.customExtensions.length > 0) {
          context.addCustomExtensions(args.customExtensions);
        }
        if (args.ignorePatterns.length > 0) {
          context.addCustomIgnorePatterns(args.ignorePatterns);
        }

        const startedAt = Date.now();
        log.appendLine(
          `index_codebase: starting ${root} (splitter=${args.splitter}, force=${args.force})`
        );
        indexingStates.set(root, {
          phase: 'running',
          startedAt,
          progress: { phase: 'starting', current: 0, total: 0, percentage: 0 },
          currentFiles: 0,
          currentChunks: 0,
        });
        const stats = await context.indexCodebase(
          root,
          (progress) => {
            const prev = indexingStates.get(root);
            // Preserve the live currentChunks bumped by the LanceDB hook —
            // the progress callback fires per-file but chunk inserts may
            // arrive between callbacks.
            const currentChunks =
              prev?.phase === 'running' ? prev.currentChunks : 0;
            indexingStates.set(root, {
              phase: 'running',
              startedAt,
              progress,
              currentFiles: progress.current,
              currentChunks,
            });
          },
          args.force,
          args.ignorePatterns.length > 0 ? args.ignorePatterns : undefined
        );
        const finishedAt = Date.now();
        indexingStates.set(root, {
          phase: 'completed',
          finishedAt,
          indexedFiles: stats.indexedFiles,
          totalChunks: stats.totalChunks,
          status: stats.status,
        });
        log.appendLine(
          `index_codebase: completed ${root} in ${finishedAt - startedAt}ms — ` +
            `${stats.indexedFiles} files, ${stats.totalChunks} chunks (${stats.status})`
        );
        return text(
          `Indexed ${root}: ${stats.indexedFiles} files, ` +
            `${stats.totalChunks} chunks (status: ${stats.status}).`
        );
      } catch (err) {
        const message = errorMessage(err);
        if (workspaceRoot) {
          indexingStates.set(workspaceRoot, {
            phase: 'failed',
            finishedAt: Date.now(),
            error: message,
          });
        }
        log.appendLine(`index_codebase: FAILED ${workspaceRoot ?? '<no workspace>'} — ${message}`);
        return text(`Failed to index workspace: ${message}`, true);
      }
    }
  );

  server.registerTool(
    'search_code',
    { description: SEARCH_CODE_DESCRIPTION, inputSchema: searchInput },
    async (args) => {
      try {
        const root = requireWorkspace(workspaceRoot);
        const context = factory.get();
        const filter = buildExtensionFilter(args.extensionFilter);
        const results = await context.semanticSearch(
          root,
          args.query,
          args.limit,
          undefined,
          filter
        );
        if (results.length === 0) {
          return text(`No results for "${args.query}" in ${root}.`);
        }
        return text(formatResults(args.query, root, results));
      } catch (err) {
        return text(`Search failed: ${errorMessage(err)}`, true);
      }
    }
  );

  server.registerTool(
    'clear_index',
    { description: CLEAR_INDEX_DESCRIPTION, inputSchema: clearInput },
    async () => {
      try {
        const root = requireWorkspace(workspaceRoot);
        const startedAt = Date.now();
        log.appendLine(`clear_index: starting ${root}`);
        const context = factory.get();
        await context.clearIndex(root);
        indexingStates.delete(root);
        log.appendLine(`clear_index: completed ${root} in ${Date.now() - startedAt}ms`);
        return text(`Cleared index for ${root}.`);
      } catch (err) {
        const message = errorMessage(err);
        log.appendLine(
          `clear_index: FAILED ${workspaceRoot ?? '<no workspace>'} — ${message}`
        );
        return text(`Failed to clear index: ${message}`, true);
      }
    }
  );

  server.registerTool(
    'get_indexing_status',
    { description: GET_INDEXING_STATUS_DESCRIPTION, inputSchema: statusInput },
    async () => {
      try {
        const root = requireWorkspace(workspaceRoot);
        const state = indexingStates.get(root);
        if (state) return text(describeState(root, state));

        // No in-process record. Try to ask the vector DB whether a collection
        // exists, but tolerate missing config — `get_indexing_status` should
        // remain useful even before the user has set their embedding API key.
        try {
          const context = factory.get();
          const has = await context.hasIndex(root);
          return text(
            has
              ? `Index exists for ${root} (no status from this session — created in a prior run).`
              : `No index for ${root}. Use index_codebase to create one.`
          );
        } catch (err) {
          if (err instanceof EmbeddingNotConfiguredError) {
            return text(
              `No indexing run recorded in this session for ${root}. ` +
                '(Embedding API key not configured, so prior-run state is unknown.)'
            );
          }
          return text(`Status unavailable: ${errorMessage(err)}`, true);
        }
      } catch (err) {
        return text(`Status unavailable: ${errorMessage(err)}`, true);
      }
    }
  );
}

function requireWorkspace(workspaceRoot: string | undefined): string {
  if (!workspaceRoot) throw new NoWorkspaceError();
  return workspaceRoot;
}

function buildExtensionFilter(exts: string[] | undefined): string | undefined {
  if (!exts || exts.length === 0) return undefined;
  const escaped = exts.map(
    (e) => `"${(e.startsWith('.') ? e : `.${e}`).replace(/"/g, '\\"')}"`
  );
  return `fileExtension in [${escaped.join(', ')}]`;
}

function formatResults(
  query: string,
  codebasePath: string,
  results: SemanticSearchResult[]
): string {
  const lines: string[] = [`Top ${results.length} results for "${query}" in ${codebasePath}:`];
  results.forEach((r, i) => {
    lines.push('');
    lines.push(
      `#${i + 1}  ${r.relativePath}:${r.startLine}-${r.endLine}  (${r.language}, score=${r.score.toFixed(3)})`
    );
    lines.push('```' + r.language);
    lines.push(r.content);
    lines.push('```');
  });
  return lines.join('\n');
}

function describeState(absolutePath: string, state: IndexingState): string {
  switch (state.phase) {
    case 'running':
      return (
        `Indexing in progress for ${absolutePath}: ` +
        `${state.progress.phase} ${state.progress.current}/${state.progress.total} ` +
        `(${state.progress.percentage}%).`
      );
    case 'completed':
      return (
        `Index ready for ${absolutePath}: ${state.indexedFiles} files, ` +
        `${state.totalChunks} chunks (status: ${state.status}).`
      );
    case 'failed':
      return `Last indexing run for ${absolutePath} failed: ${state.error}`;
  }
}

function text(message: string, isError = false): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: message }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof EmbeddingNotConfiguredError) return err.message;
  if (err instanceof NoWorkspaceError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

