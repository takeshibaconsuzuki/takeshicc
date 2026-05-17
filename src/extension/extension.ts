import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { openConfig } from './openConfig';
import { registerPasteFileRef } from './pasteFileRef';
import { getOrCreateServer, openServerLog, ServerClient } from './getOrCreateServer';
import { COMMANDS } from './commands';

let serverClient: ServerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Created before commands so the openServerLog handler can log through it.
  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(COMMANDS.applyLayout, () => applyLayout(context)),
    vscode.commands.registerCommand(COMMANDS.openConfig, () => openConfig()),
    vscode.commands.registerCommand(COMMANDS.openServerLog, () => openServerLog(log))
  );
  registerPasteFileRef(context);

  log.appendLine(
    `Takeshicc: extension activated (v${context.extension.packageJSON.version ?? '?'}).`,
  );

  // Do NOT await — getOrCreateServer loops forever and must never block activation.
  void getOrCreateServer(context, log)
    .then((c) => {
      serverClient = c;
    })
    .catch((err) => {
      log.appendLine(
        `Takeshicc: getOrCreateServer threw — ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    });
}

export function deactivate() {
  // The server idle-exits on its own; close() just stops our heartbeat.
  serverClient?.close();
}
