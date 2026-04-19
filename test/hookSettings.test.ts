import { describe, it, expect } from 'vitest';
import { mergeHooks, removeHooks } from '../src/hooks/settings';

const PORT = 12345;
const TOKEN = 'deadbeef';
const URL_FRAGMENT = `http://127.0.0.1:${PORT}/hook?source=takeshicc`;

describe('mergeHooks', () => {
  it('creates hooks block on empty settings', () => {
    const out = mergeHooks(null, PORT, TOKEN);
    expect(out.hooks).toBeDefined();
    const hooks = out.hooks as Record<string, unknown>;
    for (const ev of [
      'UserPromptSubmit',
      'PreToolUse',
      'Notification',
      'Stop',
      'StopFailure',
      'SessionEnd',
    ]) {
      expect(Array.isArray(hooks[ev])).toBe(true);
    }
    expect(hooks.SessionStart).toBeUndefined();
  });

  it('entries carry the source sentinel and token', () => {
    const out = mergeHooks(null, PORT, TOKEN);
    const hooks = out.hooks as Record<string, unknown[]>;
    const matcher = (hooks.UserPromptSubmit as Record<string, unknown>[])[0] as {
      hooks: { url: string; headers: Record<string, string> }[];
    };
    expect(matcher.hooks[0].url).toBe(URL_FRAGMENT);
    expect(matcher.hooks[0].headers['x-takeshicc-token']).toBe(TOKEN);
  });

  it('preserves unrelated settings and unrelated hook entries', () => {
    const input = {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
    };
    const out = mergeHooks(input, PORT, TOKEN);
    expect((out.permissions as Record<string, unknown>).allow).toEqual(['Bash(ls)']);
    const ups = (out.hooks as Record<string, unknown[]>).UserPromptSubmit as Record<
      string,
      unknown
    >[];
    expect(ups.length).toBe(2);
    expect(ups[0]).toEqual({
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    });
  });

  it('replaces stale takeshicc entry with fresh port/token', () => {
    const stale = mergeHooks(null, 1111, 'old');
    const fresh = mergeHooks(stale, PORT, TOKEN);
    const ups = (fresh.hooks as Record<string, unknown[]>).UserPromptSubmit as Record<
      string,
      unknown
    >[];
    expect(ups.length).toBe(1);
    const url = ((ups[0] as { hooks: { url: string }[] }).hooks[0].url);
    expect(url).toBe(URL_FRAGMENT);
  });
});

describe('removeHooks', () => {
  it('strips only takeshicc entries, leaves user hooks alone', () => {
    const withOurs = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo user' }] },
          {
            hooks: [
              {
                type: 'http',
                url: URL_FRAGMENT,
                headers: { 'x-takeshicc-token': TOKEN },
              },
            ],
          },
        ],
      },
    };
    const out = removeHooks(withOurs) as {
      hooks: { UserPromptSubmit: unknown[] };
    };
    expect(out.hooks.UserPromptSubmit.length).toBe(1);
    expect(out.hooks.UserPromptSubmit[0]).toEqual({
      hooks: [{ type: 'command', command: 'echo user' }],
    });
  });

  it('drops the event key when no entries remain', () => {
    const onlyOurs = mergeHooks(null, PORT, TOKEN);
    const cleaned = removeHooks(onlyOurs) as Record<string, unknown>;
    expect(cleaned.hooks).toBeUndefined();
  });

  it('drops the hooks key when no events remain', () => {
    const withOthers = {
      permissions: { allow: ['X'] },
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'http',
                url: URL_FRAGMENT,
                headers: { 'x-takeshicc-token': TOKEN },
              },
            ],
          },
        ],
      },
    };
    const cleaned = removeHooks(withOthers) as Record<string, unknown>;
    expect(cleaned.hooks).toBeUndefined();
    expect(cleaned.permissions).toEqual({ allow: ['X'] });
  });

  it('no-op on settings without hooks', () => {
    const input = { permissions: { allow: ['X'] } };
    expect(removeHooks(input)).toEqual(input);
  });
});
