// Standalone shared-server process.
//
// One of these is spawned (detached, via WMI on Windows) by the first VS Code
// window that fails to connect. It outlives every window; windows are clients
// holding an open pipe socket, and the set of live sockets is the reference
// count — when the last closes, the server exits after a grace period.
//
// Two listeners:
//   - a named pipe / unix socket: VS Code windows connect, hold the connection
//     open, and receive idle/busy broadcasts.
//   - a loopback HTTP port: Claude Code hooks POST lifecycle events here (see
//     claudeHooks.ts). Those map to idle/busy and trigger a broadcast.
//
// This file must never import 'vscode' — it runs in a plain Node process.

import * as net from 'net';
import * as fs from 'fs';
import * as http from 'http';
import { HOOK_HTTP_PORT } from './shared';

const GRACE_MS = 10000;

const pipePath = process.argv[2];
if (!pipePath) {
  console.error('takeshicc server: missing pipe path argument');
  process.exit(1);
}

// --- Idle/busy state -------------------------------------------------------

/** Claude sessions currently mid-turn. The machine is busy iff non-empty. */
const busySessions = new Set<string>();
/** Identifier of the most recently active chat (a Claude session id). */
let topic = '';

interface StateMessage {
  type: 'state';
  state: 'idle' | 'busy';
  topic: string;
}

function currentState(): StateMessage {
  return {
    type: 'state',
    state: busySessions.size > 0 ? 'busy' : 'idle',
    topic,
  };
}

/** Long-lived pipe clients (VS Code windows) that receive broadcasts. */
const subscribers = new Set<net.Socket>();

function broadcastState(): void {
  const line = JSON.stringify(currentState()) + '\n';
  for (const socket of subscribers) {
    socket.write(line);
  }
}

function handleHookEvent(body: string): void {
  let event = '';
  let sessionId = '';
  try {
    const parsed = JSON.parse(body) as {
      hook_event_name?: unknown;
      session_id?: unknown;
    };
    if (typeof parsed.hook_event_name === 'string') {
      event = parsed.hook_event_name;
    }
    if (typeof parsed.session_id === 'string') {
      sessionId = parsed.session_id;
    }
  } catch {
    return; // No usable JSON payload.
  }

  // Every Claude Code hook POSTs to one endpoint; discriminate by event name.
  switch (event) {
    case 'UserPromptSubmit':
      if (sessionId) {
        busySessions.add(sessionId);
        topic = sessionId;
      }
      break;
    case 'Stop':
      if (sessionId) {
        busySessions.delete(sessionId);
      } else {
        busySessions.clear(); // No id to match — assume everything idled.
      }
      break;
    default:
      return; // An event we don't translate.
  }
  broadcastState();
}

// --- Pipe server: VS Code windows ------------------------------------------

let clientCount = 0;
let graceTimer: NodeJS.Timeout | undefined;

const server = net.createServer((socket) => {
  // A new window connected — cancel any pending shutdown.
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
  clientCount++;
  subscribers.add(socket);

  socket.on('error', () => {
    // A 'close' event always follows; refcount is adjusted there.
  });
  socket.on('close', () => {
    clientCount--;
    subscribers.delete(socket);
    if (clientCount <= 0) {
      scheduleShutdown();
    }
  });

  // Handshake, immediately followed by the current state so the window
  // starts in sync. clientCount is already incremented, so the grace timer
  // can no longer fire — a client that sees 'ready' has a server that stays
  // alive until it disconnects.
  socket.write('ready\n');
  socket.write(JSON.stringify(currentState()) + '\n');
});

function scheduleShutdown(): void {
  if (graceTimer) {
    return;
  }
  graceTimer = setTimeout(() => {
    graceTimer = undefined;
    if (clientCount <= 0) {
      // Exit the whole process — never server.close(). A closed-but-alive
      // server keeps serving existing connections while rejecting new ones,
      // and releases the pipe name, which lets a second server start =>
      // split brain. process.exit() is atomic and total.
      process.exit(0);
    }
  }, GRACE_MS);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Another window won the race and is already serving — stand down.
    process.exit(0);
  }
  console.error('takeshicc server error:', err);
  process.exit(1);
});

// On non-Windows the pipe path is a Unix domain socket file a crashed server
// may have left behind; clear a stale one. (No-op on Windows.)
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(pipePath);
  } catch {
    // ENOENT — nothing to clean up.
  }
}

server.listen(pipePath);

// --- HTTP server: Claude Code hooks ----------------------------------------

const hookServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || (req.url ?? '') !== '/hook') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > 1_000_000) {
      req.destroy(); // Guard against an unbounded body.
    }
  });
  req.on('end', () => {
    // 204 (2xx, empty body) tells Claude Code the hook succeeded without
    // blocking the turn. State is updated after the response is sent.
    res.writeHead(204).end();
    handleHookEvent(body);
  });
  req.on('error', () => {
    try {
      res.destroy();
    } catch {
      // Response already gone.
    }
  });
});

hookServer.on('error', (err) => {
  // e.g. EADDRINUSE: the hook bridge is unavailable, but window sharing and
  // broadcasts still work. Degrade gracefully rather than crash.
  console.error('takeshicc hook listener error:', err);
});

// Bind loopback-only so Windows Firewall never prompts. unref() so the pipe
// server alone owns the process lifecycle.
hookServer.listen(HOOK_HTTP_PORT, '127.0.0.1', () => {
  hookServer.unref();
});
