// Standalone per-repo HTTP server. Bundled by esbuild into out/server.js and
// run as a detached plain-Node process. MUST NEVER `import 'vscode'`.
//
// The port bind is the mutex: if a sibling already owns the port, listen()
// fails with EADDRINUSE and this process exits(0) (the duplicate spawn is
// harmless). The server idle-exits once no live instance remains — promptly
// once its registry empties, or idleTimeoutMs after spawn if none ever
// registers.

import express = require('express');
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  HOST,
  InstanceEventItem,
  InstanceEventsMessage,
  ROUTES,
  MISSING_WORKTREE_FIELDS_ERROR,
  RegisterRequest,
  WorktreeJobsMessage,
} from '../common/protocol';
import { groupIdFor, instanceIdFor } from '../common/gitUtils';
import { lineSplitter } from '../common/lineSplitter';
import { errMsg } from '../common/errMsg';

const IDLE_CHECK_MS = 5_000;

// Safety net so a hung bootstrap (e.g. one blocked on a prompt or a lock)
// can't pin this server — and its bound port — alive forever via the
// activeServerJobs idle-exit guard.
const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;

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

interface Instance extends InstanceEventItem {
  lastHeartbeatAt: number;
}

// Live VS Code instances sharing this server, keyed by instanceId — the seed
// for future cross-instance routing. Liveness moves only on register +
// heartbeat, never on a rejected request, so a client stuck polling
// /register cannot keep a doomed server alive.
const registry = new Map<string, Instance>();

// The active worktree-create jobs, keyed by jobId — tracked like the instance
// registry: an entry is here while the job runs and removed the moment it
// finishes. Its worktree path rides along so a snapshot lets every window list
// the in-progress worktree. The job runs to completion regardless of who is
// connected.
const jobs = new Map<string, { worktreePath: string }>();

// Live GET /instance-events streams. A broadcast target: each gets a snapshot
// on connect, then a delta whenever the registry changes.
const instanceSubscribers = new Set<express.Response>();

// Live GET /worktree-jobs streams. A broadcast target: each gets a snapshot
// on connect, then a `done` frame per job as it finishes.
const jobSubscribers = new Set<express.Response>();

// Nonzero ⇒ an in-flight job (via withServerJob) is running and the server
// must not idle-exit. SSE subscribers deliberately do *not*
// count: a watching window is already kept alive through its registered
// instance's heartbeat, and a stream that outlives the registration must not
// pin a registry-empty server (which would hold its bound port past the
// intended idle-exit).
let activeServerJobs = 0;

function instanceSnapshot(): InstanceEventItem[] {
  return Array.from(registry.values(), ({ groupId, worktreePath }) => ({
    groupId,
    worktreePath,
  }));
}

function instanceItem(inst: Instance): InstanceEventItem {
  return { groupId: inst.groupId, worktreePath: inst.worktreePath };
}

// Drop instances whose heartbeat lapsed past idleTimeoutMs (closed/reloaded/
// crashed window). A live client beats every idleTimeoutMs/3 — a 3x margin,
// so it is never pruned in flight.
function sweepStaleInstances(): void {
  const now = Date.now();
  for (const [id, inst] of registry) {
    if (now - inst.lastHeartbeatAt > idleTimeoutMs) {
      registry.delete(id);
      log(`unregistered ${id} (${inst.worktreePath}); heartbeat lapsed; ${registry.size} live`);
      broadcastInstance({ type: 'unregistered', instance: instanceItem(inst) });
    }
  }
}

function withServerJob<T>(job: () => Promise<T>): Promise<T> {
  activeServerJobs++;
  return job().finally(() => {
    activeServerJobs--;
  });
}

function sseWrite(
  res: express.Response,
  message: InstanceEventsMessage | WorktreeJobsMessage,
): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

function broadcastInstance(message: InstanceEventsMessage): void {
  for (const res of instanceSubscribers) {
    sseWrite(res, message);
  }
}

function broadcastJob(message: WorktreeJobsMessage): void {
  for (const res of jobSubscribers) {
    sseWrite(res, message);
  }
}

// Broadcast the terminal result to whoever is watching, then stop tracking
// the job — it is no longer active, so it drops out of future snapshots. The
// stream itself stays open for subsequent jobs.
function finishJob(done: Extract<WorktreeJobsMessage, { type: 'done' }>): void {
  broadcastJob(done);
  jobs.delete(done.jobId);
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve();
      }
    });
  });
}

function trimStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// shell:true spawns an intermediate shell that owns the real grandchildren, so
// on POSIX we start a new process group (detached) and signal the whole group;
// child.kill() alone would orphan them.
function killChildTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // Already exited — nothing to kill.
  }
}

function runBootstrapCommand(opts: {
  command: string;
  cwd: string;
  branchName: string;
  baseBranch: string;
}): Promise<void> {
  const { command, cwd, branchName, baseBranch } = opts;
  log(`bootstrap start: ${command} (cwd ${cwd})`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TAKESHICC_WORKTREE_PATH: cwd,
        TAKESHICC_BRANCH_NAME: branchName,
        TAKESHICC_BASE_BRANCH: baseBranch,
      },
    });

    // Output goes only to the server log (the "Open Server Log" target),
    // line-buffered so chunk/multi-byte splits aren't mangled.
    const sink = (stream: 'stdout' | 'stderr') =>
      lineSplitter((line) => log(`bootstrap ${stream}: ${line}`));
    const stdout = sink('stdout');
    const stderr = sink('stderr');
    child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));

    const timer = setTimeout(() => {
      log(`bootstrap timed out after ${BOOTSTRAP_TIMEOUT_MS}ms — killing`);
      killChildTree(child);
    }, BOOTSTRAP_TIMEOUT_MS);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, killSignal) => {
      clearTimeout(timer);
      stdout.flush();
      stderr.flush();
      if (code === 0) {
        log(`bootstrap done: ${command}`);
        resolve();
        return;
      }
      reject(
        new Error(killSignal ? `bootstrap killed by ${killSignal}` : `bootstrap exited ${code}`),
      );
    });
  });
}

// Runs to completion independent of the requester: the worktree should still
// land (and bootstrap finish) even if the window that asked for it goes away.
async function runWorktreeJob(
  jobId: string,
  fields: {
    branchName: string;
    baseBranch: string;
    worktreePath: string;
    bootstrapCommand: string;
  },
): Promise<void> {
  const { branchName, baseBranch, worktreePath, bootstrapCommand } = fields;
  try {
    log(`worktree create start: branch ${branchName}, base ${baseBranch}, path ${worktreePath}`);
    await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], mainWorktreePath);
    log(`worktree created: ${worktreePath}`);
    // The worktree now exists on disk; tell every window to list it before the
    // (possibly long) bootstrap runs. The job stays active until bootstrap
    // finishes, so the window can flag it as still in-progress.
    broadcastJob({ type: 'created', jobId, worktreePath });
    if (bootstrapCommand) {
      await runBootstrapCommand({
        command: bootstrapCommand,
        cwd: worktreePath,
        branchName,
        baseBranch,
      });
    }
    finishJob({ type: 'done', jobId, worktreePath, status: 'ok' });
  } catch (err) {
    const message = errMsg(err);
    log(`worktree create failed: ${message}`);
    finishJob({ type: 'done', jobId, worktreePath, status: 'failed', error: message });
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
  const instance = { groupId, worktreePath, lastHeartbeatAt: Date.now() };
  registry.set(instanceId, instance);
  log(`registered ${instanceId} (${worktreePath}); ${registry.size} live`);
  broadcastInstance({ type: 'registered', instance: instanceItem(instance) });
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

app.get(ROUTES.instanceEvents, (_req, res) => {
  res.status(200).set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  sseWrite(res, { type: 'snapshot', instances: instanceSnapshot() });

  instanceSubscribers.add(res);
  res.on('close', () => {
    instanceSubscribers.delete(res);
  });
});

app.post(ROUTES.createWorktree, (req, res) => {
  const body = (req.body ?? {}) as Partial<CreateWorktreeRequest>;
  const branchName = trimStr(body.branchName);
  const baseBranch = trimStr(body.baseBranch);
  const worktreePath = trimStr(body.worktreePath);
  const bootstrapCommand = trimStr(body.bootstrapCommand);
  if (!branchName || !baseBranch || !worktreePath) {
    res.status(400).json({ error: MISSING_WORKTREE_FIELDS_ERROR } satisfies CreateWorktreeResponse);
    return;
  }

  const jobId = randomUUID();
  jobs.set(jobId, { worktreePath });
  log(`worktree job ${jobId} accepted: branch ${branchName}, base ${baseBranch}`);
  res.status(202).json({ jobId } satisfies CreateWorktreeResponse);
  void withServerJob(() =>
    runWorktreeJob(jobId, { branchName, baseBranch, worktreePath, bootstrapCommand }),
  );
});

app.get(ROUTES.worktreeJobs, (_req, res) => {
  res.status(200).set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  sseWrite(res, {
    type: 'snapshot',
    jobs: Array.from(jobs, ([jobId, { worktreePath }]) => ({ jobId, worktreePath })),
  });

  jobSubscribers.add(res);
  res.on('close', () => {
    jobSubscribers.delete(res);
  });
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
  if (registry.size === 0 && activeServerJobs === 0 && Date.now() - serverStart > idleTimeoutMs) {
    log(`idle for >${idleTimeoutMs}ms with no live instance or server job — exiting`);
    process.exit(0);
  }
}, IDLE_CHECK_MS).unref();
