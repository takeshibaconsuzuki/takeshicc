// Minimal stub of the vscode API used by modules under test. Vitest runs in
// plain node and the real `vscode` module is only available inside the VS Code
// extension host.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];
  readonly event = (listener: (e: T) => unknown): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(e: T): void {
    for (const l of this.listeners.slice()) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export type Disposable = { dispose(): void };

export const workspace = {
  getConfiguration(_section?: string): { get<T>(key: string, defaultValue: T): T } {
    return {
      get<T>(_key: string, defaultValue: T): T {
        return defaultValue;
      },
    };
  },
  onDidChangeConfiguration(_listener: (e: unknown) => void): Disposable {
    return { dispose() {} };
  },
};
