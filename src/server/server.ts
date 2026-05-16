// Standalone per-repo HTTP server. Bundled by esbuild into out/server.js and
// run as a detached plain-Node process. MUST NEVER `import 'vscode'`.
//
// The port bind is the mutex: if a sibling already owns the port, listen()
// fails with EADDRINUSE and this process exits(0) (the duplicate spawn is
// harmless). The server idle-exits after idleTimeoutMs with no requests.

import express = require('express');
import { HOST, ROUTES } from './protocol';

const IDLE_CHECK_MS = 5_000;

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

const app = express();

// Mark activity on every request so the idle check can never exit under load.
app.use((_req, _res, next) => {
  lastActivityAt = Date.now();
  next();
});

app.get(ROUTES.whoami, (_req, res) => {
  res.status(200).json({ groupKey, version });
});

app.get(ROUTES.ping, (_req, res) => {
  res.status(200).send('ok');
});

app.use((_req, res) => {
  res.status(404).send('not found');
});

const server = app.listen(port, HOST);

server.on('error', (err: NodeJS.ErrnoException) => {
  // A sibling won the bind — that process is the server; this one is redundant.
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

// Idle self-shutdown. Always process.exit — exit is atomic (port fully bound
// or fully free), avoiding a closed-but-alive split-brain window.
setInterval(() => {
  if (Date.now() - lastActivityAt > idleTimeoutMs) {
    process.exit(0);
  }
}, IDLE_CHECK_MS).unref();
