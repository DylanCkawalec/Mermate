'use strict';

/**
 * Meta-Cognition Gateway Bridge
 *
 * Connects the Node.js inference pipeline to the Python meta-cognition
 * gateway service. Provides:
 *
 *   - refinePrompt(stage, msg, seedPrompt) — GoT prompt refinement
 *   - scorePrompt(prompt, msg)             — multi-factor scoring
 *   - auditRun(runId)                      — run quality audit
 *   - cronOptimize()                       — batch audit + recommendations
 *   - isAvailable()                        — health probe
 *
 * The gateway is optional. When unavailable, all calls return graceful
 * fallbacks (passthrough prompt, default score). The inference pipeline
 * never blocks on meta-gateway failure.
 */

const logger = require('../utils/logger');

const META_URL = process.env.META_GATEWAY_URL || 'http://localhost:8200';
const META_TIMEOUT_MS = parseInt(process.env.META_GATEWAY_TIMEOUT || '5000', 10);
const META_ENABLED = process.env.META_GATEWAY_ENABLED !== 'false';

const _healthCache = { ok: false, checkedAt: 0 };
const HEALTH_TTL = 30_000;

async function _fetch(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || META_TIMEOUT_MS);
  try {
    const res = await fetch(`${META_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isAvailable() {
  if (!META_ENABLED) return false;
  const now = Date.now();
  if (now - _healthCache.checkedAt < HEALTH_TTL) return _healthCache.ok;
  const data = await _fetch('/health');
  _healthCache.ok = !!(data && data.status === 'ok');
  _healthCache.checkedAt = now;
  if (_healthCache.ok) {
    logger.info('meta_gateway.available', { got_config: data.got_config });
  }
  return _healthCache.ok;
}

async function refinePrompt(stage, msg, seedPrompt) {
  if (!(await isAvailable())) return { prompt: seedPrompt, refined: false };
  const start = Date.now();
  const data = await _fetch('/refine', {
    msg: msg || '',
    seed_prompt: seedPrompt || '',
    original_goal: msg || '',
  });
  const ms = Date.now() - start;
  if (data && data.success && data.system_prompt) {
    logger.info('meta_gateway.refined', {
      stage,
      score: data.score,
      nodes: data.explored,
      pruned: data.pruned,
      ms,
    });
    return {
      prompt: data.system_prompt,
      refined: true,
      score: data.score,
      evidence: data.evidence,
      benchmark: data.benchmark,
    };
  }
  return { prompt: seedPrompt, refined: false };
}

async function scorePrompt(prompt, msg) {
  if (!(await isAvailable())) return { score: 0.5, evidence: [], reasons: ['meta-gateway unavailable'] };
  const data = await _fetch('/score', { prompt, msg });
  if (data && typeof data.score === 'number') return data;
  return { score: 0.5, evidence: [], reasons: ['score request failed'] };
}

async function auditRun(runId) {
  if (!(await isAvailable())) return null;
  const data = await _fetch('/audit', { run_id: runId });
  if (data && typeof data.score === 'number') {
    logger.info('meta_gateway.audit', { runId: runId.slice(0, 8), score: data.score });
    return data;
  }
  return null;
}

async function cronOptimize() {
  if (!(await isAvailable())) return null;
  const data = await _fetch('/cron/optimize', {}, 30_000);
  if (data && data.success) {
    logger.info('meta_gateway.cron', {
      audited: data.runs_audited,
      avgScore: data.aggregate?.avg_score,
      recommendations: (data.recommendations || []).length,
    });
    return data;
  }
  return null;
}

module.exports = { isAvailable, refinePrompt, scorePrompt, auditRun, cronOptimize };
