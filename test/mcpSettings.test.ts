import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mergeMcp,
  removeMcp,
  normalizeProjectKey,
  pruneStaleVariants,
  SERVER_NAME,
} from '../src/mcp/settings';

const PORT = 12345;
const TOKEN = 'deadbeef';
const WS = '/Users/test/Workspace/proj';
const URL_FRAGMENT = `http://127.0.0.1:${PORT}/mcp?source=takeshicc`;

function projectMcp(out: Record<string, unknown>, ws: string): Record<string, unknown> {
  const projects = out.projects as Record<string, Record<string, unknown>>;
  const project = projects[ws];
  return project.mcpServers as Record<string, unknown>;
}

describe('mergeMcp', () => {
  it('creates projects.<ws>.mcpServers block on empty settings', () => {
    const out = mergeMcp(null, PORT, TOKEN, WS);
    const servers = projectMcp(out, WS);
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

  it('preserves unrelated top-level keys, sibling project entries, and sibling MCP servers', () => {
    const input = {
      numStartups: 7,
      projects: {
        '/other/project': {
          allowedTools: ['Read'],
        },
        [WS]: {
          mcpServers: { otherServer: { type: 'stdio', command: 'foo' } },
          lastSessionId: 'abc',
        },
      },
    };
    const out = mergeMcp(input, PORT, TOKEN, WS);
    expect(out.numStartups).toBe(7);

    const projects = out.projects as Record<string, Record<string, unknown>>;
    expect(projects['/other/project']).toEqual({ allowedTools: ['Read'] });

    const ours = projects[WS];
    expect(ours.lastSessionId).toBe('abc');
    const servers = ours.mcpServers as Record<string, unknown>;
    expect(servers.otherServer).toEqual({ type: 'stdio', command: 'foo' });
    expect((servers[SERVER_NAME] as { url: string }).url).toBe(URL_FRAGMENT);
  });

  it('replaces stale takeshicc entry for the same workspace with fresh port/token', () => {
    const stale = mergeMcp(null, 1111, 'old', WS);
    const fresh = mergeMcp(stale, PORT, TOKEN, WS);
    const servers = projectMcp(fresh, WS);
    expect(Object.keys(servers)).toEqual([SERVER_NAME]);
    const entry = servers[SERVER_NAME] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(entry.url).toBe(URL_FRAGMENT);
    expect(entry.headers['x-takeshicc-mcp-token']).toBe(TOKEN);
  });

  it('keeps separate entries per workspace', () => {
    const ws2 = '/Users/test/Workspace/other';
    const first = mergeMcp(null, 1111, 'tok-a', WS);
    const both = mergeMcp(first, 2222, 'tok-b', ws2);
    const servers1 = projectMcp(both, WS);
    const servers2 = projectMcp(both, ws2);
    expect((servers1[SERVER_NAME] as { url: string }).url).toContain(':1111');
    expect((servers2[SERVER_NAME] as { url: string }).url).toContain(':2222');
  });

  it('leaves a foreign top-level entry under the takeshicc name untouched', () => {
    const foreign = {
      mcpServers: {
        [SERVER_NAME]: { type: 'stdio', command: 'someone-elses-server' },
      },
    };
    const out = mergeMcp(foreign, PORT, TOKEN, WS);
    const top = out.mcpServers as Record<string, unknown>;
    expect(top[SERVER_NAME]).toEqual({
      type: 'stdio',
      command: 'someone-elses-server',
    });
  });
});

describe('removeMcp', () => {
  it('strips only the takeshicc entry under the matching workspace', () => {
    const withOurs = {
      projects: {
        [WS]: {
          mcpServers: {
            otherServer: { type: 'stdio', command: 'foo' },
            [SERVER_NAME]: {
              type: 'http',
              url: URL_FRAGMENT,
              headers: { 'x-takeshicc-mcp-token': TOKEN },
            },
          },
        },
      },
    };
    const out = removeMcp(withOurs, WS) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const servers = out.projects[WS].mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['otherServer']);
    expect(servers.otherServer).toEqual({ type: 'stdio', command: 'foo' });
  });

  it('drops the project mcpServers key when our entry was the only one', () => {
    const onlyOurs = mergeMcp(null, PORT, TOKEN, WS);
    const cleaned = removeMcp(onlyOurs, WS) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(cleaned.projects[WS].mcpServers).toBeUndefined();
  });

  it('preserves unrelated top-level and sibling-project keys when removing', () => {
    const input = mergeMcp({ numStartups: 7 }, PORT, TOKEN, WS);
    (input.projects as Record<string, unknown>)['/other'] = {
      allowedTools: ['Read'],
    };
    const cleaned = removeMcp(input, WS) as {
      numStartups: number;
      projects: Record<string, Record<string, unknown>>;
    };
    expect(cleaned.numStartups).toBe(7);
    expect(cleaned.projects['/other']).toEqual({ allowedTools: ['Read'] });
  });

  it('leaves a sibling workspace entry untouched', () => {
    const ws2 = '/Users/test/Workspace/other';
    const both = mergeMcp(mergeMcp(null, 1111, 'tok-a', WS), 2222, 'tok-b', ws2);
    const cleaned = removeMcp(both, WS) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const otherServers = cleaned.projects[ws2].mcpServers as Record<string, unknown>;
    expect(otherServers[SERVER_NAME]).toBeDefined();
  });

  it('leaves a foreign entry under the takeshicc name untouched', () => {
    const foreign = {
      projects: {
        [WS]: {
          mcpServers: {
            [SERVER_NAME]: {
              type: 'stdio',
              command: 'someone-elses-server',
            },
          },
        },
      },
    };
    const out = removeMcp(foreign, WS);
    expect(out).toEqual(foreign);
  });

  it('no-op on settings without projects', () => {
    const input = { numStartups: 7 };
    expect(removeMcp(input, WS)).toEqual(input);
  });

  it('no-op when the target workspace has no project entry', () => {
    const input = { projects: { '/other': { allowedTools: ['Read'] } } };
    expect(removeMcp(input, WS)).toEqual(input);
  });
});

describe('normalizeProjectKey', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p });
  }

  it('uppercases drive letter and converts backslashes on Windows', () => {
    setPlatform('win32');
    expect(normalizeProjectKey('e:\\Devel\\takeshicc')).toBe('E:/Devel/takeshicc');
  });

  it('leaves an already-normalized Windows path unchanged', () => {
    setPlatform('win32');
    expect(normalizeProjectKey('E:/Devel/takeshicc')).toBe('E:/Devel/takeshicc');
  });

  it('leaves POSIX paths untouched on POSIX', () => {
    setPlatform('linux');
    expect(normalizeProjectKey('/Users/test/proj')).toBe('/Users/test/proj');
  });

  it('does not transform paths on POSIX even with Windows-looking input', () => {
    setPlatform('darwin');
    expect(normalizeProjectKey('e:\\foo')).toBe('e:\\foo');
  });
});

describe('pruneStaleVariants', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('removes our entry from a differently-cased Windows variant', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const canonical = 'E:/Devel/takeshicc';
    const stale = 'e:\\Devel\\takeshicc';
    const input = mergeMcp(null, 1111, 'old', stale);
    const out = pruneStaleVariants(input, canonical) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(out.projects[stale].mcpServers).toBeUndefined();
  });

  it('preserves sibling MCP servers under a stale variant', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const canonical = 'E:/Devel/takeshicc';
    const stale = 'e:\\Devel\\takeshicc';
    const input = {
      projects: {
        [stale]: {
          mcpServers: {
            otherServer: { type: 'stdio', command: 'foo' },
            [SERVER_NAME]: {
              type: 'http',
              url: 'http://127.0.0.1:1111/mcp?source=takeshicc',
              headers: { 'x-takeshicc-mcp-token': 'old' },
            },
          },
        },
      },
    };
    const out = pruneStaleVariants(input, canonical) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const servers = out.projects[stale].mcpServers as Record<string, unknown>;
    expect(servers[SERVER_NAME]).toBeUndefined();
    expect(servers.otherServer).toEqual({ type: 'stdio', command: 'foo' });
  });

  it('does not touch the canonical key', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const canonical = 'E:/Devel/takeshicc';
    const input = mergeMcp(null, 1111, 'tok', canonical);
    const out = pruneStaleVariants(input, canonical) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const servers = out.projects[canonical].mcpServers as Record<string, unknown>;
    expect(servers[SERVER_NAME]).toBeDefined();
  });

  it('does not touch unrelated project keys', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const canonical = 'E:/Devel/takeshicc';
    const input = mergeMcp(null, 1111, 'tok', 'E:/Devel/other');
    const out = pruneStaleVariants(input, canonical) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const servers = out.projects['E:/Devel/other'].mcpServers as Record<
      string,
      unknown
    >;
    expect(servers[SERVER_NAME]).toBeDefined();
  });

  it('no-op on POSIX where keys are already canonical', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const input = mergeMcp(null, 1111, 'tok', '/Users/test/proj');
    expect(pruneStaleVariants(input, '/Users/test/proj')).toEqual(input);
  });
});
