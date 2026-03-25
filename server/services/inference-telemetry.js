'use strict';

/**
 * Inference Telemetry — per-call measurement for every LLM inference.
 *
 * Every call to infer(), inferMax(), or inferWithRole() produces a
 * telemetry record capturing role, stage, model, provider, latency,
 * token estimates, cost estimate, and scoring metadata.
 *
 * Records are stored in per-run arrays keyed by runId. Callers can
 * retrieve and serialize them for audit, logging, or UX display.
 */

const { randomUUID } = require('node:crypto');
const logger = require('../utils/logger');
const catalog = require('./model-catalog');

const VERBOSE_TELEMETRY = process.env.MERMATE_VERBOSE_TELEMETRY === 'true';

const _runs = new Map();
const MAX_RUNS = 50;

function createRun(label) {
  const runId = randomUUID();
  if (_runs.size >= MAX_RUNS) {
    const oldest = _runs.keys().next().value;
    _runs.delete(oldest);
  }
  _runs.set(runId, { id: runId, label, startedAt: Date.now(), records: [] });
  return runId;
}

const _estimateTokens = catalog.estimateTokens;
const _estimateCost = catalog.estimateCost;

function record(runId, {
  stage,
  role = 'default',
  model = 'unknown',
  provider = 'unknown',
  promptText = '',
  outputText = '',
  latencyMs = 0,
  validationScore = null,
  pruneDecision = null,
  batchId = null,
  parentStateId = null,
  success = true,
  error = null,
}) {
  const tokensIn = _estimateTokens(promptText);
  const tokensOut = _estimateTokens(outputText);
  const costEstimate = _estimateCost(model, tokensIn, tokensOut);

  const entry = Object.freeze({
    id: randomUUID(),
    runId,
    batchId: batchId || runId,
    stage,
    role,
    model,
    provider,
    tokensIn,
    tokensOut,
    costEstimate,
    latencyMs: Math.round(latencyMs),
    validationScore,
    pruneDecision,
    parentStateId,
    success,
    error,
    timestamp: Date.now(),
  });

  const run = _runs.get(runId);
  if (run) run.records.push(entry);

  if (VERBOSE_TELEMETRY) {
    logger.info('telemetry.record', {
      runId: runId?.slice(0, 8),
      stage,
      role,
      model,
      provider,
      tokensIn,
      tokensOut,
      cost: costEstimate,
      latencyMs: entry.latencyMs,
      success,
    });
  }

  return entry;
}

function getRun(runId) {
  return _runs.get(runId) || null;
}

function getRunSummary(runId) {
  const run = _runs.get(runId);
  if (!run) return null;

  const records = run.records;
  const totalCalls = records.length;
  const totalTokensIn = records.reduce((s, r) => s + r.tokensIn, 0);
  const totalTokensOut = records.reduce((s, r) => s + r.tokensOut, 0);
  const totalCost = +records.reduce((s, r) => s + r.costEstimate, 0).toFixed(6);
  const totalLatency = records.reduce((s, r) => s + r.latencyMs, 0);
  const stages = [...new Set(records.map(r => r.stage))];
  const roles = [...new Set(records.map(r => r.role).filter(r => r !== 'default'))];
  const providers = [...new Set(records.map(r => r.provider))];

  return {
    runId,
    label: run.label,
    totalCalls,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    totalLatencyMs: totalLatency,
    wallClockMs: Date.now() - run.startedAt,
    stages,
    roles,
    providers,
  };
}

module.exports = { createRun, record, getRun, getRunSummary };
