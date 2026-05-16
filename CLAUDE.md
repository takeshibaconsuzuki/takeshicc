# takeshicc

Bare-bones VS Code extension.

## Environment

Node is workspace-scoped. Install it with `scripts\setup-node.ps1` on
Windows (into `.node.win\`, binary at `.node.win\node.exe`) or
`scripts/setup-node.sh` on macOS/Linux (into `.node.posix/`, binary at
`.node.posix/bin/node`) — separate directories so a shared checkout can hold
both. Re-running either script after bumping the pinned version replaces the
existing install in place. `.vscode\settings.json` prepends the right
directory (`.node.win\` on Windows, `.node.posix/bin` on macOS/Linux) to
`PATH` for every integrated terminal, so `npm` and the build commands just
work — no manual PATH setup needed when running in a VS Code terminal.

## node_modules (per-platform)

`node_modules` holds platform-specific native binaries — esbuild's prebuilt
binary and `better-sqlite3`'s compiled, Electron-ABI-rebuilt addon — so it
**cannot** be shared between Windows and macOS/Linux. Like Node itself, the
install is kept per-platform. `node_modules` is always a real directory (npm
will not install into a symlinked one) holding the running OS's install; the
inactive OS's tree is parked alongside in `node_modules.win\` or
`node_modules.posix/`. `scripts\link-modules.mjs` swaps these trees so
`node_modules` always matches the current OS (renames within one filesystem,
so it is instant). It runs automatically as npm's `preinstall` hook and again
at the top of `scripts\esbuild.mjs`, so switching OS needs no manual step. Run
`npm install` once per platform to populate that platform's tree — re-run only
when dependencies change.

## First-time setup

```powershell
.\scripts\setup-node.ps1   # Windows; macOS/Linux: ./scripts/setup-node.sh
npm install
npm run build:all
```

## Develop

- `F5` — launches the Extension Development Host (runs the `build:all` task first)
- `npm run watch:ext` / `npm run watch:server` — incremental rebuilds in watch mode
- Entry points: `src\extension\extension.ts` → `out\extension.js`,
  `src\server\server.ts` → `out\server.js`, and
  `src\reporter\reporter.ts` → `out\reporter.js` (plus
  `src\reporter\reporter.ps1`, copied verbatim to `out\reporter.ps1`)

## Source layout

- `src\extension\` — runs in the VS Code extension host; may `import 'vscode'`.
- `src\server\` — a standalone Node process; must **never** `import 'vscode'`.
- `src\reporter\` — a short-lived Claude Code `UserPromptSubmit` command hook
  that reports the Claude process's ancestor PIDs so the extension can bind a
  live chat to the VS Code terminal hosting it. Two implementations: `.ps1`
  (PowerShell) on Windows, `.ts` (plain Node, never `import 'vscode'`)
  elsewhere — see registerHooks.ts for why the hook process itself must be a
  walkable ancestor of the terminal.
- `src\server\protocol.ts` — the vscode-free wire contract shared by all three.

The extension talks to a per-repository local HTTP server, spawned on demand
and shared across windows. The repo→port mapping is a user-maintained file at
`~\.takeshicc\config.json`; without an entry the server feature stays off.

## Build

esbuild (`scripts\esbuild.mjs`) bundles three self-contained CJS outputs:
`out\extension.js`, `out\server.js`, and `out\reporter.js`. Type-checking is
integrated into the build via `@jgoz/esbuild-plugin-typecheck` (runs `tsc` in a
worker) — there is no separate typecheck step, and `tsconfig.json` sets
`noEmit`. `npm run build:all` builds all three; `build:ext` / `build:server` /
`build:reporter` build one.

## Native modules

Native modules (`better-sqlite3`) must match VS Code's Electron ABI — plain
Node prebuilts crash the Extension Host. `npm install`'s `postinstall` runs
`scripts\rebuild.mjs`, which detects the installed VS Code's Electron version
and rebuilds against it. Override detection with
`TAKESHICC_ELECTRON_VERSION=<x.y.z>` (useful when `code` isn't on `PATH`).
Requires a native C/C++ toolchain — MSVC / Xcode CLT / `build-essential`.

## Packaging

`.vscodeignore` is an allowlist: everything is excluded by default and
files that should ship in the `.vsix` are re-included with `!` patterns.
