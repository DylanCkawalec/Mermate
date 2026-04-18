'use strict';

const logger = require('../utils/logger');
const traceStore = require('./trace-store');

const OPSEEQ_URL = (process.env.OPSEEQ_URL || 'http://localhost:9090')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
const TIMEOUT_MS = parseInt(process.env.OPSEEQ_TIMEOUT_MS || '15000', 10);

async function _fetch(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(`${OPSEEQ_URL}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  try {
    const data = await _fetch('/health', { timeoutMs: 5000 });
    return { healthy: data.status === 'ok', ...data };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

async function listModels() {
  try {
    const data = await _fetch('/v1/models');
    return data.data || [];
  } catch (err) {
    logger.warn('opseeq.list_models_failed', { error: err.message });
    return [];
  }
}

async function inference(messages, { model, temperature = 0, maxTokens = 500 } = {}) {
  const body = {
    model: model || undefined,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const data = await _fetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model,
    provider: data._opseeq?.provider,
    usage: data.usage,
    raw: data,
  };
}

function getUrl() { return OPSEEQ_URL; }

/**
 * Report a pipeline stage event to Opseeq for trace correlation.
 * Fire-and-forget — never blocks the pipeline on Opseeq availability.
 */
async function reportStage(runId, stageEvent) {
  if (!runId) return;
  const event = { ...stageEvent, ts: Date.now() };
  // Always persist locally
  traceStore.append(runId, event);
  // Flush to disk so TLA/TS/Rust events survive without a second render finalize
  void traceStore.persist(runId).catch((err) => {
    logger.debug('trace_store.persist_after_stage_failed', { runId: runId.slice(0, 8), error: err.message });
  });
  // Best-effort forward to Opseeq
  try {
    await _fetch('/api/mermate/stage', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, ...event }),
      timeoutMs: 3000,
    });
  } catch (err) {
    logger.debug('opseeq.report_stage_failed', { runId: runId.slice(0, 8), stage: stageEvent?.stage, error: err.message });
  }
}

/**
 * Read back the full trace for a given run_id from Opseeq.
 * Returns null if Opseeq is unavailable.
 */
async function getTrace(runId) {
  if (!runId) return null;
  try {
    const data = await _fetch(`/api/mermate/trace/${runId}`, { timeoutMs: 5000 });
    return data;
  } catch (err) {
    logger.debug('opseeq.get_trace_failed', { runId, error: err.message });
    return null;
  }
}

module.exports = { health, listModels, inference, getUrl, reportStage, getTrace };
