# takeshicc

Bare-bones VS Code extension.

## Environment

Node is workspace-scoped. Install it once per platform: `scripts\setup-node.ps1`
on Windows (binary at `.node.win\node.exe`) or `scripts/setup-node.sh` on
macOS/Linux (binary at `.node.posix/bin/node`). `.vscode/settings.json`
prepends the right directory to `PATH` for VS Code integrated terminals, so
`npm` and the build commands work there with no manual PATH setup.

## node_modules (per-platform)

`node_modules` holds platform-specific native binaries and **cannot** be shared
between Windows and macOS/Linux. The inactive OS's tree is parked in
`node_modules.win\` / `node_modules.posix/`; `scripts\link-modules.mjs` swaps
them to match the current OS and runs automatically (npm `preinstall` hook and
at the top of `scripts\esbuild.mjs`), so switching OS needs no manual step. Run
`npm install` once per platform; re-run only when dependencies change.

## First-time setup

```powershell
.\scripts\setup-node.ps1   # Windows; macOS/Linux: ./scripts/setup-node.sh
npm install
npm run build:all
```

## Develop

- `F5` — launches the Extension Development Host (runs `build:all` first)
- `npm run watch:ext` / `npm run watch:server` — incremental rebuilds
- Entry points: `src\extension\extension.ts` → `out\extension.js`,
  `src\server\server.ts` → `out\server.js`,
  `src\reporter\reporter.ts` → `out\reporter.js` (plus
  `src\reporter\reporter.ps1`, copied verbatim to `out\reporter.ps1`)

## Source layout

- `src\extension\` — runs in the VS Code extension host; may `import 'vscode'`.
- `src\server\` — a standalone Node process; must **never** `import 'vscode'`.
- `src\reporter\` — a short-lived Claude Code `UserPromptSubmit` command hook
  reporting the Claude process's ancestor PIDs so the extension can bind a live
  chat to the hosting VS Code terminal. `.ps1` (PowerShell) on Windows, `.ts`
  (plain Node, never `import 'vscode'`) elsewhere — see registerHooks.ts for
  why the hook process must be a walkable ancestor of the terminal.

The extension talks to a per-repository local HTTP server, spawned on demand
and shared across windows. The repo→port mapping is a user-maintained file at
`~\.takeshicc\config.json`; without an entry the server feature stays off.

## Build

esbuild (`scripts\esbuild.mjs`) bundles three self-contained CJS outputs:
`out\extension.js`, `out\server.js`, `out\reporter.js`. Type-checking is
integrated into the build via `@jgoz/esbuild-plugin-typecheck` — there is **no
separate typecheck step**, and `tsconfig.json` sets `noEmit`. `npm run
build:all` builds all three; `build:ext` / `build:server` / `build:reporter`
build one.

## Native modules

`better-sqlite3` must match the editor's Electron ABI — plain Node prebuilts
crash the Extension Host. `npm install`'s `postinstall` runs
`scripts\rebuild.mjs`, which detects the editor's Electron version (looks for
`code`, then `cursor`, on `PATH`) and rebuilds against it. Override with
`TAKESHICC_ELECTRON_VERSION=<x.y.z>` when no editor CLI is on `PATH` or the
wrong editor is picked. Requires a native C/C++ toolchain (MSVC / Xcode CLT /
`build-essential`).

## Packaging

`.vscodeignore` is an allowlist: everything is excluded by default; files that
ship in the `.vsix` are re-included with `!` patterns.
