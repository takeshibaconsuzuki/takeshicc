import * as vscode from 'vscode';

const COMMAND_ID = 'takeshicc.pasteFileRef';

// When the integrated terminal has focus, VS Code sends keystrokes straight to
// the shell — workbench keybindings only fire if their command is listed in
// `terminal.integrated.commandsToSkipShell`. Add ours so Alt+K works from the
// terminal too.
async function ensureSkipShell() {
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  const userValue =
    config.inspect<string[]>('commandsToSkipShell')?.globalValue ?? [];
  if (userValue.includes(COMMAND_ID)) {
    return;
  }
  try {
    await config.update(
      'commandsToSkipShell',
      [...userValue, COMMAND_ID],
      vscode.ConfigurationTarget.Global,
    );
  } catch (err) {
    vscode.window.showWarningMessage(
      `Takeshicc: could not register Alt+K for the terminal — add "${COMMAND_ID}" ` +
        'to terminal.integrated.commandsToSkipShell manually. ' +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// Wires up the `takeshicc.pasteFileRef` command (bound to Alt+K). It pastes a
// Claude Code file reference — `@<relative-path>#L<start>-<end>` — for the
// active editor's selection into the active terminal.
export function registerPasteFileRef(context: vscode.ExtensionContext) {
  void ensureSkipShell();

  // Alt+K may be pressed while the terminal has focus, in which case
  // `activeTextEditor` is undefined. Remember the last editor + selection so
  // the reference still resolves to the code the user just selected.
  let lastEditor = vscode.window.activeTextEditor;
  let lastSelection = lastEditor?.selection;

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      lastEditor = e.textEditor;
      lastSelection = e.selections[0];
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        lastEditor = editor;
        lastSelection = editor.selection;
      }
    }),
    vscode.commands.registerCommand(COMMAND_ID, () => {
      const editor = vscode.window.activeTextEditor ?? lastEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          'Takeshicc: open a file to reference first.',
        );
        return;
      }
      const selection = vscode.window.activeTextEditor
        ? editor.selection
        : (lastSelection ?? editor.selection);

      const terminal =
        vscode.window.activeTerminal ?? vscode.window.terminals[0];
      if (!terminal) {
        vscode.window.showWarningMessage(
          'Takeshicc: no terminal open to paste into.',
        );
        return;
      }

      // Claude Code at-mentions use forward slashes regardless of platform.
      const relPath = vscode.workspace
        .asRelativePath(editor.document.uri, false)
        .replace(/\\/g, '/');

      let ref: string;
      if (selection.isEmpty) {
        // Just a cursor, no selection — reference the whole file.
        ref = `@${relPath}`;
      } else {
        const startLine = selection.start.line + 1;
        let endLine = selection.end.line + 1;
        // A selection ending at column 0 doesn't actually include that last line.
        if (selection.end.character === 0 && endLine > startLine) {
          endLine--;
        }
        ref =
          startLine === endLine
            ? `@${relPath}#L${startLine}`
            : `@${relPath}#L${startLine}-${endLine}`;
      }

      // Trailing space, no newline — the user keeps typing their prompt.
      terminal.sendText(ref + ' ', false);
      terminal.show();
    }),
  );
}
