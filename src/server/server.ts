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
  DeleteWorktreeRequest,
  DeleteWorktreeResponse,
  HOST,
  InstanceCommandMessage,
  InstanceEventItem,
  InstanceEventsMessage,
  ROUTES,
  MISSING_WORKTREE_FIELDS_ERROR,
  RegisterRequest,
  UnregisterRequest,
  WorktreeJobOperation,
  WorktreeJobsMessage,
} from '../common/protocol';
import {
  canonicalizePath,
  groupIdFor,
  instanceIdFor,
  parseWorktreeList,
  type WorktreeListEntry,
} from '../common/gitUtils';
import { lineSplitter } from '../common/lineSplitter';
import { errMsg } from '../common/errMsg';

const IDLE_CHECK_MS = 5_000;

// Safety net so a hung bootstrap (e.g. one blocked on a prompt or a lock)
// can't pin this server — and its bound port — alive forever via the
// activeServerJobs idle-exit guard.
const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;
const DELETE_INSTANCE_WAIT_MS = 2 * 60_000;

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

// The active worktree jobs, keyed by jobId — tracked like the instance
// registry: an entry is here while the job runs and removed the moment it
// finishes. Its worktree path rides along so a snapshot lets every window list
// the in-progress worktree. The job runs to completion regardless of who is
// connected.
const jobs = new Map<string, { worktreePath: string; operation: WorktreeJobOperation }>();

// The job deleting a given canonical worktree path, if any. A worktree with an
// active delete job is rejected on re-register so the server can finish cleanup
// after requesting its live instance to quit. Derived from `jobs` (delete-job
// worktree paths are stored canonical) so the two never drift.
function deleteJobIdForPath(canonicalPath: string): string | undefined {
  for (const [jobId, job] of jobs) {
    if (job.operation === 'delete' && job.worktreePath === canonicalPath) {
      return jobId;
    }
  }
  return undefined;
}

// Live GET /instance-events streams. A broadcast target: each gets a snapshot
// on connect, then a delta whenever the registry changes.
const instanceSubscribers = new Set<express.Response>();

// Live GET /worktree-jobs streams. A broadcast target: each gets a snapshot
// on connect, then a `done` frame per job as it finishes.
const jobSubscribers = new Set<express.Response>();

// Per-instance command delivery, all keyed by instanceId: the live
// /instance-commands SSE streams; commands queued while no stream is connected
// (replayed and dropped on the next connect); and resolvers waiting for an
// instance to unregister (so a delete job can proceed once its window quits).
const commandSubscribers = new Map<string, Set<express.Response>>();
const pendingInstanceCommands = new Map<string, InstanceCommandMessage[]>();
const unregisterWaiters = new Map<string, Set<() => void>>();

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

function unregisterInstance(instanceId: string, reason: string): boolean {
  const inst = registry.get(instanceId);
  if (!inst) {
    return false;
  }
  registry.delete(instanceId);
  log(`unregistered ${instanceId} (${inst.worktreePath}); ${reason}; ${registry.size} live`);
  broadcastInstance({ type: 'unregistered', instance: instanceItem(inst) });
  const waiters = unregisterWaiters.get(instanceId);
  if (waiters) {
    unregisterWaiters.delete(instanceId);
    for (const resolve of waiters) {
      resolve();
    }
  }
  pendingInstanceCommands.delete(instanceId);
  const subscribers = commandSubscribers.get(instanceId);
  if (subscribers) {
    for (const res of subscribers) {
      res.end();
    }
  }
  commandSubscribers.delete(instanceId);
  return true;
}

// Drop instances whose heartbeat lapsed past idleTimeoutMs (closed/reloaded/
// crashed window). A live client beats every idleTimeoutMs/3 — a 3x margin,
// so it is never pruned in flight.
function sweepStaleInstances(): void {
  const now = Date.now();
  for (const [id, inst] of registry) {
    if (now - inst.lastHeartbeatAt > idleTimeoutMs) {
      unregisterInstance(id, 'heartbeat lapsed');
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
  message: InstanceCommandMessage | InstanceEventsMessage | WorktreeJobsMessage,
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

function jobSnapshot() {
  return Array.from(jobs, ([jobId, { worktreePath, operation }]) => ({
    jobId,
    worktreePath,
    operation,
  }));
}

function commandSubscriberSet(instanceId: string): Set<express.Response> {
  let set = commandSubscribers.get(instanceId);
  if (!set) {
    set = new Set();
    commandSubscribers.set(instanceId, set);
  }
  return set;
}

// Deliver to a live command stream if one is connected; otherwise queue it for
// replay on the next connect. A delivered command is *not* queued, so a
// flapping stream never re-replays an already-sent command.
function sendInstanceCommand(instanceId: string, message: InstanceCommandMessage): void {
  const subscribers = commandSubscribers.get(instanceId);
  if (!subscribers || subscribers.size === 0) {
    const pending = pendingInstanceCommands.get(instanceId) ?? [];
    pending.push(message);
    pendingInstanceCommands.set(instanceId, pending);
    log(`queued instance command ${message.type} for ${instanceId}; no command stream`);
    return;
  }
  for (const res of subscribers) {
    sseWrite(res, message);
  }
}

function waitForUnregistered(instanceId: string, timeoutMs: number): Promise<void> {
  if (!registry.has(instanceId)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const waiters = unregisterWaiters.get(instanceId);
      waiters?.delete(done);
      if (waiters?.size === 0) {
        unregisterWaiters.delete(instanceId);
      }
      reject(new Error(`instance ${instanceId} did not unregister within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const waiters = unregisterWaiters.get(instanceId) ?? new Set<() => void>();
    waiters.add(done);
    unregisterWaiters.set(instanceId, waiters);
  });
}

// Broadcast the terminal result to whoever is watching, then stop tracking
// the job — it is no longer active, so it drops out of future snapshots. The
// stream itself stays open for subsequent jobs.
function finishJob(done: Extract<WorktreeJobsMessage, { type: 'done' }>): void {
  broadcastJob(done);
  jobs.delete(done.jobId);
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function trimStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function worktreeInfoFor(worktreePath: string): Promise<WorktreeListEntry> {
  const stdout = await runGit(['worktree', 'list', '--porcelain'], mainWorktreePath);
  const canonical = canonicalizePath(worktreePath);
  const info = parseWorktreeList(stdout).find(
    (entry) => canonicalizePath(entry.path) === canonical,
  );
  if (!info) {
    throw new Error(`worktree not found: ${worktreePath}`);
  }
  return info;
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
    finishJob({ type: 'done', jobId, worktreePath, operation: 'create', status: 'ok' });
  } catch (err) {
    const message = errMsg(err);
    log(`worktree create failed: ${message}`);
    finishJob({
      type: 'done',
      jobId,
      worktreePath,
      operation: 'create',
      status: 'failed',
      error: message,
    });
  }
}

async function runDeleteWorktreeJob(
  jobId: string,
  fields: { worktreePath: string; branchName: string },
): Promise<void> {
  const { worktreePath, branchName } = fields;
  try {
    const canonicalWorktreePath = canonicalizePath(worktreePath);
    const instanceId = instanceIdFor(canonicalWorktreePath);
    log(`worktree delete start: branch ${branchName ?? '(none)'}, path ${canonicalWorktreePath}`);

    if (registry.has(instanceId)) {
      log(`requesting quit from ${instanceId} before deleting ${canonicalWorktreePath}`);
      sendInstanceCommand(instanceId, { type: 'quit', worktreePath: canonicalWorktreePath });
      await waitForUnregistered(instanceId, DELETE_INSTANCE_WAIT_MS);
      log(`${instanceId} unregistered; deleting ${canonicalWorktreePath}`);
    }

    await runGit(['worktree', 'remove', canonicalWorktreePath], mainWorktreePath);
    log(`worktree removed: ${canonicalWorktreePath}`);

    await runGit(['branch', '-D', '--', branchName], mainWorktreePath);
    log(`branch deleted: ${branchName}`);

    finishJob({
      type: 'done',
      jobId,
      worktreePath: canonicalWorktreePath,
      operation: 'delete',
      status: 'ok',
    });
  } catch (err) {
    const message = errMsg(err);
    log(`worktree delete failed: ${message}`);
    finishJob({
      type: 'done',
      jobId,
      worktreePath,
      operation: 'delete',
      status: 'failed',
      error: message,
    });
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
  if (deleteJobIdForPath(canonicalizePath(worktreePath))) {
    log(`register rejected: worktree marked for deletion (${worktreePath})`);
    res.status(200).json({ status: 'transient', reason: 'worktree marked for deletion' });
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

app.post(ROUTES.unregister, (req, res) => {
  const { instanceId } = (req.body ?? {}) as Partial<UnregisterRequest>;
  if (typeof instanceId !== 'string' || !instanceId) {
    res.status(400).json({ error: 'instanceId is required' });
    return;
  }
  unregisterInstance(instanceId, 'client shutdown');
  res.status(200).json({ ok: true });
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

app.get(ROUTES.instanceCommands, (req, res) => {
  const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : undefined;
  if (!instanceId || !registry.has(instanceId)) {
    res.status(410).send('gone');
    return;
  }

  res.status(200).set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();

  const subscribers = commandSubscriberSet(instanceId);
  subscribers.add(res);
  // Flush anything queued while no stream was connected, then drop it — it is
  // now delivered and must not replay on the next reconnect.
  const pending = pendingInstanceCommands.get(instanceId);
  if (pending) {
    pendingInstanceCommands.delete(instanceId);
    for (const message of pending) {
      sseWrite(res, message);
    }
  }

  res.on('close', () => {
    subscribers.delete(res);
    if (subscribers.size === 0) {
      commandSubscribers.delete(instanceId);
    }
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
  jobs.set(jobId, { worktreePath, operation: 'create' });
  log(`worktree job ${jobId} accepted: branch ${branchName}, base ${baseBranch}`);
  res.status(202).json({ jobId } satisfies CreateWorktreeResponse);
  void withServerJob(() =>
    runWorktreeJob(jobId, { branchName, baseBranch, worktreePath, bootstrapCommand }),
  );
});

app.post(ROUTES.deleteWorktree, async (req, res) => {
  const body = (req.body ?? {}) as Partial<DeleteWorktreeRequest>;
  const worktreePath = trimStr(body.worktreePath);
  if (!worktreePath) {
    res.status(400).json({ error: 'Worktree path is required.' } satisfies DeleteWorktreeResponse);
    return;
  }

  const canonicalWorktreePath = canonicalizePath(worktreePath);
  if (canonicalWorktreePath === canonicalizePath(mainWorktreePath)) {
    res
      .status(400)
      .json({ error: 'The main worktree cannot be deleted.' } satisfies DeleteWorktreeResponse);
    return;
  }

  const existingJobId = deleteJobIdForPath(canonicalWorktreePath);
  if (existingJobId) {
    res.status(202).json({ jobId: existingJobId } satisfies DeleteWorktreeResponse);
    return;
  }

  let info: WorktreeListEntry;
  try {
    info = await worktreeInfoFor(canonicalWorktreePath);
  } catch (err) {
    res.status(400).json({ error: errMsg(err) } satisfies DeleteWorktreeResponse);
    return;
  }
  if (info.bare) {
    res.status(400).json({
      error: 'Bare repositories cannot be deleted as worktrees.',
    } satisfies DeleteWorktreeResponse);
    return;
  }
  if (!info.branch) {
    res.status(400).json({
      error: 'Only worktrees on a local branch can be deleted.',
    } satisfies DeleteWorktreeResponse);
    return;
  }
  const branchName = info.branch;

  const jobId = randomUUID();
  jobs.set(jobId, { worktreePath: canonicalWorktreePath, operation: 'delete' });
  log(`delete job ${jobId} accepted: branch ${branchName}, path ${canonicalWorktreePath}`);
  broadcastJob({ type: 'deleting', jobId, worktreePath: canonicalWorktreePath });
  res.status(202).json({ jobId } satisfies DeleteWorktreeResponse);
  void withServerJob(() =>
    runDeleteWorktreeJob(jobId, {
      worktreePath: canonicalWorktreePath,
      branchName,
    }),
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
    jobs: jobSnapshot(),
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
