import { randomBytes } from "crypto";
import type {
  TelemetrySpan,
  TelemetryExporter,
  GlobalMetrics,
  OODADecision,
  LatencyStats,
} from "./types";

// ─── Reservoir sampler ───────────────────────────────────────────────────────

/**
 * Fixed-size circular buffer for latency samples.
 * Evicts oldest sample when full (FIFO eviction, not random reservoir).
 * Provides O(n log n) percentile on demand over the stored window.
 * A window of 1024 gives statistically stable p95/p99 estimates.
 */
export class LatencyReservoir {
  private readonly buf: number[];
  private readonly capacity: number;
  private head = 0;
  private count = 0;

  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.buf = new Array<number>(capacity).fill(0);
  }

  record(valueMs: number): void {
    this.buf[this.head] = valueMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  snapshot(): LatencyStats {
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

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  private pct(sorted: number[], p: number): number {
    const idx = Math.min(
      Math.floor((p / 100) * (sorted.length - 1)),
      sorted.length - 1
    );
    return sorted[idx];
  }
}

// ─── ID generation ───────────────────────────────────────────────────────────

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
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
export class Telemetry {
  private readonly exporters: TelemetryExporter[] = [];
  private readonly startedAt = Date.now();

  constructor(exporters: TelemetryExporter[] = []) {
    this.exporters = [...exporters];
  }

  addExporter(exporter: TelemetryExporter): void {
    this.exporters.push(exporter);
  }

  emitSpan(span: TelemetrySpan): void {
    for (const e of this.exporters) {
      try {
        e.onSpan(span);
      } catch {
        // exporter errors must never propagate into hot path
      }
    }
  }

  emitMetrics(metrics: GlobalMetrics): void {
    for (const e of this.exporters) {
      try {
        e.onMetrics(metrics);
      } catch {
        // silent
      }
    }
  }

  emitOODADecision(decision: OODADecision): void {
    for (const e of this.exporters) {
      try {
        e.onOODADecision(decision);
      } catch {
        // silent
      }
    }
  }

  get uptimeMs(): number {
    return Date.now() - this.startedAt;
  }
}

// ─── Built-in exporters ──────────────────────────────────────────────────────

/**
 * Writes structured JSON to stdout.
 * Compatible with log aggregators (Datadog, Loki, CloudWatch, etc.) that
 * consume newline-delimited JSON (NDJSON).
 */
export class StdoutJsonExporter implements TelemetryExporter {
  onSpan(span: TelemetrySpan): void {
    this.write("span", span);
  }

  onMetrics(metrics: GlobalMetrics): void {
    this.write("metrics", metrics);
  }

  onOODADecision(decision: OODADecision): void {
    this.write("ooda", decision);
  }

  private write(type: string, payload: unknown): void {
    process.stdout.write(
      JSON.stringify({ type, ts: Date.now(), ...flattenPayload(payload) }) +
        "\n"
    );
  }
}

/**
 * Retains the last N spans in memory.
 * Useful for testing and for the CLI dashboard.
 */
export class MemoryExporter implements TelemetryExporter {
  private readonly maxSpans: number;
  readonly spans: TelemetrySpan[] = [];
  readonly decisions: OODADecision[] = [];
  lastMetrics?: GlobalMetrics;

  constructor(maxSpans = 500) {
    this.maxSpans = maxSpans;
  }

  onSpan(span: TelemetrySpan): void {
    if (this.spans.length >= this.maxSpans) this.spans.shift();
    this.spans.push(span);
  }

  onMetrics(metrics: GlobalMetrics): void {
    this.lastMetrics = metrics;
  }

  onOODADecision(decision: OODADecision): void {
    if (this.decisions.length >= 200) this.decisions.shift();
    this.decisions.push(decision);
  }

  clear(): void {
    this.spans.length = 0;
    this.decisions.length = 0;
    this.lastMetrics = undefined;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenPayload(obj: unknown): Record<string, unknown> {
  if (typeof obj === "object" && obj !== null) {
    return obj as Record<string, unknown>;
  }
  return { value: obj };
}
