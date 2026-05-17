// Standalone per-repo HTTP server. Bundled by esbuild into out/server.js and
// run as a detached plain-Node process. MUST NEVER `import 'vscode'`.
//
// The port bind is the mutex: if a sibling already owns the port, listen()
// fails with EADDRINUSE and this process exits(0) (the duplicate spawn is
// harmless). The server idle-exits once no live instance remains — promptly
// once its registry empties, or idleTimeoutMs after spawn if none ever
// registers.

import express = require('express');
import { HOST, ROUTES, RegisterRequest } from '../common/protocol';
import { groupIdFor, instanceIdFor } from '../common/gitUtils';

const IDLE_CHECK_MS = 5_000;

// Timestamped line to stdout — captured into ~/.takeshicc/server-<port>.log.
function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

// argv[2] = port, argv[3] = mainWorktreePath, argv[4] = idleTimeoutMs, argv[5] = version.
const port = Number(process.argv[2]);
const mainWorktreePath = process.argv[3];
const idleTimeoutMs = Number(process.argv[4]);
const version = process.argv[5];

// idleTimeoutMs floor mirrors config.ts GroupSchema (.min(5_000)): below
// IDLE_CHECK_MS the heartbeat can't keep the server alive under a live client.
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !mainWorktreePath ||
  !Number.isInteger(idleTimeoutMs) ||
  idleTimeoutMs < IDLE_CHECK_MS ||
  !version
) {
  console.error(
    `Takeshicc server: bad arguments — ` +
      `port=${process.argv[2]} mainWorktreePath=${process.argv[3]} ` +
      `idleTimeoutMs=${process.argv[4]} version=${process.argv[5]}`,
  );
  process.exit(1);
}

// Echoed on /register; the client matches it to detect "another process owns
// this port" (mainWorktreePath rides along to keep that error readable).
const groupId = groupIdFor(mainWorktreePath);

// Idle-exit baseline for an empty registry: with no instances, the server
// exits once it has outlived idleTimeoutMs.
const serverStart = Date.now();

interface Instance {
  worktreePath: string;
  lastHeartbeatAt: number;
}

// Live VS Code instances sharing this server, keyed by instanceId — the seed
// for future cross-instance routing. Liveness moves only on register +
// heartbeat, never on a rejected request, so a client stuck polling
// /register cannot keep a doomed server alive.
const registry = new Map<string, Instance>();

// Drop instances whose heartbeat lapsed past idleTimeoutMs (closed/reloaded/
// crashed window). A live client beats every idleTimeoutMs/3 — a 3x margin,
// so it is never pruned in flight.
function sweepStaleInstances(): void {
  const now = Date.now();
  for (const [id, inst] of registry) {
    if (now - inst.lastHeartbeatAt > idleTimeoutMs) {
      registry.delete(id);
      log(`unregistered ${id} (${inst.worktreePath}); heartbeat lapsed; ${registry.size} live`);
    }
  }
}

const app = express();
app.use(express.json());

app.post(ROUTES.register, (req, res) => {
  // Reject (transient) a version-mismatched client or an already-registered
  // worktree; the client keeps polling until the blocker clears.
  const { worktreePath, version: clientVersion } = (req.body ?? {}) as Partial<RegisterRequest>;
  if (typeof worktreePath !== 'string' || !worktreePath || typeof clientVersion !== 'string') {
    log(`register rejected: malformed body from ${req.socket.remoteAddress ?? '?'}`);
    res.status(400).json({ status: 'transient', reason: 'malformed register body' });
    return;
  }
  if (clientVersion !== version) {
    log(`register rejected: version mismatch (server ${version}, client ${clientVersion})`);
    res.status(200).json({ status: 'transient', reason: `version mismatch (server ${version})` });
    return;
  }
  const instanceId = instanceIdFor(worktreePath);
  if (registry.has(instanceId)) {
    log(`register rejected: instance already registered for ${worktreePath}`);
    res.status(200).json({ status: 'transient', reason: 'worktree already registered' });
    return;
  }
  registry.set(instanceId, { worktreePath, lastHeartbeatAt: Date.now() });
  log(`registered ${instanceId} (${worktreePath}); ${registry.size} live`);
  res.status(200).json({ status: 'registered', groupId, mainWorktreePath, instanceId });
});

app.get(ROUTES.ping, (req, res) => {
  // Heartbeat — fires every idleTimeoutMs/3, so it is intentionally not
  // logged. Refreshes the named instance's liveness; an unknown instance tells
  // the client to reconnect/register again.
  const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : undefined;
  const inst = instanceId ? registry.get(instanceId) : undefined;
  if (!inst) {
    res.status(410).send('gone');
    return;
  }
  inst.lastHeartbeatAt = Date.now();
  res.status(200).send('ok');
});

app.use((req, res) => {
  log(`404: ${req.method} ${req.url}`);
  res.status(404).send('not found');
});

const server = app.listen(port, HOST, () => {
  log(
    `listening on ${HOST}:${port} — group "${mainWorktreePath}", v${version}, ` +
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

// Prune dead instances, then exit if none remain — the sweep guarantees any
// survivor is fresh, so emptiness is the only exit condition. process.exit is
// atomic (port fully bound or fully free), avoiding a closed-but-alive window.
setInterval(() => {
  sweepStaleInstances();
  if (registry.size === 0 && Date.now() - serverStart > idleTimeoutMs) {
    log(`idle for >${idleTimeoutMs}ms with no live instance — exiting`);
    process.exit(0);
  }
}, IDLE_CHECK_MS).unref();
