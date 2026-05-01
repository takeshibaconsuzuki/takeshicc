import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ContextFactory } from './context';
import { registerContextTools } from './contextTools';

export const MCP_TOKEN_HEADER = 'x-takeshicc-mcp-token';
export const MCP_PATH = '/mcp';
export const MCP_SOURCE_TAG = 'source=takeshicc';

export interface McpServerConfig {
  port: number;
  token: string;
}

/**
 * Loopback-only HTTP MCP endpoint backed by the official @modelcontextprotocol/sdk.
 * Uses StreamableHTTPServerTransport in stateless mode: a fresh McpServer + transport
 * are constructed per request, since stateless transports cannot be reused across
 * requests without risking message-id collisions (per SDK guidance).
 *
 * A per-activation random token gates incoming requests so other processes on the
 * box can't reach the endpoint. Claude Code is configured with the token via
 * ~/.claude.json (see ./settings.ts).
 */
export class McpHttpServer implements vscode.Disposable {
  private readonly httpServer: http.Server;
  private readonly _token = crypto.randomBytes(32).toString('hex');
  private readonly portPromise: Promise<number>;
  private readonly contextFactory: ContextFactory;
  private disposed = false;

  constructor() {
    this.contextFactory = new ContextFactory();
    this.httpServer = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.portPromise = new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.httpServer.off('error', onError);
        const addr = this.httpServer.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('server.address() returned unexpected value'));
      });
    });
  }

  async getConfig(): Promise<McpServerConfig> {
    return { port: await this.portPromise, token: this._token };
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (this.disposed) {
      res.statusCode = 503;
      res.end();
      return;
    }

    const url = req.url ?? '';
    if (!url.startsWith(MCP_PATH)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const supplied = req.headers[MCP_TOKEN_HEADER];
    if (supplied !== this._token) {
      res.statusCode = 401;
      res.end();
      return;
    }

    const server = buildMcpServer(this.contextFactory);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: (err as Error).message },
            id: null,
          })
        );
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.httpServer.close();
    this.contextFactory.dispose();
  }
}

/**
 * Construct a fresh McpServer with the takeshicc tool surface. Called per request
 * because stateless transports must not be reused.
 */
function buildMcpServer(contextFactory: ContextFactory): McpServer {
  const server = new McpServer({
    name: 'takeshicc',
    version: '0.0.1',
  });

  registerContextTools(server, contextFactory);

  return server;
}
