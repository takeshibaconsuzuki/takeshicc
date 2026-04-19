import type { HookSessionStatus } from '../hooks/stateMachine';

export type SessionStatus =
  | 'inactive'
  | 'busy'
  | 'awaiting'
  | 'awaiting_permission';

/**
 * Map hook-state-machine status to the UI's SessionStatus vocabulary. Both
 * `idle` (Stop fired) and `awaiting_input` (idle_prompt notification) render
 * as 🟢 awaiting — they mean the same thing to the user.
 */
export function mapHookStatus(s: HookSessionStatus): SessionStatus {
  switch (s) {
    case 'busy':
      return 'busy';
    case 'idle':
    case 'awaiting_input':
      return 'awaiting';
    case 'awaiting_permission':
      return 'awaiting_permission';
  }
}
