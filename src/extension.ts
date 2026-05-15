import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { registerPasteFileRef } from './pasteFileRef';
import { SharedServerConnection } from './sharedServer';

let sharedServer: SharedServerConnection | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.applyLayout', () => applyLayout(context))
  );
  registerPasteFileRef(context);

  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(log);
  sharedServer = new SharedServerConnection(context, log);
  void sharedServer.start();
}

export function deactivate() {
  sharedServer?.dispose();
  sharedServer = undefined;
}
