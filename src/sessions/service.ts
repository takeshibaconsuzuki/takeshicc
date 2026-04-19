import { listSessions, getSessionInfo, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

export class SessionService {
  private cache: SDKSessionInfo[] = [];
  private lastFetch = 0;
  private readonly CACHE_MS = 5_000;

  constructor(private readonly dir: string | undefined) {}

  async list(force = false): Promise<SDKSessionInfo[]> {
    const now = Date.now();
    if (!force && now - this.lastFetch < this.CACHE_MS) return this.cache;
    try {
      this.cache = await listSessions({ dir: this.dir, limit: 100 });
      this.lastFetch = now;
    } catch {
      // Missing ~/.claude, permission error, etc. — treat as empty.
      this.cache = [];
      this.lastFetch = now;
    }
    return this.cache;
  }

  async getInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
    try {
      return await getSessionInfo(sessionId, { dir: this.dir });
    } catch {
      return undefined;
    }
  }
}
