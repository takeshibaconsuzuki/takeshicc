// A minimal, vscode-free logging sink for code in `common` (sharable with the
// standalone server). `vscode.OutputChannel` structurally satisfies this — it
// has `appendLine(value: string): void` — so the extension passes its channel
// directly with no adapter.

export interface Logger {
  appendLine(message: string): void;
}
