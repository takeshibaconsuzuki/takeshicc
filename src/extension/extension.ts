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

let serverClient: ServerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Created before commands so the openServerLog handler can log through it.
  const log = vscode.window.createOutputChannel('Takeshicc');
  const liveChats = new LiveChatsViewProvider(log);
  context.subscriptions.push(
    log,
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
      // Subscribe to the server's push stream: it delivers the current
      // snapshot immediately and a fresh one on every change.
      c.subscribeLiveChats((chats) => liveChats.update(chats));
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
