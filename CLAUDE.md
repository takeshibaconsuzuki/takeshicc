# takeshicc

Bare-bones VS Code extension.

## Environment

Node is workspace-scoped at `.\.node\node.exe` (downloaded by
`scripts\setup-node.ps1`). `.vscode\settings.json` prepends `.node\` to
`PATH` for every integrated terminal, so `npm`, `tsc`, and the build task
just work — no manual PATH setup needed when running in a VS Code terminal.

## First-time setup

```powershell
.\scripts\setup-node.ps1
npm install
npm run compile
```

## Develop

- `npm run watch` — incremental TypeScript build
- `F5` — launches Extension Development Host
- Entry point: `src\extension.ts` → `out\extension.js`

## Native modules

Native modules must match VS Code's Electron ABI
(plain Node prebuilts will crash the Extension Host). `npm install` runs
`scripts\rebuild.mjs` via `postinstall`, which:

1. Looks for `code` (or `code.cmd` / `code.exe`) on `PATH`.
2. Resolves symlinks, then walks parent dirs to find VS Code's bundled
   `package.json` (handles macOS app bundles, Linux system installs, and
   Windows hashed-subfolder layouts). Falls back to parsing the wrapper
   script for an absolute resources path (covers `/usr/bin/code`).
3. Reads `devDependencies.electron` from that file and hands the version
   to `@electron/rebuild`.

Override the detected version with `TAKESHICC_ELECTRON_VERSION=<x.y.z>`
before running `npm install` / `npm run rebuild` — useful when `code` is
not on `PATH` or you want to target a different VS Code than the one
installed. Requires a native C/C++ toolchain (MSVC on Windows, Xcode CLT
on macOS, `build-essential` on Linux).

## Packaging

`.vscodeignore` is an allowlist: everything is excluded by default and
files that should ship in the `.vsix` are re-included with `!` patterns.
