import { describe, it, expect } from 'vitest';
import { buildReference, type ReferenceInput } from '../src/reference';

function mkInput(opts: {
  scheme?: string;
  path?: string;
  startLine?: number;
  startChar?: number;
  endLine?: number;
  endChar?: number;
  isEmpty?: boolean;
}): ReferenceInput {
  const startLine = opts.startLine ?? 0;
  const startChar = opts.startChar ?? 0;
  const endLine = opts.endLine ?? startLine;
  const endChar = opts.endChar ?? startChar;
  const isEmpty = opts.isEmpty ?? (startLine === endLine && startChar === endChar);
  return {
    uri: { scheme: opts.scheme ?? 'file' } as any,
    selection: {
      isEmpty,
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    } as any,
    workspaceRelativePath: opts.path ?? 'src/foo.ts',
  };
}

describe('buildReference', () => {
  it('returns null for non-file schemes', () => {
    expect(buildReference(mkInput({ scheme: 'untitled' }))).toBeNull();
    expect(buildReference(mkInput({ scheme: 'vscode-notebook-cell' }))).toBeNull();
    expect(buildReference(mkInput({ scheme: 'vscode-remote' }))).toBeNull();
  });

  it('returns @path for empty selection', () => {
    expect(buildReference(mkInput({ isEmpty: true }))).toBe('@src/foo.ts');
  });

  it('normalizes Windows backslashes to forward slashes', () => {
    expect(buildReference(mkInput({ path: 'src\\a\\b.ts', isEmpty: true }))).toBe(
      '@src/a/b.ts'
    );
  });

  it('multi-line selection → range', () => {
    // Select from line 20 char 0 to line 35 char 10 (1-indexed: L20-L35)
    const ref = buildReference(
      mkInput({ startLine: 19, startChar: 0, endLine: 34, endChar: 10 })
    );
    expect(ref).toBe('@src/foo.ts#L20-L35');
  });

  it('single-line selection (cursor inside one line) → no range', () => {
    // Same line 20, chars 5 to 15
    const ref = buildReference(
      mkInput({ startLine: 19, startChar: 5, endLine: 19, endChar: 15 })
    );
    expect(ref).toBe('@src/foo.ts#L20');
  });

  it('whole-line selection ending at char 0 of next line → decrement end', () => {
    // User selected lines 20..22 by dragging from start of 20 to start of 23.
    // start.line=19, end.line=22, end.character=0 → should produce L20-L22.
    const ref = buildReference(
      mkInput({ startLine: 19, startChar: 0, endLine: 22, endChar: 0 })
    );
    expect(ref).toBe('@src/foo.ts#L20-L22');
  });

  it('whole-single-line selection (line 20 to start of line 21) → single-line form', () => {
    // start.line=19 char 0, end.line=20 char 0 → end decrements to 20 → start===end → L20
    const ref = buildReference(
      mkInput({ startLine: 19, startChar: 0, endLine: 20, endChar: 0 })
    );
    expect(ref).toBe('@src/foo.ts#L20');
  });

  it('nested file paths preserved', () => {
    const ref = buildReference(
      mkInput({ path: 'src/a/b/c.ts', startLine: 9, endLine: 9, startChar: 1, endChar: 3 })
    );
    expect(ref).toBe('@src/a/b/c.ts#L10');
  });

  it('root-level file', () => {
    expect(
      buildReference(mkInput({ path: 'README.md', isEmpty: true }))
    ).toBe('@README.md');
  });
});
