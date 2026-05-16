// Binds each live Claude Code chat to the VS Code terminal hosting it.
//
// The reporter hook (see src/reporter) attaches the Claude process's ancestor
// PIDs to every chat — one of those PIDs is the shell process of the terminal
// the session runs in. This tracker resolves each terminal's shell PID via
// `Terminal.processId` and matches it against that list, so a live-chat row
// can reveal its terminal.
//
// Matching is window-local: a chat whose terminal lives in another VS Code
// window has no ancestor PID among this window's terminals and stays unbound
// (and so non-revealable here) — which is the correct outcome.

import * as vscode from 'vscode';
import { LiveChatMetadata } from '../server/protocol';

export class TerminalTracker implements vscode.Disposable {
  // chatId -> the terminal hosting it. A binding is sticky: once made it holds
  // until the chat ends or the terminal closes, so it survives the snapshots
  // (e.g. plain HTTP events) that carry no ancestorPids.
  private readonly bindings = new Map<string, vscode.Terminal>();

  // Terminal -> resolved shell PID. `Terminal.processId` is a one-shot promise
  // and a terminal's PID never changes, so each is resolved at most once.
  private readonly pidCache = new Map<vscode.Terminal, number | undefined>();

  // ingest() runs are serialized through this promise chain. The first `pidOf`
  // for a terminal genuinely awaits the terminal, so a slow run must not
  // interleave with a newer snapshot's run and reconcile bindings against
  // half-applied state — each call waits for the previous one to finish.
  private ingestChain: Promise<void> = Promise.resolve();

  private readonly onChange = new vscode.EventEmitter<void>();
  // Fires when the set of bindings changes for a reason other than an incoming
  // snapshot (a terminal closing) — `ingest` callers refresh on their own.
  readonly onDidChange = this.onChange.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.OutputChannel) {
    this.disposables.push(
      this.onChange,
      vscode.window.onDidCloseTerminal((closed) =>
        this.onTerminalClosed(closed),
      ),
    );
  }

  // Reconcile the bindings against a live-chat snapshot: drop chats that ended,
  // then bind any new chat whose ancestor PIDs include one of this window's
  // terminal shell PIDs. Calls are serialized (see ingestChain) so snapshots
  // are applied one at a time, in arrival order.
  ingest(chats: LiveChatMetadata[]): Promise<void> {
    const run = this.ingestChain.then(() => this.ingestNow(chats));
    // Keep the chain alive past a failed run — ingestNow guards its own work,
    // but a stray rejection here must not wedge every later ingest.
    this.ingestChain = run.catch(() => {});
    return run;
  }

  private async ingestNow(chats: LiveChatMetadata[]): Promise<void> {
    const liveIds = new Set(chats.map((c) => c.chatId));
    for (const chatId of [...this.bindings.keys()]) {
      if (!liveIds.has(chatId)) {
        this.bindings.delete(chatId);
      }
    }

    const terminals = vscode.window.terminals;
    const pending = chats.filter(
      (c) =>
        !this.bindings.has(c.chatId) &&
        c.ancestorPids !== undefined &&
        c.ancestorPids.length > 0,
    );
    const noPids = chats.filter(
      (c) => !this.bindings.has(c.chatId) && !c.ancestorPids?.length,
    ).length;
    this.log.appendLine(
      `Takeshicc: live-chat ingest — ${chats.length} chat(s), ` +
        `${this.bindings.size} already bound, ${pending.length} unbound with ` +
        `ancestorPids, ${noPids} unbound without (reporter not run yet), ` +
        `${terminals.length} terminal(s) in this window.`,
    );

    for (const chat of pending) {
      const pids = chat.ancestorPids ?? [];
      const wanted = new Set(pids);
      this.log.appendLine(
        `Takeshicc: matching chat ${chat.chatId} — ` +
          `ancestorPids [${pids.join(', ')}].`,
      );
      let bound = false;
      for (const terminal of terminals) {
        const pid = await this.pidOf(terminal);
        const hit = pid !== undefined && wanted.has(pid);
        this.log.appendLine(
          `Takeshicc:   terminal "${terminal.name}" shell pid ` +
            `${pid ?? 'unknown'}${hit ? ' — MATCH' : ''}.`,
        );
        if (hit) {
          this.bindings.set(chat.chatId, terminal);
          bound = true;
          break;
        }
      }
      this.log.appendLine(
        bound
          ? `Takeshicc: bound chat ${chat.chatId} to its terminal.`
          : `Takeshicc: chat ${chat.chatId} matched no terminal in this window.`,
      );
    }
  }

  // chatIds that can be revealed — i.e. bound to a terminal in this window.
  revealableChatIds(): Set<string> {
    return new Set(this.bindings.keys());
  }

  // Focus the terminal hosting `chatId`. Returns false if it is not bound to a
  // terminal in this window (the caller surfaces that to the user).
  reveal(chatId: string): boolean {
    const terminal = this.bindings.get(chatId);
    if (!terminal) {
      return false;
    }
    terminal.show();
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // Resolve and cache a terminal's shell PID.
  private async pidOf(terminal: vscode.Terminal): Promise<number | undefined> {
    if (this.pidCache.has(terminal)) {
      return this.pidCache.get(terminal);
    }
    let pid: number | undefined;
    try {
      pid = await terminal.processId;
    } catch {
      pid = undefined;
    }
    this.pidCache.set(terminal, pid);
    return pid;
  }

  private onTerminalClosed(closed: vscode.Terminal): void {
    this.pidCache.delete(closed);
    let changed = false;
    for (const [chatId, terminal] of this.bindings) {
      if (terminal === closed) {
        this.bindings.delete(chatId);
        changed = true;
      }
    }
    if (changed) {
      this.onChange.fire();
    }
  }
}
