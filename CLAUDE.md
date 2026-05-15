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
- `F5` — launches Extension Development Host; run `Takeshicc: Hello World`
  from the command palette
- Entry point: `src\extension.ts` → `out\extension.js`

## Packaging

`.vscodeignore` is an allowlist: everything is excluded by default and
files that should ship in the `.vsix` are re-included with `!` patterns.
