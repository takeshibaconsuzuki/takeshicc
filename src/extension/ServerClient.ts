import * as http from 'http';
import * as vscode from 'vscode';
import {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  HOST,
  InstanceEventsMessage,
  ROUTES,
  WorktreeJobsMessage,
} from '../common/protocol';
import { lineSplitter } from '../common/lineSplitter';
import { errMsg } from '../common/errMsg';

const HEARTBEAT_TIMEOUT_MS = 1_000;
const CREATE_WORKTREE_TIMEOUT_MS = 5_000;

// Contract: implementations must clean up before invoking this callback.
export type DeadConnectionHandler = (reason: string) => void;

// Handle to a live SSE subscription: `done` settles when the stream
// ends (resolve) or errors (reject); `stop()` tears it down.
export interface EventStream {
  stop(): void;
  done: Promise<void>;
}

export type InstanceEventsStream = EventStream;
export type WorktreeJobsStream = EventStream;

// A keep-alive client plus heartbeat loop that keeps the server from
// idle-exiting under a live extension window.
export class ServerClient {
  public readonly port: number;
  public readonly groupId: string;

  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  private readonly pingPath: string;
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private failedSinceMs: number | undefined;

  constructor(
    port: number,
    groupId: string,
    private readonly idleTimeoutMs: number,
    instanceId: string,
    private readonly log: vscode.OutputChannel,
    private readonly onDeadConnection: DeadConnectionHandler,
  ) {
    this.port = port;
    this.groupId = groupId;
    this.pingPath = `${ROUTES.ping}?instanceId=${encodeURIComponent(instanceId)}`;

    const heartbeatMs = Math.floor(this.idleTimeoutMs / 3);
    this.timer = setInterval(() => {
      this.heartbeat();
    }, heartbeatMs);
    this.timer.unref();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.timer);
    this.agent.destroy();
  }

  // One HTTP round-trip that collects the body and JSON-parses it. A non-JSON
  // body (proxy error page, empty) yields {} so the caller can fall back to
  // statusCode rather than surfacing a confusing parse error.
  private requestJson<T>(
    options: http.RequestOptions,
    init?: { payload?: string; timeoutMs?: number },
  ): Promise<{ statusCode: number; parsed: Partial<T> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Partial<T> = {};
          try {
            if (text) {
              parsed = JSON.parse(text) as Partial<T>;
            }
          } catch {
            // Leave parsed = {}; caller decides based on statusCode.
          }
          resolve({ statusCode, parsed });
        });
      });
      if (init?.timeoutMs !== undefined) {
        req.setTimeout(init.timeoutMs, () => {
          req.destroy(new Error('request timeout'));
        });
      }
      req.on('error', reject);
      req.end(init?.payload);
    });
  }

  // Starts a background worktree-create job and returns its id. The actual
  // work (git + bootstrap) runs server-side and outlives this request, so
  // this is a quick call that can share the keep-alive agent.
  public async createWorktree(request: CreateWorktreeRequest): Promise<string> {
    const payload = JSON.stringify(request);
    const { statusCode, parsed } = await this.requestJson<CreateWorktreeResponse>(
      {
        host: HOST,
        port: this.port,
        path: ROUTES.createWorktree,
        method: 'POST',
        agent: this.agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      { payload, timeoutMs: CREATE_WORKTREE_TIMEOUT_MS },
    );
    if (statusCode >= 200 && statusCode < 300 && typeof parsed.jobId === 'string') {
      return parsed.jobId;
    }
    throw new Error(parsed.error || `status ${statusCode}`);
  }

  // Subscribes to the server's instance-registry stream: `onMessage` gets one
  // `snapshot` then a delta per registry change.
  public streamInstanceEvents(
    onMessage: (message: InstanceEventsMessage) => void,
  ): InstanceEventsStream {
    return this.streamJson(ROUTES.instanceEvents, onMessage);
  }

  // Subscribes to the server's active-jobs stream: `onMessage` gets one
  // `snapshot` then an `event` per job event, for as long as the connection
  // lives. It never settles on a job's terminal event — the stream spans all
  // jobs. `done` resolves when the stream ends and rejects on a connection
  // error; `stop()` tears it down (caller reconnects / disposes). Uses a
  // dedicated connection (agent: false) with no timeout — it stays open
  // indefinitely, so it must not borrow the shared maxSockets:1 heartbeat
  // agent.
  public streamWorktreeJobs(onMessage: (message: WorktreeJobsMessage) => void): WorktreeJobsStream {
    return this.streamJson(ROUTES.worktreeJobs, onMessage);
  }

  private streamJson<T>(path: string, onMessage: (message: T) => void): EventStream {
    let request: http.ClientRequest | undefined;
    const done = new Promise<void>((resolve, reject) => {
      request = http.get(
        {
          host: HOST,
          port: this.port,
          path,
          agent: false,
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            res.resume();
            reject(new Error(`status ${statusCode}`));
            return;
          }
          const splitter = lineSplitter((line) => {
            if (!line.startsWith('data:')) {
              return;
            }
            try {
              onMessage(JSON.parse(line.slice(line.indexOf(':') + 1)) as T);
            } catch {
              // Ignore a malformed frame; the stream stays usable.
            }
          });
          res.on('data', (chunk: Buffer) => splitter.write(chunk));
          res.on('end', () => {
            splitter.flush();
            resolve();
          });
          res.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    return { stop: () => request?.destroy(), done };
  }

  private markFailed(reason: string): void {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    this.failedSinceMs ??= now;
    const failedForMs = now - this.failedSinceMs;
    this.log.appendLine(
      `Takeshicc: heartbeat failed (${failedForMs}ms/${this.idleTimeoutMs}ms) — ${reason}`,
    );
    if (failedForMs >= this.idleTimeoutMs) {
      this.close();
      this.onDeadConnection(reason);
    }
  }

  private heartbeat(): void {
    if (this.closed) {
      return;
    }
    const req = http.get(
      { host: HOST, port: this.port, path: this.pingPath, agent: this.agent },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        res.on('end', () => {
          if (this.closed) {
            return;
          }
          if (statusCode >= 200 && statusCode < 300) {
            this.failedSinceMs = undefined;
          } else {
            this.markFailed(`ping status ${statusCode}`);
          }
        });
        res.resume();
      },
    );
    req.setTimeout(HEARTBEAT_TIMEOUT_MS, () => {
      req.destroy(new Error('heartbeat timeout'));
    });
    req.on('error', (err) => {
      this.markFailed(errMsg(err));
    });
  }
}
