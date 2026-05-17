import { CONFIG_PATH, TAKESHICC_DIR } from '../common/config';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { errMsg } from '../common/errMsg';

// Opens CONFIG_PATH in an editor, scaffolding an empty config first if it does
// not yet exist — the command is most useful before any config is written.
export async function openConfig(): Promise<void> {
  try {
    await fs.promises.mkdir(TAKESHICC_DIR, { recursive: true });
    try {
      // 'wx' fails with EEXIST rather than clobbering an existing config.
      await fs.promises.writeFile(CONFIG_PATH, '{\n  "groups": {}\n}\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(CONFIG_PATH));
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`Takeshicc: could not open ${CONFIG_PATH} — ${errMsg(err)}`);
  }
}
