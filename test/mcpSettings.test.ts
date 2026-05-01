import { describe, it, expect } from 'vitest';
import { mergeMcp, removeMcp, SERVER_NAME } from '../src/mcp/settings';

const PORT = 12345;
const TOKEN = 'deadbeef';
const URL_FRAGMENT = `http://127.0.0.1:${PORT}/mcp?source=takeshicc`;

describe('mergeMcp', () => {
  it('creates mcpServers block on empty settings', () => {
    const out = mergeMcp(null, PORT, TOKEN);
    const servers = out.mcpServers as Record<string, unknown>;
    expect(servers).toBeDefined();
    const entry = servers[SERVER_NAME] as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(entry.type).toBe('http');
    expect(entry.url).toBe(URL_FRAGMENT);
    expect(entry.headers['x-takeshicc-mcp-token']).toBe(TOKEN);
  });

  it('preserves unrelated top-level keys and sibling MCP servers', () => {
    const input = {
      numStartups: 7,
      mcpServers: {
        otherServer: { type: 'stdio', command: 'foo' },
      },
    };
    const out = mergeMcp(input, PORT, TOKEN);
    expect(out.numStartups).toBe(7);
    const servers = out.mcpServers as Record<string, unknown>;
    expect(servers.otherServer).toEqual({ type: 'stdio', command: 'foo' });
    expect((servers[SERVER_NAME] as { url: string }).url).toBe(URL_FRAGMENT);
  });

  it('replaces stale takeshicc entry with fresh port/token', () => {
    const stale = mergeMcp(null, 1111, 'old');
    const fresh = mergeMcp(stale, PORT, TOKEN);
    const servers = fresh.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual([SERVER_NAME]);
    const entry = servers[SERVER_NAME] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(entry.url).toBe(URL_FRAGMENT);
    expect(entry.headers['x-takeshicc-mcp-token']).toBe(TOKEN);
  });
});

describe('removeMcp', () => {
  it('strips only the takeshicc entry, leaves other servers alone', () => {
    const withOurs = {
      mcpServers: {
        otherServer: { type: 'stdio', command: 'foo' },
        [SERVER_NAME]: {
          type: 'http',
          url: URL_FRAGMENT,
          headers: { 'x-takeshicc-mcp-token': TOKEN },
        },
      },
    };
    const out = removeMcp(withOurs) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(out.mcpServers)).toEqual(['otherServer']);
    expect(out.mcpServers.otherServer).toEqual({ type: 'stdio', command: 'foo' });
  });

  it('drops the mcpServers key when our entry was the only one', () => {
    const onlyOurs = mergeMcp(null, PORT, TOKEN);
    const cleaned = removeMcp(onlyOurs) as Record<string, unknown>;
    expect(cleaned.mcpServers).toBeUndefined();
  });

  it('preserves unrelated top-level keys when removing', () => {
    const input = mergeMcp({ numStartups: 7 }, PORT, TOKEN);
    const cleaned = removeMcp(input) as Record<string, unknown>;
    expect(cleaned.numStartups).toBe(7);
    expect(cleaned.mcpServers).toBeUndefined();
  });

  it('leaves a foreign entry under the takeshicc name untouched', () => {
    const foreign = {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'stdio',
          command: 'someone-elses-server',
        },
      },
    };
    const out = removeMcp(foreign);
    expect(out).toEqual(foreign);
  });

  it('no-op on settings without mcpServers', () => {
    const input = { numStartups: 7 };
    expect(removeMcp(input)).toEqual(input);
  });
});
