import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { registerPasteFileRef } from './pasteFileRef';
import { getOrCreateServer, ServerClient } from './getOrCreateServer';

let serverClient: ServerClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.applyLayout', () => applyLayout(context))
  );
  registerPasteFileRef(context);

  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(log);
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
