'use strict';

const logger = require('../utils/logger');
const traceStore = require('./trace-store');
const wsBridge = require('./opseeq-ws-bridge');

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

// Opseeq >= v7.5 removed the push-ingestion endpoint (`/api/mermate/stage`)
// in favour of polling mermate directly. Detect the 404 once and stop
// pushing — local trace persistence (traceStore) remains the lineage record.
let _stagePushUnsupported = false;

/**
 * Report a pipeline stage event to Opseeq for trace correlation.
 * Fire-and-forget — never blocks the pipeline on Opseeq availability.
 *
 * Transport selection:
 *   1. WS bridge (if connected) — queued on transient disconnects.
 *   2. HTTP fallback, only against Opseeq builds that still ingest pushes.
 *
 * Both transports may fire for the same event; Opseeq deduplicates by the
 * (run_id, stage, ts) tuple. Neither transport is retried, so the local
 * trace store is the durable record.
 */
function reportStage(runId, stageEvent) {
  if (!runId) return;
  const event = { ...stageEvent, ts: Date.now() };
  // Always persist locally
  traceStore.append(runId, event);
  // Flush to disk so TLA/TS/Rust events survive without a second render finalize
  void traceStore.persist(runId).catch((err) => {
    logger.debug('trace_store.persist_after_stage_failed', { runId: runId.slice(0, 8), error: err.message });
  });

  // Best-effort WS dispatch — does not block the HTTP path.
  try { wsBridge.sendStage(runId, event); } catch { /* WS bridge is fire-and-forget */ }

  if (_stagePushUnsupported) return;

  // Best-effort HTTP forward for clients that haven't enabled WS. Not retried,
  // so delivery is not assured; the local trace store remains the durable
  // record. When both transports are active the Opseeq server deduplicates by
  // (run_id, stage, ts). Fire-and-forget: never blocks the calling agent flow.
  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${OPSEEQ_URL}/api/mermate/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId, ...event }),
        signal: controller.signal,
      });
      if (res.status === 404) {
        _stagePushUnsupported = true;
        logger.info('opseeq.stage_push_unsupported', { note: 'opseeq is pull-based; stage events stay in local trace' });
      }
    } catch (err) {
      logger.debug('opseeq.report_stage_failed', { runId: runId.slice(0, 8), stage: stageEvent?.stage, error: err.message });
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * Snapshot of the WS bridge state — surfaced via /api/openclaw/status so
 * operators can confirm whether low-latency telemetry is active.
 */
function wsStatus() {
  try { return wsBridge.status(); } catch { return { enabled: false }; }
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

module.exports = { health, listModels, inference, getUrl, reportStage, getTrace, wsStatus };
