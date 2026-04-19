import { describe, it, expect, beforeEach } from 'vitest';
import { HookStateMachine } from '../src/hooks/stateMachine';
import type { HookEvent } from '../src/hooks/server';

const SID = '01010101-aaaa-bbbb-cccc-000000000001';

function mk(name: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { session_id: SID, hook_event_name: name, ...extra };
}

describe('HookStateMachine', () => {
  let sm: HookStateMachine;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    sm = new HookStateMachine(() => now);
  });

  it('UserPromptSubmit → busy, clears currentTool', () => {
    sm.seedIdle(SID, '/w');
    sm.handle(mk('PreToolUse', { tool_name: 'Bash' }));
    expect(sm.get(SID)?.currentTool).toBe('Bash');
    sm.handle(mk('UserPromptSubmit'));
    expect(sm.get(SID)?.status).toBe('busy');
    expect(sm.get(SID)?.currentTool).toBeUndefined();
  });

  it('PreToolUse captures tool_name', () => {
    sm.seedIdle(SID);
    sm.handle(mk('PreToolUse', { tool_name: 'Write' }));
    expect(sm.get(SID)).toMatchObject({ status: 'busy', currentTool: 'Write' });
  });

  it('Notification permission_prompt → awaiting_permission', () => {
    sm.seedIdle(SID);
    sm.handle(
      mk('Notification', { notification_type: 'permission_prompt' })
    );
    expect(sm.get(SID)?.status).toBe('awaiting_permission');
  });

  it('Notification idle_prompt → awaiting_input', () => {
    sm.seedIdle(SID);
    sm.handle(mk('Notification', { notification_type: 'idle_prompt' }));
    expect(sm.get(SID)?.status).toBe('awaiting_input');
  });

  it('Notification with unrelated type does not change state', () => {
    sm.seedIdle(SID);
    sm.handle(mk('UserPromptSubmit'));
    sm.handle(mk('Notification', { notification_type: 'auth_success' }));
    expect(sm.get(SID)?.status).toBe('busy');
  });

  it('Stop → idle and clears currentTool', () => {
    sm.seedIdle(SID);
    sm.handle(mk('PreToolUse', { tool_name: 'Edit' }));
    sm.handle(mk('Stop'));
    expect(sm.get(SID)).toMatchObject({
      status: 'idle',
      currentTool: undefined,
    });
  });

  it('StopFailure → idle (e.g. rate limit, user interruption)', () => {
    sm.seedIdle(SID);
    sm.handle(mk('PreToolUse', { tool_name: 'Bash' }));
    sm.handle(mk('StopFailure'));
    expect(sm.get(SID)).toMatchObject({
      status: 'idle',
      currentTool: undefined,
    });
  });

  it('SessionEnd deletes the entry', () => {
    sm.seedIdle(SID);
    sm.handle(mk('SessionEnd', { reason: 'other' }));
    expect(sm.get(SID)).toBeUndefined();
  });

  it('tolerates events arriving without a prior seed', () => {
    sm.handle(mk('PreToolUse', { tool_name: 'Bash', cwd: '/w' }));
    expect(sm.get(SID)).toMatchObject({
      status: 'busy',
      currentTool: 'Bash',
      cwd: '/w',
    });
  });

  it('unknown events do not create entries or fire events', () => {
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.handle(mk('Ragnarok'));
    expect(sm.get(SID)).toBeUndefined();
    expect(fires).toBe(0);
  });

  it('fires onDidChange only on actual state transitions', () => {
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.seedIdle(SID);
    sm.seedIdle(SID); // idempotent — same state
    expect(fires).toBe(1);
    sm.handle(mk('UserPromptSubmit'));
    expect(fires).toBe(2);
  });

  it('lastEventAt updates on each handled event', () => {
    sm.seedIdle(SID);
    const t1 = sm.get(SID)?.lastEventAt;
    now = 2_000_000;
    sm.handle(mk('UserPromptSubmit'));
    const t2 = sm.get(SID)?.lastEventAt;
    expect(t2).toBe(2_000_000);
    expect(t2).not.toBe(t1);
  });

  it('isolates state across sessions', () => {
    const OTHER = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    sm.seedIdle(SID);
    sm.seedIdle(OTHER);
    sm.handle(mk('UserPromptSubmit'));
    expect(sm.get(SID)?.status).toBe('busy');
    expect(sm.get(OTHER)?.status).toBe('idle');
  });

  it('seedIdle creates an idle entry when none exists', () => {
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.seedIdle(SID, '/w');
    expect(sm.get(SID)).toMatchObject({
      status: 'idle',
      cwd: '/w',
      currentTool: undefined,
    });
    expect(fires).toBe(1);
  });

  it('seedIdle is idempotent when state is already idle', () => {
    sm.seedIdle(SID);
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.seedIdle(SID);
    expect(fires).toBe(0);
  });

  it('seedIdle overwrites a stale busy state (e.g. previous run)', () => {
    sm.seedIdle(SID);
    sm.handle(mk('PreToolUse', { tool_name: 'Bash' }));
    expect(sm.get(SID)?.status).toBe('busy');
    sm.seedIdle(SID);
    expect(sm.get(SID)).toMatchObject({
      status: 'idle',
      currentTool: undefined,
    });
  });

  it('a real hook event after seedIdle still transitions correctly', () => {
    sm.seedIdle(SID);
    sm.handle(mk('UserPromptSubmit'));
    expect(sm.get(SID)?.status).toBe('busy');
  });

  it('clear removes the session and fires a change', () => {
    sm.seedIdle(SID);
    expect(sm.get(SID)).toBeDefined();
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.clear(SID);
    expect(sm.get(SID)).toBeUndefined();
    expect(fires).toBe(1);
  });

  it('clear on an unknown session is a no-op', () => {
    let fires = 0;
    sm.onDidChange(() => fires++);
    sm.clear(SID);
    expect(fires).toBe(0);
  });
});
