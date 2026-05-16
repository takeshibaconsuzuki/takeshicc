// Client side of the shared server.
//
// Each VS Code window calls `start()` on activation and `dispose()` on
// deactivation. The first window to find no running server spawns one
// (detached, so it outlives this window); every window then holds an open
// socket for its lifetime. If the server dies, the socket closes and we
// transparently respawn/reconnect.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 1000;

/** Stable, per-user, per-version address for the shared server. */
function pipePathFor(version: string): string {
  const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9]/g, '_');
  const name = `takeshicc-${version}-${user}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect to the shared server AND wait for its `ready` handshake. Resolving
 * on the raw TCP/pipe `connect` event is not enough: a connection can be
 * accepted by the OS into a server that exits a moment later. The server
 * sends `ready` only after it has incremented its refcount, so a socket that
 * delivers `ready` is backed by a server that cannot exit until we disconnect.
 * Anything short of that (reset, close, timeout) is treated as "no server".
 */
function connectAndHandshake(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let settled = false;

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const onClose = () => fail(new Error('closed before handshake'));
    const timer = setTimeout(() => fail(new Error('handshake timed out')), HANDSHAKE_TIMEOUT_MS);

    socket.once('error', fail);
    socket.once('close', onClose);
    socket.once('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      if (chunk.toString('utf8').startsWith('ready')) {
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', fail);
        socket.removeListener('close', onClose);
        resolve(socket);
      } else {
        fail(new Error('unexpected handshake payload'));
      }
    });
  });
}

export class SharedServerConnection {
  private socket: net.Socket | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {}

  async start(): Promise<void> {
    await this.connect();
  }

  /** Connect to the shared server, spawning one if none is running. */
  private async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const version: string = this.context.extension.packageJSON.version ?? '0';
    const pipePath = pipePathFor(version);

    try {
      const socket = await this.connectOrSpawn(pipePath, version);
      if (this.disposed) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      this.log.appendLine('Connected to shared server.');
      socket.once('close', () => {
        this.socket = undefined;
        if (!this.disposed) {
          // Server went away — respawn and reconnect.
          this.log.appendLine('Lost shared server; reconnecting...');
          setTimeout(() => void this.connect(), RECONNECT_DELAY_MS);
        }
      });
    } catch (err) {
      this.log.appendLine(`Could not reach shared server: ${err}`);
      if (!this.disposed) {
        setTimeout(() => void this.connect(), RECONNECT_DELAY_MS);
      }
    }
  }

  private async connectOrSpawn(pipePath: string, version: string): Promise<net.Socket> {
    // Fast path: a server is already running.
    try {
      return await connectAndHandshake(pipePath);
    } catch {
      // None yet — spawn one below.
    }

    this.spawnServer(pipePath);
    this.log.appendLine('No shared server found; spawned one.');

    // Retry while the server boots. If a racing window won, we connect to
    // its server instead and our own spawned process exits on EADDRINUSE.
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let delay = 50;
    while (Date.now() < deadline) {
      await sleep(delay);
      try {
        return await connectAndHandshake(pipePath);
      } catch {
        delay = Math.min(delay * 2, 500);
      }
    }
    throw new Error('timed out starting the shared server');
  }

  private spawnServer(pipePath: string): void {
    const serverJs = this.context.asAbsolutePath(path.join('out', 'server.js'));
    if (process.platform === 'win32') {
      this.spawnServerWindows(serverJs, pipePath);
    } else {
      // POSIX has no Job Objects: a detached, unref'd child genuinely
      // outlives the parent. process.execPath is VS Code's Electron binary;
      // ELECTRON_RUN_AS_NODE makes it behave as a plain Node runtime.
      const child = spawn(process.execPath, [serverJs, pipePath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.unref();
    }
  }

  /**
   * Spawn the server so it survives this window closing.
   *
   * A child created by `spawn` belongs to VS Code's Job Object and is killed
   * the moment this extension host shuts down — `detached` does not escape a
   * Job Object. So we don't create the server ourselves: we ask the WMI
   * service to create it via Win32_Process.Create. The new process is
   * parented under the WMI service host, outside our job, and survives.
   *
   * Layers, outermost first:
   *  - powershell (short-lived, may be in our job — only needs to issue the
   *    CIM call) delivered via -EncodedCommand to avoid all shell quoting.
   *  - cmd.exe wrapper: injects ELECTRON_RUN_AS_NODE, which a WMI-created
   *    process does NOT inherit from us. cmd /s strips only the outer quotes.
   *  - Electron-as-Node running out/server.js.
   */
  private spawnServerWindows(serverJs: string, pipePath: string): void {
    const cmdLine =
      'cmd.exe /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ' +
      `"${process.execPath}" "${serverJs}" "${pipePath}""`;
    // Escape for embedding in a PowerShell single-quoted string.
    const psQuoted = cmdLine.replace(/'/g, "''");
    // Win32_Process.Create gives a console-subsystem process (cmd.exe) a
    // visible console window by default. Pass a Win32_ProcessStartup with
    // ShowWindow = SW_HIDE (0) so the long-lived wrapper starts hidden.
    const ps =
      "$ErrorActionPreference='Stop';" +
      '$si=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly ' +
      '-Property @{ShowWindow=[uint16]0};' +
      'Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      `-Arguments @{CommandLine='${psQuoted}';ProcessStartupInformation=$si}` +
      ' | Out-Null';
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  }

  dispose(): void {
    this.disposed = true;
    // Graceful close so the server sees a clean disconnect and decrements
    // its refcount immediately.
    this.socket?.end();
    this.socket = undefined;
  }
}
