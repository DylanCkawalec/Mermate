/**
 * Priority tier for jobs and rate-limiter requests.
 * Lower numeric value = higher urgency.
 * Maps naturally to OODA decision-making tiers:
 *   CRITICAL  → Act  (immediate execution)
 *   HIGH      → Decide (near-immediate)
 *   NORMAL    → Orient
 *   LOW       → Observe
 *   BACKGROUND→ deferred / best-effort
 */
export declare enum JobPriority {
    CRITICAL = 0,
    HIGH = 1,
    NORMAL = 2,
    LOW = 3,
    BACKGROUND = 4
}
/**
 * Classification of an upstream target.
 * Drives default OODA tuning and header-parsing behaviour.
 */
export declare enum EndpointType {
    /** Localhost inference server (Ollama, LM Studio, llama.cpp HTTP). */
    LOCAL_AI = "local-ai",
    /** Cloud inference APIs with hard rate limits (OpenAI, Anthropic, Cohere…). */
    EXTERNAL_API = "external-api",
    /** Fully OODA-driven: starts at maxRequests, adjusts to observed reality. */
    ADAPTIVE = "adaptive"
}
export interface EndpointConfig {
    type: EndpointType;
    /** Maximum requests allowed within intervalMs (initial / configured cap). */
    maxRequests: number;
    /** Rate-limit window in milliseconds. */
    intervalMs: number;
    /**
     * Target p95 latency in ms. OODA scales down when observed latency exceeds
     * this by 50%, and scales up when it is below 60% of this value.
     * Defaults: 2000 for LOCAL_AI, 1000 for EXTERNAL_API.
     */
    targetLatencyMs?: number;
    /**
     * Acceptable error rate (0–1). OODA scales down aggressively when breached.
     * Default: 0.05 (5%).
     */
    maxErrorRate?: number;
    /**
     * Hard floor: OODA will never reduce the limit below this value.
     * Default: 1.
     */
    minRequests?: number;
    /**
     * Hard ceiling: OODA will never raise the limit above this value.
     * Default: maxRequests * 4.
     */
    maxRequestsHardCap?: number;
    /**
     * Emit an onBackpressure signal when queue depth exceeds this threshold.
     * Does NOT block or reject — only signals.
     * Default: Infinity (no signal).
     */
    softQueueLimit?: number;
}
export interface PrioritizedEntry<T> {
    data: T;
    priority: JobPriority;
    id: string;
    enqueuedAt: number;
    seq: number;
}
export interface LatencyStats {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    samples: number;
}
export interface EndpointMetrics {
    endpoint: string;
    type: EndpointType;
    queueDepth: number;
    activeRequests: number;
    windowUsage: number;
    currentLimit: number;
    totalExecuted: number;
    totalErrors: number;
    /** Trailing error rate (0–1). */
    errorRate: number;
    executionLatency: LatencyStats;
    queueWaitLatency: LatencyStats;
    /** Requests per second in the last measurement window. */
    throughputRps: number;
    /** Rate-limit window duration (mirrors EndpointConfig.intervalMs). */
    intervalMs: number;
}
export interface GlobalMetrics {
    uptimeMs: number;
    endpoints: Record<string, EndpointMetrics>;
    totalQueueDepth: number;
    totalActive: number;
    oodaCycles: number;
}
export type OODAReason = "scale-up" | "scale-down" | "maintain";
export interface OODADecision {
    endpoint: string;
    previousLimit: number;
    newLimit: number;
    reason: OODAReason;
    ewmaLatencyMs: number;
    ewmaErrorRate: number;
    confidence: number;
}
export interface TelemetrySpan {
    traceId: string;
    spanId: string;
    endpoint: string;
    priority: JobPriority;
    queueWaitMs: number;
    executionMs: number;
    success: boolean;
    error?: string;
    timestamp: number;
}
export interface TelemetryExporter {
    onSpan(span: TelemetrySpan): void;
    onMetrics(metrics: GlobalMetrics): void;
    onOODADecision(decision: OODADecision): void;
}
export interface ExecuteOptions {
    priority?: JobPriority;
    /** Propagate an existing trace ID for distributed tracing correlation. */
    traceId?: string;
    /** Reject the promise if the job hasn't started executing within this many ms. */
    timeoutMs?: number;
}
/**
 * Feed observed upstream signals back to the OODA controller.
 * Typically parsed from response headers (x-ratelimit-*, retry-after).
 */
export interface UpstreamFeedback {
    /** Remaining requests in the current window, if reported by upstream. */
    remainingRequests?: number;
    /** How many ms until the upstream window resets. */
    resetAfterMs?: number;
    /** Explicit retry-after from a 429/503 response. */
    retryAfterMs?: number;
    /** HTTP status code of the upstream response, for error-rate tracking. */
    statusCode?: number;
}
export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /** Add ±25% jitter to prevent thundering-herd retries. */
    jitter: boolean;
}
export interface ProcessorConfig<T> {
    processingFunction: (job: T) => Promise<void> | void;
    concurrency: number;
    name?: string;
    onError?: (error: unknown, job: T) => void;
    onCancel?: (job: T) => void;
    retry?: RetryOptions;
}
//# sourceMappingURL=types.d.ts.map