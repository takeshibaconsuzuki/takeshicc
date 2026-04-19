import * as vscode from 'vscode';
import type { HookEvent } from './server';

export type HookSessionStatus =
  | 'busy'
  | 'idle'
  | 'awaiting_permission'
  | 'awaiting_input';

export interface HookSessionState {
  sessionId: string;
  cwd?: string;
  status: HookSessionStatus;
  currentTool?: string;
  lastEventAt: number;
}

/**
 * Per-session state machine driven by hook events. Authoritative status
 * source for every session the sidebar shows. Sessions with no entry here
 * (never seeded, never heard a hook from) render as `inactive` — no emoji.
 */
export class HookStateMachine implements vscode.Disposable {
  private readonly states = new Map<string, HookSessionState>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(sessionId: string): HookSessionState | undefined {
    return this.states.get(sessionId);
  }

  knownSessionIds(): Iterable<string> {
    return this.states.keys();
  }

  /**
   * Forget a session. Used when its terminal is destroyed abruptly — claude
   * was killed mid-session so no `SessionEnd` hook will ever fire, and the
   * last known state (usually idle/awaiting) would otherwise linger forever.
   */
  clear(sessionId: string): void {
    if (this.states.delete(sessionId)) this.emitter.fire();
  }

  /**
   * Seed a session as idle (🟢 awaiting) without a hook event. Used when the
   * extension spawns or adopts a claude process — `SessionStart` on `--resume`
   * isn't reliably fired by Claude Code in practice, so we pre-populate the
   * state so the sidebar shows green the moment the terminal is launched. A
   * real hook event arriving later overwrites this seed; if the seed is
   * already there (stale from a prior run), we overwrite it back to idle.
   */
  seedIdle(sessionId: string, cwd?: string): void {
    const next: HookSessionState = {
      sessionId,
      cwd,
      status: 'idle',
      currentTool: undefined,
      lastEventAt: this.now(),
    };
    const prev = this.states.get(sessionId);
    if (prev && statesEqual(prev, next)) return;
    this.states.set(sessionId, next);
    this.emitter.fire();
  }

  handle(event: HookEvent): void {
    const id = event.session_id;

    if (event.hook_event_name === 'SessionEnd') {
      if (this.states.delete(id)) this.emitter.fire();
      return;
    }

    const prev = this.states.get(id);
    const base: HookSessionState = prev
      ? { ...prev }
      : {
          sessionId: id,
          cwd: event.cwd,
          status: 'idle',
          lastEventAt: this.now(),
        };

    let next: HookSessionState | null = null;

    switch (event.hook_event_name) {
      case 'UserPromptSubmit':
        next = { ...base, status: 'busy', currentTool: undefined };
        break;
      case 'PreToolUse':
        next = { ...base, status: 'busy', currentTool: event.tool_name };
        break;
      case 'Notification':
        if (event.notification_type === 'permission_prompt') {
          next = { ...base, status: 'awaiting_permission' };
        } else if (event.notification_type === 'idle_prompt') {
          next = { ...base, status: 'awaiting_input' };
        }
        // Other notification types (auth_success, elicitation_dialog, ...)
        // don't carry status info — ignore.
        break;
      case 'Stop':
      case 'StopFailure':
        next = { ...base, status: 'idle', currentTool: undefined };
        break;
      default:
        // Unknown event — ignore to stay forward-compatible with new hooks.
        return;
    }

    if (!next) return;
    next.lastEventAt = this.now();
    if (event.cwd) next.cwd = event.cwd;

    if (statesEqual(prev, next)) return;
    this.states.set(id, next);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
    this.states.clear();
  }
}

function statesEqual(
  a: HookSessionState | undefined,
  b: HookSessionState
): boolean {
  if (!a) return false;
  return (
    a.status === b.status &&
    a.currentTool === b.currentTool &&
    a.cwd === b.cwd &&
    a.sessionId === b.sessionId
  );
}
