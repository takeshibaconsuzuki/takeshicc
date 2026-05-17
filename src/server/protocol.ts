// Shared, dependency-free wire contract between the extension client and the
// standalone server process. No `vscode`, no Node-heavy imports — bundles
// cleanly into both outputs.

export const HOST = '127.0.0.1';

export const ROUTES = {
  whoami: '/whoami',
  ping: '/ping',
  updateChatState: '/update-chat-state',
  // Server-Sent Events stream: pushes the full LiveChatMetadata[] snapshot on
  // connect and again on every change to the live set. Takes an optional
  // `?tail=<n>` query param — the subscriber's desired tail length (its
  // `takeshicc.tailLines` setting); the server resolves each chat's `tail` at
  // the max n across all connected subscribers.
  subscribeLiveChats: '/subscribe-live-chats',
  // Synchronous read of past (non-live) chats for a given worktree. Takes a
  // `?dir=` query param and returns HistoricalChatMetadata[].
  getHistoricalChats: '/get-historical-chats',
} as const;

// A Claude Code chat's run state, derived from its hook events.
export type ChatState = 'idle' | 'busy';

// One live Claude Code chat — the element type pushed (as a full array) over
// the /subscribe-live-chats SSE stream.
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
  // The last N text lines of the chat's transcript — visible user/assistant
  // text only (string content and text blocks), regardless of role or message
  // count. Refreshed by the server's periodic poll alongside `summary`. N is
  // the subscriber's `takeshicc.tailLines` setting, passed as the `?tail=`
  // query param on /subscribe-live-chats; the server reads at the max N across
  // subscribers, so a window may receive more lines than it asked for and
  // should slice to its own N. Absent until the first poll after some
  // subscriber requested a non-zero N.
  tail?: string[];
}

// One past Claude Code chat — the element type returned by
// GET /get-historical-chats. These are sessions that exist on disk but are not
// in the live set: finished chats the user can resume. Sourced from the Claude
// Agent SDK's listSessions, scoped to a single git worktree (the request's
// `dir`, with the SDK's includeWorktrees flag off so sibling worktrees of the
// same repo are excluded).
export interface HistoricalChatMetadata {
  chatId: string;
  // Display label — the session's custom title, else its auto-generated
  // summary, else its first prompt. Same precedence as LiveChatMetadata.summary
  // and Claude Code's own resume picker.
  summary: string;
  mTime: number; // epoch ms of the session's last modification
  // The last N text lines of the chat's transcript — same "visible
  // conversation" extraction as LiveChatMetadata.tail. NOT supplied by the
  // server: the extension client reads it once via the Claude Agent SDK
  // (transcripts of past chats are immutable, so a single read suffices) and
  // fills it in before rendering. Absent until that read completes, or when
  // `takeshicc.tailLines` is 0.
  tail?: string[];
}

// The subset of a Claude Code hook event payload the server relies on. Hooks
// POST their full JSON payload; only these fields are read. session_id and
// hook_event_name drive chat state; cwd is the session's working directory and
// transcript_path its JSONL transcript file — both stashed so the periodic
// refresher can resolve the summary and read the tail; ancestorPids is added
// by the reporter hook (see src/reporter) and carried through unchanged.
export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
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
// dialog, an MCP elicitation). Mid-turn tool-use events are 'busy'. Subagent
// and task events are 'keep', not 'busy': they run inside a turn (already
// 'busy' there) but can also outlive it — Claude Code spawns background
// subagents/tasks that finish well after Stop — so they must not drive the
// state. Events that can fire in any state (notifications, file/config
// changes) or that are pure housekeeping (compaction) are 'keep' too: they
// refresh liveness without flipping the state. Kept exhaustive so the server
// never has to guess — an unrecognized event is the only thing that falls
// back to 'busy'.
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

  // Subagents and tasks — 'keep', never 'busy'. They run within a turn (where
  // the state is already 'busy' from UserPromptSubmit and tool use) but can
  // also outlive it: Claude Code spawns background subagents/tasks that finish
  // well after Stop — a post-turn recap is one. Marking these 'busy' let a
  // late SubagentStop/TaskCompleted flip an already-idle chat back to busy,
  // with no following Stop to clear it — stuck busy forever. 'keep' refreshes
  // liveness only and leaves the turn's run-state to UserPromptSubmit/Stop.
  SubagentStart: 'keep',
  SubagentStop: 'keep',
  TaskCreated: 'keep',
  TaskCompleted: 'keep',

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
