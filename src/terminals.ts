import * as vscode from 'vscode';

export function resolveTargetTerminal(): vscode.Terminal | undefined {
  const active = vscode.window.activeTerminal;
  if (active) return active;
  return vscode.window.terminals.find((t) =>
    t.name.toLowerCase().includes('claude')
  );
}

export class TerminalTracker implements vscode.Disposable {
  private readonly map = new Map<string, vscode.Terminal>();
  private readonly pending = new Set<vscode.Terminal>();
  private readonly closeSub: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly unregisterEmitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changeEmitter.event;
  /** Fired with the session ID whenever a session is removed from the tracker. */
  readonly onDidUnregister = this.unregisterEmitter.event;

  constructor() {
    this.closeSub = vscode.window.onDidCloseTerminal((t) => this.unregister(t));
  }

  get(sessionId: string): vscode.Terminal | undefined {
    return this.map.get(sessionId);
  }

  trackedSessionIds(): Iterable<string> {
    return this.map.keys();
  }

  register(sessionId: string, terminal: vscode.Terminal): void {
    const prev = this.map.get(sessionId);
    this.map.set(sessionId, terminal);
    this.pending.delete(terminal);
    if (prev !== terminal) this.changeEmitter.fire();
  }

  /** Remove any associations for this terminal without disposing the terminal itself. */
  unregister(terminal: vscode.Terminal): void {
    const cleared: string[] = [];
    for (const [id, tracked] of this.map) {
      if (tracked === terminal) {
        this.map.delete(id);
        cleared.push(id);
      }
    }
    this.pending.delete(terminal);
    for (const id of cleared) this.unregisterEmitter.fire(id);
    if (cleared.length > 0) this.changeEmitter.fire();
  }

  isTracked(terminal: vscode.Terminal): boolean {
    if (this.pending.has(terminal)) return true;
    for (const tracked of this.map.values()) {
      if (tracked === terminal) return true;
    }
    return false;
  }

  markPending(terminal: vscode.Terminal): void {
    this.pending.add(terminal);
  }

  isPending(terminal: vscode.Terminal): boolean {
    return this.pending.has(terminal);
  }

  dispose(): void {
    this.closeSub.dispose();
    this.changeEmitter.dispose();
    this.unregisterEmitter.dispose();
    this.map.clear();
    this.pending.clear();
  }
}
