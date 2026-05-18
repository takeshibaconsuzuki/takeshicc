import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { openConfig } from './openConfig';
import { registerPasteFileRef } from './pasteFileRef';
import { getOrCreateServer, openServerLog } from './getOrCreateServer';
import { COMMANDS } from './commands';
import type { ServerClient } from './ServerClient';
import { WorktreesViewProvider } from './worktreesView';

let serverClient: ServerClient | undefined;
let reconnecting = false;
let deactivated = false;

function startServerSupervisor(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  const connect = async (reason: string) => {
    if (deactivated || reconnecting) {
      return;
    }
    reconnecting = true;
    serverClient = undefined;
    if (reason !== 'activation') {
      log.appendLine(`Takeshicc: reconnecting to server after ${reason}.`);
    }
    try {
      serverClient = await getOrCreateServer(context, log, (deadReason) => {
        void connect(deadReason);
      });
    } catch (err) {
      log.appendLine(
        `Takeshicc: getOrCreateServer threw — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    } finally {
      reconnecting = false;
    }
  };

  // Do NOT await — getOrCreateServer may poll indefinitely and must never
  // block activation.
  void connect('activation');
}

export async function activate(context: vscode.ExtensionContext) {
  deactivated = false;
  // Created before commands so the openServerLog handler can log through it.
  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(COMMANDS.applyLayout, () => applyLayout(context)),
    vscode.commands.registerCommand(COMMANDS.openConfig, () => openConfig()),
    vscode.commands.registerCommand(COMMANDS.openServerLog, () => openServerLog(log)),
    vscode.window.registerWebviewViewProvider(
      WorktreesViewProvider.viewType,
      new WorktreesViewProvider(log, () => serverClient),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  registerPasteFileRef(context);

  log.appendLine(
    `Takeshicc: extension activated (v${context.extension.packageJSON.version ?? '?'}).`,
  );

  startServerSupervisor(context, log);
}

export function deactivate() {
  deactivated = true;
  // The server idle-exits on its own; close() just stops our heartbeat.
  serverClient?.close();
}
