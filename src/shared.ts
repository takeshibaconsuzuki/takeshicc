// Constants shared between the extension (vscode context) and the standalone
// server (plain Node). This module must stay dependency-free.

/** Loopback TCP port the server listens on for Claude Code hook events. */
export const HOOK_HTTP_PORT = 48291;
