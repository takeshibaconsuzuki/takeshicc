import { describe, it, expect, afterAll } from 'vitest';
import { McpHttpServer, MCP_PATH, MCP_TOKEN_HEADER } from '../src/mcp/server';

const server = new McpHttpServer();

afterAll(() => server.dispose());

async function rpc(body: unknown): Promise<{ status: number; text: string }> {
  const { port, token } = await server.getConfig();
  const r = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [MCP_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

function parseSseJson(text: string): { result?: unknown; error?: unknown } {
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error(`no data line in ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

describe('McpHttpServer', () => {
  it('rejects requests without the auth token', async () => {
    const { port } = await server.getConfig();
    const r = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('lists the four claude-context tools', async () => {
    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    const { status, text } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(status).toBe(200);
    const parsed = parseSseJson(text) as { result: { tools: { name: string }[] } };
    const names = parsed.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'clear_index',
      'get_indexing_status',
      'index_codebase',
      'search_code',
    ]);
  });

  it('search_code surfaces "embedding not configured" error when API key is unset', async () => {
    const { text } = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'search_code',
        arguments: { path: '/tmp', query: 'anything' },
      },
    });
    const parsed = parseSseJson(text) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0].text).toMatch(/embedding API key is not set/i);
  });

  it('get_indexing_status reports unknown index when nothing has run', async () => {
    const { text } = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'get_indexing_status',
        arguments: { path: '/tmp' },
      },
    });
    const parsed = parseSseJson(text) as {
      result: { content: { text: string }[] };
    };
    // No state recorded; without embedding config we surface a friendly
    // "no run recorded in this session" message rather than a hard error.
    expect(parsed.result.content[0].text).toMatch(/No indexing run recorded/i);
  });

  it('rejects relative paths', async () => {
    const { text } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'clear_index',
        arguments: { path: 'relative/path' },
      },
    });
    const parsed = parseSseJson(text) as
      | { result: { content: { text: string }[]; isError?: boolean } }
      | { error: { message: string } };
    if ('error' in parsed) {
      expect(parsed.error.message).toMatch(/absolute/i);
    } else {
      expect(parsed.result.content[0].text).toMatch(/absolute/i);
    }
  });
});
