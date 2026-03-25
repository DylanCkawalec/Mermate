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
const rmBridge = require('./rate-master-bridge');
const catalog = require('./model-catalog');

// ---- Configuration --------------------------------------------------------

// Single API key — prefer OPENAI_API_KEY (new), fall back to MERMATE_AI_API_KEY (legacy)
const PREMIUM_API_KEY   = process.env.OPENAI_API_KEY || process.env.MERMATE_AI_API_KEY || '';
const PREMIUM_PROVIDER  = process.env.MERMATE_AI_PROVIDER || 'openai';

// Tiered model pool — each stage picks the right tier
const MODELS = Object.freeze({
  // Orchestrator / final synthesis — most capable, slowest
  orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || process.env.MERMATE_AI_MAX_MODEL || 'gpt-4o',
  // Worker — primary reasoning, branch exploration, enhance
  worker:       process.env.MERMATE_WORKER_MODEL       || process.env.MERMATE_AI_MODEL       || 'gpt-4o',
  // Fast structured — JSON extraction, routing, repair, narration
  fast:         process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-4o-mini',
  // Validator / router — cheap scoring, suggestions
  nano:         process.env.MERMATE_ROUTER_MODEL       || 'gpt-4o-mini',
  // Image generation
  image:        process.env.MERMATE_IMAGE_MODEL        || 'gpt-image-1',
});

// Backward-compat aliases used throughout the file
const PREMIUM_MODEL     = MODELS.worker;
const PREMIUM_MAX_MODEL = MODELS.orchestrator;
const MAX_ENABLED       = process.env.MERMATE_AI_MAX_ENABLED === 'true';

const OLLAMA_URL   = process.env.LOCAL_LLM_BASE_URL || process.env.MERMATE_OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.LOCAL_LLM_MODEL    || process.env.MERMATE_OLLAMA_MODEL || 'gpt-oss:20b';

const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';

const INFER_TIMEOUT_MS     = parseInt(process.env.MERMATE_INFER_TIMEOUT || process.env.MERMATE_INFER_TIMEOUT_MS || '120000', 10);
const MAX_INFER_TIMEOUT_MS = parseInt(process.env.MERMATE_MAX_INFER_TIMEOUT || process.env.MERMATE_MAX_INFER_TIMEOUT_MS || '180000', 10);
const MAX_RETRIES          = parseInt(process.env.MERMATE_MAX_RETRIES || '2', 10);

// P3: Per-stage model routing — each stage gets the optimal model tier
const STAGE_MODEL_MAP = Object.freeze({
  fact_extraction:     MODELS.fast,         // structured JSON — gpt-4.1-mini
  diagram_plan:        MODELS.fast,         // structured JSON — gpt-4.1-mini
  composition:         MODELS.worker,       // creative Mermaid — gpt-5.2
  semantic_repair:     MODELS.fast,         // targeted JSON fix — gpt-4.1-mini
  copilot_suggest:     MODELS.nano,         // short completion — gpt-4.1-nano
  copilot_enhance:     MODELS.worker,       // full enhancement — gpt-5.2
  decompose:           MODELS.worker,       // multi-view reasoning — gpt-5.2
  render_prepare:      MODELS.worker,       // one-shot Mermaid — gpt-5.2
  model_repair:        MODELS.fast,         // targeted fix — gpt-4.1-mini
  max_composition:     MODELS.orchestrator, // final quality — gpt-5.4
  merge_composition:   MODELS.orchestrator, // merge all subviews into mega-diagram — gpt-5.4
  repair_from_trace:   MODELS.fast,         // error-trace repair — gpt-4.1-mini
  compose_ts:          MODELS.worker,       // runtime synthesis — gpt-5.2
  repair_ts:           MODELS.fast,         // compile/test repair — gpt-4.1-mini
  validate_ts:         MODELS.fast,         // validator commentary — gpt-4.1-mini
});

// P5: Per-stage token caps — right-size output budget to reduce waste
const STAGE_TOKEN_CAP = Object.freeze({
  fact_extraction:     2048,
  diagram_plan:        3072,
  composition:         8192,
  semantic_repair:     4096,
  copilot_suggest:     128,
  copilot_enhance:     8192,
  decompose:           6144,
  render_prepare:      8192,
  model_repair:        4096,
  max_composition:     16384,
  merge_composition:   16384,
  repair_from_trace:   4096,
  compose_ts:          16384,
  repair_ts:           8192,
  validate_ts:         4096,
});

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

// ---- Rate-limit aware HTTP call helper ------------------------------------

const _activeConcurrency = { count: 0 };

function _parseRetryAfter(res) {
  const header = res.headers.get('retry-after');
  if (!header) return 5000;
  const secs = parseInt(header, 10);
  return Number.isFinite(secs) ? secs * 1000 : 5000;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Core HTTP call with 429/503 retry logic, routed through rate-master's
 * OODA-driven adaptive queue for per-endpoint traffic shaping.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.headers
 * @param {object} opts.body
 * @param {number} opts.timeoutMs
 * @param {string} opts.model
 * @param {string} opts.logPrefix
 * @param {Array}  opts.rateEvents - accumulator for rate event metadata
 * @param {Function} opts.extractContent - (data) => string|null
 * @param {string} [opts.stage] - pipeline stage for rate-master priority
 * @param {string} [opts.inputText] - input text for context size estimation
 * @returns {Promise<{content: string|null, actionTag: object|null}>}
 */
async function _fetchWithRetry({ url, headers, body, timeoutMs, model, logPrefix, rateEvents, extractContent, stage, inputText }) {
  let lastError = null;
  let actionTag = null;

  const rawFetch = async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      _activeConcurrency.count++;
      try {
        const res = await fetch(url, {
          method: 'POST', headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // Feed upstream headers back to rate-master for self-calibration
        const remaining = res.headers.get('x-ratelimit-remaining');
        const resetAfter = res.headers.get('x-ratelimit-reset-after');
        const retryAfterHeader = res.headers.get('retry-after');
        if (remaining || resetAfter || retryAfterHeader) {
          rmBridge.feedback(model, {
            remainingRequests: remaining ? parseInt(remaining, 10) : undefined,
            resetAfterMs: resetAfter ? parseFloat(resetAfter) * 1000 : undefined,
            retryAfterMs: retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined,
            statusCode: res.status,
          });
        }

        if (res.status === 429 || res.status === 503) {
          const retryAfterMs = _parseRetryAfter(res);
          const eventType = res.status === 429 ? '429_rate_limit' : '503_overloaded';

          logger.warn(`${logPrefix}.rate_limited`, {
            model, status: res.status, retryAfterMs,
            attempt: attempt + 1, maxRetries: MAX_RETRIES,
            concurrency: _activeConcurrency.count,
          });

          const rateEvent = {
            type: eventType,
            http_status: res.status,
            retry_after_ms: retryAfterMs,
            retry_count: attempt + 1,
            concurrency_window: _activeConcurrency.count,
            deferred: false,
            downgraded_to: null,
            impact_ms: retryAfterMs,
          };

          if (attempt < MAX_RETRIES) {
            const backoff = retryAfterMs || (Math.pow(2, attempt + 1) * 1000);
            rateEvent.impact_ms = backoff;
            rateEvents.push(rateEvent);
            await _sleep(backoff);
            continue;
          }
          rateEvents.push(rateEvent);
          return null;
        }

        if (!res.ok) {
          logger.warn(`${logPrefix}.http_error`, { model, status: res.status });
          return null;
        }

        const data = await res.json();
        return extractContent(data);
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') {
          const rateEvent = {
            type: 'timeout', http_status: 0,
            retry_after_ms: 0, retry_count: attempt + 1,
            concurrency_window: _activeConcurrency.count,
            deferred: false, downgraded_to: null, impact_ms: timeoutMs,
          };
          rateEvents.push(rateEvent);
        }
        logger.warn(`${logPrefix}.error`, { model, error: err.message, attempt: attempt + 1 });
        if (attempt < MAX_RETRIES) {
          await _sleep(Math.pow(2, attempt + 1) * 1000);
          continue;
        }
      } finally {
        _activeConcurrency.count--;
        clearTimeout(timer);
      }
    }

    logger.warn(`${logPrefix}.exhausted`, { model, error: lastError?.message });
    return null;
  };

  // Route through rate-master's adaptive queue
  try {
    const executed = await rmBridge.execute(stage || logPrefix, model, inputText, rawFetch);
    actionTag = executed.actionTag;
    return { content: executed.result, actionTag };
  } catch {
    // If rate-master fails to execute (queue timeout etc.), fall through directly
    const content = await rawFetch();
    return { content, actionTag };
  }
}

/**
 * Call the premium API with an explicit API key (for role-based inference).
 * Includes 429/503 retry with exponential backoff.
 * @returns {Promise<{content: string|null, actionTag: object|null}>}
 */
async function _callPremiumWithKey(apiKey, systemPrompt, userPrompt, modelOverride, timeoutMs, rateEvents, stage) {
  const model = modelOverride || PREMIUM_MODEL;
  const events = rateEvents || [];
  const tokenParam = catalog.usesCompletionTokens(model) ? { max_completion_tokens: 16384 } : { max_tokens: 8192 };

  return _fetchWithRetry({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: {
      model, temperature: 0, ...tokenParam,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    },
    timeoutMs: timeoutMs || INFER_TIMEOUT_MS,
    model,
    logPrefix: 'provider.role',
    rateEvents: events,
    extractContent: (data) => data.choices?.[0]?.message?.content || null,
    stage: stage || 'copilot_enhance',
    inputText: userPrompt,
  });
}

/**
 * @returns {Promise<{content: string|null, actionTag: object|null}>}
 */
async function _callPremium(systemPrompt, userPrompt, modelOverride, timeoutMs, maxTokensOverride, rateEvents, stage) {
  const model = modelOverride || PREMIUM_MODEL;
  const timeout = timeoutMs || INFER_TIMEOUT_MS;
  const events = rateEvents || [];

  if (PREMIUM_PROVIDER === 'anthropic') {
    return _fetchWithRetry({
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PREMIUM_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model, max_tokens: 8192, temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      timeoutMs: timeout, model,
      logPrefix: 'provider.premium',
      rateEvents: events,
      extractContent: (data) => data.content?.[0]?.text || null,
      stage: stage || 'copilot_enhance',
      inputText: userPrompt,
    });
  }

  const tokenLimit = maxTokensOverride || 16384;
  const tokenParam = catalog.usesCompletionTokens(model)
    ? { max_completion_tokens: tokenLimit }
    : { max_tokens: Math.min(tokenLimit, 8192) };

  return _fetchWithRetry({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PREMIUM_API_KEY}`,
    },
    body: {
      model, temperature: 0, ...tokenParam,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    },
    timeoutMs: timeout, model,
    logPrefix: 'provider.premium',
    rateEvents: events,
    extractContent: (data) => data.choices?.[0]?.message?.content || null,
    stage: stage || 'copilot_enhance',
    inputText: userPrompt,
  });
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
  const rateEvents = [];

  const stageModel = STAGE_MODEL_MAP[stage] || PREMIUM_MODEL;
  const stageTokenCap = STAGE_TOKEN_CAP[stage] || undefined;

  const preferLocal = stage === 'copilot_suggest' || stage === 'copilot_enhance';

  // Lazy health checks — skip network probes for providers we won't need
  const premiumOk = await _checkHealth('premium');
  let ollamaOk, enhancerOk;
  if (premiumOk && !preferLocal) {
    // Premium is first in chain and available — defer local checks until needed
    ollamaOk = false;
    enhancerOk = false;
  } else {
    [ollamaOk, enhancerOk] = await Promise.all([
      _checkHealth('ollama'),
      _checkHealth('enhancer'),
    ]);
  }

  const providers = [
    { name: 'premium',  ok: premiumOk,  call: () => _callPremium(systemPrompt, userPrompt, stageModel, undefined, stageTokenCap, rateEvents, stage), isPremium: true },
    { name: 'ollama',   ok: ollamaOk,   call: () => _callOllama(systemPrompt, userPrompt), isPremium: false },
    { name: 'enhancer', ok: enhancerOk, call: () => _callEnhancer(systemPrompt, userPrompt, stage, context.extra), isPremium: false },
  ];

  // Reorder: local-first for copilot stages, premium-first otherwise
  const chain = preferLocal
    ? [providers[1], providers[2], providers[0]]
    : providers;

  let _localChecked = ollamaOk || enhancerOk;

  for (const prov of chain) {
    // Lazy fallback: if premium exhausted without result, check local providers on demand
    if (!prov.ok && !prov.isPremium && !_localChecked) {
      _localChecked = true;
      [ollamaOk, enhancerOk] = await Promise.all([_checkHealth('ollama'), _checkHealth('enhancer')]);
      providers[1].ok = ollamaOk;
      providers[2].ok = enhancerOk;
      if (!prov.ok) prov.ok = prov.name === 'ollama' ? ollamaOk : enhancerOk;
    }
    if (!prov.ok) continue;

    logger.info('provider.route', { provider: prov.name, stage, tier: prov.isPremium ? catalog.classifyTier(stageModel) : catalog.Tier.LOCAL });
    const callStart = Date.now();
    const callResult = await prov.call();
    const latencyMs = Date.now() - callStart;

    const output = prov.isPremium ? callResult?.content : callResult;
    const actionTag = prov.isPremium ? callResult?.actionTag : null;

    if (!output || !output.trim()) {
      logger.warn('provider.empty', { provider: prov.name, stage, ms: latencyMs });
      // On premium failure, trigger lazy local check for remaining chain items
      if (prov.isPremium && !_localChecked) {
        _localChecked = true;
        [ollamaOk, enhancerOk] = await Promise.all([_checkHealth('ollama'), _checkHealth('enhancer')]);
        providers[1].ok = ollamaOk;
        providers[2].ok = enhancerOk;
      }
      continue;
    }

    if (output.trim() === userPrompt.trim()) {
      logger.warn('provider.noop', { provider: prov.name, stage, ms: latencyMs });
      continue;
    }

    logger.info('provider.ok', { provider: prov.name, stage, len: output.length, ms: latencyMs, model: prov.isPremium ? stageModel : undefined, tag: actionTag?.tag });
    return {
      output: output.trim(), provider: prov.name, noOp: false, latencyMs,
      model: prov.isPremium ? stageModel : (prov.name === 'ollama' ? OLLAMA_MODEL : 'enhancer'),
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
    };
  }

  logger.warn('provider.exhausted', { stage });
  return { output: null, provider: 'none', noOp: true, latencyMs: 0, model: 'none', rateEvents: rateEvents.length ? rateEvents : undefined };
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
  const rateEvents = [];

  logger.info('provider.max.attempting', { model: maxModel, stage });
  const callStart = Date.now();
  const callResult = await _callPremium(systemPrompt, userPrompt, maxModel, MAX_INFER_TIMEOUT_MS, undefined, rateEvents, stage);
  const latencyMs = Date.now() - callStart;
  const output = callResult?.content;
  const actionTag = callResult?.actionTag;

  if (output && output.trim() && output.trim() !== userPrompt.trim()) {
    logger.info('provider.max.success', { model: maxModel, stage, outputLen: output.length, latencyMs, rmTag: actionTag?.tag });
    return {
      output: output.trim(), provider: `premium-max:${maxModel}`, noOp: false, latencyMs, model: maxModel,
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
    };
  }

  if (rateEvents.length) {
    logger.warn('provider.max.rate_limited_downgrade', { model: maxModel, stage, events: rateEvents.length });
  }
  logger.warn('provider.max.failed', { model: maxModel, stage, fallback: 'default_infer', latencyMs });
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

// ---- Allowed stages for role-based inference --------------------------------
// Only these stages may use a named role. All other stages fall through
// to the default provider chain. This prevents arbitrary role execution.
const ROLE_ALLOWED_STAGES = new Set([
  'fact_extraction',
  'diagram_plan',
  'composition',
  'semantic_repair',
  'render_prepare',
  'decompose',
  'repair_from_trace',
  'copilot_enhance',
]);

/**
 * Run inference using a specific named role's credentials and model.
 *
 * Stage-safe: only stages in ROLE_ALLOWED_STAGES may use a role.
 * Controller-gated: if the role is not found, not enabled, or has no
 * valid API key, falls through to the default infer() chain.
 *
 * This function does NOT schedule agents or launch workers. It simply
 * uses the role's API key and model for a single inference call within
 * the bounded controller pipeline.
 *
 * @param {string} stage - Pipeline stage name
 * @param {object} context - Same as infer() context
 * @param {string} roleName - Name from ARCHITECT_AI_{N}_NAME
 * @returns {Promise<{output: string|null, provider: string, noOp: boolean}>}
 */
async function inferWithRole(stage, context, roleName) {
  if (!ROLE_ALLOWED_STAGES.has(stage)) {
    logger.info('provider.role.stage_blocked', { stage, roleName, reason: 'stage not allowed for role inference' });
    return infer(stage, context);
  }

  const registry = require('./role-registry');
  const role = registry.getRoleByName(roleName);

  if (!role || !role.enabled) {
    logger.info('provider.role.not_available', { roleName, found: !!role, enabled: role?.enabled });
    return infer(stage, context);
  }

  const apiKey = role.apiKey;
  if (!apiKey || apiKey.startsWith('{')) {
    logger.info('provider.role.no_valid_key', { roleName, reason: 'unresolved or empty key' });
    return infer(stage, context);
  }

  const model = role.model || PREMIUM_MODEL;

  // ALWAYS use the axiom-based stage prompt — never bypass it.
  // The context.systemPrompt (if any) is agent role context injected into
  // the user prompt by the caller, not a system prompt override.
  const promptConfig = buildPrompt(stage);
  const systemPrompt = promptConfig.system;
  const userPrompt = context.userPrompt || '';

  logger.info('provider.role.attempting', { roleName, model, stage, domain: role.domain });

  const rateEvents = [];
  const callStart = Date.now();
  try {
    const callResult = await _callPremiumWithKey(apiKey, systemPrompt, userPrompt, model, INFER_TIMEOUT_MS, rateEvents, stage);
    const latencyMs = Date.now() - callStart;
    const output = callResult?.content;
    const actionTag = callResult?.actionTag;

    if (!output || !output.trim()) {
      logger.warn('provider.role.empty_output', { roleName, stage, latencyMs });
      return infer(stage, context);
    }

    if (output.trim() === userPrompt.trim()) {
      logger.warn('provider.role.no_op', { roleName, stage, latencyMs });
      return infer(stage, context);
    }

    logger.info('provider.role.success', { roleName, model, stage, outputLen: output.length, latencyMs, rmTag: actionTag?.tag });
    return {
      output: output.trim(), provider: `role:${roleName}:${model}`, noOp: false, latencyMs, model,
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
    };
  } catch (err) {
    const latencyMs = Date.now() - callStart;
    logger.warn('provider.role.error', { roleName, stage, error: err.message, latencyMs });
    return infer(stage, context);
  }
}

module.exports = { infer, inferMax, inferWithRole, checkProviders, isMaxAvailable };
