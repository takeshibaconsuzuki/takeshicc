// Shared, dependency-free wire contract between the extension client and the
// standalone server process. No `vscode`, no Node-heavy imports — bundles
// cleanly into both outputs.

export const HOST = '127.0.0.1';

export const ROUTES = {
  whoami: '/whoami',
  ping: '/ping',
  updateChatState: '/update-chat-state',
  getLiveChats: '/get-live-chats',
  // Server-Sent Events stream: pushes the full LiveChatMetadata[] snapshot on
  // connect and again on every change to the live set.
  subscribeLiveChats: '/subscribe-live-chats',
} as const;

// A Claude Code chat's run state, derived from its hook events.
export type ChatState = 'idle' | 'busy';

// One live Claude Code chat — the element type returned by GET /get-live-chats
// and pushed (as a full array) over the /events SSE stream.
export interface LiveChatMetadata {
  chatId: string;
  state: ChatState;
  mTime: number; // epoch ms of the last hook event for this chat
  // Process-ancestor PIDs of this chat's Claude process, reported by the
  // reporter hook on every UserPromptSubmit (see src/reporter). One of them is
  // the PID of the VS Code terminal's shell — the extension matches it to a
  // Terminal so a live-chat row can reveal the terminal hosting the session.
  // Absent until the reporter has first run (or if it could not reach the
  // server).
  ancestorPids?: number[];
  // Human-readable label for the chat — the session's custom title, else its
  // auto-generated summary, else its first prompt (the same precedence Claude
  // Code's own resume picker uses). Resolved asynchronously by the server via
  // the Claude Agent SDK's getSessionInfo; absent until the first lookup for
  // this chat resolves (a brand-new session has no extractable summary yet).
  summary?: string;
}

// The subset of a Claude Code hook event payload the server relies on. Hooks
// POST their full JSON payload; only these fields are read. session_id and
// hook_event_name drive chat state; cwd is the session's working directory,
// used to locate its transcript when resolving the summary; ancestorPids is
// added by the reporter hook (see src/reporter) and carried through unchanged.
export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  ancestorPids?: number[];
}

// What an incoming hook event does to the chat it belongs to:
//   'busy' / 'idle' — set the chat to that run state
//   'end'           — the chat is over; drop it from the live set
//   'keep'          — carries no run-state signal; only refresh the chat's
//                     mTime, leaving its current state untouched
export type HookEffect = ChatState | 'end' | 'keep';

// Every Claude Code hook event mapped to its effect on chat state. 'busy'
// means Claude is actively advancing the chat; 'idle' means it is not — either
// the turn is over (Stop) or it is blocked waiting on the human (a permission
// dialog, an MCP elicitation). Mid-turn work events — tool use, subagents,
// tasks — are 'busy'. Events that can fire in any state (notifications,
// file/config changes) or that are pure housekeeping (compaction) are 'keep':
// they refresh liveness without flipping the state. Kept exhaustive so the
// server never has to guess — an unrecognized event is the only thing that
// falls back to 'busy'.
export const HOOK_EFFECTS: Record<string, HookEffect> = {
  // Session lifecycle.
  SessionStart: 'idle', // session (re)started or cleared — the chat is awaiting input
  Setup: 'busy', // `--init` / `--maintenance` initialization run
  SessionEnd: 'end', // chat closed

  // Turn boundaries.
  UserPromptSubmit: 'busy', // user submitted a prompt — the turn begins
  UserPromptExpansion: 'busy', // a typed slash command is expanding
  Stop: 'idle', // Claude finished responding — the turn ends
  StopFailure: 'idle', // the turn ended on an API error

  // Blocked on the human — 'idle' until they act, even with a turn still live.
  PermissionRequest: 'idle', // a permission dialog is open, awaiting a decision
  Elicitation: 'idle', // an MCP tool is waiting on user input

  // Tool use — mid-turn, Claude working.
  PreToolUse: 'busy',
  PermissionDenied: 'busy', // auto-mode denial — Claude may retry, no human
  PostToolUse: 'busy',
  PostToolUseFailure: 'busy',
  PostToolBatch: 'busy',
  ElicitationResult: 'busy', // the human answered — Claude resumes work

  // Subagents and tasks — mid-turn (a subagent ending does not end the turn).
  SubagentStart: 'busy',
  SubagentStop: 'busy',
  TaskCreated: 'busy',
  TaskCompleted: 'busy',

  // Context compaction — state-neutral housekeeping. It can fire mid-turn
  // (auto) or between turns (manual /compact), so it must never flip the state.
  PreCompact: 'keep',
  PostCompact: 'keep',

  // Worktree operations — Claude-initiated, mid-turn.
  WorktreeCreate: 'busy',
  WorktreeRemove: 'busy',

  // Can fire in any state — refresh liveness only, never flip the state.
  Notification: 'keep',
  TeammateIdle: 'keep',
  CwdChanged: 'keep',
  FileChanged: 'keep',
  ConfigChange: 'keep',
  InstructionsLoaded: 'keep',
};

// The hook events the extension registers in settings.local.json: every event
// in HOOK_EFFECTS. Registering the full set means the server observes every
// lifecycle point — so mTime tracks true last activity, and the 'busy'
// fallback is reserved purely for events Claude Code adds in the future.
export const HOOK_REGISTER_EVENTS: readonly string[] =
  Object.keys(HOOK_EFFECTS);
