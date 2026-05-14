import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { buildReference } from './reference';
import { resolveTargetTerminal, TerminalTracker } from './terminals';
import { SessionService } from './sessions/service';
import { SessionsWebviewViewProvider } from './sessions/view';
import { parseClaudeCommand } from './parseClaudeCommand';
import { HookServer, type HookEvent } from './hooks/server';
import { HookStateMachine } from './hooks/stateMachine';
import { installHooks, uninstallHooks } from './hooks/settings';
import { McpHttpServer } from './mcp/server';
import { registerMcpServer, unregisterMcpServer } from './mcp/settings';
import { WorktreeService } from './worktrees/service';

const AUTO_REFRESH_MS = 30_000;
const NEW_CHAT_POLL_MS = 1_000;

let activeWorkspaceRoot: string | undefined;
let hooksReady: Promise<void> = Promise.resolve();

// Cached at activation so the layout-sizes write doesn't have to rebuild paths.
let cachedGlobalDbPath: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  activeWorkspaceRoot = workspaceRoot;
  const log = vscode.window.createOutputChannel('Takeshi CC');
  log.appendLine(`activate: workspace=${workspaceRoot ?? '<none>'}`);

  const service = new SessionService(workspaceRoot);
  const tracker = new TerminalTracker();
  const hookStates = new HookStateMachine();
  const hookServer = new HookServer();
  const mcpServer = new McpHttpServer(log);
  const worktreeEmitter = new vscode.EventEmitter<void>();
  const worktrees = new WorktreeService(workspaceRoot, worktreeEmitter, log);

  // Selected worktree drives the cwd used by newChat. Defaults to the
  // workspace root; updated by the dropdown in the Sessions webview.
  let selectedWorktreePath: string = workspaceRoot ?? '';
  const selectionState = {
    getSelectedWorktree: () => selectedWorktreePath || workspaceRoot || '',
    setSelectedWorktree: (p: string) => {
      selectedWorktreePath = p;
    },
  };

  const provider = new SessionsWebviewViewProvider(
    context.extensionUri,
    service,
    tracker,
    hookStates,
    workspaceRoot,
    'takeshicc.openSession',
    worktrees,
    selectionState,
    () => hookServer.getConfig(),
    log
  );

  context.subscriptions.push(
    hookServer.onEvent((e) => {
      log.appendLine(`hook ${describeEvent(e)}`);
      hookStates.handle(e);
    }),
    tracker.onDidUnregister((sessionId) => {
      log.appendLine(`unregister session=${sessionId.slice(0, 8)} — clearing hook state`);
      hookStates.clear(sessionId);
    })
  );

  hooksReady = bootstrapHooks(hookServer, workspaceRoot, log);
  void bootstrapMcp(mcpServer, workspaceRoot, log);
  void ensurePanelLeft(log);

  if (context.globalStorageUri) {
    cachedGlobalDbPath = path.join(
      path.dirname(context.globalStorageUri.fsPath),
      'state.vscdb'
    );
  }

  context.subscriptions.push(
    log,
    tracker,
    hookStates,
    hookServer,
    mcpServer,
    provider,
    worktreeEmitter,
    vscode.commands.registerCommand(
      'takeshicc.insertReference',
      insertReferenceCommand
    ),
    vscode.window.registerWebviewViewProvider(
      SessionsWebviewViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('takeshicc.refreshSessions', () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand(
      'takeshicc.openSession',
      (sessionId: string) =>
        openSessionCommand(sessionId, service, tracker, hookStates, log, workspaceRoot)
    ),
    vscode.commands.registerCommand('takeshicc.newChat', () =>
      newChatCommand(
        service,
        provider,
        tracker,
        hookStates,
        log,
        selectionState.getSelectedWorktree() || workspaceRoot
      )
    ),
    vscode.commands.registerCommand('takeshicc.applyLayoutSizes', () =>
      applyLayoutSizesCommand(context, log)
    ),

    // Observe claude invocations in ANY terminal. When the user types `claude`
    // or `claude --resume <id>` manually, we still want to track it so that
    // clicking the session in the sidebar reveals the existing terminal
    // instead of spawning a duplicate.
    vscode.window.onDidStartTerminalShellExecution((event) => {
      const cmd = event.execution.commandLine.value;
      const parsed = parseClaudeCommand(cmd);
      if (!parsed) return;

      const already = tracker.isTracked(event.terminal);
      log.appendLine(
        `shell-start: cmd=${JSON.stringify(cmd.slice(0, 80))} parsed=${parsed.kind}${parsed.kind === 'resume' ? ` id=${parsed.sessionId.slice(0, 8)}` : ''} alreadyTracked=${already}`
      );

      // Avoid racing with our own newChat poller or a prior registration.
      if (already) return;

      if (parsed.kind === 'resume') {
        tracker.register(parsed.sessionId, event.terminal);
        hookStates.seedIdle(parsed.sessionId, workspaceRoot);
        log.appendLine(`  → registered + seedIdle(${parsed.sessionId.slice(0, 8)})`);
        void provider.refresh();
      } else {
        tracker.markPending(event.terminal);
        log.appendLine('  → markPending + attachNewSession');
        void attachNewSession(event.terminal, service, provider, tracker, hookStates);
      }
    }),

    // When `claude` exits inside a tracked terminal, detach the terminal from
    // its session. For terminals we spawned ourselves (newChat / openSession),
    // also dispose the terminal — the user didn't open it, so closing it
    // matches the lifecycle of the claude process. Manually-invoked terminals
    // are left alone so the user keeps their shell prompt.
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (!tracker.isTracked(event.terminal)) return;
      const parsed = parseClaudeCommand(event.execution.commandLine.value);
      if (!parsed) return;
      const owned = tracker.isOwned(event.terminal);
      tracker.unregister(event.terminal);
      if (owned) event.terminal.dispose();
    }),

    // Refresh on terminal close — sessions are flushed to disk on exit.
    vscode.window.onDidCloseTerminal(() => provider.refresh())
  );

  const interval = setInterval(() => provider.refresh(), AUTO_REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export async function deactivate(): Promise<void> {
  if (activeWorkspaceRoot) {
    try {
      await uninstallHooks(activeWorkspaceRoot);
    } catch {
      // Best-effort — we're shutting down.
    }
  }
  if (activeWorkspaceRoot) {
    try {
      await unregisterMcpServer({ workspaceRoot: activeWorkspaceRoot });
    } catch {
      // Best-effort — we're shutting down.
    }
  }
}

async function writeLayoutSizesToDb(
  sidebarPx: number,
  panelPx: number
): Promise<void> {
  if (!cachedGlobalDbPath) {
    throw new Error('writeLayoutSizesToDb: paths not initialized');
  }
  // better-sqlite3 operates on disk via mmap/pread — no whole-file load, so
  // this works regardless of how large the DB has grown (e.g. Cursor's
  // multi-GB cursorDiskKV table).
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(cachedGlobalDbPath);
  try {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)'
    );
    stmt.run('workbench.sideBar.size', String(sidebarPx));
    stmt.run('workbench.panel.size', String(panelPx));
    stmt.run('workbench.panel.lastNonMaximizedWidth', String(panelPx));
  } finally {
    db.close();
  }
}

async function applyLayoutSizesCommand(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): Promise<void> {
  if (!context.globalStorageUri) {
    log.appendLine('applyLayoutSizes: no globalStorageUri');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('takeshicc.layout');
  const sidebarPx = cfg.get<number>('sidebarSizePx', 470);
  const panelPx = cfg.get<number>('panelSizePx', 622);

  try {
    await writeLayoutSizesToDb(sidebarPx, panelPx);
    log.appendLine(`applyLayoutSizes: wrote sidebar=${sidebarPx} panel=${panelPx}`);
  } catch (err) {
    log.appendLine(`applyLayoutSizes: write FAILED — ${(err as Error).message}`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Wrote sidebar=${sidebarPx}px, panel=${panelPx}px to global state.vscdb. ` +
      `Quit VS Code now? (Reload doesn't work — VS Code's shutdown persist clobbers our write. Quitting bypasses that.)`,
    'Quit VS Code',
    'Later'
  );
  if (choice === 'Quit VS Code') {
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

async function ensurePanelLeft(log: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  const key = 'workbench.panel.defaultLocation';
  const current = cfg.get<string>(key);
  if (current !== 'left') {
    try {
      await cfg.update(key, 'left', vscode.ConfigurationTarget.Global);
      log.appendLine(`ensurePanelLeft: set ${key}=left (was ${current ?? '<unset>'})`);
    } catch (err) {
      log.appendLine(`ensurePanelLeft: setting update FAILED — ${(err as Error).message}`);
    }
  }
  try {
    await vscode.commands.executeCommand('workbench.action.positionPanelLeft');
  } catch (err) {
    log.appendLine(`ensurePanelLeft: positionPanelLeft FAILED — ${(err as Error).message}`);
  }
}

async function bootstrapHooks(
  server: HookServer,
  workspaceRoot: string | undefined,
  log: vscode.OutputChannel
): Promise<void> {
  if (!workspaceRoot) {
    log.appendLine('bootstrapHooks: no workspace, skipping');
    return;
  }
  try {
    const { port, token } = await server.getConfig();
    const file = await installHooks({ workspaceRoot, port, token });
    log.appendLine(`bootstrapHooks: port=${port}, settings=${file}`);
  } catch (err) {
    log.appendLine(`bootstrapHooks: FAILED — ${(err as Error).message}`);
    void vscode.window.showWarningMessage(
      `Takeshi CC: failed to install Claude Code hooks (${(err as Error).message}). Per-session status in the sidebar will be unavailable.`
    );
  }
}

async function bootstrapMcp(
  server: McpHttpServer,
  workspaceRoot: string | undefined,
  log: vscode.OutputChannel
): Promise<void> {
  if (!workspaceRoot) {
    log.appendLine('bootstrapMcp: no workspace, skipping');
    return;
  }
  try {
    const { port, token } = await server.getConfig();
    const file = await registerMcpServer({ port, token, workspaceRoot });
    log.appendLine(`bootstrapMcp: port=${port}, settings=${file}`);
  } catch (err) {
    log.appendLine(`bootstrapMcp: FAILED — ${(err as Error).message}`);
  }
}

function describeEvent(e: HookEvent): string {
  const parts: string[] = [
    e.hook_event_name,
    `session=${e.session_id.slice(0, 8)}`,
  ];
  if (e.tool_name) parts.push(`tool=${e.tool_name}`);
  if (e.notification_type) parts.push(`notif=${e.notification_type}`);
  if (e.reason) parts.push(`reason=${e.reason}`);
  return parts.join(' ');
}

async function insertReferenceCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const ref = buildReference({
    uri: editor.document.uri,
    selection: editor.selection,
    workspaceRelativePath: vscode.workspace.asRelativePath(editor.document.uri, false),
  });
  if (!ref) return;

  const terminal = resolveTargetTerminal();
  if (!terminal) {
    void vscode.window.showInformationMessage(
      'No terminal available. Open a terminal and run `claude`.'
    );
    return;
  }

  terminal.show(false);
  terminal.sendText(ref + ' ', false);
}

async function openSessionCommand(
  sessionId: string,
  service: SessionService,
  tracker: TerminalTracker,
  hookStates: HookStateMachine,
  log: vscode.OutputChannel,
  cwd: string | undefined
): Promise<void> {
  log.appendLine(`openSession(${sessionId.slice(0, 8)})`);
  const existing = tracker.get(sessionId);
  if (existing) {
    log.appendLine('  → existing terminal, revealing');
    existing.show(false);
    return;
  }

  // Wait for hook settings to be written before spawning claude, otherwise
  // the subprocess may read stale settings from a previous activation (or no
  // settings at all on first install) and miss every hook for the session.
  await hooksReady;

  const info = await service.getInfo(sessionId);
  const label = info?.customTitle?.trim() || info?.summary?.trim() || sessionId.slice(0, 8);
  // Prefer the session's recorded cwd so a chat started in a worktree resumes
  // in that worktree. Falls back to the workspace root if the path no longer
  // exists (e.g. the worktree was removed).
  const sessionCwd = await resolveSessionCwd(info?.cwd, cwd, log);
  const terminal = vscode.window.createTerminal({
    name: `Claude: ${label}`,
    cwd: sessionCwd,
  });
  tracker.markOwned(terminal);
  tracker.register(sessionId, terminal);
  hookStates.seedIdle(sessionId, cwd);
  log.appendLine(`  → spawned terminal + seedIdle(${sessionId.slice(0, 8)})`);
  terminal.show(false);
  terminal.sendText(`claude --resume ${sessionId}`, true);
}

async function newChatCommand(
  service: SessionService,
  provider: SessionsWebviewViewProvider,
  tracker: TerminalTracker,
  hookStates: HookStateMachine,
  log: vscode.OutputChannel,
  cwd: string | undefined
): Promise<void> {
  log.appendLine('newChat');
  await hooksReady;
  const terminal = vscode.window.createTerminal({
    name: 'Claude: new',
    cwd,
  });
  tracker.markOwned(terminal);
  tracker.markPending(terminal);
  terminal.show(false);
  terminal.sendText('claude', true);

  void attachNewSession(terminal, service, provider, tracker, hookStates);
}

/**
 * Poll listSessions to find the session ID for a terminal that started `claude`
 * without --resume. Runs until the session is discovered and registered, or the
 * terminal is no longer pending (claude exited, terminal closed, or the
 * extension deactivated — all of which clear the pending flag via the tracker).
 *
 * Caller must have already called `tracker.markPending(terminal)`.
 */
async function attachNewSession(
  terminal: vscode.Terminal,
  service: SessionService,
  provider: SessionsWebviewViewProvider,
  tracker: TerminalTracker,
  hookStates: HookStateMachine
): Promise<void> {
  const startTime = Date.now();
  const knownIds = new Set((await service.list(true)).map((s) => s.sessionId));

  while (tracker.isPending(terminal)) {
    await sleep(NEW_CHAT_POLL_MS);
    if (!tracker.isPending(terminal)) return;
    if (terminal.exitStatus !== undefined) {
      tracker.unregister(terminal);
      return;
    }

    const sessions = await service.list(true);
    const fresh = sessions.find(
      (s) =>
        !knownIds.has(s.sessionId) &&
        (s.createdAt ?? s.lastModified) >= startTime
    );
    if (fresh) {
      tracker.register(fresh.sessionId, terminal);
      hookStates.seedIdle(fresh.sessionId);
      void provider.refresh();
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveSessionCwd(
  sessionCwd: string | undefined,
  fallback: string | undefined,
  log: vscode.OutputChannel
): Promise<string | undefined> {
  if (!sessionCwd) return fallback;
  try {
    const stat = await fs.stat(sessionCwd);
    if (stat.isDirectory()) return sessionCwd;
  } catch {
    // dir gone (worktree removed, etc.) — fall through
  }
  log.appendLine(
    `openSession: session cwd ${sessionCwd} unavailable, falling back to ${fallback ?? '<none>'}`
  );
  return fallback;
}
