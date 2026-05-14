import { describe, it, expect, afterAll } from 'vitest';
import type * as vscode from 'vscode';
import { McpHttpServer, MCP_PATH, MCP_TOKEN_HEADER } from '../src/mcp/server';

const noopLog = { appendLine: () => {} } as unknown as vscode.OutputChannel;
const server = new McpHttpServer(noopLog);

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

  it('completes the initialize handshake', async () => {
    const { status, text } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    expect(status).toBe(200);
    const parsed = parseSseJson(text) as {
      result: { serverInfo: { name: string } };
    };
    expect(parsed.result.serverInfo.name).toBe('takeshicc');
  });
});
