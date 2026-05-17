// Atomic getOrCreate for the per-repo HTTP server.
//
// Runs once on activation. Resolves the git group, looks it up in the config,
// then loops forever converging on a single shared server: probe /whoami,
// spawn a detached server process if none answers, poll until it is ready.
// The OS port bind is the mutex — duplicate spawns are harmless.

import * as http from 'http';
import * as fs from 'fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { HOST, ROUTES } from '../common/protocol';
import { CONFIG_PATH, TAKESHICC_DIR, lookupGroup, serverLogPath, ResolvedGroup } from '../common/config';
import { resolveGitGroup } from '../common/gitGroup';
import { errMsg } from '../common/errMsg';

const WHOAMI_TIMEOUT_MS = 1_000;
const POLL_INITIAL_MS = 50;
const POLL_CAP_MS = 500;
const POLL_DEADLINE_MS = 8_000;

export interface ServerClient {
  port: number;
  groupKey: string;
  close(): void;
}

type WhoamiResult =
  | { kind: 'ok'; groupKey: string; version: string }
  | { kind: 'refused' }
  | { kind: 'transient'; reason: string };

type PollResult =
  | { kind: 'ready' }
  | { kind: 'mismatch'; groupKey: string }
  | { kind: 'deadline' };

// ±25% jitter on a backoff delay.
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

// GET /whoami. http.get's `timeout` only emits a 'timeout' event — it does not
// abort the request — so the handler calls req.destroy() to avoid leaking a
// socket on a slow / black-holing port.
function tryWhoami(port: number): Promise<WhoamiResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: WhoamiResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(r);
    };
    const req = http.get(
      { host: HOST, port, path: ROUTES.whoami, timeout: WHOAMI_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            done({ kind: 'transient', reason: `status ${res.statusCode}` });
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done({
              kind: 'ok',
              groupKey: String(body.groupKey),
              version: String(body.version),
            });
          } catch {
            done({ kind: 'transient', reason: 'unparseable /whoami body' });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done({ kind: 'transient', reason: 'whoami timeout' });
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done(
        code === 'ECONNREFUSED'
          ? { kind: 'refused' }
          : { kind: 'transient', reason: code ?? err.message },
      );
    });
  });
}

// Classifies an answered /whoami: ours (ready, warning if the build is stale)
// or held by an unrelated process (mismatch). The single converger for both
// the initial probe and the poll loop.
function classify(
  who: WhoamiResult & { kind: 'ok' },
  groupKey: string,
  version: string,
  log: vscode.OutputChannel,
): { kind: 'ready' } | { kind: 'mismatch'; groupKey: string } {
  if (who.groupKey !== groupKey) {
    return { kind: 'mismatch', groupKey: who.groupKey };
  }
  if (who.version !== version) {
    log.appendLine(
      `Takeshicc: connected to a stale server (server ${who.version}, ` +
        `extension ${version}); it will be replaced after it idle-exits.`,
    );
  }
  return { kind: 'ready' };
}

// Poll /whoami with jittered exponential backoff until it answers or the
// deadline passes. `first` lets the caller seed the loop with an
// already-obtained sample, avoiding a redundant immediate re-probe.
async function pollConnect(
  port: number,
  groupKey: string,
  version: string,
  log: vscode.OutputChannel,
  first?: WhoamiResult,
): Promise<PollResult> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let delay = POLL_INITIAL_MS;
  let who = first;
  for (;;) {
    if (!who) {
      who = await tryWhoami(port);
    }
    if (who.kind === 'ok') {
      return classify(who, groupKey, version, log);
    }
    if (Date.now() >= deadline) {
      return { kind: 'deadline' };
    }
    await sleep(jitter(delay));
    delay = Math.min(delay * 2, POLL_CAP_MS);
    who = undefined;
  }
}

// Spawn the server as a detached Node process. The port bind is the mutex; a
// duplicate spawn exits(0) on EADDRINUSE. stdout+stderr go to a per-port log
// so startup failures are diagnosable.
function spawnServer(
  serverJs: string,
  port: number,
  groupKey: string,
  idleTimeoutMs: number,
  version: string,
  log: vscode.OutputChannel,
): void {
  fs.mkdirSync(TAKESHICC_DIR, { recursive: true });
  const fd = fs.openSync(serverLogPath(port), 'a');
  try {
    const child = spawn(
      process.execPath,
      [serverJs, String(port), groupKey, String(idleTimeoutMs), version],
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

// Builds a ServerClient: a keep-alive agent plus a heartbeat interval that
// keeps the server from idle-exiting under a live client.
function makeClient(
  port: number,
  groupKey: string,
  idleTimeoutMs: number,
  log: vscode.OutputChannel,
): ServerClient {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const heartbeatMs = Math.floor(idleTimeoutMs / 3);
  const timer = setInterval(() => {
    const req = http.get({ host: HOST, port, path: ROUTES.ping, agent }, (res) => {
      res.resume();
    });
    req.on('error', (err) => {
      log.appendLine(`Takeshicc: heartbeat failed — ${errMsg(err)}`);
    });
  }, heartbeatMs);
  timer.unref();
  return {
    port,
    groupKey,
    close() {
      clearInterval(timer);
      agent.destroy();
    },
  };
}

type GroupResolution =
  | { kind: 'ok'; groupKey: string; group: ResolvedGroup }
  | { kind: 'no-folder' }
  | { kind: 'not-git' }
  | { kind: 'bad-config'; message: string }
  | { kind: 'not-configured'; groupKey: string };

// Workspace folder -> git group -> config lookup. Returns a reason the callers
// map to their own UI; resolveGitGroup logs the 'not-git' specifics itself.
async function resolveConfiguredGroup(log: vscode.OutputChannel): Promise<GroupResolution> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { kind: 'no-folder' };
  }
  const groupKey = await resolveGitGroup(folder.uri.fsPath, log);
  if (!groupKey) {
    return { kind: 'not-git' };
  }
  let group: ResolvedGroup | undefined;
  try {
    group = lookupGroup(groupKey);
  } catch (err) {
    return { kind: 'bad-config', message: errMsg(err) };
  }
  if (!group) {
    return { kind: 'not-configured', groupKey };
  }
  return { kind: 'ok', groupKey, group };
}

function reportBadConfig(message: string, log: vscode.OutputChannel): void {
  const line = `Takeshicc: invalid config at ${CONFIG_PATH} — ${message}`;
  vscode.window.showErrorMessage(line);
  log.appendLine(line);
}

function reportMismatch(port: number, otherGroup: string, groupKey: string): void {
  vscode.window.showErrorMessage(
    `Takeshicc: port ${port} is held by another process (group ` +
      `"${otherGroup}", expected "${groupKey}"). Fix ${CONFIG_PATH}.`,
  );
}

export async function getOrCreateServer(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<ServerClient | undefined> {
  log.appendLine('Takeshicc: resolving server...');

  const r = await resolveConfiguredGroup(log);
  if (r.kind === 'no-folder') {
    log.appendLine('Takeshicc: no workspace folder open — server feature off.');
    return undefined;
  }
  if (r.kind === 'not-git') {
    return undefined; // resolveGitGroup already logged the specific reason
  }
  if (r.kind === 'bad-config') {
    reportBadConfig(r.message, log);
    return undefined;
  }
  if (r.kind === 'not-configured') {
    log.appendLine(
      `Takeshicc: group "${r.groupKey}" not found in ${CONFIG_PATH} — server feature off. ` +
        `Add a "groups" entry for it to enable the server.`,
    );
    return undefined;
  }

  const { groupKey, group } = r;
  const { port, idleTimeoutMs } = group;
  log.appendLine(
    `Takeshicc: group "${groupKey}" -> port ${port}, idleTimeoutMs ${idleTimeoutMs}.`,
  );
  const version: string = context.extension.packageJSON.version ?? '0';
  const serverJs = context.asAbsolutePath('out/server.js');

  // Loop forever; each iteration surfaces its own error notification, and the
  // ~8 s poll deadline paces them.
  for (;;) {
    const who = await tryWhoami(port);

    // refused -> spawn, then poll a fresh probe. transient/ok -> feed the
    // sample straight into pollConnect (ok resolves immediately; transient
    // backs off without an extra redundant probe).
    let firstSample: WhoamiResult | undefined = who;
    if (who.kind === 'refused') {
      spawnServer(serverJs, port, groupKey, idleTimeoutMs, version, log);
      firstSample = undefined;
    } else if (who.kind === 'transient') {
      log.appendLine(`Takeshicc: /whoami transient (${who.reason}); polling.`);
    }

    const poll = await pollConnect(port, groupKey, version, log, firstSample);
    if (poll.kind === 'ready') {
      log.appendLine(`Takeshicc: connected to server on port ${port}.`);
      return makeClient(port, groupKey, idleTimeoutMs, log);
    }
    if (poll.kind === 'mismatch') {
      reportMismatch(port, poll.groupKey, groupKey);
      return undefined;
    }
    // Deadline exceeded — surface the server log and continue the loop.
    vscode.window.showErrorMessage(
      `Takeshicc: server on port ${port} did not become ready; ` +
        `see ${serverLogPath(port)}.`,
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
      `Takeshicc: "${r.groupKey}" is not in ${CONFIG_PATH} — no server log.`,
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
