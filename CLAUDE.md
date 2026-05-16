# takeshicc

Bare-bones VS Code extension.

## Environment

Node is workspace-scoped at `.\.node\node.exe` (downloaded by
`scripts\setup-node.ps1`). `.vscode\settings.json` prepends `.node\` to
`PATH` for every integrated terminal, so `npm` and the build commands
just work — no manual PATH setup needed when running in a VS Code terminal.

## First-time setup

```powershell
.\scripts\setup-node.ps1
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
