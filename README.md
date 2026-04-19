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
- **On claude exit, associations drop.** The terminal stays (at your shell prompt, yours to reuse); next click on the session opens a fresh `claude --resume` terminal.

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
- **Shell integration enabled in your terminal** (default in Cursor and recent VS Code). If `onDidStartTerminalShellExecution` events don't fire, manual-invocation tracking and the association-drop-on-exit both silently no-op — the extension still works for reference insertion and for terminals it spawns itself.

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

Unit tests live under `test/` and cover the pure helpers: `buildReference` (selection → `@path#Lx-Ly`), `parseClaudeCommand` (shell command → invocation kind), `mergeHooks`/`removeHooks` (settings.local.json manipulation), `HookStateMachine` (hook event → session status transitions), and `formatRelativeTime`. Anything that touches the `vscode` API or hits the filesystem is not unit-tested; verify it manually in the Extension Development Host (`F5` inside the project). `vscode` is stubbed in `test/_stubs/vscode.ts` so pure modules can still import `EventEmitter` without pulling in the real API.

## Known limitations

- **Single workspace folder.** Multi-root workspaces only show sessions for the first folder.
- **Claude sessions started before the extension activates are not tracked** until you re-run `claude` in that terminal (shell-start events only fire on new executions). A window reload has the same effect — any tracked sessions from before the reload become untracked.
- **Sessions from sibling git worktrees are included** (the SDK's `listSessions` default). Usually what you want; not currently configurable.
- **Non-`file://` editors are ignored** by the reference command (untitled, remote, notebooks).
- **Status relies on hooks registered in `.claude/settings.local.json`** — if the file isn't writable (permissions, read-only mount), the sidebar falls back to showing every session as inactive.
- **Multiple VS Code windows on the same workspace overwrite each other's hook port.** Last writer wins; the other window's server still runs but stops receiving events. Reload the losing window to re-register.
- **Session titles are truncated to 40 characters.** VS Code's TreeView has no grid layout — long labels push descriptions off-screen, so titles are hard-truncated to guarantee the age/timestamp stays visible. Full title is in the hover tooltip.
