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

A small VS Code extension (also runs in Cursor, a VS Code fork): a few
editor-layout/terminal commands plus a per-repository local HTTP server.

## Build

```
npm install        # postinstall rebuilds native modules (see Native modules)
npm run build:all  # or build:ext / build:server; watch:ext / watch:server
npm run vsix       # package the .vsix
npm run rebuild    # re-run the native-module ABI rebuild standalone
```

esbuild (`scripts/esbuild.mjs`) bundles each entry point into one CJS file
under `out/`, leaving host-provided and native dependencies external.
Type-checking runs *inside* every build (no separate typecheck step;
`tsconfig.json` is `noEmit`); there is no test suite. On macOS/Linux use
system Node 20+; on Windows the pinned toolchain is bootstrapped by
`scripts/setup-node.ps1`.

## Source layout

- `src/extension/` — runs in the extension host; may `import 'vscode'`.
  Entry: `extension.ts`.
- `src/server/` — standalone Node process; must **never** `import 'vscode'`.
  Entry: `server.ts`.
- `src/common/` — vscode-free helpers shared by both sides (incl. the HTTP
  wire contract); must bundle into both outputs.

## Server lifecycle & concurrency model

- **Group identity.** `resolveGitGroup` maps a workspace folder to its repo's
  canonical main-worktree path, so all linked worktrees share one server.
  `canonicalizePath` must produce identical output in `gitGroup.ts` *and*
  `config.ts`.
- **Opt-in.** `~/.takeshicc/config.json` maps a group key to its
  `{ port, idleTimeoutMs }`. Unless the workspace resolves to a configured git
  repo the feature stays silently off; only a malformed config surfaces an
  error.
- **Port bind is the mutex.** `getOrCreateServer` loops forever converging:
  probe `GET /whoami`; if refused, spawn a detached server, poll until ready.
  Duplicate spawns are harmless (loser exits(0) on `EADDRINUSE`). A `/whoami`
  with a different `groupKey` means another process owns the port → error, no
  retry.
- **Spawned as plain Node** via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`;
  logs to `~/.takeshicc/server-<port>.log`.
- **Idle/heartbeat.** Server self-exits after `idleTimeoutMs` of no requests;
  client pings `/ping` every `idleTimeoutMs/3` to keep a live one alive.
  Version mismatch is logged, not fatal.

## Config invariants

`config.json` is zod-validated in `src/common/config.ts`. The port and
idle-timeout bounds are **duplicated in `server.ts`** and must stay in sync;
the idle-timeout floor exists so a live client's heartbeat always outpaces the
server's idle-exit check.

## Commands

IDs in `src/extension/commands.ts` **must stay in sync** with
`contributes.commands` in `package.json`.

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
