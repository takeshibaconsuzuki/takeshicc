// Atomic getOrCreate for the per-repo HTTP server.
//
// Runs once on activation. Resolves the git group, looks it up in the config,
// then loops forever converging on a single shared server: POST /register,
// spawn a detached server process if none answers, poll until it admits us.
// The OS port bind is the mutex — duplicate spawns are harmless.

import * as http from 'http';
import * as fs from 'fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { HOST, ROUTES, RegisterRequest, RegisterResponse } from '../common/protocol';
import {
  CONFIG_PATH,
  TAKESHICC_DIR,
  lookupGroup,
  serverLogPath,
  ResolvedGroup,
} from '../common/config';
import { resolveGitMetadata } from '../common/gitUtils';
import { errMsg } from '../common/errMsg';
import { DeadConnectionHandler, ServerClient } from './ServerClient';

const REGISTER_TIMEOUT_MS = 1_000;
const POLL_INITIAL_MS = 50;
const POLL_CAP_MS = 500;
const POLL_DEADLINE_MS = 8_000;

// Outcome of one /register attempt. `ok` mirrors RegisterResponse's
// registered payload; the server already rejected a bad version as transient.
type RegisterResult =
  | { kind: 'ok'; groupId: string; mainWorktreePath: string; instanceId: string }
  | { kind: 'refused' }
  | { kind: 'transient'; reason: string };

type PollResult =
  | { kind: 'ready'; instanceId: string }
  | { kind: 'mismatch'; mainWorktreePath: string }
  | { kind: 'deadline' };

// ±25% jitter on a backoff delay.
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

// POST /register with a JSON body. http.request's `timeout` only emits a
// 'timeout' event — it does not abort the request — so the handler calls
// req.destroy() to avoid leaking a socket on a slow / black-holing port.
function tryRegister(port: number, worktreePath: string, version: string): Promise<RegisterResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RegisterResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(r);
    };
    const payload = JSON.stringify({ worktreePath, version } satisfies RegisterRequest);
    const req = http.request(
      {
        host: HOST,
        port,
        path: ROUTES.register,
        method: 'POST',
        timeout: REGISTER_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done({ kind: 'transient', reason: `status ${res.statusCode}` });
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RegisterResponse;
            done(
              body.status === 'registered'
                ? {
                    kind: 'ok',
                    groupId: String(body.groupId),
                    mainWorktreePath: String(body.mainWorktreePath),
                    instanceId: String(body.instanceId),
                  }
                : { kind: 'transient', reason: String(body.reason) || 'transient' },
            );
          } catch {
            done({ kind: 'transient', reason: 'unparseable /register body' });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ kind: 'transient', reason: 'register timeout' });
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done(
        code === 'ECONNREFUSED'
          ? { kind: 'refused' }
          : { kind: 'transient', reason: code ?? err.message },
      );
    });
    req.end(payload);
  });
}

// Classifies a successful register: ours (ready) or held by an unrelated
// process (mismatch). The server already rejected a stale build as transient,
// so a registered response only needs its groupId matched against ours; a
// mismatch carries the offending mainWorktreePath for a human-readable error.
function classify(result: RegisterResult & { kind: 'ok' }, groupId: string): PollResult {
  return result.groupId === groupId
    ? { kind: 'ready', instanceId: result.instanceId }
    : { kind: 'mismatch', mainWorktreePath: result.mainWorktreePath };
}

// Re-POST /register with jittered exponential backoff until the server admits
// us or the deadline passes. `first` lets the caller seed the loop with an
// already-obtained sample, avoiding a redundant immediate re-probe. The loop
// returns on the first non-transient answer, so exactly one register succeeds.
async function pollConnect(
  port: number,
  groupId: string,
  worktreePath: string,
  version: string,
  first?: RegisterResult,
): Promise<PollResult> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let delay = POLL_INITIAL_MS;
  let result = first;
  for (;;) {
    if (!result) {
      result = await tryRegister(port, worktreePath, version);
    }
    if (result.kind === 'ok') {
      return classify(result, groupId);
    }
    if (Date.now() >= deadline) {
      return { kind: 'deadline' };
    }
    await sleep(jitter(delay));
    delay = Math.min(delay * 2, POLL_CAP_MS);
    result = undefined;
  }
}

// Spawn the server as a detached Node process. The port bind is the mutex; a
// duplicate spawn exits(0) on EADDRINUSE. stdout+stderr go to a per-port log
// so startup failures are diagnosable.
function spawnServer(
  serverJs: string,
  port: number,
  mainWorktreePath: string,
  idleTimeoutMs: number,
  version: string,
  log: vscode.OutputChannel,
): void {
  fs.mkdirSync(TAKESHICC_DIR, { recursive: true });
  const fd = fs.openSync(serverLogPath(port), 'a');
  try {
    const child = spawn(
      process.execPath,
      [serverJs, String(port), mainWorktreePath, String(idleTimeoutMs), version],
      {
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        // process.execPath is VS Code's Electron binary; this runs it as plain Node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    child.unref();
    log.appendLine(`Takeshicc: spawned server (pid ${child.pid ?? '?'}) on port ${port}.`);
  } finally {
    fs.closeSync(fd); // the child holds its own dup of the fd
  }
}

type GroupResolution =
  | { kind: 'ok'; group: ResolvedGroup }
  | { kind: 'no-folder' }
  | { kind: 'not-git' }
  | { kind: 'bad-config'; message: string }
  | { kind: 'not-configured'; mainWorktreePath: string };

// Workspace folder -> git metadata -> config lookup. Returns a reason the
// callers map to their own UI; resolveGitMetadata logs the 'not-git'
// specifics itself.
async function resolveConfiguredGroup(log: vscode.OutputChannel): Promise<GroupResolution> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { kind: 'no-folder' };
  }
  const meta = await resolveGitMetadata(folder.uri.fsPath, log);
  if (!meta) {
    return { kind: 'not-git' };
  }
  let group: ResolvedGroup | undefined;
  try {
    group = lookupGroup(meta);
  } catch (err) {
    return { kind: 'bad-config', message: errMsg(err) };
  }
  if (!group) {
    return { kind: 'not-configured', mainWorktreePath: meta.mainWorktreePath };
  }
  return { kind: 'ok', group };
}

function reportBadConfig(message: string, log: vscode.OutputChannel): void {
  const line = `Takeshicc: invalid config at ${CONFIG_PATH} — ${message}`;
  vscode.window.showErrorMessage(line);
  log.appendLine(line);
}

function reportMismatch(port: number, otherGroup: string, mainWorktreePath: string): void {
  vscode.window.showErrorMessage(
    `Takeshicc: port ${port} is held by another process (group ` +
      `"${otherGroup}", expected "${mainWorktreePath}"). Fix ${CONFIG_PATH}.`,
  );
}

export async function getOrCreateServer(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  onDeadConnection: DeadConnectionHandler = () => {},
): Promise<ServerClient | undefined> {
  log.appendLine('Takeshicc: resolving server...');

  const r = await resolveConfiguredGroup(log);
  if (r.kind === 'no-folder') {
    log.appendLine('Takeshicc: no workspace folder open — server feature off.');
    return undefined;
  }
  if (r.kind === 'not-git') {
    return undefined; // resolveGitMetadata already logged the specific reason
  }
  if (r.kind === 'bad-config') {
    reportBadConfig(r.message, log);
    return undefined;
  }
  if (r.kind === 'not-configured') {
    log.appendLine(
      `Takeshicc: group "${r.mainWorktreePath}" not found in ${CONFIG_PATH} — server feature off. ` +
        `Add a "groups" entry for it to enable the server.`,
    );
    return undefined;
  }

  const { group } = r;
  const { port, idleTimeoutMs, groupId, mainWorktreePath, worktreePath } = group;
  log.appendLine(
    `Takeshicc: group "${mainWorktreePath}" -> port ${port}, idleTimeoutMs ${idleTimeoutMs}.`,
  );
  const version: string = context.extension.packageJSON.version ?? '0';
  const serverJs = context.asAbsolutePath('out/server.js');

  // Loop forever; each iteration surfaces its own error notification, and the
  // ~8 s poll deadline paces them.
  for (;;) {
    const result = await tryRegister(port, worktreePath, version);

    // refused -> spawn, then poll a fresh probe. transient/ok -> feed the
    // sample straight into pollConnect (ok resolves immediately; transient
    // backs off without an extra redundant probe).
    let firstSample: RegisterResult | undefined = result;
    if (result.kind === 'refused') {
      spawnServer(serverJs, port, mainWorktreePath, idleTimeoutMs, version, log);
      firstSample = undefined;
    } else if (result.kind === 'transient') {
      log.appendLine(`Takeshicc: /register transient (${result.reason}); polling.`);
    }

    const poll = await pollConnect(port, groupId, worktreePath, version, firstSample);
    if (poll.kind === 'ready') {
      log.appendLine(`Takeshicc: connected to server on port ${port}.`);
      return new ServerClient(port, groupId, idleTimeoutMs, poll.instanceId, log, onDeadConnection);
    }
    if (poll.kind === 'mismatch') {
      reportMismatch(port, poll.mainWorktreePath, mainWorktreePath);
      return undefined;
    }
    // Deadline exceeded — surface the server log and continue the loop.
    vscode.window.showErrorMessage(
      `Takeshicc: server on port ${port} did not become ready; ` + `see ${serverLogPath(port)}.`,
    );
  }
}

// Command handler: opens the per-port server log for the current workspace's
// configured group, or explains why there is none.
export async function openServerLog(log: vscode.OutputChannel): Promise<void> {
  const r = await resolveConfiguredGroup(log);
  if (r.kind === 'no-folder') {
    vscode.window.showInformationMessage('Takeshicc: no workspace folder open.');
    return;
  }
  if (r.kind === 'not-git') {
    vscode.window.showInformationMessage(
      'Takeshicc: workspace is not a git repository — no server log.',
    );
    return;
  }
  if (r.kind === 'bad-config') {
    reportBadConfig(r.message, log);
    return;
  }
  if (r.kind === 'not-configured') {
    vscode.window.showInformationMessage(
      `Takeshicc: "${r.mainWorktreePath}" is not in ${CONFIG_PATH} — no server log.`,
    );
    return;
  }

  const logPath = serverLogPath(r.group.port);
  if (!fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(
      `Takeshicc: no server log at ${logPath} yet — the server has not been spawned.`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc);
}
