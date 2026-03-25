"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndpointType = exports.JobPriority = exports.newSpanId = exports.newTraceId = exports.MemoryExporter = exports.StdoutJsonExporter = exports.LatencyReservoir = exports.Telemetry = exports.PriorityQueue = exports.OODAController = exports.JobProcessor = exports.createExternalAPILimiter = exports.createLocalAILimiter = exports.AdaptiveRateLimiter = exports.RateMaster = void 0;
// ─── Primary API ─────────────────────────────────────────────────────────────
var RateMaster_1 = require("./RateMaster");
Object.defineProperty(exports, "RateMaster", { enumerable: true, get: function () { return RateMaster_1.RateMaster; } });
// ─── Core primitives ─────────────────────────────────────────────────────────
var AdaptiveRateLimiter_1 = require("./AdaptiveRateLimiter");
Object.defineProperty(exports, "AdaptiveRateLimiter", { enumerable: true, get: function () { return AdaptiveRateLimiter_1.AdaptiveRateLimiter; } });
Object.defineProperty(exports, "createLocalAILimiter", { enumerable: true, get: function () { return AdaptiveRateLimiter_1.createLocalAILimiter; } });
Object.defineProperty(exports, "createExternalAPILimiter", { enumerable: true, get: function () { return AdaptiveRateLimiter_1.createExternalAPILimiter; } });
var JobProcessor_1 = require("./JobProcessor");
Object.defineProperty(exports, "JobProcessor", { enumerable: true, get: function () { return JobProcessor_1.JobProcessor; } });
// ─── OODA ─────────────────────────────────────────────────────────────────────
var OODAController_1 = require("./OODAController");
Object.defineProperty(exports, "OODAController", { enumerable: true, get: function () { return OODAController_1.OODAController; } });
// ─── Data structures ──────────────────────────────────────────────────────────
var PriorityQueue_1 = require("./PriorityQueue");
Object.defineProperty(exports, "PriorityQueue", { enumerable: true, get: function () { return PriorityQueue_1.PriorityQueue; } });
// ─── Telemetry ────────────────────────────────────────────────────────────────
var Telemetry_1 = require("./Telemetry");
Object.defineProperty(exports, "Telemetry", { enumerable: true, get: function () { return Telemetry_1.Telemetry; } });
Object.defineProperty(exports, "LatencyReservoir", { enumerable: true, get: function () { return Telemetry_1.LatencyReservoir; } });
Object.defineProperty(exports, "StdoutJsonExporter", { enumerable: true, get: function () { return Telemetry_1.StdoutJsonExporter; } });
Object.defineProperty(exports, "MemoryExporter", { enumerable: true, get: function () { return Telemetry_1.MemoryExporter; } });
Object.defineProperty(exports, "newTraceId", { enumerable: true, get: function () { return Telemetry_1.newTraceId; } });
Object.defineProperty(exports, "newSpanId", { enumerable: true, get: function () { return Telemetry_1.newSpanId; } });
// ─── Types ────────────────────────────────────────────────────────────────────
var types_1 = require("./types");
Object.defineProperty(exports, "JobPriority", { enumerable: true, get: function () { return types_1.JobPriority; } });
Object.defineProperty(exports, "EndpointType", { enumerable: true, get: function () { return types_1.EndpointType; } });
//# sourceMappingURL=index.js.map