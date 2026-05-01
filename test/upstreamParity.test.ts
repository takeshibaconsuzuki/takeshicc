import { describe, it, expect, afterAll } from 'vitest';
import {
  INDEX_CODEBASE_DESCRIPTION,
  SEARCH_CODE_DESCRIPTION,
  CLEAR_INDEX_DESCRIPTION,
  GET_INDEXING_STATUS_DESCRIPTION,
} from '../src/mcp/contextTools';
import { McpHttpServer, MCP_PATH, MCP_TOKEN_HEADER } from '../src/mcp/server';

// Snapshot of @zilliz/claude-context-mcp@0.1.11 dist/index.js — the four
// tool definitions exactly as upstream advertises them. If upstream changes
// in a way agents would notice, this snapshot must be updated in lockstep
// (and INDEX_CODEBASE_DESCRIPTION etc. updated to match).
const UPSTREAM_INDEX_CODEBASE_DESCRIPTION = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;

const UPSTREAM_SEARCH_CODE_DESCRIPTION = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

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
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

const UPSTREAM_CLEAR_INDEX_DESCRIPTION =
  'Clear the search index. IMPORTANT: You MUST provide an absolute path.';

const UPSTREAM_GET_INDEXING_STATUS_DESCRIPTION =
  'Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.';

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

const UPSTREAM_TOOLS: ToolSchema[] = [
  {
    name: 'index_codebase',
    description: UPSTREAM_INDEX_CODEBASE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'ABSOLUTE path to the codebase directory to index.',
        },
        force: {
          type: 'boolean',
          description: 'Force re-indexing even if already indexed',
          default: false,
        },
        splitter: {
          type: 'string',
          description:
            "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
          enum: ['ast', 'langchain'],
          default: 'ast',
        },
        customExtensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
          default: [],
        },
        ignorePatterns: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
          default: [],
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: UPSTREAM_SEARCH_CODE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'ABSOLUTE path to the codebase directory to search in.',
        },
        query: {
          type: 'string',
          description: 'Natural language query to search for in the codebase',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
          maximum: 50,
        },
        extensionFilter: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
          default: [],
        },
      },
      required: ['path', 'query'],
    },
  },
  {
    name: 'clear_index',
    description: UPSTREAM_CLEAR_INDEX_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'ABSOLUTE path to the codebase directory to clear.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_indexing_status',
    description: UPSTREAM_GET_INDEXING_STATUS_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'ABSOLUTE path to the codebase directory to check status for.',
        },
      },
      required: ['path'],
    },
  },
];

const server = new McpHttpServer();
afterAll(() => server.dispose());

async function listTools(): Promise<ToolSchema[]> {
  const { port, token } = await server.getConfig();
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    [MCP_TOKEN_HEADER]: token,
  };
  await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });
  const r = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '))!;
  const parsed = JSON.parse(dataLine.slice('data: '.length));
  return parsed.result.tools as ToolSchema[];
}

/**
 * Strip cosmetic differences that don't affect agent behavior:
 * - the JSON-Schema `$schema` field added by zod-to-json-schema
 * - the SDK's `execution.taskSupport` annotation (new in SDK 1.x; absent
 *   from the older SDK upstream uses)
 * - object key order (handled implicitly by deep-equality)
 */
function normalize(tool: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    inputSchema: stripSchemaArtifacts(tool.inputSchema as Record<string, unknown>),
  };
  return cleaned;
}

function stripSchemaArtifacts(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignore, ...rest } = schema;
  return rest;
}

describe('upstream tool-surface parity (@zilliz/claude-context-mcp@0.1.11)', () => {
  it('our descriptions are byte-identical to upstream', () => {
    expect(INDEX_CODEBASE_DESCRIPTION).toBe(UPSTREAM_INDEX_CODEBASE_DESCRIPTION);
    expect(SEARCH_CODE_DESCRIPTION).toBe(UPSTREAM_SEARCH_CODE_DESCRIPTION);
    expect(CLEAR_INDEX_DESCRIPTION).toBe(UPSTREAM_CLEAR_INDEX_DESCRIPTION);
    expect(GET_INDEXING_STATUS_DESCRIPTION).toBe(UPSTREAM_GET_INDEXING_STATUS_DESCRIPTION);
  });

  it('advertises every upstream tool with matching schema', async () => {
    const advertised = await listTools();
    const byName = new Map(advertised.map((t) => [t.name, t]));
    for (const expected of UPSTREAM_TOOLS) {
      const actual = byName.get(expected.name);
      expect(actual, `missing tool ${expected.name}`).toBeDefined();
      expect(normalize(actual as unknown as Record<string, unknown>)).toEqual(
        expected as unknown as Record<string, unknown>
      );
    }
  });

  it('does not omit any upstream tool', async () => {
    const advertised = await listTools();
    const advertisedNames = new Set(advertised.map((t) => t.name));
    for (const expected of UPSTREAM_TOOLS) {
      expect(advertisedNames.has(expected.name)).toBe(true);
    }
  });
});
