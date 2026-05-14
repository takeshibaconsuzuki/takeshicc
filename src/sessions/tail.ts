import type * as vscode from 'vscode';
import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';

interface CachedTail {
  lastModified: number;
  lines: number;
  text: string;
}

/**
 * Builds the tail of a session for display: walk newest→oldest, contribute
 * each message's last N lines (string repr including text and tool calls)
 * into a chronological accumulator, stop once the accumulator has ≥ N lines
 * (or messages are exhausted), then return the last N lines of the
 * accumulator.
 *
 * Caches by `(sessionId, lastModified, tailLines)` — `lastModified` changes
 * on every new message, and the cap-per-message and final-slice both depend
 * on `tailLines`, so all three must match for a hit.
 */
export class TailCache {
  private readonly cache = new Map<string, CachedTail>();

  constructor(
    private readonly dir: string | undefined,
    private readonly log?: vscode.OutputChannel
  ) {}

  /**
   * `cacheOnly=true` returns whatever's already cached — even if
   * `lastModified` has since advanced. Used by the fast refresh path so a
   * status-icon update doesn't trigger a tail re-read against a possibly
   * mid-flush JSONL (Claude fires Stop before the final message lands;
   * reading then returns a partial transcript and caches it). The slow
   * path passes `cacheOnly=false`, which re-reads when `lastModified`
   * changed. When no cache entry exists yet — even in `cacheOnly` mode —
   * we fall through to a fresh read so first-time sessions don't render
   * with an empty tail.
   */
  async get(
    sessionId: string,
    lastModified: number,
    tailLines: number,
    cacheOnly: boolean = false
  ): Promise<string> {
    if (tailLines <= 0) return '';
    const cached = this.cache.get(sessionId);
    if (cached && cached.lines === tailLines) {
      if (cached.lastModified === lastModified) {
        this.log?.appendLine(
          `tail HIT   ${shortId(sessionId)} lastModified=${lastModified} lines=${tailLines} chars=${cached.text.length}`
        );
        return cached.text;
      }
      if (cacheOnly) {
        this.log?.appendLine(
          `tail STALE ${shortId(sessionId)} lastModified=${lastModified} ` +
            `cachedLastModified=${cached.lastModified} lines=${tailLines} chars=${cached.text.length}`
        );
        return cached.text;
      }
    }
    const prev = cached
      ? `prevLastModified=${cached.lastModified} prevChars=${cached.text.length}`
      : 'no-prev';
    const start = Date.now();
    const { text, messageCount } = await buildTail(sessionId, this.dir, tailLines);
    const ms = Date.now() - start;
    this.log?.appendLine(
      `tail MISS  ${shortId(sessionId)} lastModified=${lastModified} ${prev} ` +
        `lines=${tailLines} messages=${messageCount} chars=${text.length} read=${ms}ms`
    );
    this.cache.set(sessionId, { lastModified, lines: tailLines, text });
    return text;
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

async function buildTail(
  sessionId: string,
  dir: string | undefined,
  tailLines: number
): Promise<{ text: string; messageCount: number }> {
  let messages: SessionMessage[];
  try {
    messages = await getSessionMessages(sessionId, { dir });
  } catch {
    return { text: '', messageCount: 0 };
  }

  let acc = '';
  // Newest message first; prepend each contribution so the accumulator
  // ends up chronological (oldest line at top, newest at bottom).
  for (let i = messages.length - 1; i >= 0; i--) {
    const s = stringifyMessage(messages[i]);
    if (!s) continue;
    const piece = takeLastLines(s, tailLines);
    acc = acc ? piece + '\n' + acc : piece;
    if (countLines(acc) >= tailLines) break;
  }
  return { text: takeLastLines(acc, tailLines), messageCount: messages.length };
}

function stringifyMessage(m: SessionMessage): string {
  const payload = m.message;
  if (!payload || typeof payload !== 'object') return '';
  const content = (payload as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const t = (block as { type?: unknown }).type;
    if (t === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    } else if (t === 'tool_use') {
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input;
      parts.push(formatToolUse(typeof name === 'string' ? name : 'unknown', input));
    } else if (t === 'tool_result') {
      const result = (block as { content?: unknown }).content;
      const formatted = formatToolResult(result);
      if (formatted) parts.push(formatted);
    }
    // thinking, image, etc. → skip
  }
  return parts.join('\n').split('\n').filter((l) => l.trim() !== '').join('\n');
}

function formatToolUse(name: string, input: unknown): string {
  const summary = summarizeInput(input);
  return summary ? `[${name}] ${summary}` : `[${name}]`;
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  // Common identifying field for the major tools, in priority order.
  for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'description']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  const json = JSON.stringify(obj);
  return json.length > 120 ? json.slice(0, 119) + '…' : json;
}

function formatToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const t = (block as { type?: unknown }).type;
    if (t === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function takeLastLines(s: string, n: number): string {
  if (n <= 0) return '';
  const lines = s.split('\n');
  if (lines.length <= n) return s;
  return lines.slice(-n).join('\n');
}

function countLines(s: string): number {
  if (s === '') return 0;
  return s.split('\n').length;
}
