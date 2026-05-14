# Takeshi CC

A lightweight VS Code / Cursor extension that fills gaps in the official Claude Code workflow when you use the Claude Code CLI from the integrated terminal.

## Features

### 1. `Alt+K` — Insert file reference

In the editor, press `Alt+K`. The extension sends `@path/to/file.ts#L20-L35` (or `@path/to/file.ts` with no selection) to the active terminal — no newline, so you can keep typing and submit when ready.

Terminal targeting: active terminal first, else any terminal whose name contains "claude", else an info message.

### 2. Sessions sidebar

Activity-bar panel listing Claude Code sessions for the current workspace, newest first. Rendered as a WebviewView with a three-column grid: status icon, topic + chat tail (lighter shade), and a right-aligned relative timestamp. Auto-refreshes every 30s; a refresh button in the title bar forces it.

- **`+` New Chat** — spawns `claude` in a new terminal and polls the session store until the new session ID shows up, then links the terminal to it.
- **Click a session** — if a tracked terminal exists for it, that terminal is revealed; otherwise a new `claude --resume <id>` terminal is spawned.
- **Manual invocations are tracked.** Type `claude`, `claude --resume <id>`, or `claude -r <id>` in any integrated terminal and the extension associates it with the session automatically.
- **On claude exit:**
  - For terminals the extension spawned (New Chat, click-to-resume), the terminal is disposed — its lifecycle matches the `claude` process.
  - For manually-invoked terminals, the association drops but the terminal stays at your shell prompt, yours to reuse. Next click on the session opens a fresh `claude --resume` terminal.

**Chat-tail preview.** Below the topic, the row shows the last few lines of the rendered conversation — text blocks plus tool calls like `[Bash] git status` — clamped to a configurable number of lines via `takeshicc.sessions.tailLines` (default `2`, `0` to hide). The algorithm is `tail -n N` over the rendered transcript: walk newest → oldest, prepend each message's last N lines into a chronological accumulator, stop once it has N lines (or messages are exhausted), then return the last N. Read on the slow 30s refresh tick and on green transitions (`Stop` / `StopFailure` / `idle_prompt`); cached by `(sessionId, lastModified, tailLines)` so unchanged sessions don't re-read the JSONL.

### 3. Per-session status indicator

For every tracked session, the leftmost column of each row shows whether Claude is busy or awaiting your input, driven by Claude Code's [hook](https://code.claude.com/docs/en/hooks) system:

- 🟢 **green filled circle** — *awaiting*. Turn is finished (`Stop`/`StopFailure` fired) or Claude sent an `idle_prompt` notification. Your turn.
- 🟡 **yellow filled circle** — *awaiting permission*. Claude sent a `permission_prompt` notification; a tool is waiting for you to approve or deny.
- 🟠 **spinning orange ring** — *busy*. User prompt submitted, or a tool is running (`PreToolUse` captures the tool name).
- **empty slot** — *inactive*. No hook events received for this session since the extension activated.

On activation the extension starts a loopback-only HTTP server on a random port (bound to `127.0.0.1`, protected by a per-activation random 32-byte token in the `x-takeshicc-token` header) and writes merge-safe entries into `.claude/settings.local.json` pointing Claude's `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `StopFailure`, and `SessionEnd` hooks at that server. Entries are tagged with `?source=takeshicc` in the URL so deactivation can strip only our entries and leave any other hooks you've configured alone.

The file contains a rotating port and secret token, so **add `.claude/settings.local.json` to your `.gitignore`** — Claude Code does not do this automatically despite the `.local.json` suffix.

`SessionStart` is not registered because `claude --resume` doesn't reliably fire it in practice (despite the docs). Instead, the extension seeds a session as *awaiting* (green) the moment we spawn or adopt its terminal, and lets subsequent hooks drive the real state transitions from there.

Status glyphs are rendered as plain CSS (filled circles via `--vscode-charts-{green,yellow}`, spinner via `@keyframes spin`) in a dedicated 12px column of the WebviewView grid. `HookStateMachine.onDidChange` emits the new `HookSessionState` (or `undefined` on clear), so the view can filter for "turned green" transitions and re-read the chat tail on those events without paying for a full re-read on every `PreToolUse`.

**Known gap:** hooks only fire for sessions started *after* the extension has written `settings.local.json`. A session started before the extension activated stays in the *inactive* state (empty status slot) until you quit and re-run `claude` in that terminal — which is almost always what you want, since such sessions are also untracked for terminal correlation. A window reload has the same effect.

### 4. Built-in MCP server

On activation the extension also stands up a loopback-only HTTP MCP server backed by the official `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`, stateless mode — a fresh `McpServer` and transport are constructed per request, per the SDK's stateless-mode guidance), and writes a `projects.<workspaceRoot>.mcpServers.takeshicc` entry into `~/.claude.json` so the running `claude` process auto-discovers it. The entry is **per-project**, so the `takeshicc` server only appears in the workspace whose VS Code window is hosting the extension — Claude won't see takeshicc in unrelated projects. Same security model as the hook server: bound to `127.0.0.1` on a random OS-assigned port, gated by a per-activation 32-byte token in the `x-takeshicc-mcp-token` header. The URL is tagged `?source=takeshicc` so we only ever overwrite our own slot — sibling MCP servers and unrelated `~/.claude.json` keys are preserved. On `deactivate()` the slot is removed (best-effort). When no workspace folder is open the registration is skipped entirely.

The server currently exposes no tools — kept as scaffolding for future additions.

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

Unit tests live under `test/` and cover the pure helpers: `buildReference` (selection → `@path#Lx-Ly`), `parseClaudeCommand` (shell command → invocation kind), `mergeHooks`/`removeHooks` (`settings.local.json` manipulation), `mergeMcp`/`removeMcp` (`~/.claude.json` manipulation), `HookStateMachine` (hook event → session status transitions), and `formatRelativeTime`. One integration test (`test/mcpServer.integration.test.ts`) boots the real `McpHttpServer` on a loopback port and exercises it via JSON-RPC over HTTP — covering auth and the (currently empty) `tools/list` surface. Anything that touches the `vscode` API beyond config reads, or hits the filesystem, is not unit-tested; verify it manually in the Extension Development Host (`F5` inside the project). `vscode` is stubbed in `test/_stubs/vscode.ts` so pure modules can still import `EventEmitter` and call `workspace.getConfiguration` without pulling in the real API.

**Bundle / native dependencies.** `sql.js` is pure-JS but ships a `.wasm` asset esbuild can't inline, so it's marked external in `esbuild.js` and `.vscodeignore` allowlists its `dist/sql-wasm.{js,wasm}` files. Everything else inlines via esbuild.

## Known limitations

- **Single workspace folder.** Multi-root workspaces only show sessions for the first folder.
- **Claude sessions started before the extension activates are not tracked** until you re-run `claude` in that terminal (shell-start events only fire on new executions). A window reload has the same effect — any tracked sessions from before the reload become untracked.
- **Sessions from sibling git worktrees are included** (the SDK's `listSessions` default). Usually what you want; not currently configurable.
- **Non-`file://` editors are ignored** by the reference command (untitled, remote, notebooks).
- **Status relies on hooks registered in `.claude/settings.local.json`** — if the file isn't writable (permissions, read-only mount), the sidebar falls back to showing every session as inactive.
- **Multiple VS Code windows on the same workspace overwrite each other's hook port.** Last writer wins; the other window's server still runs but stops receiving events. Reload the losing window to re-register. The MCP server has the same property — both windows write to the same `projects.<workspaceRoot>.mcpServers.takeshicc` slot, so the most recently activated window owns the entry. Different workspaces don't collide.
- **Long session titles are ellipsised to one line.** The topic column uses CSS `text-overflow: ellipsis`, so it adapts to sidebar width rather than a fixed character cap. Widen the sidebar to see more.
