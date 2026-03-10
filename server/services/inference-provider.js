'use strict';

/**
 * Inference Provider — Self-sufficient Node.js provider chain for Mermate.
 *
 * Abstracts model inference behind a single infer() call that cascades through
 * available providers: premium API → Ollama → Python enhancer → local fallback.
 *
 * The provider layer is invisible to the UI. The user presses Render and gets
 * the best result the system can produce with whatever providers are configured.
 */

const { buildPrompt } = require('./axiom-prompts');
const logger = require('../utils/logger');

// ---- Configuration --------------------------------------------------------

const PREMIUM_API_KEY   = process.env.MERMATE_AI_API_KEY || '';
const PREMIUM_PROVIDER  = process.env.MERMATE_AI_PROVIDER || 'openai';
const PREMIUM_MODEL     = process.env.MERMATE_AI_MODEL || 'gpt-4o-mini';
const PREMIUM_MAX_MODEL = process.env.MERMATE_AI_MAX_MODEL || '';
const MAX_ENABLED       = process.env.MERMATE_AI_MAX_ENABLED === 'true';

const OLLAMA_URL   = process.env.MERMATE_OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.MERMATE_OLLAMA_MODEL || 'gpt-oss:20b';

const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';

const INFER_TIMEOUT_MS     = 30_000;
const MAX_INFER_TIMEOUT_MS = 120_000;

// ---- Health cache ---------------------------------------------------------

const _healthCache = {
  premium: { ok: false, checkedAt: 0 },
  ollama:  { ok: false, checkedAt: 0 },
  enhancer:{ ok: false, checkedAt: 0 },
};
const HEALTH_TTL = 30_000;

async function _checkHealth(provider) {
  const now = Date.now();
  const cached = _healthCache[provider];
  if (cached && now - cached.checkedAt < HEALTH_TTL) return cached.ok;

  let ok = false;
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 3000);

    if (provider === 'premium') {
      ok = !!PREMIUM_API_KEY;
    } else if (provider === 'ollama') {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
      ok = res.ok;
    } else if (provider === 'enhancer') {
      const res = await fetch(`${ENHANCER_URL}/health`, { signal: controller.signal });
      ok = res.ok;
    }
  } catch {
    ok = false;
  } finally {
    if (timer) clearTimeout(timer);
  }

  _healthCache[provider] = { ok, checkedAt: now };
  return ok;
}

// ---- Provider implementations ---------------------------------------------

async function _callPremium(systemPrompt, userPrompt, modelOverride, timeoutMs) {
  const model = modelOverride || PREMIUM_MODEL;
  const timeout = timeoutMs || INFER_TIMEOUT_MS;
  const baseUrl = PREMIUM_PROVIDER === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://api.openai.com/v1/chat/completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    if (PREMIUM_PROVIDER === 'anthropic') {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': PREMIUM_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn('provider.premium.http_error', { model, status: res.status });
        return null;
      }
      const data = await res.json();
      return data.content?.[0]?.text || null;
    }

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PREMIUM_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('provider.premium.http_error', { model, status: res.status });
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.warn('provider.premium.error', { model, error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _callOllama(systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFER_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: { temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.message?.content || null;
  } catch (err) {
    logger.warn('provider.ollama.error', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _callEnhancer(systemPrompt, userPrompt, stage, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFER_TIMEOUT_MS);

  try {
    const res = await fetch(`${ENHANCER_URL}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_source: extra?.rawSource || userPrompt,
        stage: stage || 'render_prepare',
        system_prompt: systemPrompt,
        temperature: 0,
        diagram_type: extra?.diagramType || null,
        content_state: extra?.contentState || null,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.enhanced_source || null;
  } catch (err) {
    logger.warn('provider.enhancer.error', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Main entry point -----------------------------------------------------

/**
 * Run inference through the provider chain. Returns the model's text output
 * or null if all providers fail.
 *
 * @param {string} stage - Prompt stage (render_prepare, model_repair, copilot_enhance, etc.)
 * @param {object} context - Structured context for the prompt
 * @param {string} context.userPrompt - The user-facing content to transform
 * @param {string} [context.systemPrompt] - Override system prompt (otherwise built from stage)
 * @param {object} [context.profile] - InputProfile for structured context injection
 * @param {object} [context.extra] - Additional fields for enhancer bridge
 * @returns {Promise<{output: string|null, provider: string, noOp: boolean}>}
 */
/**
 * Run inference through the provider chain for a given stage.
 * Chain order depends on the stage: copilot stages prefer local first,
 * render stages prefer premium first.
 */
async function infer(stage, context = {}) {
  const promptConfig = context.systemPrompt
    ? { system: context.systemPrompt, temperature: 0 }
    : buildPrompt(stage);

  const systemPrompt = promptConfig.system;
  const userPrompt = context.userPrompt || '';

  // Copilot stages prefer local (cheap, fast) first
  const preferLocal = stage === 'copilot_suggest' || stage === 'copilot_enhance';

  const chain = preferLocal
    ? [
        { name: 'ollama',   check: () => _checkHealth('ollama'),   call: () => _callOllama(systemPrompt, userPrompt) },
        { name: 'enhancer', check: () => _checkHealth('enhancer'), call: () => _callEnhancer(systemPrompt, userPrompt, stage, context.extra) },
        { name: 'premium',  check: () => _checkHealth('premium'),  call: () => _callPremium(systemPrompt, userPrompt) },
      ]
    : [
        { name: 'premium',  check: () => _checkHealth('premium'),  call: () => _callPremium(systemPrompt, userPrompt) },
        { name: 'ollama',   check: () => _checkHealth('ollama'),   call: () => _callOllama(systemPrompt, userPrompt) },
        { name: 'enhancer', check: () => _checkHealth('enhancer'), call: () => _callEnhancer(systemPrompt, userPrompt, stage, context.extra) },
      ];

  for (const provider of chain) {
    const available = await provider.check();
    if (!available) continue;

    logger.info('provider.attempting', { provider: provider.name, stage });
    const output = await provider.call();

    if (!output || !output.trim()) {
      logger.warn('provider.empty_output', { provider: provider.name, stage });
      continue;
    }

    const isNoOp = output.trim() === userPrompt.trim();
    if (isNoOp) {
      logger.warn('provider.no_op', { provider: provider.name, stage });
      continue;
    }

    logger.info('provider.success', { provider: provider.name, stage, outputLen: output.length });
    return { output: output.trim(), provider: provider.name, noOp: false };
  }

  logger.warn('provider.all_failed', { stage });
  return { output: null, provider: 'none', noOp: true };
}

/**
 * Run inference using the strongest configured premium model (Max mode).
 * Falls back to default premium, then Ollama, then local.
 */
async function inferMax(stage, context = {}) {
  const maxModel = PREMIUM_MAX_MODEL || PREMIUM_MODEL;
  if (!PREMIUM_API_KEY) {
    logger.info('provider.max.no_api_key', { stage, fallback: 'infer' });
    return infer(stage, context);
  }

  const promptConfig = context.systemPrompt
    ? { system: context.systemPrompt, temperature: 0 }
    : buildPrompt(stage);

  const systemPrompt = promptConfig.system;
  const userPrompt = context.userPrompt || '';

  logger.info('provider.max.attempting', { model: maxModel, stage });
  const output = await _callPremium(systemPrompt, userPrompt, maxModel, MAX_INFER_TIMEOUT_MS);

  if (output && output.trim() && output.trim() !== userPrompt.trim()) {
    logger.info('provider.max.success', { model: maxModel, stage, outputLen: output.length });
    return { output: output.trim(), provider: `premium-max:${maxModel}`, noOp: false };
  }

  logger.warn('provider.max.failed', { model: maxModel, stage, fallback: 'default_infer' });
  return infer(stage, context);
}

/**
 * Check if Max mode is available (API key set and max model configured).
 */
function isMaxAvailable() {
  return !!(PREMIUM_API_KEY && MAX_ENABLED);
}

/**
 * Check which providers are currently available.
 * @returns {Promise<{premium: boolean, ollama: boolean, enhancer: boolean}>}
 */
async function checkProviders() {
  const [premium, ollama, enhancer] = await Promise.all([
    _checkHealth('premium'),
    _checkHealth('ollama'),
    _checkHealth('enhancer'),
  ]);
  return { premium, ollama, enhancer };
}

module.exports = { infer, inferMax, checkProviders, isMaxAvailable };
