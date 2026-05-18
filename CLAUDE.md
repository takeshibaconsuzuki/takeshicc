# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Writing documentation** (this file and any other docs or prose you produce
in this repo — READMEs, design notes, doc comments): write for durability.
Capture the high-level ideas, architecture, and rationale that stay true
across refactors; omit implementation details that a reader can quickly
recover from the code and that would need re-syncing whenever the code changes
(the files in a directory, an exhaustive option list, the current shape of one
module). Express each point at the level of the lasting concept, not a
concrete instance that could be renamed or deleted without warning — but do
name the command, script, or file a reader must run or open to act on, since
that is an entry point, not churning detail. Lists are
fine when their entries are themselves durable concepts; an enumeration that
just mirrors today's code is the smell. When updating, rewrite and tighten in
place rather than appending.

# takeshicc

A small VS Code extension (also runs in Cursor, a VS Code fork): a worktree
sidebar plus editor-layout/terminal commands, backed by a per-repository
local HTTP server.

## Build

```
npm install        # postinstall rebuilds native modules (see Native modules)
npm run build:all  # or build:ext / build:server; watch:ext / watch:server
npm run lint       # eslint (lint:fix to autofix); format / format:check = prettier
npm run vsix       # package the .vsix
npm run rebuild    # re-run the native-module ABI rebuild standalone
```

esbuild (`scripts/esbuild.mjs`) bundles each entry point into one CJS file
under `out/`, leaving host-provided and native dependencies external.
Type-checking runs *inside* every build (no separate typecheck step;
`tsconfig.json` is `noEmit`); there is no test suite. Prettier owns
formatting and ESLint defers to it (`eslint-config-prettier`). On
macOS/Linux use system Node 20+; on Windows the pinned toolchain is
bootstrapped by `scripts/setup-node.ps1`.

## Source layout

- `src/extension/` — runs in the extension host; may `import 'vscode'`.
  Entry: `extension.ts`.
- `src/server/` — standalone Node process; must **never** `import 'vscode'`.
  Entry: `server.ts`.
- `src/common/` — vscode-free helpers shared by both sides (incl. the HTTP
  wire contract); must bundle into both outputs.

## Server lifecycle & concurrency model

- **Group identity.** `resolveGitMetadata` yields two canonical paths: the
  repo's main-worktree path (shared by all linked worktrees → one server) and
  *this* worktree's root (`--show-toplevel`, per-instance, subdirectory-proof).
  It is the *sole* path canonicalizer (the only other `canonicalizePath` use
  normalizes user-authored config keys in `lookupGroup`), so everything
  carried by `GitMetadata`/`ResolvedGroup`/the wire is already canonical.
  `groupIdFor`/`instanceIdFor` sha256 those paths into *namespaced* opaque
  ids (`group_`/`instance_`) — the raw hash is private so a worktree that
  *is* its main worktree can't collide its group and instance ids.
  `lookupGroup` composes the one `ResolvedGroup` carrier downstream reads.
  `groupId` is the routing token and the `/register` identity check (it
  matches across processes only because client and server hash the same
  canonical path); `mainWorktreePath` stays the config key and diagnostic.
- **Opt-in.** `~/.takeshicc/config.json` maps a main-worktree path to its
  `{ port, idleTimeoutMs }`. Unless the workspace resolves to a configured git
  repo the feature stays silently off; only a malformed config surfaces an
  error.
- **Port bind is the mutex.** `getOrCreateServer` loops forever converging:
  `POST /register` (announcing the worktree path + build version); if refused,
  spawn a detached server, poll until it admits us. Duplicate spawns are
  harmless (loser exits(0) on `EADDRINUSE`). A register answered with a
  different `groupId` means another process owns the port → error, no retry
  (the response also carries `mainWorktreePath` so that error names the
  offending repo).
- **Registry.** A successful `/register` admits the client into the server's
  in-memory map keyed by `instanceId` (the `instance_…` id of the
  canonicalized worktree path, server-derived and handed back so the client
  echoes it on every heartbeat) — the seed for future message routing between
  the VS Code instances sharing one server. A stale build or a worktree whose instance is
  already registered is rejected as *transient*; the client keeps polling and
  converges once the offending instance is pruned (freeing the slot to
  re-register with the still-running shared server) or, if it was the sole
  instance, the now-empty server idle-exits and the client respawns one.
  `GET /instance-events` is the UI feed: a subscriber gets a snapshot of live
  instances, then register/unregister deltas so sibling-window badges stay
  current without polling.
- **Spawned as plain Node** via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`;
  logs to `~/.takeshicc/server-<port>.log`.
- **Idle/heartbeat.** Per-instance liveness moves *only* on successful
  register and `/ping?instanceId=…` (every `idleTimeoutMs/3`), never on a
  rejected request. A periodic sweep prunes instances whose heartbeat lapsed
  past `idleTimeoutMs` (3x the heartbeat, so a live one is never pruned mid-
  flight); since survivors are therefore always fresh, the server exits
  exactly when the registry is empty, no in-flight job is outstanding
  (`activeServerJobs`), *and* it has outlived
  `idleTimeoutMs` (so: no grace after the last disconnect; a never-registered
  server exits `idleTimeoutMs` after spawn). Consequences: a client stuck
  polling `/register` can't keep a doomed server alive, a co-tenant's death
  doesn't disrupt the others, and reload / version-bump self-heals.
- **Worktree creation is a background job.** `POST /create-worktree`
  validates, registers a job, and returns its id *immediately*; the server
  then runs `git worktree add` and the optional user bootstrap command to
  completion regardless of whether the requester is still connected. Active
  jobs are tracked *parallel to the instance registry* — present while
  running, dropped the moment they finish (no retention) — and each carries
  the worktree path it will produce. `GET /worktree-jobs` is a single SSE
  stream spanning all jobs: a subscriber gets a snapshot of the active jobs
  on connect, then per job a `created` once `git worktree add` lands the
  worktree on disk and a `done` (ok / failed) when the whole job finishes.
  The worktree path rides every frame so *all* windows list the new worktree
  the instant it exists and flag it in-progress (a spinner) until its
  bootstrap finishes, converging regardless of which window initiated it.
  Bootstrap *output* is still not streamed — it goes to the server log,
  which a failure notification offers to open. A reconnecting subscriber
  resumes from the snapshot (the authoritative in-flight set); a job that
  finished while it was disconnected is simply absent (the worktree-list
  refresh covers that). A stream subscriber deliberately does *not* keep the
  server alive (a watching window is already covered by its instance
  heartbeat); only the in-flight job does, via `activeServerJobs`, so the one
  bound on a runaway bootstrap is its timeout. This decouples a
  possibly-minutes-long bootstrap from any single window's lifetime.

## Config invariants

`config.json` is zod-validated in `src/common/config.ts`. The port and
idle-timeout bounds are **duplicated in `server.ts`** and must stay in sync;
the idle-timeout floor exists so a live client's heartbeat always outpaces
both the server's idle-exit check and the stale-instance sweep.

## User-facing surface

Command IDs in `src/extension/commands.ts` and the webview view id **must
stay in sync** with `contributes.commands` / `contributes.views` in
`package.json`; activation also wires the keybindings declared there.

- **Worktrees view** (`src/extension/worktreesView.ts`) — the primary UI: a
  webview in the activity-bar sidebar that lists the repo's git worktrees,
  creates new ones (delegated to the server's background-job + SSE flow
  above — the worktree is listed as soon as it exists on disk and shows a
  spinner until its bootstrap finishes), and opens one in a new
  window. Worktrees with a live VS Code window are flagged from the
  `/instance-events` stream exposed through `ServerClient`. The view is a
  self-contained HTML/CSS/JS string with a
  strict CSP; the host side shells out to `git` only for the read-only
  list/branch queries and otherwise posts state — keep the wire `*Message`
  types and the message handlers as the contract between the two halves.
- `applyLayout` — writes `workbench.sideBar.size`/`workbench.panel.size`
  directly into VS Code's *global* `state.vscdb` (a SQLite file — this is why
  a native module is needed). Requires quitting the editor after; Reload
  Window clobbers it.
- `pasteFileRef` (Alt+K) — pastes a Claude Code at-reference
  (`@<rel-path>#L<start>-<end>`) for the editor selection into the terminal;
  self-registers in `terminal.integrated.commandsToSkipShell`.
- `openConfig` / `openServerLog` — open the config file / per-port server log.

## Native modules

Native modules must match the host editor's Electron ABI (plain Node
prebuilts crash the Extension Host). `postinstall` runs `scripts/rebuild.mjs`,
which detects the editor's Electron version and rebuilds. Overrides:
`TAKESHICC_ELECTRON_VERSION=<x.y.z>`; `TAKESHICC_EDITOR=code|cursor`. Needs a
native C/C++ toolchain.

## Packaging

`.vscodeignore` is an allowlist — everything is excluded by default; shipped
files (incl. the native module's runtime files) are re-included with `!`.
