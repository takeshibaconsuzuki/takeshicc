import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { openConfig } from './config';
import { registerPasteFileRef } from './pasteFileRef';
import {
  copyServerKillCommand,
  getOrCreateServer,
  openServerLog,
  ServerClient,
} from './getOrCreateServer';
import { LiveChatsViewProvider } from './liveChatsView';
import { HistoricalChatMetadata, LiveChatMetadata } from '../server/protocol';
import { TerminalTracker } from './terminalTracker';
import { readHistoricalTail } from './historicalTail';

// A resumed Claude Code session is launched as `claude --resume <id>` (also
// `--resume=<id>` or `-r <id>`). parseResumeChatId pulls the session id out of
// a terminal command line — used both to recognise a resume the user typed
// themselves and to recognise when a resume's `claude` process has exited.
// Returns the lower-cased session UUID, or undefined when the command line is
// not a claude resume carrying an explicit id (a bare `claude --resume` opens
// an interactive picker, so there is no id to extract up front).
const RESUME_ID_RE =
  /(?:--resume[=\s]+|(?:^|\s)-r[=\s]+)["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function parseResumeChatId(commandLine: string): string | undefined {
  if (!/\bclaude\b/.test(commandLine)) {
    return undefined;
  }
  const m = RESUME_ID_RE.exec(commandLine);
  return m ? m[1].toLowerCase() : undefined;
}

let serverClient: ServerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Created before commands so the openServerLog handler can log through it.
  const log = vscode.window.createOutputChannel('Takeshicc');

  // The first workspace folder — the worktree historical chats are scoped to,
  // and the cwd a resumed chat's terminal is spawned in.
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Maps live chats to the terminals hosting them; clicking a chat row reveals
  // its terminal through tracker.reveal().
  const tracker = new TerminalTracker(log);

  // The latest server snapshot and the worktree's historical chats — module
  // state because both the optimistic-resume handlers and the server
  // subscription read and write them. The view is re-rendered (refresh)
  // whenever either, the optimistic set, or the terminal bindings change.
  let latestChats: LiveChatMetadata[] = [];
  let latestHistorical: HistoricalChatMetadata[] = [];

  // Optimistically-resumed chats: chatId -> the terminal running it, plus the
  // label and timestamp to render. A resume — clicked on a historical row, or
  // typed by the user and observed via terminal shell integration — is shown
  // as a live-idle chat synthesised from this map straight away, rather than
  // waiting for the session's first hook (SessionStart is not reliably
  // delivered). An entry is held until the real chat arrives over SSE (server
  // truth takes over), its terminal closes, or its `claude` process exits — it
  // is deliberately NOT time-limited, since a resumed session may legitimately
  // sit idle and untouched for any length of time.
  const optimistic = new Map<
    string,
    { terminal: vscode.Terminal; summary: string; mTime: number }
  >();

  // Re-renders the view. Reassigned once the server connects; a no-op before
  // then — the view shows no clickable rows until it is.
  let refresh: () => void = () => {};

  // Discard an optimistic entry — the server now owns the chat, its terminal
  // closed, or its `claude` process exited — and re-render.
  const dropOptimistic = (chatId: string): void => {
    if (optimistic.delete(chatId)) {
      refresh();
    }
  };

  // Begin tracking a resumed chat optimistically: bind its terminal and show
  // it as a live-idle chat at once. summary/mTime are carried over from the
  // historical record so the row looks identical across the historical <->
  // live transition. A no-op if it is already tracked — clicked resumes are
  // added here directly and then observed a second time via shell integration;
  // the second sighting must not clobber the first.
  const addOptimistic = (
    chatId: string,
    terminal: vscode.Terminal,
    summary: string,
    mTime: number,
  ): void => {
    if (optimistic.has(chatId)) {
      return;
    }
    tracker.bind(chatId, terminal);
    optimistic.set(chatId, { terminal, summary, mTime });
    refresh();
  };

  // A `claude --resume <id>` command starting in a terminal — seen via shell
  // integration. Tracks the user's own manual resumes (clicked resumes reach
  // here too, but addOptimistic already holds them). The label and mtime, when
  // known, are taken from the historical list; mtime falls back to now for a
  // session with no historical record (e.g. resumed from another worktree).
  const onResumeCommandStart = (
    terminal: vscode.Terminal,
    commandLine: string,
  ): void => {
    const chatId = parseResumeChatId(commandLine);
    if (!chatId || optimistic.has(chatId)) {
      return;
    }
    const hist = latestHistorical.find((x) => x.chatId === chatId);
    addOptimistic(
      chatId,
      terminal,
      hist?.summary ?? '',
      hist?.mTime ?? Date.now(),
    );
    log.appendLine(
      `Takeshicc: observed 'claude --resume ${chatId}' — ` +
        `tracking it optimistically as a live chat.`,
    );
  };

  const liveChats = new LiveChatsViewProvider(
    log,
    (chatId) => {
      const revealed = tracker.reveal(chatId);
      log.appendLine(
        `Takeshicc: row clicked for chat ${chatId} — ` +
          `${revealed ? 'revealed its terminal' : 'no bound terminal'}.`,
      );
      if (!revealed) {
        vscode.window.showInformationMessage(
          'Takeshicc: that chat is not running in a terminal in this window.',
        );
      }
    },
    // onResume — a historical-chat row was clicked: open a terminal in the
    // worktree, run `claude --resume <chatId>`, and optimistically treat the
    // chat as live-idle and bound to that terminal right away.
    (chatId, summary, mTime) => {
      const terminal = vscode.window.createTerminal({
        name: `claude --resume`,
        cwd: workspaceDir,
      });
      terminal.show();
      terminal.sendText(`claude --resume ${chatId}`);
      addOptimistic(chatId, terminal, summary, mTime);
      log.appendLine(
        `Takeshicc: resuming historical chat ${chatId} in a new terminal.`,
      );
    },
    // onNewChat — the New Chat button was pressed: open a terminal in the
    // worktree and run `claude`. Unlike a resume, no optimistic/synthetic
    // entry is created — the chat has no id yet and SessionStart is not
    // reliably delivered. It surfaces on its own once the session's first
    // UserPromptSubmit fires the reporter hook, whose ancestor PIDs let the
    // tracker bind it to this terminal.
    () => {
      const terminal = vscode.window.createTerminal({
        name: `claude`,
        cwd: workspaceDir,
      });
      terminal.show();
      terminal.sendText(`claude`);
      log.appendLine('Takeshicc: started a new chat in a new terminal.');
    },
  );
  context.subscriptions.push(
    log,
    tracker,
    // A resume whose terminal closes is over (or never started) — drop it.
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [chatId, entry] of optimistic) {
        if (entry.terminal === closed) {
          dropOptimistic(chatId);
        }
      }
    }),
    // Shell integration: catch `claude --resume` typed by the user, and catch
    // any resume's `claude` process exiting (which ends the chat — clear the
    // optimistic entry; if the server already owns the chat this is a no-op).
    vscode.window.onDidStartTerminalShellExecution((e) =>
      onResumeCommandStart(e.terminal, e.execution.commandLine.value),
    ),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      const chatId = parseResumeChatId(e.execution.commandLine.value);
      if (chatId) {
        dropOptimistic(chatId);
      }
    }),
    vscode.window.registerWebviewViewProvider(
      LiveChatsViewProvider.viewType,
      liveChats,
    ),
    vscode.commands.registerCommand('takeshicc.applyLayout', () =>
      applyLayout(context),
    ),
    vscode.commands.registerCommand('takeshicc.openConfig', () => openConfig()),
    vscode.commands.registerCommand('takeshicc.openServerLog', () =>
      openServerLog(log),
    ),
    vscode.commands.registerCommand('takeshicc.copyServerKillCommand', () =>
      copyServerKillCommand(log),
    ),
  );
  registerPasteFileRef(context);

  log.appendLine(
    `Takeshicc: extension activated (v${context.extension.packageJSON.version ?? '?'}).`,
  );

  // Do NOT await — getOrCreateServer loops forever and must never block activation.
  void getOrCreateServer(context, log)
    .then((c) => {
      serverClient = c;
      if (!c) {
        // No server for this workspace — feature off.
        liveChats.setOff();
        return;
      }
      // The live set the view shows and the tracker reconciles against: the
      // server snapshot plus a synthetic idle entry for each optimistically-
      // resumed chat the server has not reported yet. Feeding this (not the raw
      // snapshot) to tracker.ingest keeps an optimistic binding from being
      // reconciled away before the resumed session's hooks land.
      const mergedLiveChats = (): LiveChatMetadata[] => {
        const reported = new Set(latestChats.map((x) => x.chatId));
        // A resumed chat carries its client-read historical tail across the
        // historical -> live transition: on the synthetic optimistic entry,
        // and as a fallback for a server-reported chat that has no live tail
        // yet (the server needs a hook event plus a poll cycle). The server's
        // tail wins the moment it exists — for a just-resumed chat it reads
        // the same transcript, so the content does not jump.
        const synthetic: LiveChatMetadata[] = [];
        for (const [chatId, entry] of optimistic) {
          if (!reported.has(chatId)) {
            synthetic.push({
              chatId,
              state: 'idle',
              mTime: entry.mTime,
              summary: entry.summary,
              tail: historicalTails.get(chatId),
            });
          }
        }
        const reportedWithTail = latestChats.map((c) =>
          c.tail === undefined && historicalTails.has(c.chatId)
            ? { ...c, tail: historicalTails.get(c.chatId) }
            : c,
        );
        return [...reportedWithTail, ...synthetic];
      };

      refresh = () => {
        const merged = mergedLiveChats();
        const liveIds = new Set(merged.map((x) => x.chatId));
        // A chat belongs in exactly one section — keep live ones out of the
        // historical list (a clicked row leaves Historical the instant it is
        // resumed, without waiting for the next historical fetch).
        const historical = latestHistorical.filter(
          (x) => !liveIds.has(x.chatId),
        );
        liveChats.update(merged, tracker.revealableChatIds(), historical);
      };
      context.subscriptions.push(tracker.onDidChange(refresh));

      // This window's desired chat-tail length. Clamped to a non-negative
      // integer; the package.json schema already bounds the value, this just
      // hardens against a hand-edit. Used both for the live subscription
      // (passed to the server) and for the historical tails read below.
      const tailLines = (): number => {
        const n = vscode.workspace
          .getConfiguration('takeshicc')
          .get<number>('tailLines', 3);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      };

      // chatId -> its historical tail, read exactly once. Past transcripts are
      // immutable, so a cached entry is never stale. Kept even after a chat is
      // resumed (it leaves the historical list but the entry lingers) so
      // mergedLiveChats can bridge its tail until the server's live tail lands.
      // Cleared when `takeshicc.tailLines` changes so the new length applies.
      const historicalTails = new Map<string, string[]>();

      // Read — once — the tail of every historical chat not already cached,
      // itself via the Claude Agent SDK (not the server). Sequential to keep
      // the one-time disk cost gentle. Only populates the cache; rendering is
      // the caller's job, deferred until this resolves so a historical row is
      // never shown before its tail is ready.
      const fillHistoricalTails = async (
        chats: HistoricalChatMetadata[],
      ): Promise<void> => {
        const n = tailLines();
        if (n <= 0) {
          return;
        }
        for (const chat of chats) {
          if (historicalTails.has(chat.chatId)) {
            continue;
          }
          const t = await readHistoricalTail(chat.chatId, workspaceDir, n);
          if (t && t.length) {
            historicalTails.set(chat.chatId, t);
          }
        }
      };

      // Fetch the worktree's past chats, then reveal them only once their
      // tails are loaded — the prior list stays visible until the new one is
      // ready, so a row never flashes in without its description.
      const fetchHistorical = () => {
        if (!workspaceDir) {
          return;
        }
        c.getHistoricalChats(workspaceDir)
          .then(async (historical) => {
            await fillHistoricalTails(historical);
            latestHistorical = historical.map((h) => ({
              ...h,
              tail: historicalTails.get(h.chatId),
            }));
            refresh();
          })
          .catch((err) => {
            log.appendLine(
              `Takeshicc: historical chats fetch failed — ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          });
      };

      // Re-fetch historical chats only when the live-chat membership changes —
      // a chat ending is what turns it into a historical one, and re-reading
      // every session file on each mid-turn hook event would be wasteful.
      // Starts null so the first snapshot always triggers the initial fetch.
      let liveSig: string | null = null;

      const onSnapshot = (chats: LiveChatMetadata[]) => {
        latestChats = chats;
        // The server now owns any optimistic chat it reports — once it does,
        // the synthetic entry is no longer needed.
        for (const chatId of [...optimistic.keys()]) {
          if (chats.some((x) => x.chatId === chatId)) {
            dropOptimistic(chatId);
          }
        }
        void tracker.ingest(mergedLiveChats()).then(refresh);
        refresh();
        const sig = chats
          .map((x) => x.chatId)
          .sort()
          .join(',');
        if (sig !== liveSig) {
          liveSig = sig;
          fetchHistorical();
        }
      };

      // Subscribe to the server's push stream: it delivers the current
      // snapshot immediately and a fresh one on every change.
      c.subscribeLiveChats(onSnapshot, tailLines());

      // Re-subscribe when the tail-length setting changes so it applies live —
      // subscribeLiveChats replaces the prior stream, and the server recomputes
      // its tail at the new max across subscribers.
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('takeshicc.tailLines')) {
            c.subscribeLiveChats(onSnapshot, tailLines());
            // Apply the new length to historical chats too: drop the cache so
            // the next fetch re-reads each at the new N (consistent with the
            // live re-subscribe above; still a one-shot, not a poll).
            historicalTails.clear();
            fetchHistorical();
          }
        }),
      );
    })
    .catch((err) => {
      log.appendLine(
        `Takeshicc: getOrCreateServer threw — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      liveChats.setError('server resolution failed');
    });
}

export function deactivate() {
  // The server idle-exits on its own; close() just stops our heartbeat.
  serverClient?.close();
}
