import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { registerPasteFileRef } from './pasteFileRef';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.applyLayout', () => applyLayout(context))
  );
  registerPasteFileRef(context);
}

export function deactivate() {}
