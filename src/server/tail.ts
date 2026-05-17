// Shared, vscode-free transcript-tail extraction. Two callers, one core:
//   - the server polls a live chat's JSONL file directly (readTailFromFile),
//   - the extension client reads a historical chat once via the Claude Agent
//     SDK and feeds the parsed messages through lastTextLines.
// Both funnel their entries through textLinesOf so live and historical chats
// show the same kind of "visible conversation" tail. No `vscode` import — this
// must bundle cleanly into both the server and the extension.

import * as fs from 'fs';

// Trailing bytes of a transcript readTailFromFile scans. Bounds the read on
// arbitrarily long sessions; large enough to still hold the last text lines
// after the (skipped) tool-use/result and thinking entries between them.
export const TAIL_BYTES = 256 * 1024;

// Pull human-readable text out of one transcript entry — a raw JSONL object or
// an SDK SessionMessage; both share `{ type, message: { content } }`. A
// user/assistant message's string content, or its `text` blocks. Everything
// else (tool use/results, thinking, snapshots, titles, mode markers) is
// skipped — the tail is the visible conversation, regardless of role or count.
export function textLinesOf(entry: unknown): string[] {
  const e = entry as { type?: unknown; message?: { content?: unknown } };
  if (e?.type !== 'user' && e?.type !== 'assistant') {
    return [];
  }
  const content = e.message?.content;
  const texts: string[] = [];
  if (typeof content === 'string') {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text);
      }
    }
  }
  return texts
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
}

// The last `n` visible text lines across a sequence of transcript entries.
// Shared tail core: the file reader and the SDK reader both parse entries
// their own way, then hand them here. Returns [] for n <= 0.
export function lastTextLines(entries: Iterable<unknown>, n: number): string[] {
  if (n <= 0) {
    return [];
  }
  const lines: string[] = [];
  for (const entry of entries) {
    for (const line of textLinesOf(entry)) {
      lines.push(line);
    }
  }
  return lines.slice(-n);
}

// Last `n` text lines of a session's transcript JSONL file. Reads only the
// trailing TAIL_BYTES so the cost is bounded no matter how long the session is
// — a window that starts mid-file just drops its (partial) first JSONL line.
// Returns undefined on n <= 0 or any error (missing/locked file) so the caller
// keeps the previous tail rather than clobbering it with nothing.
export async function readTailFromFile(
  p: string | undefined,
  n: number,
): Promise<string[] | undefined> {
  if (!p || n <= 0) {
    return undefined;
  }
  try {
    const { size } = await fs.promises.stat(p);
    const start = Math.max(0, size - TAIL_BYTES);
    const fh = await fs.promises.open(p, 'r');
    let text: string;
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      // Decode only what was actually read: a short read (file rotated or
      // truncated between stat and read — rare for an append-only JSONL) would
      // otherwise leave zero-filled tail bytes that corrupt the last entry.
      const { bytesRead } = await fh.read(buf, 0, len, start);
      text = buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
    const rawLines = text.split('\n');
    if (start > 0) {
      rawLines.shift(); // a mid-file window's first line is partial JSON
    }
    const entries: unknown[] = [];
    for (const raw of rawLines) {
      const s = raw.trim();
      if (!s) {
        continue;
      }
      try {
        entries.push(JSON.parse(s));
      } catch {
        continue;
      }
    }
    return lastTextLines(entries, n);
  } catch {
    return undefined;
  }
}
