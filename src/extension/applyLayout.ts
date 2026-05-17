import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import Database = require('better-sqlite3');

// VS Code keeps part sizes as discrete keys in the *global* state.vscdb,
// stored as text. Sidebar/panel positions live in the workspace db and are
// handled here via the positionPanelLeft command instead.
const SIDEBAR_SIZE_KEY = 'workbench.sideBar.size';
const PANEL_SIZE_KEY = 'workbench.panel.size';

function globalStateDbPath(context: vscode.ExtensionContext): string {
  return path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
}

export async function applyLayout(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = globalStateDbPath(context);
  if (!fs.existsSync(dbPath)) {
    vscode.window.showErrorMessage(`Takeshicc: state.vscdb not found at ${dbPath}`);
    return;
  }

  // Dock the panel on the left first so workbench.panel.size maps to width.
  await vscode.commands.executeCommand('workbench.action.positionPanelLeft');

  const config = vscode.workspace.getConfiguration('takeshicc');
  const sidebarWidth = config.get<number>('sidebarWidth');
  const panelWidth = config.get<number>('panelWidth');

  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Takeshicc: failed to open state.vscdb — ${(err as Error).message}`);
    return;
  }

  const updated: string[] = [];
  try {
    const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    if (typeof sidebarWidth === 'number') {
      upsert.run(SIDEBAR_SIZE_KEY, String(sidebarWidth));
      updated.push(`sidebar=${sidebarWidth}`);
    }
    if (typeof panelWidth === 'number') {
      upsert.run(PANEL_SIZE_KEY, String(panelWidth));
      updated.push(`panel=${panelWidth}`);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Takeshicc: write failed — ${(err as Error).message}`);
    return;
  } finally {
    db.close();
  }

  if (updated.length === 0) {
    vscode.window.showWarningMessage('Takeshicc: no widths configured to apply.');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Takeshicc: moved panel left and wrote ${updated.join(', ')} to state.vscdb. ` +
      `Quit ${vscode.env.appName} now — Reload Window will clobber the change.`,
    'Quit'
  );
  if (choice === 'Quit') {
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}
