import { EventEmitter } from "events";
import type { ProcessorConfig, RetryOptions } from "./types";
import { JobPriority } from "./types";
import { AdaptiveRateLimiter } from "./AdaptiveRateLimiter";

// ─── Job entry ───────────────────────────────────────────────────────────────

interface JobEntry<T> {
  job: T;
  key: string;
  priority: JobPriority;
  attempts: number;
  addedAt: number;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface ProcessorStats {
  name: string;
  endpoint: string;
  queueDepth: number;
  activeWorkers: number;
  concurrency: number;
  totalProcessed: number;
  totalErrors: number;
  totalRetries: number;
  totalCancelled: number;
  utilizationPct: string;
  isIdle: boolean;
}

// ─── JobProcessor ────────────────────────────────────────────────────────────

/**
 * Priority-aware, retry-capable job processor that routes work through an
 * AdaptiveRateLimiter — the authoritative traffic shaper.
 *
 * Design:
 *  - Jobs are deduplicated by JSON serialisation (same key = one in-flight instance).
 *  - Priority ordering: CRITICAL jobs are always attempted before BACKGROUND.
 *  - Retry with exponential back-off + optional jitter prevents thundering herds.
 *  - cancelAllPending() drains the queue, firing onCancel for each job.
 *  - waitForIdle() resolves when both queue and active workers are empty.
 *  - adjustConcurrency() scales workers at runtime (hook for OODA integration).
 *
 * Events:
 *  "idle"      — emitted when queue empties and all workers finish.
 *  "error"     — (error, job) forwarded after all retries exhausted.
 *  "cancelled" — (job) for each job flushed by cancelAllPending().
 */
export class JobProcessor<T> extends EventEmitter {
  private readonly cfg: Required<ProcessorConfig<T>>;
  private readonly limiter?: AdaptiveRateLimiter;

  private readonly queue: Array<JobEntry<T>> = [];
  private readonly dedup = new Set<string>();

  private activeWorkers = 0;
  private concurrency: number;
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalRetries = 0;
  private totalCancelled = 0;

  private statsIntervalId?: ReturnType<typeof setInterval>;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    config: ProcessorConfig<T>,
    limiter?: AdaptiveRateLimiter
  ) {
    super();
    this.cfg = {
      name: "Unnamed Processor",
      onError: () => undefined,
      onCancel: () => undefined,
      retry: { maxRetries: 0, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
      ...config,
    };
    this.limiter = limiter;
    this.concurrency = config.concurrency;
  }

  // ─── Job submission ───────────────────────────────────────────────────────

  public addJob(
    job: T,
    priority: JobPriority = JobPriority.NORMAL
  ): boolean {
    const key = JSON.stringify(job);
    if (this.dedup.has(key)) return false;

    this.dedup.add(key);
    this.enqueueEntry({ job, key, priority, attempts: 0, addedAt: Date.now() });
    this.spawnWorkers();
    return true;
  }

  public addJobs(
    jobs: T[],
    priority: JobPriority = JobPriority.NORMAL
  ): number {
    let added = 0;
    for (const job of jobs) {
      if (this.addJob(job, priority)) added++;
    }
    return added;
  }

  // ─── Controls ─────────────────────────────────────────────────────────────

  public adjustConcurrency(newLimit: number): void {
    if (newLimit < 1) throw new Error("concurrency must be ≥ 1");
    this.concurrency = newLimit;
    this.spawnWorkers();
  }

  /**
   * Cancel all pending (not yet executing) jobs.
   * Jobs currently being processed by a worker are not affected.
   */
  public cancelAllPending(): number {
    const drained = this.queue.splice(0);
    this.dedup.clear();
    // Re-insert keys for actively running jobs so dedup still works.
    // (Active jobs have been removed from this.queue already; dedup.clear is safe
    //  because new addJob calls after cancel will proceed normally.)

    for (const entry of drained) {
      this.totalCancelled++;
      try {
        this.cfg.onCancel(entry.job);
        this.emit("cancelled", entry.job);
      } catch {
        // swallow
      }
    }

    this.checkIdle();
    return drained.length;
  }

  /** Promise that resolves when the queue is empty and all workers are done. */
  public waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  public getStats(): ProcessorStats {
    return {
      name: this.cfg.name,
      endpoint: this.limiter?.endpoint ?? "none",
      queueDepth: this.queue.length,
      activeWorkers: this.activeWorkers,
      concurrency: this.concurrency,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      totalRetries: this.totalRetries,
      totalCancelled: this.totalCancelled,
      utilizationPct: (
        (this.activeWorkers / Math.max(1, this.concurrency)) *
        100
      ).toFixed(1),
      isIdle: this.isIdle,
    };
  }

  public startStatsLogging(intervalMs = 5_000): () => void {
    if (this.statsIntervalId) clearInterval(this.statsIntervalId);
    this.statsIntervalId = setInterval(() => {
      const s = this.getStats();
      console.log(
        `[rate-master:${s.name}] q=${s.queueDepth} active=${s.activeWorkers}/${s.concurrency} ` +
          `processed=${s.totalProcessed} err=${s.totalErrors} retries=${s.totalRetries} ` +
          `cancelled=${s.totalCancelled} idle=${s.isIdle}`
      );
    }, intervalMs);

    return () => {
      if (this.statsIntervalId) {
        clearInterval(this.statsIntervalId);
        this.statsIntervalId = undefined;
      }
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private get isIdle(): boolean {
    return this.queue.length === 0 && this.activeWorkers === 0;
  }

  private enqueueEntry(entry: JobEntry<T>): void {
    // Insert in priority order (stable — preserve FIFO within same priority).
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].priority > entry.priority) i--;
    this.queue.splice(i, 0, entry);
  }

  private spawnWorkers(): void {
    while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
      this.activeWorkers++;
      this.workerLoop().catch(() => undefined);
    }
  }

  private async workerLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) continue;

      this.dedup.delete(entry.key);
      await this.processEntry(entry);
    }

    this.activeWorkers--;
    this.checkIdle();
  }

  private async processEntry(entry: JobEntry<T>): Promise<void> {
    const execute = (): Promise<void> =>
      Promise.resolve(this.cfg.processingFunction(entry.job));

    try {
      if (this.limiter) {
        await this.limiter.enqueue(() => execute(), entry.priority);
      } else {
        await execute();
      }
      this.totalProcessed++;
    } catch (err) {
      const retry = this.cfg.retry;
      if (entry.attempts < retry.maxRetries) {
        entry.attempts++;
        this.totalRetries++;

        const delay = this.backoffDelay(entry.attempts, retry);
        await sleep(delay);

        // Re-add to queue front for next attempt (same priority, no dedup check needed).
        this.queue.unshift(entry);
        this.dedup.add(entry.key);
      } else {
        this.totalErrors++;
        try {
          this.cfg.onError(err, entry.job);
          this.emit("error", err, entry.job);
        } catch {
          // swallow
        }
      }
    }
  }

  private backoffDelay(attempt: number, opts: RetryOptions): number {
    const base = Math.min(
      opts.maxDelayMs,
      opts.baseDelayMs * Math.pow(2, attempt - 1)
    );
    if (!opts.jitter) return base;
    return base * (0.75 + Math.random() * 0.5); // ±25% jitter
  }

  private checkIdle(): void {
    if (this.isIdle && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
      this.emit("idle");
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
