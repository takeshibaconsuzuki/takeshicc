// Standalone per-repo HTTP server. Bundled by esbuild into out/server.js and
// run as a detached plain-Node process. MUST NEVER `import 'vscode'`.
//
// The port bind is the mutex: if a sibling already owns the port, listen()
// fails with EADDRINUSE and this process exits(0) (the duplicate spawn is
// harmless). The server idle-exits after idleTimeoutMs with no requests.

import express from 'express';
import {
  HOST,
  HOOK_EFFECTS,
  HookEffect,
  LiveChatMetadata,
  ROUTES,
} from './protocol';

const IDLE_CHECK_MS = 5_000;

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
  const body = req.body as { session_id?: unknown; hook_event_name?: unknown };
  const chatId = body?.session_id;
  const eventName = body?.hook_event_name;
  if (typeof chatId !== 'string' || !chatId || typeof eventName !== 'string') {
    res.status(400).json({ error: 'expected { session_id, hook_event_name }' });
    return;
  }

  const existing = liveChats.get(chatId);
  const now = Date.now();

  // An unrecognized event means a hook fired, so the chat is doing something —
  // 'busy' is the safe fallback.
  const effect: HookEffect = HOOK_EFFECTS[eventName] ?? 'busy';

  if (effect === 'end') {
    liveChats.delete(chatId);
    log(`chat ${chatId}: ${eventName} -> ended`);
  } else if (effect === 'keep') {
    // A 'keep' event carries no run-state signal. For a tracked chat it just
    // refreshes liveness; for an untracked one there is no state to keep, so
    // ignore it rather than invent one — wait for an event that says idle/busy.
    if (!existing) {
      log(`chat ${chatId}: ${eventName} -> ignored (untracked)`);
      res.status(200).end();
      return;
    }
    liveChats.set(chatId, { chatId, state: existing.state, mTime: now });
    log(`chat ${chatId}: ${eventName} -> kept (${existing.state})`);
  } else {
    liveChats.set(chatId, { chatId, state: effect, mTime: now });
    log(`chat ${chatId}: ${eventName} -> ${effect}`);
  }
  res.status(200).end();
});

// /get-live-chats — current snapshot of every tracked chat.
app.get(ROUTES.getLiveChats, (_req, res) => {
  const chats: LiveChatMetadata[] = [...liveChats.values()];
  res.status(200).json(chats);
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
