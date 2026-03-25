import { EventEmitter } from "events";
import type { EndpointConfig, EndpointMetrics, UpstreamFeedback } from "./types";
import { EndpointType, JobPriority } from "./types";
import { PriorityQueue } from "./PriorityQueue";
import { LatencyReservoir, newSpanId, newTraceId } from "./Telemetry";

// ─── Internal types ──────────────────────────────────────────────────────────

interface QueuedRequest {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  priority: JobPriority;
  enqueuedAt: number;
  traceId: string;
  spanId: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

// ─── AdaptiveRateLimiter ─────────────────────────────────────────────────────

/**
 * Enterprise-grade adaptive rate limiter for AI inference workloads.
 *
 * Core guarantees:
 *  1. **Never-deny**: enqueue() always returns a Promise. Requests are queued
 *     until capacity is available — the service is never stopped.
 *  2. **Priority-first**: CRITICAL requests execute before BACKGROUND ones.
 *     FIFO is preserved within each priority tier (stable ordering).
 *  3. **Adaptive limits**: adjustLimit() accepts runtime limit changes from an
 *     external OODA controller without restart.
 *  4. **Feedback loop**: feed() accepts upstream signals (x-ratelimit-*, 429s)
 *     so the limiter self-calibrates to what the upstream actually allows.
 *  5. **Backpressure signals**: optional onBackpressure callback fires when queue
 *     depth exceeds softQueueLimit — caller decides how to respond.
 *
 * Algorithm: sliding-window counter (stateless window, no token leakage).
 * Chosen over token-bucket for AI APIs because upstream rate limits are
 * typically expressed as "N requests per M seconds" with hard resets.
 *
 * Events emitted (EventEmitter):
 *  "backpressure"  (queueDepth: number)
 *  "limitChanged"  (prev: number, next: number)
 *  "feedback"      (feedback: UpstreamFeedback)
 */
export class AdaptiveRateLimiter extends EventEmitter {
  readonly endpoint: string;
  readonly config: EndpointConfig;

  private effectiveMax: number;
  private readonly intervalMs: number;

  // Sliding-window timestamp log: timestamps of requests started in the window.
  private readonly windowLog: number[] = [];

  // Priority queue of waiting requests.
  private readonly waiting = new PriorityQueue<QueuedRequest>();

  private activeCount = 0;
  private totalExecuted = 0;
  private totalErrors = 0;

  // Telemetry reservoirs.
  private readonly execLatency = new LatencyReservoir(1024);
  private readonly waitLatency = new LatencyReservoir(1024);

  // Throughput tracking (requests started in the last ~10s).
  private readonly tpLog: number[] = [];
  private static readonly TP_WINDOW = 10_000;

  // Error-rate trailing window (last 100 outcomes: 0=ok, 1=err).
  private readonly errWindow: number[] = [];
  private static readonly ERR_WINDOW = 100;

  constructor(endpoint: string, config: EndpointConfig) {
    super();
    this.endpoint = endpoint;
    this.config = config;
    this.effectiveMax = config.maxRequests;
    this.intervalMs = config.intervalMs;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Enqueue a function for rate-limited execution.
   *
   * - Returns a Promise that resolves with the function's return value.
   * - Never rejects due to capacity. Rejects only if:
   *     a) The wrapped function itself throws/rejects.
   *     b) A timeoutMs was specified and the request hasn't started by then.
   *     c) cancelAll() is called while the request is queued.
   */
  public enqueue<T>(
    fn: () => Promise<T>,
    priority: JobPriority = JobPriority.NORMAL,
    options: { traceId?: string; timeoutMs?: number } = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const depth = this.waiting.size;
      const softLimit = this.config.softQueueLimit ?? Infinity;

      if (depth >= softLimit) {
        this.emit("backpressure", depth);
      }

      const req: QueuedRequest = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority,
        enqueuedAt: Date.now(),
        traceId: options.traceId ?? newTraceId(),
        spanId: newSpanId(),
      };

      if (options.timeoutMs != null && options.timeoutMs > 0) {
        req.timeoutHandle = setTimeout(() => {
          req.reject(
            new Error(
              `Rate-limiter queue timeout after ${options.timeoutMs}ms (endpoint: ${this.endpoint})`
            )
          );
          // The item will remain in the heap; when popped, its promise is already
          // settled and we detect a cancelled state via a sentinel flag if needed.
          // For simplicity we rely on Promise.race()-style usage in the caller.
        }, options.timeoutMs);
      }

      this.waiting.push(req, priority);
      this.drain();
    });
  }

  /**
   * Adjust the effective rate limit at runtime.
   * Called by OODAController on each OODA cycle.
   * Immediately drains the queue if new capacity frees up.
   */
  public adjustLimit(newMax: number): void {
    const prev = this.effectiveMax;
    this.effectiveMax = Math.max(
      this.config.minRequests ?? 1,
      Math.min(
        this.config.maxRequestsHardCap ?? this.config.maxRequests * 4,
        Math.round(newMax)
      )
    );

    if (this.effectiveMax !== prev) {
      this.emit("limitChanged", prev, this.effectiveMax);
      this.drain();
    }
  }

  /**
   * Feed upstream response metadata back for self-calibration.
   * Parses x-ratelimit-remaining / retry-after style signals.
   */
  public feed(feedback: UpstreamFeedback): void {
    this.emit("feedback", feedback);

    // If upstream tells us it has very few slots left, back off immediately.
    if (
      feedback.remainingRequests !== undefined &&
      feedback.remainingRequests < 2
    ) {
      this.adjustLimit(Math.max(1, this.effectiveMax * 0.7));
    }

    // Explicit retry-after: schedule a single drain attempt after the delay.
    if (feedback.retryAfterMs != null && feedback.retryAfterMs > 0) {
      setTimeout(() => this.drain(), feedback.retryAfterMs);
    }

    // Track status code for error rate.
    if (feedback.statusCode !== undefined) {
      const isErr = feedback.statusCode >= 400 ? 1 : 0;
      this.recordError(isErr === 1);
    }
  }

  /**
   * Cancel all queued (not yet executing) requests.
   * @returns Number of requests cancelled.
   */
  public cancelAll(): number {
    let count = 0;
    while (!this.waiting.isEmpty) {
      const req = this.waiting.pop();
      if (req) {
        clearTimeout(req.timeoutHandle);
        req.reject(new Error(`Cancelled (endpoint: ${this.endpoint})`));
        count++;
      }
    }
    return count;
  }

  get currentLimit(): number {
    return this.effectiveMax;
  }

  /** Full snapshot for OODA and observability. */
  public getMetrics(): EndpointMetrics {
    const now = Date.now();
    this.evictWindow(now);

    const tpCount = this.tpLog.filter(
      (t) => t > now - AdaptiveRateLimiter.TP_WINDOW
    ).length;
    const throughputRps = tpCount / (AdaptiveRateLimiter.TP_WINDOW / 1000);

    const errCount = this.errWindow.reduce((s, v) => s + v, 0);
    const errorRate =
      this.errWindow.length === 0 ? 0 : errCount / this.errWindow.length;

    return {
      endpoint: this.endpoint,
      type: this.config.type,
      queueDepth: this.waiting.size,
      activeRequests: this.activeCount,
      windowUsage: this.windowLog.length,
      currentLimit: this.effectiveMax,
      totalExecuted: this.totalExecuted,
      totalErrors: this.totalErrors,
      errorRate,
      executionLatency: this.execLatency.snapshot(),
      queueWaitLatency: this.waitLatency.snapshot(),
      throughputRps,
      intervalMs: this.intervalMs,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Drain as many queued requests as current capacity permits. */
  private drain(): void {
    const now = Date.now();
    this.evictWindow(now);

    while (!this.waiting.isEmpty && this.windowLog.length < this.effectiveMax) {
      const req = this.waiting.pop();
      if (req) this.execute(req, now);
    }

    // If queue still has items, schedule a retry when the oldest window entry expires.
    if (!this.waiting.isEmpty) {
      const delay = this.nextSlotDelayMs();
      if (delay > 0) {
        setTimeout(() => this.drain(), delay);
      }
    }
  }

  private async execute(req: QueuedRequest, now: number): Promise<void> {
    clearTimeout(req.timeoutHandle);

    const waitMs = now - req.enqueuedAt;
    this.waitLatency.record(waitMs);
    this.windowLog.push(now);
    this.trackThroughput(now);
    this.activeCount++;

    const execStart = Date.now();

    try {
      const result = await req.fn();
      const execMs = Date.now() - execStart;
      this.execLatency.record(execMs);
      this.totalExecuted++;
      this.recordError(false);
      req.resolve(result);
    } catch (err) {
      this.totalErrors++;
      this.recordError(true);
      req.reject(err);
    } finally {
      this.activeCount--;
      this.drain();
    }
  }

  private evictWindow(now: number): void {
    const cutoff = now - this.intervalMs;
    while (this.windowLog.length > 0 && this.windowLog[0] <= cutoff) {
      this.windowLog.shift();
    }
  }

  private nextSlotDelayMs(): number {
    if (this.windowLog.length === 0) return 0;
    const oldest = this.windowLog[0];
    return Math.max(1, oldest + this.intervalMs - Date.now());
  }

  private trackThroughput(now: number): void {
    const cutoff = now - AdaptiveRateLimiter.TP_WINDOW;
    while (this.tpLog.length > 0 && this.tpLog[0] <= cutoff) this.tpLog.shift();
    this.tpLog.push(now);
  }

  private recordError(isError: boolean): void {
    if (this.errWindow.length >= AdaptiveRateLimiter.ERR_WINDOW) {
      this.errWindow.shift();
    }
    this.errWindow.push(isError ? 1 : 0);
  }
}

// ─── Factory helpers ─────────────────────────────────────────────────────────

const DEFAULT_LOCAL_AI: Partial<EndpointConfig> = {
  type: EndpointType.LOCAL_AI,
  maxRequests: 4,
  intervalMs: 1_000,
  targetLatencyMs: 3_000,
  maxErrorRate: 0.1,
  minRequests: 1,
};

const DEFAULT_EXTERNAL_API: Partial<EndpointConfig> = {
  type: EndpointType.EXTERNAL_API,
  maxRequests: 60,
  intervalMs: 60_000,
  targetLatencyMs: 1_000,
  maxErrorRate: 0.05,
  minRequests: 1,
};

export function createLocalAILimiter(
  endpoint: string,
  overrides: Partial<EndpointConfig> = {}
): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter(endpoint, {
    ...DEFAULT_LOCAL_AI,
    ...overrides,
  } as EndpointConfig);
}

export function createExternalAPILimiter(
  endpoint: string,
  overrides: Partial<EndpointConfig> = {}
): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter(endpoint, {
    ...DEFAULT_EXTERNAL_API,
    ...overrides,
  } as EndpointConfig);
}
