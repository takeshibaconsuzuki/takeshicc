# Takeshi CC

A lightweight VS Code / Cursor extension that fills gaps in the official Claude Code workflow when you use the Claude Code CLI from the integrated terminal.

## Features

### 1. `Alt+K` — Insert file reference

In the editor, press `Alt+K`. The extension sends `@path/to/file.ts#L20-L35` (or `@path/to/file.ts` with no selection) to the active terminal — no newline, so you can keep typing and submit when ready.

Terminal targeting: active terminal first, else any terminal whose name contains "claude", else an info message.

### 2. Sessions sidebar

Activity-bar panel listing Claude Code sessions for the current workspace, newest first. Auto-refreshes every 30s; a refresh button in the title bar forces it.

- **`+` New Chat** — spawns `claude` in a new terminal and polls the session store until the new session ID shows up, then links the terminal to it.
- **Click a session** — if a tracked terminal exists for it, that terminal is revealed; otherwise a new `claude --resume <id>` terminal is spawned.
- **Manual invocations are tracked.** Type `claude`, `claude --resume <id>`, or `claude -r <id>` in any integrated terminal and the extension associates it with the session automatically.
- **On claude exit:**
  - For terminals the extension spawned (New Chat, click-to-resume), the terminal is disposed — its lifecycle matches the `claude` process.
  - For manually-invoked terminals, the association drops but the terminal stays at your shell prompt, yours to reuse. Next click on the session opens a fresh `claude --resume` terminal.

### 3. Per-session status indicator

For every tracked session, the sidebar shows whether Claude is busy or awaiting your input, driven by Claude Code's [hook](https://code.claude.com/docs/en/hooks) system:

- 🟢 **awaiting** — turn is finished (`Stop`/`StopFailure` fired) or Claude sent an `idle_prompt` notification. Your turn.
- 🟡 **awaiting permission** — Claude sent a `permission_prompt` notification; a tool is waiting for you to approve or deny.
- 🟠 **busy** — user prompt submitted, or a tool is running (`PreToolUse` captures the tool name).
- (no prefix) **inactive** — no hook events received for this session since the extension activated.

On activation the extension starts a loopback-only HTTP server on a random port (bound to `127.0.0.1`, protected by a per-activation random 32-byte token in the `x-takeshicc-token` header) and writes merge-safe entries into `.claude/settings.local.json` pointing Claude's `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `StopFailure`, and `SessionEnd` hooks at that server. Entries are tagged with `?source=takeshicc` in the URL so deactivation can strip only our entries and leave any other hooks you've configured alone.

The file contains a rotating port and secret token, so **add `.claude/settings.local.json` to your `.gitignore`** — Claude Code does not do this automatically despite the `.local.json` suffix.

`SessionStart` is not registered because `claude --resume` doesn't reliably fire it in practice (despite the docs). Instead, the extension seeds a session as 🟢 awaiting the moment we spawn or adopt its terminal, and lets subsequent hooks drive the real state transitions from there.

The emoji is prefixed to the session label — always visible, even when the row is selected or hovered (VS Code's ThemeColor on icons gets overridden by list-selection colors, so emoji is the reliable channel). The busy state also uses a spinning icon (`loading~spin`) because animation conveys "something is happening" in a way emoji can't.

**Known gap:** hooks only fire for sessions started *after* the extension has written `settings.local.json`. A session started before the extension activated stays 🟢/no-prefix until you quit and re-run `claude` in that terminal — which is almost always what you want, since such sessions are also untracked for terminal correlation. A window reload has the same effect.

### 4. Built-in MCP server (claude-context tools)

On activation the extension also stands up a loopback-only HTTP MCP server backed by the official `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`, stateless mode — a fresh `McpServer` and transport are constructed per request, per the SDK's stateless-mode guidance), and writes a `mcpServers.takeshicc` entry into `~/.claude.json` so the running `claude` process auto-discovers it. Same security model as the hook server: bound to `127.0.0.1` on a random OS-assigned port, gated by a per-activation 32-byte token in the `x-takeshicc-mcp-token` header. The URL is tagged `?source=takeshicc` so we only ever overwrite our own slot — sibling MCP servers and unrelated `~/.claude.json` keys are preserved. On `deactivate()` the slot is removed (best-effort).

The server exposes four tools:

- `index_codebase`, `search_code`, `clear_index`, `get_indexing_status` — thin wrappers around `@zilliz/claude-context-core`'s `Context` class (`indexCodebase` / `semanticSearch` / `clearIndex` / `hasIndex`). Tool names, descriptions, and JSON-Schema input shapes match `@zilliz/claude-context-mcp@0.1.11` byte-for-byte (modulo two cosmetic SDK-emitted fields — `$schema` and `execution.taskSupport` — that don't affect agent behavior). A regression test (`test/upstreamParity.test.ts`) snapshot-asserts this so drift is caught the next time upstream changes.

Embedding is OpenAI-compatible. Configure it in VS Code settings:

| Setting | Default | Notes |
|---|---|---|
| `takeshicc.embedding.apiKey` | _(empty)_ | Required. |
| `takeshicc.embedding.baseURL` | `https://api.openai.com/v1` | Point at any OpenAI-compatible endpoint (Ollama, LiteLLM, Azure, …). |
| `takeshicc.embedding.model` | `text-embedding-3-small` | Any model your endpoint exposes. |

The factory rebuilds its `Context` whenever these settings change, so a fresh API key takes effect without a window reload.

**Vector DB backend.** Indexing is backed by [LanceDB](https://lancedb.com/), an embedded local vector store. The implementation is vendored from [`danielbowne/claude-context`](https://github.com/danielbowne/claude-context) at `src/mcp/vendor/lancedb-vectordb.ts` (with imports rerouted to `@zilliz/claude-context-core`'s re-exported types and three interface methods added that post-date the upstream snapshot). Tables live at `<workspace>/.takeshicc/lancedb/` — on first use the extension also appends `.takeshicc/` to the workspace `.gitignore` (only when `.git` exists, idempotent). When no workspace folder is open, the factory falls back to `NullVectorDatabase` so the MCP server still loads cleanly; tools surface a clear error rather than crashing. Override the backend via `ContextFactory.setVectorDatabaseFactory()`.

**`.vscodeignore` carve-out.** `@zilliz/claude-context-core` greedily treats every `.<name>ignore` file in the workspace root as an indexer ignore-list. That sweeps in `.vscodeignore` (a vsce packaging file) and excludes `src/**`, `test/**`, etc. — making the index empty for projects that ship a `.vsix`. `src/mcp/context.ts` monkey-patches `Context.prototype.findIgnoreFiles` once at module load to drop only `.vscodeignore` from the returned list; `.gitignore`, `.contextignore`, `.npmignore`, and friends still flow through unchanged.

## Install

```bash
npm install
npm run vsix
# then, in Cursor:
cursor --install-extension takeshicc-0.0.1.vsix
# or in VS Code:
code --install-extension takeshicc-0.0.1.vsix
```

Reload the window after install.

## Keybind conflict

`Alt+K` is also bound by the official Claude Code extension for its chat UI. To hand `Alt+K` to Takeshi CC:

1. `Ctrl+K Ctrl+S` → search for `alt+k`.
2. Right-click the conflicting binding → **Remove Keybinding**.

Or pick your own key — add to `keybindings.json`:

```json
{
  "key": "ctrl+alt+k",
  "command": "takeshicc.insertReference",
  "when": "editorTextFocus"
}
```

## Requirements

- VS Code / Cursor 1.93 or newer (for the shell-integration execution events used to detect `claude` starting and exiting).
- **Shell integration enabled in your terminal** (default in Cursor and recent VS Code). If `onDidStartTerminalShellExecution` events don't fire, manual-invocation tracking, association-drop-on-exit, and auto-dispose of extension-spawned terminals all silently no-op — the extension still works for reference insertion and for spawning new terminals.

## Development

```bash
npm install          # first time only
npm test             # run unit tests (vitest)
npm run typecheck    # tsc --noEmit, no emit
npm run compile      # dev build (sourcemaps, no minify)
npm run watch        # rebuild on change
npm run package      # production build (minified)
npm run vsix         # production build + package .vsix
```

Unit tests live under `test/` and cover the pure helpers: `buildReference` (selection → `@path#Lx-Ly`), `parseClaudeCommand` (shell command → invocation kind), `mergeHooks`/`removeHooks` (`settings.local.json` manipulation), `mergeMcp`/`removeMcp` (`~/.claude.json` manipulation), `HookStateMachine` (hook event → session status transitions), and `formatRelativeTime`. Two integration tests (`test/mcpServer.integration.test.ts`, `test/upstreamParity.test.ts`) boot the real `McpHttpServer` on a loopback port and exercise it via JSON-RPC over HTTP — covering auth, the `tools/list` surface, and tool-call error paths. Anything that touches the `vscode` API beyond config reads, or hits the filesystem, is not unit-tested; verify it manually in the Extension Development Host (`F5` inside the project). `vscode` is stubbed in `test/_stubs/vscode.ts` so pure modules can still import `EventEmitter` and call `workspace.getConfiguration` without pulling in the real API.

**Bundle / native dependencies.** Three categories of `.node` binaries esbuild can't bundle:

- **Tree-sitter grammars** (used by the AST splitter). Real externals, loaded at runtime from the colocated `node_modules`.
- **`@lancedb/lancedb`** plus its platform-specific binary package (e.g. `@lancedb/lancedb-darwin-arm64`) and the `apache-arrow` peer dep. All marked external in `esbuild.js`. Because lancedb's native binary is shipped via `optionalDependencies`, npm only installs the host arch — so the resulting `.vsix` is host-arch-only. Repackage on each target platform.
- **Milvus / faiss SDKs** (`@zilliz/milvus2-sdk-node`, `faiss-node`). `claude-context-core` still eagerly `require`s them at module load even though we never instantiate either backend. `esbuild.js` aliases both to `src/mcp/milvusStub.js` — a Proxy that throws on any property access — so the bundle resolves without them.

The `.vscodeignore` allowlists exactly the runtime modules we need (tree-sitter packages, `@lancedb/lancedb` + its platform binary, `apache-arrow`, `tslib`, `flatbuffers`, `reflect-metadata`) and prunes docs / tests / source maps. Resulting `dist/extension.js` is ~3.2 MB; the packaged `.vsix` is ~59 MB (the lancedb native binary alone is ~91 MB before vsix compression).

## Known limitations

- **Single workspace folder.** Multi-root workspaces only show sessions for the first folder.
- **Claude sessions started before the extension activates are not tracked** until you re-run `claude` in that terminal (shell-start events only fire on new executions). A window reload has the same effect — any tracked sessions from before the reload become untracked.
- **Sessions from sibling git worktrees are included** (the SDK's `listSessions` default). Usually what you want; not currently configurable.
- **Non-`file://` editors are ignored** by the reference command (untitled, remote, notebooks).
- **Status relies on hooks registered in `.claude/settings.local.json`** — if the file isn't writable (permissions, read-only mount), the sidebar falls back to showing every session as inactive.
- **Multiple VS Code windows on the same workspace overwrite each other's hook port.** Last writer wins; the other window's server still runs but stops receiving events. Reload the losing window to re-register. The MCP server has the same property against `~/.claude.json` — the most recently activated window owns the `mcpServers.takeshicc` slot.
- **`claude-context` tools require an embedding API key.** Set `takeshicc.embedding.apiKey` (and optionally `baseURL` / `model`) before calling `index_codebase` / `search_code`. Without a workspace folder open, indexing falls back to `NullVectorDatabase` and the tools return a clear "not configured" error rather than crashing.
- **The packaged `.vsix` is host-arch-only.** `@lancedb/lancedb`'s native binary is installed via `optionalDependencies`, so `npm install` only fetches the package matching the host platform. Repackage on each target OS/arch (macOS arm64 / x64, Linux x64-gnu / arm64-gnu / *-musl, Windows x64 / arm64) before distributing.
- **Session titles are truncated to 40 characters.** VS Code's TreeView has no grid layout — long labels push descriptions off-screen, so titles are hard-truncated to guarantee the age/timestamp stays visible. Full title is in the hover tooltip.
