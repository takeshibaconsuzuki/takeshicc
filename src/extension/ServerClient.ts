import * as http from 'http';
import * as vscode from 'vscode';
import { HOST, ROUTES } from '../common/protocol';
import { errMsg } from '../common/errMsg';

const HEARTBEAT_TIMEOUT_MS = 1_000;
const HEARTBEAT_FAILURES_BEFORE_RECONNECT = 2;

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
  private failures = 0;

  constructor(
    port: number,
    groupId: string,
    idleTimeoutMs: number,
    instanceId: string,
    private readonly log: vscode.OutputChannel,
    private readonly onDeadConnection: DeadConnectionHandler,
  ) {
    this.port = port;
    this.groupId = groupId;
    this.pingPath = `${ROUTES.ping}?instanceId=${encodeURIComponent(instanceId)}`;

    const heartbeatMs = Math.floor(idleTimeoutMs / 3);
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

  private markFailed(reason: string): void {
    if (this.closed) {
      return;
    }
    this.failures += 1;
    this.log.appendLine(
      `Takeshicc: heartbeat failed (${this.failures}/${HEARTBEAT_FAILURES_BEFORE_RECONNECT}) — ${reason}`,
    );
    if (this.failures >= HEARTBEAT_FAILURES_BEFORE_RECONNECT) {
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
            this.failures = 0;
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
