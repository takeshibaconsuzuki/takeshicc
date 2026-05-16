// Standalone shared-server process.
//
// One of these is spawned (detached) by the first VS Code window that fails to
// connect to an existing server. It outlives every window: VS Code windows are
// just clients holding an open socket. The set of live sockets IS the reference
// count — when the last one closes, the server exits after a short grace period.
//
// Launched as: <electron-as-node> out/server.js <pipePath>
// This file must never import 'vscode' — it runs in a plain Node process.

import * as net from 'net';
import * as fs from 'fs';

const GRACE_MS = 10000;

const pipePath = process.argv[2];
if (!pipePath) {
  console.error('takeshicc server: missing pipe path argument');
  process.exit(1);
}

let clientCount = 0;
let graceTimer: NodeJS.Timeout | undefined;

const server = net.createServer((socket) => {
  // A new window connected — cancel any pending shutdown.
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
  clientCount++;

  socket.on('error', () => {
    // A 'close' event always follows; refcount is adjusted there.
  });
  socket.on('close', () => {
    clientCount--;
    if (clientCount <= 0) {
      scheduleShutdown();
    }
  });

  // Handshake. The client treats itself as connected only once it receives
  // this. Because clientCount was already incremented above, the grace timer
  // can no longer fire an exit — so any client that sees 'ready' is guaranteed
  // a server that stays alive until that client disconnects.
  socket.write('ready\n');

  // --- Protocol goes here -------------------------------------------------
  // Add request handling on `socket` (e.g. newline-delimited JSON) as needed.
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
      // split brain. process.exit() is atomic and total: the server is
      // either fully accepting or fully gone (pipe freed for a fresh one).
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

// On non-Windows the pipe path is a Unix domain socket file that a crashed
// server may have left behind; clear a stale one. (No-op on Windows, where
// named pipes are refcounted kernel objects that vanish with the process.)
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(pipePath);
  } catch {
    // ENOENT — nothing to clean up.
  }
}

server.listen(pipePath);
