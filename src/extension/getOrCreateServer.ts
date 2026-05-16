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
import {
  HistoricalChatMetadata,
  HOST,
  LiveChatMetadata,
  ROUTES,
} from '../server/protocol';
import { CONFIG_PATH, lookupGroup, ResolvedGroup } from './config';
import { resolveGitGroup } from './gitGroup';
import { registerHooks } from './registerHooks';

const WHOAMI_TIMEOUT_MS = 1_000;
const POLL_INITIAL_MS = 50;
const POLL_CAP_MS = 500;
const POLL_DEADLINE_MS = 8_000;

export interface ServerClient {
  port: number;
  groupKey: string;
  // Subscribe to pushed live-chat snapshots from the server's /events SSE
  // stream. onUpdate fires with the full snapshot on connect and on every
  // change; the stream reconnects on its own and is torn down by close().
  subscribeLiveChats(onUpdate: (chats: LiveChatMetadata[]) => void): void;
  // Fetch the past (non-live) chats for `dir` — a one-shot read of
  // GET /get-historical-chats. Rejects on any transport or server error.
  getHistoricalChats(dir: string): Promise<HistoricalChatMetadata[]>;
  close(): void;
}

const SSE_RECONNECT_MIN_MS = 500;
const SSE_RECONNECT_MAX_MS = 5_000;

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
    log.appendLine(
      `Takeshicc: spawned server (pid ${child.pid ?? '?'}) on port ${port}.`,
    );
  } finally {
    fs.closeSync(fd); // the child holds its own dup of the fd
  }
}

// A reconnecting Server-Sent Events subscription to the server's
// /subscribe-live-chats stream. The server pushes the full live-chat snapshot
// on connect and on every change; each event is parsed and handed to onUpdate.
// A dropped connection is retried with jittered exponential backoff. It uses
// its own connection — never the client's single-socket keep-alive agent,
// which this long-lived stream would otherwise monopolize.
function streamLiveChats(
  port: number,
  onUpdate: (chats: LiveChatMetadata[]) => void,
  log: vscode.OutputChannel,
): { close(): void } {
  let closed = false;
  let req: http.ClientRequest | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let delay = SSE_RECONNECT_MIN_MS;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, jitter(delay));
    delay = Math.min(delay * 2, SSE_RECONNECT_MAX_MS);
  };

  const connect = () => {
    if (closed) {
      return;
    }
    let buffer = '';
    let ended = false;
    // Reconnect at most once per connection attempt, whichever end fires first.
    const finish = () => {
      if (!ended) {
        ended = true;
        scheduleReconnect();
      }
    };

    req = http.get(
      {
        host: HOST,
        port,
        path: ROUTES.subscribeLiveChats,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish();
          return;
        }
        delay = SSE_RECONNECT_MIN_MS; // a healthy connection resets the backoff
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          // SSE events are separated by a blank line.
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = event
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (!data) {
              continue;
            }
            try {
              onUpdate(JSON.parse(data) as LiveChatMetadata[]);
            } catch {
              log.appendLine(
                'Takeshicc: ignored an unparseable /events message.',
              );
            }
          }
        });
        res.on('end', finish);
        res.on('error', finish);
      },
    );
    req.on('error', (err) => {
      if (!closed) {
        log.appendLine(
          `Takeshicc: /events stream error — ${(err as Error).message}; reconnecting.`,
        );
      }
      finish();
    });
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      req?.destroy();
    },
  };
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
    const req = http.get(
      { host: HOST, port, path: ROUTES.ping, agent },
      (res) => {
        res.resume();
      },
    );
    req.on('error', (err) => {
      log.appendLine(`Takeshicc: heartbeat failed — ${(err as Error).message}`);
    });
  }, heartbeatMs);
  timer.unref();

  let sse: { close(): void } | undefined;
  return {
    port,
    groupKey,
    subscribeLiveChats(onUpdate) {
      sse?.close(); // a second call replaces the prior subscription
      sse = streamLiveChats(port, onUpdate, log);
    },
    getHistoricalChats(dir) {
      return new Promise<HistoricalChatMetadata[]>((resolve, reject) => {
        const path = `${ROUTES.getHistoricalChats}?dir=${encodeURIComponent(dir)}`;
        const req = http.get({ host: HOST, port, path, agent }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              reject(new Error(`status ${res.statusCode}: ${text}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as HistoricalChatMetadata[]);
            } catch {
              reject(new Error('unparseable /get-historical-chats body'));
            }
          });
        });
        req.on('error', reject);
      });
    },
    close() {
      clearInterval(timer);
      agent.destroy();
      sse?.close();
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

  // Connecting also registers the server's Claude Code hooks for this
  // workspace. registerHooks is fire-and-forget — it must never block or fail
  // the connect, so it is not awaited and swallows its own errors.
  const outDir = context.asAbsolutePath('out');
  const connect = (): ServerClient => {
    void registerHooks(folder.uri.fsPath, port, outDir, log);
    return makeClient(port, groupKey, idleTimeoutMs, log);
  };

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
        return connect();
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
      return connect();
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

// Resolves the configured server port for the current workspace's git group:
// folder -> groupKey -> config group -> port. Surfaces a user-facing
// notification on every failure path and returns undefined — there is simply
// no server configured for this repo. Shared by the openServerLog and
// copyServerKillCommand handlers, which both need exactly this resolution.
async function resolveConfiguredPort(
  log: vscode.OutputChannel,
): Promise<number | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showInformationMessage('Takeshicc: no workspace folder open.');
    return undefined;
  }

  const groupKey = await resolveGitGroup(folder.uri.fsPath, log);
  if (!groupKey) {
    vscode.window.showInformationMessage(
      'Takeshicc: workspace is not a git repository — no server configured.',
    );
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
    return undefined;
  }
  if (!group) {
    vscode.window.showInformationMessage(
      `Takeshicc: "${groupKey}" is not in ${CONFIG_PATH} — no server configured.`,
    );
    return undefined;
  }
  return group.port;
}

// Command handler: opens the per-port server log for the current workspace's
// configured group, or explains why there is none.
export async function openServerLog(log: vscode.OutputChannel): Promise<void> {
  const port = await resolveConfiguredPort(log);
  if (port === undefined) {
    return;
  }

  const logPath = serverLogPath(port);
  if (!fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(
      `Takeshicc: no server log at ${logPath} yet — the server has not been spawned.`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc);
}

// Command handler: copies a shell one-liner that kills this repo's server to
// the clipboard — for fast dev iteration. The server is a long-lived detached
// process; after rebuilding it the old one keeps serving stale code until it
// idle-exits, so paste this into a terminal to drop it and let the next
// connect spawn the fresh build. Kills by port: the port is the worktree-
// independent identity (every worktree of the repo shares one server), so this
// works whichever worktree the command is run from.
export async function copyServerKillCommand(
  log: vscode.OutputChannel,
): Promise<void> {
  const port = await resolveConfiguredPort(log);
  if (port === undefined) {
    return;
  }

  const cmd =
    process.platform === 'win32'
      ? `Get-NetTCPConnection -LocalPort ${port} -State Listen ` +
        `-ErrorAction SilentlyContinue | ` +
        `% { Stop-Process -Id $_.OwningProcess -Force }`
      : `lsof -ti tcp:${port} | xargs kill`;

  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(
    `Takeshicc: server kill command (port ${port}) copied to clipboard.`,
  );
}
