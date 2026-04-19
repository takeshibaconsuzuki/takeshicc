import * as vscode from 'vscode';
import { SessionService } from './service';
import { SessionTreeItem } from './item';
import { TerminalTracker } from '../terminals';
import type { HookStateMachine } from '../hooks/stateMachine';
import { mapHookStatus, type SessionStatus } from './statusResolver';

type Node = SessionTreeItem | PlaceholderItem;

export class SessionTreeDataProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly service: SessionService,
    private readonly tracker: TerminalTracker,
    private readonly hookStates: HookStateMachine
  ) {
    const fireChange = () => this.emitter.fire(undefined);
    this.subs.push(tracker.onDidChange(fireChange));
    this.subs.push(hookStates.onDidChange(fireChange));
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element) return [];
    const sessions = await this.service.list();
    if (sessions.length === 0) return [new PlaceholderItem('No sessions yet')];
    return sessions
      .slice()
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((s) => new SessionTreeItem(s, this.resolveStatus(s.sessionId)));
  }

  private resolveStatus(sessionId: string): SessionStatus {
    const hook = this.hookStates.get(sessionId);
    if (!hook) return 'inactive';
    return mapHookStatus(hook.status);
  }

  async refresh(): Promise<void> {
    await this.service.list(true);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}

class PlaceholderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'claudeSessionPlaceholder';
  }
}
