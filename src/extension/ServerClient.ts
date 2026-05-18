import * as http from 'http';
import * as vscode from 'vscode';
import { HOST, InstancesResponse, ROUTES } from '../common/protocol';
import { errMsg } from '../common/errMsg';

const HEARTBEAT_TIMEOUT_MS = 1_000;
const INSTANCES_TIMEOUT_MS = 1_000;

// Contract: implementations must clean up before invoking this callback.
export type DeadConnectionHandler = (reason: string) => void;

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

  // Live instances registered with this server. Used by the worktrees view to
  // mark which worktrees have an open window.
  public instances(): Promise<InstancesResponse> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: HOST, port: this.port, path: ROUTES.instances, agent: this.agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`status ${statusCode}`));
              return;
            }
            try {
              const parsed = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              ) as Partial<InstancesResponse>;
              resolve({
                instances: Array.isArray(parsed.instances)
                  ? parsed.instances.filter(
                      (item): item is { groupId: string; worktreePath: string } =>
                        typeof item?.groupId === 'string' && typeof item.worktreePath === 'string',
                    )
                  : [],
              });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.setTimeout(INSTANCES_TIMEOUT_MS, () => {
        req.destroy(new Error('instances timeout'));
      });
      req.on('error', reject);
    });
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
