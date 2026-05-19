const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// A live SSE subscription's minimal shape (see ServerClient.EventStream):
// `done` settles when the stream ends/errors, `stop()` tears it down.
interface Stream {
  stop(): void;
  done: Promise<void>;
}

// A self-healing SSE subscription. `open` connects (returning undefined when
// the server client isn't ready yet); whenever the stream ends or errors it
// reconnects with exponential backoff, reset on the first frame of a healthy
// connection, until `stop()`. Reusable across stop/start cycles. One copy of
// the loop the worktrees view, live-chats view, and command stream each
// previously hand-rolled.
export class ReconnectingStream<T> {
  private stream?: Stream;
  private timer?: NodeJS.Timeout;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly open: (onMessage: (message: T) => void) => Stream | undefined,
    private readonly onMessage: (message: T) => void,
    private readonly baseMs: number = RECONNECT_BASE_MS,
    private readonly maxMs: number = RECONNECT_MAX_MS,
  ) {}

  public start(): void {
    this.stopped = false;
    this.ensure();
  }

  public stop(): void {
    this.stopped = true;
    this.stream?.stop();
    this.stream = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private ensure(): void {
    if (this.stopped || this.stream) {
      return;
    }
    const handle = this.open((message) => {
      // Any frame proves a healthy connection — reset the backoff.
      this.attempts = 0;
      this.onMessage(message);
    });
    if (!handle) {
      this.scheduleReconnect();
      return;
    }
    this.stream = handle;
    handle.done
      .catch(() => undefined)
      .finally(() => {
        if (this.stream === handle) {
          this.stream = undefined;
        }
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) {
      return;
    }
    const delay = Math.min(this.baseMs * 2 ** this.attempts, this.maxMs);
    this.attempts++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ensure();
    }, delay);
    this.timer.unref?.();
  }
}
