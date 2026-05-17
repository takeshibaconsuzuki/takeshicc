# takeshicc

Bare-bones VS Code extension. Also runs in Cursor (a VS Code fork).

## Environment

Node is workspace-scoped at `.\.node\node.exe` (downloaded by
`scripts\setup-node.ps1`). `.vscode\settings.json` prepends `.node\` to
`PATH` for every integrated terminal, so `npm` and the build commands
just work — no manual PATH setup needed when running in a VS Code / Cursor
terminal (Cursor reads `.vscode\settings.json` too).

## First-time setup

```powershell
.\scripts\setup-node.ps1
npm install
npm run build:all
```

## Develop

- `F5` — launches the Extension Development Host (runs the `build:all` task first)
- `npm run watch:ext` / `npm run watch:server` — incremental rebuilds in watch mode
- Entry points: `src\extension\extension.ts` → `out\extension.js` and
  `src\server\server.ts` → `out\server.js`

## Source layout

- `src\extension\` — runs in the VS Code extension host; may `import 'vscode'`.
- `src\server\` — a standalone Node process; must **never** `import 'vscode'`.
- `src\server\protocol.ts` — the vscode-free wire contract shared by both sides.

The extension talks to a per-repository local HTTP server, spawned on demand
and shared across windows. The repo→port mapping is a user-maintained file at
`~\.takeshicc\config.json`; without an entry the server feature stays off.

## Build

esbuild (`scripts\esbuild.mjs`) bundles two self-contained CJS outputs:
`out\extension.js` and `out\server.js`. Type-checking is integrated into the
build via `@jgoz/esbuild-plugin-typecheck` (runs `tsc` in a worker) — there is
no separate typecheck step, and `tsconfig.json` sets `noEmit`. `npm run
build:all` builds both bundles; `build:ext` / `build:server` build one.

## Native modules

Native modules (`better-sqlite3`) must match the host editor's Electron ABI —
plain Node prebuilts crash the Extension Host. `npm install`'s `postinstall`
runs `scripts\rebuild.mjs`, which detects the editor's Electron version and
rebuilds against it. Detection order: `TAKESHICC_ELECTRON_VERSION=<x.y.z>`
(explicit override) → the editor whose integrated terminal launched the
rebuild (via the `VSCODE_GIT_ASKPASS_*` env vars VS Code/Cursor export) → the
`code`/`cursor` CLI wrapper on `PATH`. From a resolved install the version
comes from the macOS `.app` bundle's `Electron Framework` (packaged editors
list no `electron` dep in any `package.json`), falling back to a `package.json`
electron dep for source checkouts / non-mac layouts. Both VS Code and Cursor
(a VS Code fork with its own Electron) are supported; when several editors are
on `PATH`, set `TAKESHICC_EDITOR=code|cursor` to pick one. Requires a native
C/C++ toolchain — MSVC / Xcode CLT / `build-essential`.

## Packaging

`.vscodeignore` is an allowlist: everything is excluded by default and
files that should ship in the `.vsix` are re-included with `!` patterns.
