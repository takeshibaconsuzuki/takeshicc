// Client-side tail for historical (past, non-live) chats.
//
// Live chats get their tail from the server, which polls the JSONL file. Past
// chats are immutable, so there is nothing to poll: the extension reads each
// one's transcript once, itself, via the Claude Agent SDK — getSessionMessages
// parses the session JSONL (filesystem only — no `claude` process, no network,
// same as the server's getSessionInfo). The parsed messages are run through
// the same shared extractor the server uses, so a historical row's tail looks
// exactly like a live row's.

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { lastTextLines } from '../server/tail';

// The last `n` visible text lines of a past chat's transcript, or undefined on
// n <= 0 or any read/parse error (the row simply renders without a tail). Read
// once per chat by the caller — this performs no caching itself.
export async function readHistoricalTail(
  chatId: string,
  dir: string | undefined,
  n: number,
): Promise<string[] | undefined> {
  if (n <= 0) {
    return undefined;
  }
  try {
    // `dir` scopes the lookup to the worktree (same semantics as listSessions);
    // omitted, the SDK searches every project — slower but still correct.
    const messages = await getSessionMessages(
      chatId,
      dir ? { dir } : undefined,
    );
    return lastTextLines(messages, n);
  } catch {
    return undefined;
  }
}
