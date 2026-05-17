// Atomic getOrCreate for the per-repo HTTP server.
//
// Runs once on activation. Resolves the git group, looks it up in the config,
// then loops forever converging on a single shared server: probe /whoami,
// spawn a detached server process if none answers, poll until it is ready.
// The OS port bind is the mutex — duplicate spawns are harmless.

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { HOST, ROUTES } from '../server/protocol';
import { CONFIG_PATH, lookupGroup, ResolvedGroup } from '../common/config';
import { resolveGitGroup } from '../common/gitGroup';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ±25% jitter on a backoff delay.
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function serverLogPath(port: number): string {
  return path.join(os.homedir(), '.takeshicc', `server-${port}.log`);
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

// Poll /whoami with jittered exponential backoff until it matches our group
// or the per-attempt deadline passes.
async function pollConnect(
  port: number,
  groupKey: string,
  version: string,
  log: vscode.OutputChannel,
): Promise<PollResult> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let delay = POLL_INITIAL_MS;
  for (;;) {
    const who = await tryWhoami(port);
    if (who.kind === 'ok') {
      if (who.groupKey === groupKey) {
        if (who.version !== version) {
          log.appendLine(
            `Takeshicc: connected to a stale server (server ${who.version}, ` +
              `extension ${version}); it will be replaced after it idle-exits.`,
          );
        }
        return { kind: 'ready' };
      }
      return { kind: 'mismatch', groupKey: who.groupKey };
    }
    if (Date.now() >= deadline) {
      return { kind: 'deadline' };
    }
    await sleep(jitter(delay));
    delay = Math.min(delay * 2, POLL_CAP_MS);
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
  const logPath = serverLogPath(port);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
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
      log.appendLine(`Takeshicc: heartbeat failed — ${(err as Error).message}`);
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

export async function getOrCreateServer(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<ServerClient | undefined> {
  log.appendLine('Takeshicc: resolving server...');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log.appendLine('Takeshicc: no workspace folder open — server feature off.');
    return undefined;
  }

  const groupKey = await resolveGitGroup(folder.uri.fsPath, log);
  if (!groupKey) {
    // resolveGitGroup has already logged the specific reason.
    return undefined;
  }

  let group: ResolvedGroup | undefined;
  try {
    group = lookupGroup(groupKey);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Takeshicc: invalid config at ${CONFIG_PATH} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    log.appendLine(
      `Takeshicc: invalid config at ${CONFIG_PATH} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (!group) {
    // Repo not configured — normal "feature off" state, no notification.
    log.appendLine(
      `Takeshicc: group "${groupKey}" not found in ${CONFIG_PATH} — server feature off. ` +
        `Add a "groups" entry for it to enable the server.`,
    );
    return undefined;
  }

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

    if (who.kind === 'ok') {
      if (who.groupKey === groupKey) {
        if (who.version !== version) {
          log.appendLine(
            `Takeshicc: connected to a stale server (server ${who.version}, ` +
              `extension ${version}); it will be replaced after it idle-exits.`,
          );
        }
        log.appendLine(`Takeshicc: connected to server on port ${port}.`);
        return makeClient(port, groupKey, idleTimeoutMs, log);
      }
      // Port owned by an unrelated process — config error: do not spawn, do
      // not loop.
      vscode.window.showErrorMessage(
        `Takeshicc: port ${port} is held by another process (group ` +
          `"${who.groupKey}", expected "${groupKey}"). Fix ${CONFIG_PATH}.`,
      );
      return undefined;
    }

    if (who.kind === 'refused') {
      spawnServer(serverJs, port, groupKey, idleTimeoutMs, version, log);
    } else {
      log.appendLine(`Takeshicc: /whoami transient (${who.reason}); polling.`);
    }

    const poll = await pollConnect(port, groupKey, version, log);
    if (poll.kind === 'ready') {
      log.appendLine(`Takeshicc: connected to server on port ${port}.`);
      return makeClient(port, groupKey, idleTimeoutMs, log);
    }
    if (poll.kind === 'mismatch') {
      vscode.window.showErrorMessage(
        `Takeshicc: port ${port} is held by another process (group ` +
          `"${poll.groupKey}", expected "${groupKey}"). Fix ${CONFIG_PATH}.`,
      );
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
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showInformationMessage('Takeshicc: no workspace folder open.');
    return;
  }

  const groupKey = await resolveGitGroup(folder.uri.fsPath, log);
  if (!groupKey) {
    vscode.window.showInformationMessage(
      'Takeshicc: workspace is not a git repository — no server log.',
    );
    return;
  }

  let group: ResolvedGroup | undefined;
  try {
    group = lookupGroup(groupKey);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Takeshicc: invalid config at ${CONFIG_PATH} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!group) {
    vscode.window.showInformationMessage(
      `Takeshicc: "${groupKey}" is not in ${CONFIG_PATH} — no server log.`,
    );
    return;
  }

  const logPath = serverLogPath(group.port);
  if (!fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(
      `Takeshicc: no server log at ${logPath} yet — the server has not been spawned.`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc);
}
