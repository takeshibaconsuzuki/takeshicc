import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'Notification'
  | 'Stop'
  | 'StopFailure'
  | 'SessionEnd';

export interface HookEvent {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: HookEventName | string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  notification_type?: string;
  reason?: string;
}

export interface HookServerConfig {
  port: number;
  token: string;
}

export const TOKEN_HEADER = 'x-takeshicc-token';

/**
 * Loopback-only HTTP server that receives hook POSTs from Claude Code. Binds
 * to 127.0.0.1 on an OS-assigned port; rejects requests without the per-activation
 * token so other processes on the box can't spoof session state.
 */
export class HookServer implements vscode.Disposable {
  private readonly server: http.Server;
  private readonly _token = crypto.randomBytes(32).toString('hex');
  private readonly portPromise: Promise<number>;
  private readonly emitter = new vscode.EventEmitter<HookEvent>();
  readonly onEvent = this.emitter.event;
  private disposed = false;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.portPromise = new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('server.address() returned unexpected value'));
      });
    });
  }

  async getConfig(): Promise<HookServerConfig> {
    return { port: await this.portPromise, token: this._token };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const supplied = req.headers[TOKEN_HEADER];
    if (supplied !== this._token) {
      res.statusCode = 401;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(body) as unknown;
        if (isHookEvent(parsed) && !this.disposed) {
          this.emitter.fire(parsed);
        }
      } catch {
        // Invalid JSON — swallow so we always respond 200 and never block claude.
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 200;
        res.end('{}');
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.server.close();
    this.emitter.dispose();
  }
}

function isHookEvent(x: unknown): x is HookEvent {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as HookEvent).session_id === 'string' &&
    typeof (x as HookEvent).hook_event_name === 'string'
  );
}
