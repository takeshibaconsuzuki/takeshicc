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
import { readTailFromFile } from './tail';

const IDLE_CHECK_MS = 5_000;

// Cadence of the summary+tail refresher. Each tick re-resolves every live
// chat's summary and re-reads its transcript tail, pushing one snapshot if
// anything changed. Skipped when no one is subscribed.
const REFRESH_MS = 3_000;

// Hard cap on a subscriber's requested tail length — bounds the snapshot
// against a bogus ?tail= value.
const TAIL_MAX = 200;

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

// Per-subscriber requested tail length: the `?tail=` query param on
// /subscribe-live-chats, which carries each window's `takeshicc.tailLines`
// setting. The snapshot's `tail` is computed at the max across subscribers so
// every window gets at least the lines it asked for (it slices to its own N).
const tailWanted = new Map<express.Response, number>();
function maxTailLines(): number {
  let m = 0;
  for (const v of tailWanted.values()) {
    m = Math.max(m, v);
  }
  return m;
}

// The current live-chat set as a plain array — the payload of every
// /subscribe-live-chats push.
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
      // Write to a half-dead socket — drop it from both maps (kept in lockstep,
      // exactly as the 'close' handler does); its 'close' will also fire.
      sseClients.delete(res);
      tailWanted.delete(res);
    }
  }
}

// chatId -> the filesystem context the periodic refresher needs: the
// session's cwd (points getSessionInfo straight at its project) and its
// transcript JSONL path (read for the tail). Both ride in on the hook payload;
// kept in this side map so neither inflates the broadcast snapshot. Dropped
// when the chat ends.
const chatCtx = new Map<string, { cwd?: string; transcriptPath?: string }>();

// The chat's display label via the Claude Agent SDK. getSessionInfo reads only
// the session's JSONL transcript — no network, no `claude` process — and its
// `summary` is the session's custom title, else its auto-generated summary,
// else its first prompt. `dir` just points the lookup straight at the right
// project (omitted, the SDK searches every project — slower but still works).
// Best-effort: any failure is logged and resolves undefined, so the caller
// keeps the prior summary.
function resolveSummary(
  chatId: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  return getSessionInfo(chatId, cwd ? { dir: cwd } : undefined)
    .then((info) => info?.summary)
    .catch((err) => {
      log(`chat ${chatId}: getSessionInfo failed — ${(err as Error).message}`);
      return undefined;
    });
}

function sameLines(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => v === b[i]);
}

// One refresh pass: re-resolve every live chat's summary and tail, then push a
// single snapshot if anything changed.
async function refreshPass(): Promise<void> {
  const n = maxTailLines();
  let changed = false;
  for (const { chatId } of chatSnapshot()) {
    const ctx = chatCtx.get(chatId);
    const [summary, tail] = await Promise.all([
      resolveSummary(chatId, ctx?.cwd),
      readTailFromFile(ctx?.transcriptPath, n),
    ]);
    const cur = liveChats.get(chatId);
    if (!cur) {
      continue; // ended mid-refresh — do not resurrect it
    }
    const nextSummary = summary ?? cur.summary;
    // n === 0 means every subscriber disabled the tail — drop it rather than
    // leave the last one stale. Otherwise keep the prior tail on a read miss.
    const nextTail = n <= 0 ? undefined : (tail ?? cur.tail);
    if (nextSummary !== cur.summary || !sameLines(cur.tail, nextTail)) {
      if (nextSummary !== cur.summary) {
        log(`chat ${chatId}: summary -> ${JSON.stringify(nextSummary)}`);
      }
      liveChats.set(chatId, {
        ...cur,
        summary: nextSummary,
        tail: nextTail,
      });
      changed = true;
    }
  }
  if (changed) {
    broadcastLiveChats();
  }
}

// Periodic + on-demand refresher. Serialized by refreshInFlight so a slow disk
// can never overlap passes. A call that arrives while a pass is running sets
// refreshQueued so exactly one more pass runs after the current one finishes;
// further calls coalesce into that single queued pass. That trailing re-run is
// what lets an on-connect off-cycle refresh — which may have raised the max
// tail — take effect right after the in-flight pass instead of waiting for the
// next periodic tick. Skipped entirely when nothing is subscribed: nothing to
// broadcast and no reason to touch disk.
let refreshInFlight = false;
let refreshQueued = false;
async function refreshAllChats(): Promise<void> {
  if (sseClients.size === 0) {
    return;
  }
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    do {
      refreshQueued = false;
      await refreshPass();
    } while (refreshQueued && sseClients.size > 0);
  } finally {
    refreshInFlight = false;
  }
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
    transcript_path?: unknown;
    ancestorPids?: unknown;
  };
  const chatId = body?.session_id;
  const eventName = body?.hook_event_name;
  if (typeof chatId !== 'string' || !chatId || typeof eventName !== 'string') {
    res.status(400).json({ error: 'expected { session_id, hook_event_name }' });
    return;
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  const transcriptPath =
    typeof body.transcript_path === 'string' ? body.transcript_path : undefined;

  const existing = liveChats.get(chatId);
  const now = Date.now();

  // An unrecognized event means a hook fired, so the chat is doing something —
  // 'busy' is the safe fallback.
  const effect: HookEffect = HOOK_EFFECTS[eventName] ?? 'busy';

  // A 'keep' event carries no run-state signal. For an untracked chat there is
  // nothing to keep, so ignore it rather than invent a state — wait for an
  // event that says idle/busy. Done before the chatCtx stash below so a 'keep'
  // for a chat we decline to track leaves no orphaned context entry behind.
  if (effect === 'keep' && !existing) {
    log(`chat ${chatId}: ${eventName} -> ignored (untracked)`);
    res.status(200).end();
    return;
  }

  // Stash this chat's cwd/transcript path for the periodic refresher. Each is
  // kept once known — a later event that omits one must not erase it. An 'end'
  // event tears the chat down below, so there is nothing to refresh for it.
  if (effect !== 'end') {
    const prev = chatCtx.get(chatId);
    chatCtx.set(chatId, {
      cwd: cwd ?? prev?.cwd,
      transcriptPath: transcriptPath ?? prev?.transcriptPath,
    });
  }

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

  if (effect === 'end') {
    chatCtx.delete(chatId);
    if (liveChats.delete(chatId)) {
      log(`chat ${chatId}: ${eventName} -> ended`);
      broadcastLiveChats();
    } else {
      log(`chat ${chatId}: ${eventName} -> ignored (untracked)`);
    }
  } else if (effect === 'keep') {
    // The untracked 'keep' bailed above, so the chat is tracked here; the
    // compound guard does not narrow `existing` for the type checker. A 'keep'
    // only refreshes liveness, leaving the run state untouched.
    const kept = existing as LiveChatMetadata;
    liveChats.set(chatId, {
      chatId,
      state: kept.state,
      mTime: now,
      ancestorPids,
      summary: kept.summary,
      // Carry the periodic refresher's summary/tail through a state event so a
      // mid-turn hook does not blank them until the next refresh tick.
      tail: kept.tail,
    });
    log(`chat ${chatId}: ${eventName} -> kept (${kept.state})`);
    broadcastLiveChats();
  } else {
    liveChats.set(chatId, {
      chatId,
      state: effect,
      mTime: now,
      ancestorPids,
      summary: existing?.summary,
      tail: existing?.tail,
    });
    log(`chat ${chatId}: ${eventName} -> ${effect}`);
    broadcastLiveChats();
  }
  res.status(200).end();
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
// channel the extension subscribes to for live-chat state.
app.get(ROUTES.subscribeLiveChats, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // The subscriber's desired tail length — its `takeshicc.tailLines` setting.
  // Anything non-positive / non-integer / absent means "no tail"; cap the rest.
  const reqTail = Number(req.query.tail);
  const wantTail =
    Number.isInteger(reqTail) && reqTail > 0 ? Math.min(reqTail, TAIL_MAX) : 0;

  // Flush each snapshot the instant it is written, without Nagle batching.
  req.socket.setNoDelay(true);
  sseClients.add(res);
  tailWanted.set(res, wantTail);
  log(
    `SSE client connected (tail=${wantTail}) — ${sseClients.size} subscriber(s)`,
  );

  // Initial snapshot so a fresh subscriber starts in sync. Its summary/tail may
  // be stale (or short, if this subscriber raised the max), so kick an
  // off-cycle refresh to fill them in promptly rather than at the next tick.
  res.write(`data: ${JSON.stringify(chatSnapshot())}\n\n`);
  void refreshAllChats();

  req.on('close', () => {
    sseClients.delete(res);
    tailWanted.delete(res);
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

// Periodic summary+tail refresh. Self-guards on no subscribers and on an
// in-flight tick, and never touches lastActivityAt — it must not by itself
// keep an otherwise-idle server alive.
setInterval(() => {
  void refreshAllChats();
}, REFRESH_MS).unref();

// Idle self-shutdown. Always process.exit — exit is atomic (port fully bound
// or fully free), avoiding a closed-but-alive split-brain window.
setInterval(() => {
  if (Date.now() - lastActivityAt > idleTimeoutMs) {
    log(`idle for >${idleTimeoutMs}ms with no requests — exiting`);
    process.exit(0);
  }
}, IDLE_CHECK_MS).unref();
