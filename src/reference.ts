import type * as vscode from 'vscode';

export interface ReferenceInput {
  uri: Pick<vscode.Uri, 'scheme'>;
  selection: Pick<vscode.Selection, 'isEmpty' | 'start' | 'end'>;
  workspaceRelativePath: string;
}

export function buildReference(input: ReferenceInput): string | null {
  if (input.uri.scheme !== 'file') return null;

  const path = input.workspaceRelativePath.replace(/\\/g, '/');
  const sel = input.selection;

  if (sel.isEmpty) return `@${path}`;

  const start = sel.start.line + 1;
  let end = sel.end.line + 1;

  // Full-line selections land the cursor at char 0 of the next line.
  // Pull `end` back one so "select lines 20-22" becomes L20-L22, not L20-L23.
  if (sel.end.character === 0 && end > start) end -= 1;

  if (start === end) return `@${path}#L${start}`;
  return `@${path}#L${start}-L${end}`;
}
