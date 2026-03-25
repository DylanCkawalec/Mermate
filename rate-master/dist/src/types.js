"use strict";
// ─── Job Priority ────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndpointType = exports.JobPriority = void 0;
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
var JobPriority;
(function (JobPriority) {
    JobPriority[JobPriority["CRITICAL"] = 0] = "CRITICAL";
    JobPriority[JobPriority["HIGH"] = 1] = "HIGH";
    JobPriority[JobPriority["NORMAL"] = 2] = "NORMAL";
    JobPriority[JobPriority["LOW"] = 3] = "LOW";
    JobPriority[JobPriority["BACKGROUND"] = 4] = "BACKGROUND";
})(JobPriority || (exports.JobPriority = JobPriority = {}));
// ─── Endpoint Configuration ──────────────────────────────────────────────────
/**
 * Classification of an upstream target.
 * Drives default OODA tuning and header-parsing behaviour.
 */
var EndpointType;
(function (EndpointType) {
    /** Localhost inference server (Ollama, LM Studio, llama.cpp HTTP). */
    EndpointType["LOCAL_AI"] = "local-ai";
    /** Cloud inference APIs with hard rate limits (OpenAI, Anthropic, Cohere…). */
    EndpointType["EXTERNAL_API"] = "external-api";
    /** Fully OODA-driven: starts at maxRequests, adjusts to observed reality. */
    EndpointType["ADAPTIVE"] = "adaptive";
})(EndpointType || (exports.EndpointType = EndpointType = {}));
//# sourceMappingURL=types.js.map