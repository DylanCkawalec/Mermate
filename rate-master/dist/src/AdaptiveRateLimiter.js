"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdaptiveRateLimiter = void 0;
exports.createLocalAILimiter = createLocalAILimiter;
exports.createExternalAPILimiter = createExternalAPILimiter;
const events_1 = require("events");
const types_1 = require("./types");
const PriorityQueue_1 = require("./PriorityQueue");
const Telemetry_1 = require("./Telemetry");
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
class AdaptiveRateLimiter extends events_1.EventEmitter {
    endpoint;
    config;
    effectiveMax;
    intervalMs;
    // Sliding-window timestamp log: timestamps of requests started in the window.
    windowLog = [];
    // Priority queue of waiting requests.
    waiting = new PriorityQueue_1.PriorityQueue();
    activeCount = 0;
    totalExecuted = 0;
    totalErrors = 0;
    // Telemetry reservoirs.
    execLatency = new Telemetry_1.LatencyReservoir(1024);
    waitLatency = new Telemetry_1.LatencyReservoir(1024);
    // Throughput tracking (requests started in the last ~10s).
    tpLog = [];
    static TP_WINDOW = 10_000;
    // Error-rate trailing window (last 100 outcomes: 0=ok, 1=err).
    errWindow = [];
    static ERR_WINDOW = 100;
    constructor(endpoint, config) {
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
    enqueue(fn, priority = types_1.JobPriority.NORMAL, options = {}) {
        return new Promise((resolve, reject) => {
            const depth = this.waiting.size;
            const softLimit = this.config.softQueueLimit ?? Infinity;
            if (depth >= softLimit) {
                this.emit("backpressure", depth);
            }
            const req = {
                fn: fn,
                resolve: resolve,
                reject,
                priority,
                enqueuedAt: Date.now(),
                traceId: options.traceId ?? (0, Telemetry_1.newTraceId)(),
                spanId: (0, Telemetry_1.newSpanId)(),
            };
            if (options.timeoutMs != null && options.timeoutMs > 0) {
                req.timeoutHandle = setTimeout(() => {
                    req.reject(new Error(`Rate-limiter queue timeout after ${options.timeoutMs}ms (endpoint: ${this.endpoint})`));
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
    adjustLimit(newMax) {
        const prev = this.effectiveMax;
        this.effectiveMax = Math.max(this.config.minRequests ?? 1, Math.min(this.config.maxRequestsHardCap ?? this.config.maxRequests * 4, Math.round(newMax)));
        if (this.effectiveMax !== prev) {
            this.emit("limitChanged", prev, this.effectiveMax);
            this.drain();
        }
    }
    /**
     * Feed upstream response metadata back for self-calibration.
     * Parses x-ratelimit-remaining / retry-after style signals.
     */
    feed(feedback) {
        this.emit("feedback", feedback);
        // If upstream tells us it has very few slots left, back off immediately.
        if (feedback.remainingRequests !== undefined &&
            feedback.remainingRequests < 2) {
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
    cancelAll() {
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
    get currentLimit() {
        return this.effectiveMax;
    }
    /** Full snapshot for OODA and observability. */
    getMetrics() {
        const now = Date.now();
        this.evictWindow(now);
        const tpCount = this.tpLog.filter((t) => t > now - AdaptiveRateLimiter.TP_WINDOW).length;
        const throughputRps = tpCount / (AdaptiveRateLimiter.TP_WINDOW / 1000);
        const errCount = this.errWindow.reduce((s, v) => s + v, 0);
        const errorRate = this.errWindow.length === 0 ? 0 : errCount / this.errWindow.length;
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
    drain() {
        const now = Date.now();
        this.evictWindow(now);
        while (!this.waiting.isEmpty && this.windowLog.length < this.effectiveMax) {
            const req = this.waiting.pop();
            if (req)
                this.execute(req, now);
        }
        // If queue still has items, schedule a retry when the oldest window entry expires.
        if (!this.waiting.isEmpty) {
            const delay = this.nextSlotDelayMs();
            if (delay > 0) {
                setTimeout(() => this.drain(), delay);
            }
        }
    }
    async execute(req, now) {
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
        }
        catch (err) {
            this.totalErrors++;
            this.recordError(true);
            req.reject(err);
        }
        finally {
            this.activeCount--;
            this.drain();
        }
    }
    evictWindow(now) {
        const cutoff = now - this.intervalMs;
        while (this.windowLog.length > 0 && this.windowLog[0] <= cutoff) {
            this.windowLog.shift();
        }
    }
    nextSlotDelayMs() {
        if (this.windowLog.length === 0)
            return 0;
        const oldest = this.windowLog[0];
        return Math.max(1, oldest + this.intervalMs - Date.now());
    }
    trackThroughput(now) {
        const cutoff = now - AdaptiveRateLimiter.TP_WINDOW;
        while (this.tpLog.length > 0 && this.tpLog[0] <= cutoff)
            this.tpLog.shift();
        this.tpLog.push(now);
    }
    recordError(isError) {
        if (this.errWindow.length >= AdaptiveRateLimiter.ERR_WINDOW) {
            this.errWindow.shift();
        }
        this.errWindow.push(isError ? 1 : 0);
    }
}
exports.AdaptiveRateLimiter = AdaptiveRateLimiter;
// ─── Factory helpers ─────────────────────────────────────────────────────────
const DEFAULT_LOCAL_AI = {
    type: types_1.EndpointType.LOCAL_AI,
    maxRequests: 4,
    intervalMs: 1_000,
    targetLatencyMs: 3_000,
    maxErrorRate: 0.1,
    minRequests: 1,
};
const DEFAULT_EXTERNAL_API = {
    type: types_1.EndpointType.EXTERNAL_API,
    maxRequests: 60,
    intervalMs: 60_000,
    targetLatencyMs: 1_000,
    maxErrorRate: 0.05,
    minRequests: 1,
};
function createLocalAILimiter(endpoint, overrides = {}) {
    return new AdaptiveRateLimiter(endpoint, {
        ...DEFAULT_LOCAL_AI,
        ...overrides,
    });
}
function createExternalAPILimiter(endpoint, overrides = {}) {
    return new AdaptiveRateLimiter(endpoint, {
        ...DEFAULT_EXTERNAL_API,
        ...overrides,
    });
}
//# sourceMappingURL=AdaptiveRateLimiter.js.map