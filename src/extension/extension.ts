import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { openConfig } from './config';
import { registerPasteFileRef } from './pasteFileRef';
import {
  getOrCreateServer,
  openServerLog,
  ServerClient,
} from './getOrCreateServer';
import { LiveChatsViewProvider } from './liveChatsView';
import { LiveChatMetadata } from '../server/protocol';
import { TerminalTracker } from './terminalTracker';

let serverClient: ServerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Created before commands so the openServerLog handler can log through it.
  const log = vscode.window.createOutputChannel('Takeshicc');

  // Maps live chats to the terminals hosting them; clicking a chat row reveals
  // its terminal through tracker.reveal().
  const tracker = new TerminalTracker(log);
  const liveChats = new LiveChatsViewProvider(log, (chatId) => {
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
  });
  context.subscriptions.push(
    log,
    tracker,
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
      // The latest snapshot, re-rendered whenever it or the terminal bindings
      // change (a binding can land after the snapshot, once the tracker has
      // resolved terminal PIDs, or be lost when a terminal closes).
      let latestChats: LiveChatMetadata[] = [];
      const refresh = () =>
        liveChats.update(latestChats, tracker.revealableChatIds());
      context.subscriptions.push(tracker.onDidChange(refresh));

      // Subscribe to the server's push stream: it delivers the current
      // snapshot immediately and a fresh one on every change.
      c.subscribeLiveChats((chats) => {
        latestChats = chats;
        void tracker.ingest(chats).then(refresh);
        refresh();
      });
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
