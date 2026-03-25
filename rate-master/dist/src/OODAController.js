"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OODAController = void 0;
const events_1 = require("events");
const DEFAULT_OODA_CONFIG = {
    cycleMs: 10_000,
    ewmaAlpha: 0.2,
    scaleDownFactor: 0.15,
    scaleUpFactor: 0.10,
    minSamplesBeforeAct: 10,
};
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
class OODAController extends events_1.EventEmitter {
    limiters = new Map();
    states = new Map();
    cfg;
    telemetry;
    intervalId;
    cycleCount = 0;
    running = false;
    constructor(config = {}, telemetry) {
        super();
        this.cfg = { ...DEFAULT_OODA_CONFIG, ...config };
        this.telemetry = telemetry;
    }
    // ─── Registration ─────────────────────────────────────────────────────────
    register(name, limiter) {
        this.limiters.set(name, limiter);
        this.states.set(name, {
            ewmaLatencyMs: limiter.config.targetLatencyMs ?? 1_000,
            ewmaErrorRate: 0,
            sampleCount: 0,
        });
    }
    deregister(name) {
        this.limiters.delete(name);
        this.states.delete(name);
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────
    start() {
        if (this.running)
            return;
        this.running = true;
        this.intervalId = setInterval(() => this.runCycle(), this.cfg.cycleMs);
        // Run an initial cycle immediately so the system isn't blind at startup.
        this.runCycle();
    }
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.running = false;
    }
    get cycles() {
        return this.cycleCount;
    }
    // ─── OODA cycle ───────────────────────────────────────────────────────────
    runCycle() {
        this.cycleCount++;
        for (const [name, limiter] of this.limiters) {
            const state = this.states.get(name);
            if (!state)
                continue;
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
            if (state.sampleCount < this.cfg.minSamplesBeforeAct)
                continue;
            // ── DECIDE ───────────────────────────────────────────────────────────
            const targetLatency = limiter.config.targetLatencyMs ?? 1_000;
            const maxErrorRate = limiter.config.maxErrorRate ?? 0.05;
            const current = limiter.currentLimit;
            const { reason, newLimit, confidence } = this.decide(state.ewmaLatencyMs, state.ewmaErrorRate, targetLatency, maxErrorRate, current);
            // ── ACT ──────────────────────────────────────────────────────────────
            if (reason !== "maintain") {
                const decision = {
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
    decide(ewmaLatency, ewmaErrorRate, targetLatency, maxErrorRate, currentLimit) {
        const latencyLoad = ewmaLatency / targetLatency;
        const errorLoad = ewmaErrorRate / maxErrorRate;
        // Scale-down: system is stressed — reduce rate to protect upstream.
        if (latencyLoad > 1.5 || errorLoad > 1.0) {
            // Larger load → larger reduction, capped so we never zero-out.
            const pressure = Math.min(latencyLoad, 2.0) - 1; // 0..1
            const factor = 1 - this.cfg.scaleDownFactor * (1 + pressure * 0.5);
            const newLimit = Math.max(1, currentLimit * factor);
            const confidence = Math.min(1, (latencyLoad - 1) * 0.5 + (errorLoad - 1) * 0.5);
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
exports.OODAController = OODAController;
//# sourceMappingURL=OODAController.js.map