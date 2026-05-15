import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('takeshicc.applyLayout', () => applyLayout(context))
  );
}

export function deactivate() {}
