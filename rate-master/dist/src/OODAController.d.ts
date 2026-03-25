import { EventEmitter } from "events";
import type { AdaptiveRateLimiter } from "./AdaptiveRateLimiter";
import type { Telemetry } from "./Telemetry";
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
export declare class OODAController extends EventEmitter {
    private readonly limiters;
    private readonly states;
    private readonly cfg;
    private readonly telemetry?;
    private intervalId?;
    private cycleCount;
    private running;
    constructor(config?: Partial<OODAConfig>, telemetry?: Telemetry);
    register(name: string, limiter: AdaptiveRateLimiter): void;
    deregister(name: string): void;
    start(): void;
    stop(): void;
    get cycles(): number;
    private runCycle;
    private decide;
}
//# sourceMappingURL=OODAController.d.ts.map