"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateMaster = void 0;
const events_1 = require("events");
const types_1 = require("./types");
const AdaptiveRateLimiter_1 = require("./AdaptiveRateLimiter");
const OODAController_1 = require("./OODAController");
const JobProcessor_1 = require("./JobProcessor");
const Telemetry_1 = require("./Telemetry");
// ─── RateMaster ───────────────────────────────────────────────────────────────
/**
 * The parent rate limiter and traffic orchestrator for AI-native applications.
 *
 * RateMaster is the single entry point through which ALL AI inference traffic
 * flows. It:
 *
 *  1. Routes requests to per-endpoint AdaptiveRateLimiters.
 *  2. Applies OODA-driven adaptive limit adjustment on a recurring cycle.
 *  3. Surfaces a unified telemetry layer for tracing and metrics.
 *  4. Guarantees: NEVER denies a request. ALWAYS forwards. Shapes, never gates.
 *
 * Usage:
 * ```ts
 * const rm = new RateMaster({
 *   endpoints: {
 *     "openai":    { type: EndpointType.EXTERNAL_API, maxRequests: 60, intervalMs: 60_000 },
 *     "local-llm": { type: EndpointType.LOCAL_AI,     maxRequests: 4,  intervalMs: 1_000 },
 *   },
 * });
 *
 * // Direct execution
 * const result = await rm.execute("openai", () => openai.chat.completions.create({...}));
 *
 * // Batch job processing
 * const proc = rm.createProcessor<MyJob>("local-llm", { processingFunction: processJob, concurrency: 8 });
 * proc.addJobs(myJobs);
 * await proc.waitForIdle();
 *
 * rm.destroy();
 * ```
 *
 * Events:
 *  "ooda:decision"  (decision: OODADecision) — rate limit adjusted.
 *  "backpressure"   (endpoint: string, depth: number) — queue depth alert.
 *  "metrics"        (metrics: GlobalMetrics) — periodic snapshot.
 */
class RateMaster extends events_1.EventEmitter {
    limiters = new Map();
    processors = new Map();
    ooda;
    telemetry;
    memory;
    metricsIntervalId;
    startedAt = Date.now();
    constructor(config) {
        super();
        this.memory = new Telemetry_1.MemoryExporter(200);
        this.telemetry = new Telemetry_1.Telemetry([this.memory]);
        const ooda = new OODAController_1.OODAController(config.ooda ?? {}, this.telemetry);
        this.ooda = ooda;
        ooda.on("decision", (d) => this.emit("ooda:decision", d));
        // Register all endpoints.
        for (const [name, cfg] of Object.entries(config.endpoints)) {
            this.registerEndpoint(name, cfg);
        }
        ooda.start();
        const metricsMs = config.metricsIntervalMs ?? 15_000;
        if (metricsMs > 0) {
            this.metricsIntervalId = setInterval(() => {
                const m = this.getMetrics();
                this.telemetry.emitMetrics(m);
                this.emit("metrics", m);
            }, metricsMs);
        }
    }
    // ─── Endpoint management ──────────────────────────────────────────────────
    /**
     * Register a new endpoint at runtime (hot-add).
     * Endpoints registered in the constructor are already available.
     */
    registerEndpoint(name, config) {
        if (this.limiters.has(name)) {
            throw new Error(`Endpoint "${name}" is already registered.`);
        }
        const limiter = new AdaptiveRateLimiter_1.AdaptiveRateLimiter(name, config);
        limiter.on("backpressure", (depth) => this.emit("backpressure", name, depth));
        this.limiters.set(name, limiter);
        this.ooda.register(name, limiter);
    }
    deregisterEndpoint(name) {
        const limiter = this.limiters.get(name);
        if (!limiter)
            return;
        limiter.cancelAll();
        this.limiters.delete(name);
        this.ooda.deregister(name);
    }
    // ─── Direct execution ─────────────────────────────────────────────────────
    /**
     * Execute an async function through the named endpoint's rate limiter.
     *
     * - Always queues and eventually resolves.
     * - Priority defaults to NORMAL.
     * - Pass traceId to correlate with your own distributed traces.
     */
    execute(endpoint, fn, options = {}) {
        const limiter = this.requireLimiter(endpoint);
        const traceId = options.traceId ?? (0, Telemetry_1.newTraceId)();
        const priority = options.priority ?? types_1.JobPriority.NORMAL;
        const enqueuedAt = Date.now();
        return limiter
            .enqueue(fn, priority, { traceId, timeoutMs: options.timeoutMs })
            .then((result) => {
            this.telemetry.emitSpan({
                traceId,
                spanId: (0, Telemetry_1.newTraceId)(),
                endpoint,
                priority,
                queueWaitMs: 0, // enriched inside AdaptiveRateLimiter
                executionMs: Date.now() - enqueuedAt,
                success: true,
                timestamp: Date.now(),
            });
            return result;
        });
    }
    /**
     * Feed upstream response metadata (e.g. parsed rate-limit headers) back
     * to the endpoint's limiter for immediate self-calibration.
     */
    feedback(endpoint, fb) {
        this.requireLimiter(endpoint).feed(fb);
    }
    // ─── Job processor factory ────────────────────────────────────────────────
    /**
     * Create a JobProcessor wired to the named endpoint's rate limiter.
     * The processor inherits OODA-driven limit adjustments automatically.
     */
    createProcessor(endpoint, config) {
        const limiter = this.requireLimiter(endpoint);
        const proc = new JobProcessor_1.JobProcessor(config, limiter);
        if (!this.processors.has(endpoint)) {
            this.processors.set(endpoint, new Set());
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.processors.get(endpoint).add(proc);
        proc.once("idle", () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.processors.get(endpoint)?.delete(proc);
        });
        return proc;
    }
    // ─── Bulk controls ────────────────────────────────────────────────────────
    /**
     * Cancel all queued (not yet executing) requests across ALL endpoints.
     * Running requests complete normally.
     */
    cancelAll() {
        const result = {};
        for (const [name, limiter] of this.limiters) {
            result[name] = limiter.cancelAll();
        }
        return result;
    }
    // ─── Metrics ──────────────────────────────────────────────────────────────
    getMetrics() {
        const endpoints = {};
        let totalQueue = 0;
        let totalActive = 0;
        for (const [name, limiter] of this.limiters) {
            const m = limiter.getMetrics();
            endpoints[name] = m;
            totalQueue += m.queueDepth;
            totalActive += m.activeRequests;
        }
        return {
            uptimeMs: Date.now() - this.startedAt,
            endpoints,
            totalQueueDepth: totalQueue,
            totalActive,
            oodaCycles: this.ooda.cycles,
        };
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    /** Graceful shutdown: stop OODA, stop metrics interval. */
    destroy() {
        this.ooda.stop();
        if (this.metricsIntervalId) {
            clearInterval(this.metricsIntervalId);
            this.metricsIntervalId = undefined;
        }
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    requireLimiter(endpoint) {
        const limiter = this.limiters.get(endpoint);
        if (!limiter) {
            throw new Error(`Unknown endpoint "${endpoint}". ` +
                `Registered endpoints: [${[...this.limiters.keys()].join(", ")}]`);
        }
        return limiter;
    }
}
exports.RateMaster = RateMaster;
//# sourceMappingURL=RateMaster.js.map