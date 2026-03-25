"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryExporter = exports.StdoutJsonExporter = exports.Telemetry = exports.LatencyReservoir = void 0;
exports.newTraceId = newTraceId;
exports.newSpanId = newSpanId;
const crypto_1 = require("crypto");
// ─── Reservoir sampler ───────────────────────────────────────────────────────
/**
 * Fixed-size circular buffer for latency samples.
 * Evicts oldest sample when full (FIFO eviction, not random reservoir).
 * Provides O(n log n) percentile on demand over the stored window.
 * A window of 1024 gives statistically stable p95/p99 estimates.
 */
class LatencyReservoir {
    buf;
    capacity;
    head = 0;
    count = 0;
    constructor(capacity = 1024) {
        this.capacity = capacity;
        this.buf = new Array(capacity).fill(0);
    }
    record(valueMs) {
        this.buf[this.head] = valueMs;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity)
            this.count++;
    }
    snapshot() {
        if (this.count === 0) {
            return { p50: 0, p95: 0, p99: 0, avg: 0, samples: 0 };
        }
        const slice = this.buf.slice(0, this.count).sort((a, b) => a - b);
        const avg = slice.reduce((s, v) => s + v, 0) / slice.length;
        return {
            p50: this.pct(slice, 50),
            p95: this.pct(slice, 95),
            p99: this.pct(slice, 99),
            avg: Math.round(avg * 100) / 100,
            samples: this.count,
        };
    }
    reset() {
        this.head = 0;
        this.count = 0;
    }
    pct(sorted, p) {
        const idx = Math.min(Math.floor((p / 100) * (sorted.length - 1)), sorted.length - 1);
        return sorted[idx];
    }
}
exports.LatencyReservoir = LatencyReservoir;
// ─── ID generation ───────────────────────────────────────────────────────────
function newTraceId() {
    return (0, crypto_1.randomBytes)(16).toString("hex");
}
function newSpanId() {
    return (0, crypto_1.randomBytes)(8).toString("hex");
}
// ─── Telemetry hub ───────────────────────────────────────────────────────────
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
class Telemetry {
    exporters = [];
    startedAt = Date.now();
    constructor(exporters = []) {
        this.exporters = [...exporters];
    }
    addExporter(exporter) {
        this.exporters.push(exporter);
    }
    emitSpan(span) {
        for (const e of this.exporters) {
            try {
                e.onSpan(span);
            }
            catch {
                // exporter errors must never propagate into hot path
            }
        }
    }
    emitMetrics(metrics) {
        for (const e of this.exporters) {
            try {
                e.onMetrics(metrics);
            }
            catch {
                // silent
            }
        }
    }
    emitOODADecision(decision) {
        for (const e of this.exporters) {
            try {
                e.onOODADecision(decision);
            }
            catch {
                // silent
            }
        }
    }
    get uptimeMs() {
        return Date.now() - this.startedAt;
    }
}
exports.Telemetry = Telemetry;
// ─── Built-in exporters ──────────────────────────────────────────────────────
/**
 * Writes structured JSON to stdout.
 * Compatible with log aggregators (Datadog, Loki, CloudWatch, etc.) that
 * consume newline-delimited JSON (NDJSON).
 */
class StdoutJsonExporter {
    onSpan(span) {
        this.write("span", span);
    }
    onMetrics(metrics) {
        this.write("metrics", metrics);
    }
    onOODADecision(decision) {
        this.write("ooda", decision);
    }
    write(type, payload) {
        process.stdout.write(JSON.stringify({ type, ts: Date.now(), ...flattenPayload(payload) }) +
            "\n");
    }
}
exports.StdoutJsonExporter = StdoutJsonExporter;
/**
 * Retains the last N spans in memory.
 * Useful for testing and for the CLI dashboard.
 */
class MemoryExporter {
    maxSpans;
    spans = [];
    decisions = [];
    lastMetrics;
    constructor(maxSpans = 500) {
        this.maxSpans = maxSpans;
    }
    onSpan(span) {
        if (this.spans.length >= this.maxSpans)
            this.spans.shift();
        this.spans.push(span);
    }
    onMetrics(metrics) {
        this.lastMetrics = metrics;
    }
    onOODADecision(decision) {
        if (this.decisions.length >= 200)
            this.decisions.shift();
        this.decisions.push(decision);
    }
    clear() {
        this.spans.length = 0;
        this.decisions.length = 0;
        this.lastMetrics = undefined;
    }
}
exports.MemoryExporter = MemoryExporter;
// ─── Helpers ─────────────────────────────────────────────────────────────────
function flattenPayload(obj) {
    if (typeof obj === "object" && obj !== null) {
        return obj;
    }
    return { value: obj };
}
//# sourceMappingURL=Telemetry.js.map