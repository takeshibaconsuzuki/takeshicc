import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { registerPasteFileRef } from './pasteFileRef';
import { SharedServerConnection } from './sharedServer';
import { registerClaudeHooks } from './claudeHooks';
import { StatusPanel } from './statusPanel';

let sharedServer: SharedServerConnection | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.applyLayout', () => applyLayout(context))
  );
  registerPasteFileRef(context);

  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(log);

  const server = new SharedServerConnection(context, log);
  sharedServer = server;
  void server.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.showStatus', () => StatusPanel.show(server))
  );

  void registerClaudeHooks(log).catch((err) =>
    log.appendLine(`Hook registration failed: ${err}`)
  );
}

export function deactivate() {
  sharedServer?.dispose();
  sharedServer = undefined;
}
