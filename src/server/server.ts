// Standalone per-repo HTTP server. Bundled by esbuild into out/server.js and
// run as a detached plain-Node process. MUST NEVER `import 'vscode'`.
//
// The port bind is the mutex: if a sibling already owns the port, listen()
// fails with EADDRINUSE and this process exits(0) (the duplicate spawn is
// harmless). The server idle-exits after idleTimeoutMs with no requests.

import express from 'express';
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import {
  HOST,
  HistoricalChatMetadata,
  HOOK_EFFECTS,
  HookEffect,
  LiveChatMetadata,
  ROUTES,
} from './protocol';

const IDLE_CHECK_MS = 5_000;

// Cap on how many past chats GET /get-historical-chats returns — listSessions
// is sorted newest-first, so this keeps the most recent ones.
const HISTORICAL_LIMIT = 100;

// Timestamped line to stdout — captured into ~/.takeshicc/server-<port>.log.
function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

// argv[2] = port, argv[3] = groupKey, argv[4] = idleTimeoutMs, argv[5] = version.
const port = Number(process.argv[2]);
const groupKey = process.argv[3];
const idleTimeoutMs = Number(process.argv[4]);
const version = process.argv[5];

if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !groupKey ||
  !Number.isInteger(idleTimeoutMs) ||
  idleTimeoutMs <= 0 ||
  !version
) {
  console.error(
    `Takeshicc server: bad arguments — ` +
      `port=${process.argv[2]} groupKey=${process.argv[3]} ` +
      `idleTimeoutMs=${process.argv[4]} version=${process.argv[5]}`,
  );
  process.exit(1);
}

let lastActivityAt = Date.now();

// chatId -> live chat metadata. In-memory only: lost on idle-exit, which is
// fine — Claude Code's hooks re-report each chat's state on its next event.
const liveChats = new Map<string, LiveChatMetadata>();

// Connected /events subscribers. Each receives the full snapshot on connect
// and again on every change to the live set — this is the server-push channel.
const sseClients = new Set<express.Response>();

// The current live-chat set as a plain array — the payload of both
// GET /get-live-chats and every /events push.
function chatSnapshot(): LiveChatMetadata[] {
  return [...liveChats.values()];
}

// Push the current snapshot to every connected /events subscriber.
function broadcastLiveChats(): void {
  if (sseClients.size === 0) {
    return;
  }
  const payload = `data: ${JSON.stringify(chatSnapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // Write to a half-dead socket — drop it; its 'close' will also fire.
      sseClients.delete(res);
    }
  }
}

// chatIds with a getSessionInfo lookup in flight. One hook turn fires many
// events; this guard keeps the same chat from being queried concurrently.
const summaryInFlight = new Set<string>();

// Resolve a chat's display label via the Claude Agent SDK and, if it changed,
// store it on the chat and re-broadcast. getSessionInfo reads only the
// session's JSONL transcript — no network, no `claude` process — and its
// `summary` is the session's custom title, else its auto-generated summary,
// else its first prompt. Best-effort and fully async: the hook response never
// waits on it, and any failure is logged and swallowed.
function refreshSummary(chatId: string, cwd: string | undefined): void {
  if (summaryInFlight.has(chatId)) {
    return;
  }
  summaryInFlight.add(chatId);
  // `dir` just points the lookup straight at the right project directory; with
  // it omitted the SDK searches every project, which still works, only slower.
  void getSessionInfo(chatId, cwd ? { dir: cwd } : undefined)
    .then((info) => {
      const summary = info?.summary;
      const chat = liveChats.get(chatId);
      // The chat may have ended while the lookup was in flight — drop the
      // result rather than resurrect it. A missing/unchanged summary is a no-op.
      if (!chat || !summary || chat.summary === summary) {
        return;
      }
      liveChats.set(chatId, { ...chat, summary });
      log(`chat ${chatId}: summary -> ${JSON.stringify(summary)}`);
      broadcastLiveChats();
    })
    .catch((err) => {
      log(`chat ${chatId}: getSessionInfo failed — ${(err as Error).message}`);
    })
    .finally(() => {
      summaryInFlight.delete(chatId);
    });
}

const app = express();

// Mark activity on every request so the idle check can never exit under load.
app.use((_req, _res, next) => {
  lastActivityAt = Date.now();
  next();
});

// Parse JSON bodies for the hook endpoint (Claude Code POSTs a JSON payload).
app.use(express.json());

app.get(ROUTES.whoami, (req, res) => {
  // /whoami is a client's connect handshake — one per window activation.
  log(
    `client connected: GET ${ROUTES.whoami} from ${req.socket.remoteAddress ?? '?'}`,
  );
  res.status(200).json({ groupKey, version });
});

app.get(ROUTES.ping, (_req, res) => {
  // Heartbeat — fires every idleTimeoutMs/3, so it is intentionally not logged.
  res.status(200).send('ok');
});

// /update-chat-state — a Claude Code HTTP hook target. The POST body is the
// hook event payload; session_id is the chat id and hook_event_name selects
// the effect on that chat (see HOOK_EFFECTS).
app.post(ROUTES.updateChatState, (req, res) => {
  const body = req.body as {
    session_id?: unknown;
    hook_event_name?: unknown;
    cwd?: unknown;
    ancestorPids?: unknown;
  };
  const chatId = body?.session_id;
  const eventName = body?.hook_event_name;
  if (typeof chatId !== 'string' || !chatId || typeof eventName !== 'string') {
    res.status(400).json({ error: 'expected { session_id, hook_event_name }' });
    return;
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;

  const existing = liveChats.get(chatId);
  const now = Date.now();

  // Re-resolve the chat's summary when it has none yet, or at a turn boundary
  // (UserPromptSubmit) — the cheapest schedule that still catches the first
  // prompt, a later auto-generated summary, and a /rename. The in-flight guard
  // makes a redundant call a no-op, so this never piles up under a busy turn.
  const wantSummary = !existing?.summary || eventName === 'UserPromptSubmit';

  // ancestorPids arrives only on the reporter hook's POST; every other event
  // omits it. An empty list (the reporter ran but resolved nothing) counts as
  // omitted too, so neither it nor a plain event clobbers a good list already
  // on file — fall back to whatever was last reported for this chat.
  const reportedPids =
    Array.isArray(body.ancestorPids) &&
    body.ancestorPids.length > 0 &&
    body.ancestorPids.every((n) => typeof n === 'number')
      ? (body.ancestorPids as number[])
      : undefined;
  if (reportedPids) {
    log(
      `chat ${chatId}: ${eventName} reported ancestorPids ` +
        `[${reportedPids.join(', ')}]`,
    );
  }
  const ancestorPids = reportedPids ?? existing?.ancestorPids;

  // An unrecognized event means a hook fired, so the chat is doing something —
  // 'busy' is the safe fallback.
  const effect: HookEffect = HOOK_EFFECTS[eventName] ?? 'busy';

  if (effect === 'end') {
    if (liveChats.delete(chatId)) {
      log(`chat ${chatId}: ${eventName} -> ended`);
      broadcastLiveChats();
    } else {
      log(`chat ${chatId}: ${eventName} -> ignored (untracked)`);
    }
  } else if (effect === 'keep') {
    // A 'keep' event carries no run-state signal. For a tracked chat it just
    // refreshes liveness; for an untracked one there is no state to keep, so
    // ignore it rather than invent one — wait for an event that says idle/busy.
    if (!existing) {
      log(`chat ${chatId}: ${eventName} -> ignored (untracked)`);
      res.status(200).end();
      return;
    }
    liveChats.set(chatId, {
      chatId,
      state: existing.state,
      mTime: now,
      ancestorPids,
      summary: existing.summary,
    });
    log(`chat ${chatId}: ${eventName} -> kept (${existing.state})`);
    broadcastLiveChats();
    if (wantSummary) {
      refreshSummary(chatId, cwd);
    }
  } else {
    liveChats.set(chatId, {
      chatId,
      state: effect,
      mTime: now,
      ancestorPids,
      summary: existing?.summary,
    });
    log(`chat ${chatId}: ${eventName} -> ${effect}`);
    broadcastLiveChats();
    if (wantSummary) {
      refreshSummary(chatId, cwd);
    }
  }
  res.status(200).end();
});

// /get-live-chats — synchronous snapshot of every tracked chat. The /events
// stream below is the push equivalent; this remains as a one-shot/debug read.
app.get(ROUTES.getLiveChats, (_req, res) => {
  res.status(200).json(chatSnapshot());
});

// /get-historical-chats — past (non-live) chats for one worktree. The `?dir=`
// query param is the worktree directory; listSessions is scoped to it with
// includeWorktrees off, so sibling worktrees of the same repo are excluded.
// Chats currently in the live set still appear here (the session JSONL exists
// on disk) — the extension filters those out so each chat shows in one section.
app.get(ROUTES.getHistoricalChats, (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
  if (!dir) {
    res.status(400).json({ error: 'expected ?dir=<worktree directory>' });
    return;
  }
  void listSessions({ dir, includeWorktrees: false, limit: HISTORICAL_LIMIT })
    .then((sessions) => {
      const historical: HistoricalChatMetadata[] = sessions.map((s) => ({
        chatId: s.sessionId,
        summary: s.summary,
        mTime: s.lastModified,
      }));
      log(`GET ${ROUTES.getHistoricalChats} (${dir}) -> ${historical.length}`);
      res.status(200).json(historical);
    })
    .catch((err) => {
      const message = (err as Error).message;
      log(`GET ${ROUTES.getHistoricalChats} failed — ${message}`);
      res.status(500).json({ error: message });
    });
});

// /subscribe-live-chats — Server-Sent Events stream of live-chat snapshots.
// The current snapshot is sent immediately on connect, then a fresh snapshot
// on every change to the live set (see broadcastLiveChats). This is the push
// channel the extension subscribes to in place of polling /get-live-chats.
app.get(ROUTES.subscribeLiveChats, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Flush each snapshot the instant it is written, without Nagle batching.
  req.socket.setNoDelay(true);
  sseClients.add(res);
  log(`SSE client connected — ${sseClients.size} subscriber(s)`);

  // Initial snapshot so a fresh subscriber starts in sync.
  res.write(`data: ${JSON.stringify(chatSnapshot())}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
    log(`SSE client disconnected — ${sseClients.size} subscriber(s)`);
  });
});

app.use((req, res) => {
  log(`404: ${req.method} ${req.url}`);
  res.status(404).send('not found');
});

const server = app.listen(port, HOST, () => {
  log(
    `listening on ${HOST}:${port} — group "${groupKey}", v${version}, ` +
      `idleTimeoutMs ${idleTimeoutMs}`,
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  // A sibling won the bind — that process is the server; this one is redundant.
  if (err.code === 'EADDRINUSE') {
    log(`port ${port} already bound by a sibling — exiting`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

// Idle self-shutdown. Always process.exit — exit is atomic (port fully bound
// or fully free), avoiding a closed-but-alive split-brain window.
setInterval(() => {
  if (Date.now() - lastActivityAt > idleTimeoutMs) {
    log(`idle for >${idleTimeoutMs}ms with no requests — exiting`);
    process.exit(0);
  }
}, IDLE_CHECK_MS).unref();
