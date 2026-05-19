import * as vscode from 'vscode';
import { applyLayout } from './applyLayout';
import { openConfig } from './openConfig';
import { registerPasteFileRef } from './pasteFileRef';
import { getOrCreateServer, openServerLog } from './getOrCreateServer';
import { COMMANDS } from './commands';
import { mergeClaudeHttpHooks } from './claudeHooks';
import type { ServerClient } from './ServerClient';
import { LiveChatsViewProvider } from './liveChatsView';
import { WorktreesViewProvider } from './worktreesView';
import { resolveGitMetadata, type GitMetadata } from '../common/gitUtils';
import { errMsg } from '../common/errMsg';
import { CONFIG_PATH, lookupGroup, type ResolvedGroup } from '../common/config';

let serverClient: ServerClient | undefined;
let reconnecting = false;
let deactivated = false;

function startServerSupervisor(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  group: ResolvedGroup,
): void {
  const connect = async (reason: string) => {
    if (deactivated || reconnecting) {
      return;
    }
    reconnecting = true;
    serverClient = undefined;
    if (reason !== 'activation') {
      log.appendLine(`Takeshicc: reconnecting to server after ${reason}.`);
    }
    try {
      serverClient = await getOrCreateServer(context, log, group, (deadReason) => {
        void connect(deadReason);
      });
      serverClient?.startInstanceCommandStream((message) => {
        if (message.type !== 'quit') {
          return;
        }
        if (message.worktreePath !== group.worktreePath) {
          log.appendLine(
            `Takeshicc: ignored quit request for ${message.worktreePath}; ` +
              `current worktree is ${group.worktreePath}.`,
          );
          return;
        }
        log.appendLine(`Takeshicc: quit requested for ${message.worktreePath}.`);
        void (async () => {
          try {
            await vscode.commands.executeCommand('workbench.action.closeWindow');
          } catch (err) {
            log.appendLine(`Takeshicc: could not close target window — ${errMsg(err)}`);
          }
        })();
      });
    } catch (err) {
      log.appendLine(
        `Takeshicc: getOrCreateServer threw — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    } finally {
      reconnecting = false;
    }
  };

  // Do NOT await — getOrCreateServer may poll indefinitely and must never
  // block activation.
  void connect('activation');
}

export async function activate(context: vscode.ExtensionContext) {
  deactivated = false;

  const log = vscode.window.createOutputChannel('Takeshicc');
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.applyLayout, () => applyLayout(context)),
    vscode.commands.registerCommand(COMMANDS.openConfig, () => openConfig()),
  );
  registerPasteFileRef(context);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log.appendLine('Takeshicc: no workspace folder found');
    return;
  }

  let gitMetadata: GitMetadata;
  try {
    gitMetadata = await resolveGitMetadata(folder.uri.fsPath);
  } catch (err) {
    log.appendLine(`Takeshicc: could not resolve git metadata — ${errMsg(err)}`);
    return;
  }

  let group: ResolvedGroup | undefined;
  try {
    group = lookupGroup(gitMetadata);
  } catch (err) {
    const message = `Takeshicc: invalid config at ${CONFIG_PATH} — ${errMsg(err)}`;
    log.appendLine(message);
    vscode.window.showErrorMessage(message);
    return;
  }
  if (!group) {
    log.appendLine(
      `Takeshicc: group "${gitMetadata.mainWorktreePath}" not found in ${CONFIG_PATH}.`,
    );
    return;
  }

  try {
    const changed = mergeClaudeHttpHooks(gitMetadata.worktreePath, group.port);
    log.appendLine(
      `Takeshicc: Claude HTTP hooks ${changed ? 'merged into' : 'already present in'} ` +
        `${gitMetadata.worktreePath}/.claude/settings.local.json.`,
    );
  } catch (err) {
    const message = `Takeshicc: could not merge Claude HTTP hooks — ${errMsg(err)}`;
    log.appendLine(message);
    vscode.window.showWarningMessage(message);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.openServerLog, () => openServerLog(group)),
    vscode.window.registerWebviewViewProvider(
      WorktreesViewProvider.viewType,
      new WorktreesViewProvider(log, () => serverClient, gitMetadata, group.groupId),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewViewProvider(
      LiveChatsViewProvider.viewType,
      new LiveChatsViewProvider(() => serverClient),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  log.appendLine(
    `Takeshicc: extension activated (v${context.extension.packageJSON.version ?? '?'}).`,
  );
  log.appendLine(
    `Takeshicc: git main-worktree ${gitMetadata.mainWorktreePath}, ` +
      `current worktree ${gitMetadata.worktreePath}, ` +
      `branch ${gitMetadata.currentBranch ?? 'detached HEAD'}.`,
  );

  startServerSupervisor(context, log, group);
}

export async function deactivate(): Promise<void> {
  deactivated = true;
  // The server idle-exits on its own; unregister just lets deletion jobs move
  // immediately instead of waiting for heartbeat expiry.
  await serverClient?.unregisterAndClose();
}
