import { CONFIG_PATH } from "../common/config";
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Opens CONFIG_PATH in an editor, scaffolding an empty config first if it does
// not yet exist — the command is most useful before any config is written.
export async function openConfig(): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      await fs.promises.writeFile(CONFIG_PATH, '{\n  "groups": {}\n}\n', 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(CONFIG_PATH));
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Takeshicc: could not open ${CONFIG_PATH} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
