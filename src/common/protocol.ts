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
  // GET /instances — live VS Code instances currently registered with the
  // per-repo server. Used by extension UI to indicate active worktrees.
  instances: '/instances',
  // POST /create-worktree — start a background job that creates a linked
  // worktree and runs the optional bootstrap command in it; the job outlives
  // the request and the requesting window. Returns the job id immediately.
  createWorktree: '/create-worktree',
  // GET /worktreeJobs — Server-Sent Events stream of the server's *active*
  // worktree-create jobs (tracked like the instance registry: present while
  // running, dropped when finished). A subscriber gets a snapshot of the
  // running job ids on connect, then a `done` per job as it finishes.
  worktreeJobs: '/worktreeJobs',
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

export interface InstancesResponseItem {
  groupId: string;
  worktreePath: string;
}

export interface InstancesResponse {
  instances: InstancesResponseItem[];
}

export interface CreateWorktreeRequest {
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  bootstrapCommand: string;
}

// Rejection when required fields are missing. The server is the authority
// (it re-validates untrusted input); the client pre-checks with the same
// message to skip a round-trip — one source so the two can't drift.
export const MISSING_WORKTREE_FIELDS_ERROR =
  'Branch name, base branch, and worktree path are required.';

// POST /create-worktree ack. Exactly one field is set: `jobId` ⇒ the job is
// running and addressable on the events stream; `error` ⇒ rejected before any
// job started (validation), nothing to subscribe to.
export interface CreateWorktreeResponse {
  jobId?: string;
  error?: string;
}

// An in-flight worktree-create job, identified by the worktree it produces so
// every window can list that worktree (with a progress indicator) before its
// bootstrap finishes — `jobId` stays the addressable token on the stream.
export interface WorktreeJob {
  jobId: string;
  worktreePath: string;
}

// A frame on the GET /worktreeJobs stream. On connect: one `snapshot` of the
// active jobs. Then, per job: a `created` once `git worktree add` lands the
// worktree on disk (bootstrap continues — the list should refresh and show it
// as in-progress), and finally a `done` when the job finishes (after which the
// server stops tracking it). The bootstrap output is not streamed — it goes to
// the server log; `error` is the summary to surface, the log has detail.
export type WorktreeJobsMessage =
  | { type: 'snapshot'; jobs: WorktreeJob[] }
  | { type: 'created'; jobId: string; worktreePath: string }
  | { type: 'done'; jobId: string; worktreePath: string; status: 'ok' }
  | { type: 'done'; jobId: string; worktreePath: string; status: 'failed'; error: string };
