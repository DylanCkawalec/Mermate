/**
 * rate-master
 *
 * Adaptive OODA-driven rate limiter and job processor for agentic AI workloads.
 *
 * Core philosophy:
 *  - Never deny. Always forward. Shape traffic; never gate it.
 *  - OODA (Observe → Orient → Decide → Act) drives every limit adjustment.
 *  - Priority tiers ensure CRITICAL agent work is never blocked by BACKGROUND tasks.
 *  - Zero runtime dependencies — pure Node.js + TypeScript.
 */

// ─── Primary API ─────────────────────────────────────────────────────────────
export { RateMaster } from "./RateMaster";
export type { RateMasterConfig } from "./RateMaster";

// ─── Core primitives ─────────────────────────────────────────────────────────
export { AdaptiveRateLimiter, createLocalAILimiter, createExternalAPILimiter } from "./AdaptiveRateLimiter";
export { JobProcessor } from "./JobProcessor";
export type { ProcessorStats } from "./JobProcessor";

// ─── OODA ─────────────────────────────────────────────────────────────────────
export { OODAController } from "./OODAController";
export type { OODAConfig } from "./OODAController";

// ─── Data structures ──────────────────────────────────────────────────────────
export { PriorityQueue } from "./PriorityQueue";

// ─── Telemetry ────────────────────────────────────────────────────────────────
export {
  Telemetry,
  LatencyReservoir,
  StdoutJsonExporter,
  MemoryExporter,
  newTraceId,
  newSpanId,
} from "./Telemetry";

// ─── Types ────────────────────────────────────────────────────────────────────
export {
  JobPriority,
  EndpointType,
} from "./types";

export type {
  EndpointConfig,
  EndpointMetrics,
  GlobalMetrics,
  OODADecision,
  OODAReason,
  TelemetrySpan,
  TelemetryExporter,
  LatencyStats,
  ExecuteOptions,
  UpstreamFeedback,
  ProcessorConfig,
  RetryOptions,
  PrioritizedEntry,
} from "./types";
