import { EventEmitter } from "events";
import type { OODADecision, OODAReason } from "./types";
import type { AdaptiveRateLimiter } from "./AdaptiveRateLimiter";
import type { Telemetry } from "./Telemetry";

// ─── OODA config ─────────────────────────────────────────────────────────────

export interface OODAConfig {
  /**
   * How frequently (ms) the OODA loop runs.
   * Lower values react faster but add CPU overhead.
   * Recommended: 5_000–30_000 for production.
   */
  cycleMs: number;

  /**
   * EWMA smoothing factor α ∈ (0, 1].
   * α = 0.2 ≈ 5-sample smoothing. Lower α = slower but more stable.
   */
  ewmaAlpha: number;

  /**
   * Scale-down factor applied when the system is over-loaded.
   * newLimit = currentLimit * (1 - scaleDownFactor).
   * Default: 0.15 (15% reduction per cycle).
   */
  scaleDownFactor: number;

  /**
   * Scale-up factor applied when the system has spare capacity.
   * newLimit = currentLimit * (1 + scaleUpFactor).
   * Default: 0.10 (10% increase per cycle).
   */
  scaleUpFactor: number;

  /**
   * Minimum number of latency samples required before OODA will act.
   * Prevents over-reaction to cold-start noise.
   */
  minSamplesBeforeAct: number;
}

const DEFAULT_OODA_CONFIG: OODAConfig = {
  cycleMs: 10_000,
  ewmaAlpha: 0.2,
  scaleDownFactor: 0.15,
  scaleUpFactor: 0.10,
  minSamplesBeforeAct: 10,
};

// ─── Per-endpoint state ───────────────────────────────────────────────────────

interface EndpointState {
  ewmaLatencyMs: number;
  ewmaErrorRate: number;
  sampleCount: number;
}

// ─── OODAController ──────────────────────────────────────────────────────────

/**
 * Observe → Orient → Decide → Act controller for adaptive rate limiting.
 *
 * The OODA loop is the core adaptive engine of rate-master. On each cycle it:
 *
 *  OBSERVE:  Reads EndpointMetrics from every registered AdaptiveRateLimiter.
 *  ORIENT:   Updates EWMA (Exponentially Weighted Moving Average) of p95 latency
 *            and error rate — smoothing out short bursts without over-reacting.
 *  DECIDE:   Compares EWMA values against per-endpoint targets (latency threshold,
 *            max error rate) and calculates scale-up / scale-down / maintain.
 *  ACT:      Calls limiter.adjustLimit(newLimit) — which immediately drains the
 *            queue if capacity increased, or paces requests if capacity reduced.
 *
 * Decision thresholds (configurable via EndpointConfig):
 *  Scale-down when: ewmaLatency > targetLatency * 1.5  OR  ewmaErrorRate > maxErrorRate
 *  Scale-up   when: ewmaLatency < targetLatency * 0.6  AND ewmaErrorRate < maxErrorRate * 0.3
 *  Maintain   when: neither condition is met.
 *
 * Hard bounds are enforced by AdaptiveRateLimiter.adjustLimit() itself:
 *  [minRequests, maxRequestsHardCap].
 *
 * Events:
 *  "decision" (decision: OODADecision)
 */
export class OODAController extends EventEmitter {
  private readonly limiters = new Map<string, AdaptiveRateLimiter>();
  private readonly states = new Map<string, EndpointState>();
  private readonly cfg: OODAConfig;
  private readonly telemetry?: Telemetry;

  private intervalId?: ReturnType<typeof setInterval>;
  private cycleCount = 0;
  private running = false;

  constructor(
    config: Partial<OODAConfig> = {},
    telemetry?: Telemetry
  ) {
    super();
    this.cfg = { ...DEFAULT_OODA_CONFIG, ...config };
    this.telemetry = telemetry;
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  register(name: string, limiter: AdaptiveRateLimiter): void {
    this.limiters.set(name, limiter);
    this.states.set(name, {
      ewmaLatencyMs: limiter.config.targetLatencyMs ?? 1_000,
      ewmaErrorRate: 0,
      sampleCount: 0,
    });
  }

  deregister(name: string): void {
    this.limiters.delete(name);
    this.states.delete(name);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => this.runCycle(), this.cfg.cycleMs);
    // Run an initial cycle immediately so the system isn't blind at startup.
    this.runCycle();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.running = false;
  }

  get cycles(): number {
    return this.cycleCount;
  }

  // ─── OODA cycle ───────────────────────────────────────────────────────────

  private runCycle(): void {
    this.cycleCount++;

    for (const [name, limiter] of this.limiters) {
      const state = this.states.get(name);
      if (!state) continue;

      // ── OBSERVE ──────────────────────────────────────────────────────────
      const metrics = limiter.getMetrics();

      // ── ORIENT ───────────────────────────────────────────────────────────
      const α = this.cfg.ewmaAlpha;
      const observedLatency = metrics.executionLatency.p95;
      const observedErrorRate = metrics.errorRate;

      state.ewmaLatencyMs =
        α * observedLatency + (1 - α) * state.ewmaLatencyMs;
      state.ewmaErrorRate =
        α * observedErrorRate + (1 - α) * state.ewmaErrorRate;
      state.sampleCount += metrics.executionLatency.samples;

      // Need enough data before acting to avoid cold-start thrash.
      if (state.sampleCount < this.cfg.minSamplesBeforeAct) continue;

      // ── DECIDE ───────────────────────────────────────────────────────────
      const targetLatency =
        limiter.config.targetLatencyMs ?? 1_000;
      const maxErrorRate = limiter.config.maxErrorRate ?? 0.05;
      const current = limiter.currentLimit;

      const { reason, newLimit, confidence } = this.decide(
        state.ewmaLatencyMs,
        state.ewmaErrorRate,
        targetLatency,
        maxErrorRate,
        current
      );

      // ── ACT ──────────────────────────────────────────────────────────────
      if (reason !== "maintain") {
        const decision: OODADecision = {
          endpoint: name,
          previousLimit: current,
          newLimit,
          reason,
          ewmaLatencyMs: Math.round(state.ewmaLatencyMs),
          ewmaErrorRate: Math.round(state.ewmaErrorRate * 1000) / 1000,
          confidence,
        };

        limiter.adjustLimit(newLimit);
        this.emit("decision", decision);
        this.telemetry?.emitOODADecision(decision);
      }
    }
  }

  // ─── Decision logic ───────────────────────────────────────────────────────

  private decide(
    ewmaLatency: number,
    ewmaErrorRate: number,
    targetLatency: number,
    maxErrorRate: number,
    currentLimit: number
  ): { reason: OODAReason; newLimit: number; confidence: number } {
    const latencyLoad = ewmaLatency / targetLatency;
    const errorLoad = ewmaErrorRate / maxErrorRate;

    // Scale-down: system is stressed — reduce rate to protect upstream.
    if (latencyLoad > 1.5 || errorLoad > 1.0) {
      // Larger load → larger reduction, capped so we never zero-out.
      const pressure = Math.min(latencyLoad, 2.0) - 1; // 0..1
      const factor = 1 - this.cfg.scaleDownFactor * (1 + pressure * 0.5);
      const newLimit = Math.max(1, currentLimit * factor);
      const confidence = Math.min(
        1,
        (latencyLoad - 1) * 0.5 + (errorLoad - 1) * 0.5
      );
      return { reason: "scale-down", newLimit, confidence };
    }

    // Scale-up: system has headroom — increase throughput.
    if (latencyLoad < 0.6 && errorLoad < 0.3) {
      const newLimit = currentLimit * (1 + this.cfg.scaleUpFactor);
      const confidence = Math.min(1, (1 - latencyLoad) * 0.5 + (1 - errorLoad) * 0.5);
      return { reason: "scale-up", newLimit, confidence };
    }

    // Maintain: operating within acceptable bounds.
    return { reason: "maintain", newLimit: currentLimit, confidence: 1 };
  }
}
