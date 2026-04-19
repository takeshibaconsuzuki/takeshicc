import * as vscode from 'vscode';
import { buildReference } from './reference';
import { resolveTargetTerminal, TerminalTracker } from './terminals';
import { SessionService } from './sessions/service';
import { SessionTreeDataProvider } from './sessions/provider';
import { parseClaudeCommand } from './parseClaudeCommand';
import { HookServer, type HookEvent } from './hooks/server';
import { HookStateMachine } from './hooks/stateMachine';
import { installHooks, uninstallHooks } from './hooks/settings';

const AUTO_REFRESH_MS = 30_000;
const NEW_CHAT_POLL_MS = 1_000;

let activeWorkspaceRoot: string | undefined;
let hooksReady: Promise<void> = Promise.resolve();

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  activeWorkspaceRoot = workspaceRoot;
  const log = vscode.window.createOutputChannel('Takeshi CC');
  log.appendLine(`activate: workspace=${workspaceRoot ?? '<none>'}`);

  const service = new SessionService(workspaceRoot);
  const tracker = new TerminalTracker();
  const hookStates = new HookStateMachine();
  const hookServer = new HookServer();
  const provider = new SessionTreeDataProvider(service, tracker, hookStates);

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

  context.subscriptions.push(
    log,
    tracker,
    hookStates,
    hookServer,
    provider,
    vscode.commands.registerCommand(
      'takeshicc.insertReference',
      insertReferenceCommand
    ),
    vscode.window.registerTreeDataProvider('takeshicc.sessions', provider),
    vscode.commands.registerCommand('takeshicc.refreshSessions', () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand(
      'takeshicc.openSession',
      (sessionId: string) =>
        openSessionCommand(sessionId, service, tracker, hookStates, log, workspaceRoot)
    ),
    vscode.commands.registerCommand('takeshicc.newChat', () =>
      newChatCommand(service, provider, tracker, hookStates, log, workspaceRoot)
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
    // its session. The terminal itself is left alone (the user's shell is back
    // at its prompt), but clicking the session in the sidebar will now spawn
    // a fresh `claude --resume` terminal rather than reveal this one.
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (!tracker.isTracked(event.terminal)) return;
      const parsed = parseClaudeCommand(event.execution.commandLine.value);
      if (!parsed) return;
      tracker.unregister(event.terminal);
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

  terminal.show(true);
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
  const terminal = vscode.window.createTerminal({
    name: `Claude: ${label}`,
    cwd,
  });
  tracker.register(sessionId, terminal);
  hookStates.seedIdle(sessionId, cwd);
  log.appendLine(`  → spawned terminal + seedIdle(${sessionId.slice(0, 8)})`);
  terminal.show(false);
  terminal.sendText(`claude --resume ${sessionId}`, true);
}

async function newChatCommand(
  service: SessionService,
  provider: SessionTreeDataProvider,
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
  provider: SessionTreeDataProvider,
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
