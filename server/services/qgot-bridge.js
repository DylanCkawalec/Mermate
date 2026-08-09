'use strict';

/**
 * QGoT bridge — client for an optional local reasoning server that exposes an
 * OpenAI-compatible chat endpoint over locally hosted models.
 *
 * Position in the provider chain (see inference-provider.js): premium → ollama
 * → qgot → enhancer. QGoT is optional; when it is unreachable the health probe
 * fails fast and the chain moves on.
 *
 * Constraints:
 *   - A down server must not stall a pipeline stage.
 *   - Bounded waits: short health timeout, caller-supplied chat timeout.
 *
 * Endpoints consumed:
 *   GET  /healthz               — liveness probe
 *   POST /v1/chat/completions   — OpenAI-compatible chat
 *
 * Configuration: QGOT_URL (default http://127.0.0.1:8080), QGOT_MODEL.
 */

const logger = require('../utils/logger');

const QGOT_URL = (process.env.QGOT_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const QGOT_MODEL = process.env.QGOT_MODEL || 'gpt-oss:20b';

async function health(timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${QGOT_URL}/healthz`, { signal: controller.signal });
    return { healthy: res.ok };
  } catch (err) {
    return { healthy: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI-compatible chat against QGoT. Returns content string or null.
 */
async function chat(systemPrompt, userPrompt, { model, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${QGOT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || QGOT_MODEL,
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.warn('qgot.chat.error', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getUrl() { return QGOT_URL; }
function getModel() { return QGOT_MODEL; }

module.exports = { health, chat, getUrl, getModel };
