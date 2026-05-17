// Shared, dependency-free wire contract between the extension client and the
// standalone server process. No `vscode`, no Node-heavy imports — bundles
// cleanly into both outputs.

export const HOST = '127.0.0.1';

export const ROUTES = {
  register: '/register',
  // GET /ping?instanceId=<id> — the heartbeat. The id is the one the server
  // handed back from /register; 2xx refreshes liveness, non-2xx means the
  // client should reconnect.
  ping: '/ping',
} as const;

// POST /register — a client's connect handshake. The client announces its
// worktree and build; the server admits it into its registry (the seed for
// future cross-instance message routing) or rejects it as transient.
export interface RegisterRequest {
  worktreePath: string;
  version: string;
}

// `registered`: groupId is matched by the client to catch a wrong server on
// the port; mainWorktreePath keeps that mismatch error readable; instanceId
// is echoed on every heartbeat. `transient` ⇒ retry (stale build, or this
// worktree already has a live instance).
export type RegisterResponse =
  | { status: 'registered'; groupId: string; mainWorktreePath: string; instanceId: string }
  | { status: 'transient'; reason: string };
