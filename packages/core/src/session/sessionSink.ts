// Additive, OPTIONAL write-through mirror of the JSONL event log to an external
// sink. The canonical JSONL append stays the single writer; the sink receives
// each line only after the local append resolves. Fail-soft is enforced here:
// lines buffer in a bounded background-drained queue (oldest dropped when full),
// sink errors are swallowed, and the canonical write is never blocked or gated.

/** An external mirror for session JSONL lines. Implementations typically ship
 * from a plugin (e.g. an S3/OSS/NAS writer). All methods may be async. */
export interface SessionEventSink {
  /** Mirror one already-persisted JSONL line (no trailing newline) for the
   * given session. Called AFTER the canonical append resolves. */
  write(sessionId: string, line: string): Promise<void> | void;
  /** Optional: flush any buffered writes (best-effort). */
  flush?(sessionId: string): Promise<void> | void;
  /** Optional: release resources when the session disposes. */
  close?(): Promise<void> | void;
}

/** Options for {@link BoundedSinkQueue}. */
export interface BoundedSinkQueueOptions {
  /** Max pending lines before the oldest is dropped. Default 1000. */
  maxQueue?: number;
  /** Called (fail-soft) when the sink throws or a line is dropped. */
  onError?: (err: Error) => void;
}

/**
 * Wraps a {@link SessionEventSink} with a bounded queue and a single-flight
 * background drain, so enqueueing is synchronous and non-blocking and a slow
 * or throwing sink can never stall or crash the canonical write path.
 */
export class BoundedSinkQueue {
  private readonly sink: SessionEventSink;
  private readonly maxQueue: number;
  private readonly onError?: (err: Error) => void;
  private queue: Array<{ sessionId: string; line: string }> = [];
  private draining = false;
  private closed = false;
  /** Count of lines dropped because the queue was full (observability). */
  dropped = 0;

  constructor(sink: SessionEventSink, opts: BoundedSinkQueueOptions = {}) {
    this.sink = sink;
    this.maxQueue = Math.max(1, opts.maxQueue ?? 1000);
    this.onError = opts.onError;
  }

  /** Enqueue a line for mirroring. Synchronous, never throws, never blocks. */
  enqueue(sessionId: string, line: string): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      // Drop the oldest to bound memory; a mirror is best-effort.
      this.queue.shift();
      this.dropped++;
      this.reportError(new Error(`session sink queue full — dropped a line (total dropped: ${this.dropped})`));
    }
    this.queue.push({ sessionId, line });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.sink.write(item.sessionId, item.line);
        } catch (err) {
          this.reportError(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Drain the queue, then flush the sink. Best-effort; never throws. */
  async flush(sessionId: string): Promise<void> {
    await this.drain();
    try {
      await this.sink.flush?.(sessionId);
    } catch (err) {
      this.reportError(err as Error);
    }
  }

  /** Drain + flush-all + close the sink. Best-effort; never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.drain();
    try {
      await this.sink.close?.();
    } catch (err) {
      this.reportError(err as Error);
    }
  }

  private reportError(err: Error): void {
    try {
      this.onError?.(err);
    } catch {
      /* an onError that throws must not re-enter the failure path */
    }
  }
}
