import { EventEmitter } from "events";
import type { EndpointConfig, EndpointMetrics, UpstreamFeedback } from "./types";
import { JobPriority } from "./types";
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
export declare class AdaptiveRateLimiter extends EventEmitter {
    readonly endpoint: string;
    readonly config: EndpointConfig;
    private effectiveMax;
    private readonly intervalMs;
    private readonly windowLog;
    private readonly waiting;
    private activeCount;
    private totalExecuted;
    private totalErrors;
    private readonly execLatency;
    private readonly waitLatency;
    private readonly tpLog;
    private static readonly TP_WINDOW;
    private readonly errWindow;
    private static readonly ERR_WINDOW;
    constructor(endpoint: string, config: EndpointConfig);
    /**
     * Enqueue a function for rate-limited execution.
     *
     * - Returns a Promise that resolves with the function's return value.
     * - Never rejects due to capacity. Rejects only if:
     *     a) The wrapped function itself throws/rejects.
     *     b) A timeoutMs was specified and the request hasn't started by then.
     *     c) cancelAll() is called while the request is queued.
     */
    enqueue<T>(fn: () => Promise<T>, priority?: JobPriority, options?: {
        traceId?: string;
        timeoutMs?: number;
    }): Promise<T>;
    /**
     * Adjust the effective rate limit at runtime.
     * Called by OODAController on each OODA cycle.
     * Immediately drains the queue if new capacity frees up.
     */
    adjustLimit(newMax: number): void;
    /**
     * Feed upstream response metadata back for self-calibration.
     * Parses x-ratelimit-remaining / retry-after style signals.
     */
    feed(feedback: UpstreamFeedback): void;
    /**
     * Cancel all queued (not yet executing) requests.
     * @returns Number of requests cancelled.
     */
    cancelAll(): number;
    get currentLimit(): number;
    /** Full snapshot for OODA and observability. */
    getMetrics(): EndpointMetrics;
    /** Drain as many queued requests as current capacity permits. */
    private drain;
    private execute;
    private evictWindow;
    private nextSlotDelayMs;
    private trackThroughput;
    private recordError;
}
export declare function createLocalAILimiter(endpoint: string, overrides?: Partial<EndpointConfig>): AdaptiveRateLimiter;
export declare function createExternalAPILimiter(endpoint: string, overrides?: Partial<EndpointConfig>): AdaptiveRateLimiter;
//# sourceMappingURL=AdaptiveRateLimiter.d.ts.map