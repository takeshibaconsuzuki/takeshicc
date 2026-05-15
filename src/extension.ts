import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('takeshicc.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from takeshicc!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
