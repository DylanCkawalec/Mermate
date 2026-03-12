import { EventEmitter } from "events";
import type { EndpointConfig, ExecuteOptions, GlobalMetrics, ProcessorConfig, UpstreamFeedback } from "./types";
import { type OODAConfig } from "./OODAController";
import { JobProcessor } from "./JobProcessor";
import { Telemetry, MemoryExporter } from "./Telemetry";
export interface RateMasterConfig {
    /**
     * Named endpoint definitions.
     * At least one entry is required.
     * @example
     *   endpoints: {
     *     "openai":    { type: EndpointType.EXTERNAL_API, maxRequests: 60,  intervalMs: 60_000 },
     *     "local-llm": { type: EndpointType.LOCAL_AI,     maxRequests: 4,   intervalMs: 1_000  },
     *   }
     */
    endpoints: Record<string, EndpointConfig>;
    /** OODA controller tuning. Defaults are production-safe. */
    ooda?: Partial<OODAConfig>;
    /**
     * Metrics push interval (ms).
     * Set to 0 to disable periodic metric emission.
     * Default: 15_000.
     */
    metricsIntervalMs?: number;
    /**
     * Whether to write structured JSON spans/metrics to stdout.
     * Default: false (use addExporter() for custom output).
     */
    stdoutTelemetry?: boolean;
}
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
export declare class RateMaster extends EventEmitter {
    private readonly limiters;
    private readonly processors;
    private readonly ooda;
    readonly telemetry: Telemetry;
    readonly memory: MemoryExporter;
    private metricsIntervalId?;
    private readonly startedAt;
    constructor(config: RateMasterConfig);
    /**
     * Register a new endpoint at runtime (hot-add).
     * Endpoints registered in the constructor are already available.
     */
    registerEndpoint(name: string, config: EndpointConfig): void;
    deregisterEndpoint(name: string): void;
    /**
     * Execute an async function through the named endpoint's rate limiter.
     *
     * - Always queues and eventually resolves.
     * - Priority defaults to NORMAL.
     * - Pass traceId to correlate with your own distributed traces.
     */
    execute<R>(endpoint: string, fn: () => Promise<R>, options?: ExecuteOptions): Promise<R>;
    /**
     * Feed upstream response metadata (e.g. parsed rate-limit headers) back
     * to the endpoint's limiter for immediate self-calibration.
     */
    feedback(endpoint: string, fb: UpstreamFeedback): void;
    /**
     * Create a JobProcessor wired to the named endpoint's rate limiter.
     * The processor inherits OODA-driven limit adjustments automatically.
     */
    createProcessor<T>(endpoint: string, config: ProcessorConfig<T>): JobProcessor<T>;
    /**
     * Cancel all queued (not yet executing) requests across ALL endpoints.
     * Running requests complete normally.
     */
    cancelAll(): Record<string, number>;
    getMetrics(): GlobalMetrics;
    /** Graceful shutdown: stop OODA, stop metrics interval. */
    destroy(): void;
    private requireLimiter;
}
//# sourceMappingURL=RateMaster.d.ts.map