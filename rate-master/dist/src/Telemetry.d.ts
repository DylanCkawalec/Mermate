import type { TelemetrySpan, TelemetryExporter, GlobalMetrics, OODADecision, LatencyStats } from "./types";
/**
 * Fixed-size circular buffer for latency samples.
 * Evicts oldest sample when full (FIFO eviction, not random reservoir).
 * Provides O(n log n) percentile on demand over the stored window.
 * A window of 1024 gives statistically stable p95/p99 estimates.
 */
export declare class LatencyReservoir {
    private readonly buf;
    private readonly capacity;
    private head;
    private count;
    constructor(capacity?: number);
    record(valueMs: number): void;
    snapshot(): LatencyStats;
    reset(): void;
    private pct;
}
export declare function newTraceId(): string;
export declare function newSpanId(): string;
/**
 * Lightweight, zero-dependency telemetry hub.
 *
 * Responsibilities:
 *  - Emit structured JSON spans for every completed request.
 *  - Forward periodic global metrics snapshots to registered exporters.
 *  - Forward OODA decisions for audit trails.
 *  - Built-in stdout exporter (structured JSON, one line per event).
 *  - Pluggable exporter interface compatible with OpenTelemetry semantics.
 *
 * Designed for use as a singleton inside RateMaster.
 */
export declare class Telemetry {
    private readonly exporters;
    private readonly startedAt;
    constructor(exporters?: TelemetryExporter[]);
    addExporter(exporter: TelemetryExporter): void;
    emitSpan(span: TelemetrySpan): void;
    emitMetrics(metrics: GlobalMetrics): void;
    emitOODADecision(decision: OODADecision): void;
    get uptimeMs(): number;
}
/**
 * Writes structured JSON to stdout.
 * Compatible with log aggregators (Datadog, Loki, CloudWatch, etc.) that
 * consume newline-delimited JSON (NDJSON).
 */
export declare class StdoutJsonExporter implements TelemetryExporter {
    onSpan(span: TelemetrySpan): void;
    onMetrics(metrics: GlobalMetrics): void;
    onOODADecision(decision: OODADecision): void;
    private write;
}
/**
 * Retains the last N spans in memory.
 * Useful for testing and for the CLI dashboard.
 */
export declare class MemoryExporter implements TelemetryExporter {
    private readonly maxSpans;
    readonly spans: TelemetrySpan[];
    readonly decisions: OODADecision[];
    lastMetrics?: GlobalMetrics;
    constructor(maxSpans?: number);
    onSpan(span: TelemetrySpan): void;
    onMetrics(metrics: GlobalMetrics): void;
    onOODADecision(decision: OODADecision): void;
    clear(): void;
}
//# sourceMappingURL=Telemetry.d.ts.map