// Claude Code UserPromptSubmit command hook — non-Windows (see registerHooks;
// Windows uses reporter.ps1, because a Node/Electron child gets orphaned there
// and loses the process-ancestor chain this relies on).
//
// Claude pipes the hook's JSON payload to this process on stdin. While every
// ancestor process is still alive, it walks its own process-ancestor chain —
// reporter -> shell -> claude -> ...wrappers... -> the VS Code terminal's
// shell -> ... — collecting every ancestor PID. It then forwards the hook
// payload, augmented with that PID list as `ancestorPids`, to the server's
// /update-chat-state endpoint.
//
// The extension matches one of those PIDs to a Terminal's shell PID, which is
// how a live-chat row knows which terminal hosts the session. Forwarding the
// full payload (not just the PIDs) means UserPromptSubmit still drives chat
// state exactly as a plain HTTP hook would.
//
// Bundled by esbuild into out/reporter.js and run under VS Code's Electron
// binary in Node mode (see registerHooks). Like everything under src/server,
// it must never import 'vscode'. Failures are non-disruptive: a hook that
// errors is non-blocking, a chat that cannot be located just renders as
// non-revealable, and what happened is left in ~/.takeshicc/reporter.log.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { HOST, ROUTES } from '../server/protocol';

// Guard against a pathological / cyclic process table.
const MAX_DEPTH = 64;
// Cap every external probe so a wedged `ps`/`powershell` cannot hang the hook.
const PROBE_TIMEOUT_MS = 5_000;

// Append a line to ~/.takeshicc/reporter.log. The reporter is a detached
// process with no extension channel, so this file is its only debug trail.
// Best-effort: a logging failure must never break the hook.
function debugLog(msg: string): void {
  try {
    const dir = path.join(os.homedir(), '.takeshicc');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'reporter.log'),
      `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`,
    );
  } catch {
    // nothing we can do — and nothing that should propagate
  }
}

// Parse `<pid> <ppid>` lines (one process per line) into a pid -> ppid map.
function parsePairs(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      map.set(Number(m[1]), Number(m[2]));
    }
  }
  return map;
}

// The OS process table as raw `<pid> <ppid>` text — Windows via a CIM query,
// macOS/Linux via `ps`. Returns '' (and logs why) on failure.
function processTableText(): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object ' +
            '{ "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
      );
    }
    // `ps` is present on every macOS and Linux box; -axo with `=` headers
    // emits a bare `<pid> <ppid>` table.
    return execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch (err) {
    debugLog(`process-table query failed: ${(err as Error).message}`);
    return '';
  }
}

// The parent PID of `pid` on Linux, read straight from /proc.
function linuxParent(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields: `pid (comm) state ppid ...` — `comm` may contain spaces and ')',
    // so parse after the LAST ')'.
    const after = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const ppid = Number(after[1]); // [0] = state, [1] = ppid
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

// Every ancestor PID of this process, nearest first — the VS Code terminal's
// shell PID is meant to be among them. Each hop is logged, and a walk that
// dead-ends early dumps the full process table to ~/.takeshicc/proctree.log
// so the real chain can be traced by hand.
function collectAncestorPids(): number[] {
  const pids: number[] = [];
  const isLinux = process.platform === 'linux';
  const raw = isLinux ? '' : processTableText();
  const map = isLinux ? new Map<number, number>() : parsePairs(raw);
  debugLog(
    `walking ancestors — platform ${process.platform}, ` +
      `process.pid ${process.pid}, process.ppid ${process.ppid}` +
      (isLinux ? '' : `, process table has ${map.size} entries`),
  );

  let pid = process.pid;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const ppid = isLinux ? linuxParent(pid) : map.get(pid);
    debugLog(`  hop ${i}: pid ${pid} -> ppid ${ppid ?? 'undefined'}`);
    // Stop at the OS root (0/1) or on a cycle — neither is a useful ancestor.
    if (ppid === undefined || ppid <= 1 || pids.includes(ppid)) {
      break;
    }
    pids.push(ppid);
    pid = ppid;
  }

  if (!isLinux && pids.length <= 1 && raw) {
    try {
      const dump = path.join(os.homedir(), '.takeshicc', 'proctree.log');
      fs.writeFileSync(dump, raw);
      debugLog(`walk dead-ended early — dumped process table to ${dump}`);
    } catch {
      // best effort — the debug trail above is still useful on its own
    }
  }
  return pids;
}

// Read the hook payload Claude pipes to stdin. Resolves with '' on any error
// so the caller can bail cleanly.
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// POST the augmented payload to the server. Resolves true on a 2xx/3xx
// response, false on any failure — the reason is logged either way.
function postPayload(port: number, payload: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port,
        path: ROUTES.updateChatState,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const ok = (res.statusCode ?? 0) < 400;
        debugLog(`server responded ${res.statusCode}`);
        res.resume();
        res.on('end', () => resolve(ok));
        res.on('error', () => resolve(false));
      },
    );
    req.on('error', (err) => {
      debugLog(`POST failed: ${err.message}`);
      resolve(false);
    });
    req.on('timeout', () => {
      debugLog('POST timed out');
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

async function main(): Promise<void> {
  // argv[2] = server port, baked into the hook command by registerHooks.
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port)) {
    debugLog(`bad port argument: ${JSON.stringify(process.argv[2])}`);
    return;
  }
  debugLog(`started — server port ${port}`);

  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    debugLog(`could not parse ${raw.length}-byte stdin payload`);
    return; // no payload — nothing to forward
  }
  if (typeof payload.session_id !== 'string') {
    debugLog('stdin payload has no session_id');
    return;
  }

  const pids = collectAncestorPids();
  payload.ancestorPids = pids;
  debugLog(
    `session ${payload.session_id}: collected ancestorPids [${pids.join(', ')}]`,
  );
  const ok = await postPayload(port, payload);
  debugLog(
    `session ${payload.session_id}: POST ${ok ? 'succeeded' : 'failed'}`,
  );
}

void main();
