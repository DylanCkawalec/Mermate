'use strict';

/**
 * Rate-Master Bridge — OODA-driven adaptive traffic shaping for MERMATE.
 *
 * Every LLM call flows through this bridge:
 *   1. Routes to per-tier endpoints (orchestrator, worker, fast, local)
 *   2. OODA cycle auto-adjusts limits based on observed latency + error rate
 *   3. Priority derived from model-catalog's stage taxonomy
 *   4. Upstream rate-limit headers feed back for self-calibration
 *   5. Structured action tags emitted for full audit visibility
 *   6. Speculative health: shallowest queue wins ties in same-tier routing
 */

const path = require('node:path');
const logger = require('../utils/logger');
const catalog = require('./model-catalog');

const RM_DIST = path.resolve(__dirname, '..', '..', 'rate-master', 'dist', 'src');
const { RateMaster } = require(path.join(RM_DIST, 'RateMaster'));
const { EndpointType, JobPriority } = require(path.join(RM_DIST, 'types'));

// ---- Endpoint Configuration ------------------------------------------------

const ENDPOINT_CONFIGS = {
  [catalog.Tier.ORCHESTRATOR]: {
    type: EndpointType.EXTERNAL_API,
    maxRequests: parseInt(process.env.MERMATE_ORCH_RPM || '30', 10),
    intervalMs: 60_000,
    targetLatencyMs: 15_000,
    maxErrorRate: 0.08,
    minRequests: 1,
    softQueueLimit: 6,
  },
  [catalog.Tier.WORKER]: {
    type: EndpointType.EXTERNAL_API,
    maxRequests: parseInt(process.env.MERMATE_WORKER_RPM || '60', 10),
    intervalMs: 60_000,
    targetLatencyMs: 10_000,
    maxErrorRate: 0.05,
    minRequests: 2,
    softQueueLimit: 10,
  },
  [catalog.Tier.FAST]: {
    type: EndpointType.EXTERNAL_API,
    maxRequests: parseInt(process.env.MERMATE_FAST_RPM || '120', 10),
    intervalMs: 60_000,
    targetLatencyMs: 5_000,
    maxErrorRate: 0.05,
    minRequests: 4,
    softQueueLimit: 20,
  },
  [catalog.Tier.LOCAL]: {
    type: EndpointType.LOCAL_AI,
    maxRequests: parseInt(process.env.MERMATE_LOCAL_RPM || '4', 10),
    intervalMs: 1_000,
    targetLatencyMs: 30_000,
    maxErrorRate: 0.15,
    minRequests: 1,
    softQueueLimit: 4,
  },
};

// ---- Singleton Instance ----------------------------------------------------

let _instance = null;
let _actionSeq = 0;

function _getInstance() {
  if (_instance) return _instance;

  try {
    _instance = new RateMaster({
      endpoints: ENDPOINT_CONFIGS,
      ooda: {
        cycleMs: 5_000,
        ewmaAlpha: 0.25,
        scaleDownFactor: 0.15,
        scaleUpFactor: 0.12,
        minSamplesBeforeAct: 5,
      },
      metricsIntervalMs: 10_000,
    });

    _instance.on('ooda:decision', (d) => {
      logger.info('rm.ooda', {
        endpoint: d.endpoint,
        prev: d.previousLimit,
        next: d.newLimit,
        reason: d.reason,
        lat: d.ewmaLatencyMs,
        err: d.ewmaErrorRate,
      });
    });

    _instance.on('backpressure', (endpoint, depth) => {
      logger.warn('rm.backpressure', { endpoint, depth });
    });

    logger.info('rm.init', { endpoints: Object.keys(ENDPOINT_CONFIGS) });
  } catch (err) {
    logger.warn('rm.init_failed', { error: err.message });
    _instance = null;
  }

  return _instance;
}

// ---- Action Tag Builder ----------------------------------------------------

function buildActionTag(stage, model, endpoint, priority, contextEst) {
  const seq = ++_actionSeq;
  const canonical = catalog.canonicalStage(stage);
  return {
    tag: `[RM:${seq}:${canonical}]`,
    seq,
    stage: canonical,
    legacyStage: stage,
    model,
    endpoint,
    tier: endpoint,
    priority,
    priorityLabel: catalog.priorityLabel(priority),
    inputTokensEst: contextEst.inputTokensEst,
    outputTokensEst: contextEst.outputTokensEst,
    totalTokensEst: contextEst.totalTokensEst,
    contextUtilization: +(contextEst.contextUtilization * 100).toFixed(1),
    enqueuedAt: Date.now(),
  };
}

// ---- Public API ------------------------------------------------------------

/**
 * Execute an async function through the rate-master adaptive queue.
 *
 * @param {string} stage - Pipeline stage (legacy or canonical name)
 * @param {string} model - Model being called
 * @param {string} [inputText] - Input text for context size estimation
 * @param {Function} fn - Async function to execute
 * @returns {Promise<{result: *, actionTag: object}>}
 */
async function execute(stage, model, inputText, fn) {
  const rm = _getInstance();
  const endpoint = catalog.classifyTier(model);
  const priority = catalog.stagePriority(stage);
  const contextEst = catalog.estimateContext(stage, inputText);
  const actionTag = buildActionTag(stage, model, endpoint, priority, contextEst);

  logger.info('rm.enqueue', {
    tag: actionTag.tag,
    endpoint,
    priority: actionTag.priorityLabel,
    inTok: actionTag.inputTokensEst,
    ctxPct: actionTag.contextUtilization,
  });

  if (!rm) {
    const result = await fn();
    actionTag.queueWaitMs = 0;
    actionTag.executionMs = Date.now() - actionTag.enqueuedAt;
    return { result, actionTag };
  }

  try {
    const result = await rm.execute(endpoint, fn, {
      priority,
      traceId: `mermate-${actionTag.seq}`,
      timeoutMs: priority === catalog.Priority.CRITICAL ? 180_000 : 120_000,
    });

    actionTag.queueWaitMs = 0;
    actionTag.executionMs = Date.now() - actionTag.enqueuedAt;

    logger.info('rm.done', {
      tag: actionTag.tag,
      ms: actionTag.executionMs,
    });

    return { result, actionTag };
  } catch (err) {
    actionTag.executionMs = Date.now() - actionTag.enqueuedAt;
    actionTag.error = err.message;

    logger.warn('rm.error', {
      tag: actionTag.tag,
      error: err.message,
      ms: actionTag.executionMs,
    });

    throw err;
  }
}

/**
 * Feed upstream rate-limit headers back to the rate limiter.
 */
function feedback(model, fb) {
  const rm = _getInstance();
  if (!rm) return;
  const endpoint = catalog.classifyTier(model);
  try { rm.feedback(endpoint, fb); } catch { /* advisory */ }
}

/**
 * Get current metrics from all endpoints.
 */
function getMetrics() {
  const rm = _getInstance();
  if (!rm) return null;
  return rm.getMetrics();
}

/**
 * Get the priority for a given stage (delegates to catalog).
 */
function getPriority(stage) {
  return catalog.stagePriority(stage);
}

/**
 * Estimate context window for a stage (delegates to catalog).
 */
function estimateContextSize(stage, inputText) {
  return catalog.estimateContext(stage, inputText);
}

/**
 * Graceful shutdown — tear down OODA timers and queues.
 */
function destroy() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  execute,
  feedback,
  getMetrics,
  getPriority,
  estimateContextSize,
  buildActionTag,
  destroy,
  _resolveEndpoint: catalog.classifyTier,
};
