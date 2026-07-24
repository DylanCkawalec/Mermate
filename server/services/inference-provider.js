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

// Opseeq gateway — when set, routes all OpenAI-compatible calls through the gateway.
// If the gateway is unreachable, falls back to direct OpenAI API automatically.
const OPENAI_DIRECT_URL = 'https://api.openai.com/v1';

// Normalise OPSEEQ_URL: strip trailing slash, ensure /v1 suffix for
// OpenAI-compatible inference endpoint.  If the env var already ends
// with /v1 we keep it; otherwise we append it.
function _normaliseInferenceBase(raw) {
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL
  || _normaliseInferenceBase(process.env.OPSEEQ_URL)
  || OPENAI_DIRECT_URL;
const _useDirectFallback = OPENAI_BASE_URL !== OPENAI_DIRECT_URL;

// When the primary gateway (Opseeq) fails, fall back to the real OpenAI API.
// The Mermate model aliases (gpt-5.6-*) are not real OpenAI IDs, so map them
// to a known working model and strip parameters that only reasoning models accept.
const OPENAI_DIRECT_FALLBACK_MODEL = process.env.OPENAI_DIRECT_FALLBACK_MODEL || 'gpt-4o';

function _isMermateAlias(model) {
  return /^gpt-5\.6-(sol|terra|luna)/i.test(model || '');
}

function _normalizeDirectFallbackModel(model) {
  if (OPENAI_DIRECT_FALLBACK_MODEL && _isMermateAlias(model)) {
    return OPENAI_DIRECT_FALLBACK_MODEL;
  }
  return model;
}

function _isReasoningModel(model) {
  return /^o[1-9]/i.test(model || '') || /^o3/i.test(model || '');
}

// Shared trace ID — set by input-router.js via setTraceId() so every
// inference call correlates with the MERMATE run in Opseeq's trace.
let _traceId = null;
function setTraceId(id) { _traceId = id; _fallbackEvents.length = 0; }

// Forward Reasoning Memory — per-run accumulator of agent insights.
// Each stage appends a compact reasoning summary that downstream stages
// receive as part of their system prompt. This creates the shared
// "reasoning log" that lets GoT agents communicate across the pipeline.
//
// Structure: [{ stage, model, insight, timestamp }]
// The insight is a 1-3 sentence summary of what the agent determined
// (entities found, decisions made, invariants checked, failures detected).
const _reasoningMemory = [];
const REASONING_MEMORY_MAX_ENTRIES = 8;
const REASONING_MEMORY_MAX_CHARS = 4000;

function clearReasoningMemory() { _reasoningMemory.length = 0; }

function appendReasoningMemory(stage, model, output) {
  if (!output || output.length < 50) return;
  // Extract a compact insight from the output
  let insight = '';
  // For JSON outputs, extract key structural facts
  if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(output.trim().replace(/^```json\s*|\s*```$/g, ''));
      if (parsed.entities) insight = `Found ${parsed.entities.length} entities, ${(parsed.relationships || []).length} relationships`;
      else if (parsed.nodes) insight = `Planned ${parsed.nodes.length} nodes, ${(parsed.edges || []).length} edges, ${(parsed.subgraphs || []).length} subgraphs`;
      else if (parsed.viewName) insight = `Decomposed view: ${parsed.viewName}`;
      else insight = output.slice(0, 200).replace(/\n/g, ' ');
    } catch {
      insight = output.slice(0, 200).replace(/\n/g, ' ');
    }
  } else {
    // For text outputs (Mermaid, TLA+), extract structural summary
    const lines = output.split('\n').filter(l => l.trim() && !l.trim().startsWith('%%') && !l.trim().startsWith('---'));
    const nodeCount = (output.match(/\[[\w"' ]+\]|\([\w"' ]+\)|\{[\w"' ]+\}/g) || []).length;
    const edgeCount = (output.match(/-->|-.->|==>/g) || []).length;
    if (nodeCount > 0 || edgeCount > 0) {
      insight = `Generated ${nodeCount} nodes, ${edgeCount} edges`;
    } else {
      insight = lines.slice(0, 3).join(' ').slice(0, 200);
    }
  }

  _reasoningMemory.push({ stage, model, insight, timestamp: Date.now() });
  // Trim to max entries, keeping most recent
  while (_reasoningMemory.length > REASONING_MEMORY_MAX_ENTRIES) {
    _reasoningMemory.shift();
  }
}

function getReasoningMemoryBlock() {
  if (_reasoningMemory.length === 0) return '';
  const lines = _reasoningMemory.map(e =>
    `[${e.stage}|${e.model}] ${e.insight}`
  );
  const block = lines.join('\n');
  // Truncate to max chars, keeping most recent
  if (block.length > REASONING_MEMORY_MAX_CHARS) {
    return block.slice(-REASONING_MEMORY_MAX_CHARS);
  }
  return block;
}

// Architecture depth tier for the active run — `shallow` | `medium` | `deep`.
// Set by render.js before the pipeline starts; cleared in `finally`.
// Drives _selectModelForStage so deeper architectures escalate the final
// composition / merge / max stages to the orchestrator tier even when the
// user did NOT explicitly request Max mode.
let _depthTier = null;
function setDepthTier(tier) { _depthTier = tier || null; }
function getDepthTier() { return _depthTier; }

// Accumulates direct-fallback events for the current run so the render
// response can include them in the UI payload.
const _fallbackEvents = [];
function getFallbackEvents() { return _fallbackEvents.slice(); }
function clearFallbackEvents() { _fallbackEvents.length = 0; }

// ---- Inference activity tracker --------------------------------------------
// Let the Opseeq lifecycle manager know the server is actively using the
// premium provider so it does not shut the gateway down during a run.
let _lastInferenceAt = Date.now();
let _activeInferenceCount = 0;
function touchInferenceActivity() { _lastInferenceAt = Date.now(); }
function getLastInferenceAt() { return _lastInferenceAt; }
function getActiveInferenceCount() { return _activeInferenceCount; }

// ---- Trace helpers --------------------------------------------------------
// Emit a single compact inference.trace event for every provider attempt.
// This lets the OODA universal tracer correlate calls, providers, models,
// latencies, and failures without parsing verbose provider.* events.

function _classifyInferenceError(error) {
  if (!error) return 'ok';
  const e = String(error).toLowerCase();
  if (e.includes('timeout') || e.includes('abort')) return 'timeout';
  if (e.includes('429') || e.includes('rate') || e.includes('too many')) return 'rate_limit';
  if (e.includes('parse') || e.includes('json')) return 'parse';
  if (e.includes('schema') || e.includes('contract')) return 'schema';
  if (e.includes('exhausted') || e.includes('unavailable') || e.includes('enotfound')) return 'provider_exhausted';
  if (e.includes('refus')) return 'model_refusal';
  return 'unknown';
}

function _emitInferenceTrace({ stage, provider, model, result, latencyMs, error, outputLen, traceId }) {
  const errorClass = _classifyInferenceError(error);
  const payload = {
    stage,
    provider,
    model: model || 'unknown',
    result: result || (error ? 'error' : 'empty'),
    latencyMs,
    error_class: errorClass,
  };
  if (outputLen != null) payload.outputLen = outputLen;
  if (error) payload.error = String(error).slice(0, 120);
  if (traceId || _traceId) payload.traceId = traceId || _traceId;
  logger.info('inference.trace', payload);
}

// Tiered model pool — each stage picks the right tier
const MODELS = Object.freeze({
  // Orchestrator / final synthesis — most capable, slowest
  orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || process.env.MERMATE_AI_MAX_MODEL || 'gpt-5.6-sol',
  // Worker — primary reasoning, branch exploration, enhance
  worker:       process.env.MERMATE_WORKER_MODEL       || process.env.MERMATE_AI_MODEL       || 'gpt-5.6-terra',
  // Fast structured — JSON extraction, routing, repair, narration
  fast:         process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-5.6-luna',
  // Validator / router — cheap scoring, suggestions
  nano:         process.env.MERMATE_ROUTER_MODEL       || 'gpt-5.6-luna',
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
  fact_extraction:     MODELS.worker,       // richer fact extraction — gpt-5.6-terra
  diagram_plan:        MODELS.worker,       // better plan structure — gpt-5.6-terra
  composition:         MODELS.worker,       // creative Mermaid — gpt-5.6-terra
  semantic_repair:     MODELS.fast,         // targeted JSON fix — gpt-5.6-luna
  copilot_suggest:     MODELS.nano,         // short completion — gpt-5.6-luna
  copilot_enhance:     MODELS.worker,       // full enhancement — gpt-5.6-terra
  decompose:           MODELS.worker,       // multi-view reasoning — gpt-5.6-terra
  render_prepare:      MODELS.worker,       // one-shot Mermaid — gpt-5.6-terra
  model_repair:        MODELS.fast,         // targeted fix — gpt-5.6-luna
  max_composition:     MODELS.orchestrator, // final quality — gpt-5.6-sol
  merge_composition:   MODELS.orchestrator, // merge all subviews — gpt-5.6-sol
  repair_from_trace:   MODELS.fast,         // error-trace repair — gpt-5.6-luna
  compose_ts:          MODELS.worker,       // runtime synthesis — gpt-5.6-terra
  repair_ts:           MODELS.fast,         // compile/test repair — gpt-5.6-luna
  validate_ts:         MODELS.fast,         // validator commentary — gpt-5.6-luna
  compose_rust:        MODELS.worker,       // Rust codegen — gpt-5.6-terra
  repair_rust:         MODELS.fast,         // cargo error repair — gpt-5.6-luna
  compose_tla:         MODELS.orchestrator, // formal spec synthesis — gpt-5.6-sol
  repair_tla:          MODELS.fast,         // SANY error repair — gpt-5.6-luna
});

// Per-stage reasoning effort for GPT-5.6 models.
// Supports: none, low, medium, high, xhigh, max.
// Lower effort = lower latency + cost; higher effort = deeper reasoning.
const STAGE_REASONING_MAP = Object.freeze({
  fact_extraction:     'low',       // simple extraction, low latency
  diagram_plan:        'medium',    // structural reasoning needed
  composition:         'high',      // creative Mermaid generation
  max_composition:     'high',      // final quality synthesis
  merge_composition:   'high',      // complex merge of subviews
  copilot_enhance:     'medium',    // balanced enhancement
  copilot_suggest:     'low',       // fast autocomplete
  semantic_repair:     'low',       // targeted fix
  render_prepare:      'high',      // one-shot render quality
  decompose:           'medium',    // multi-view reasoning
  model_repair:        'low',       // targeted fix
  repair_from_trace:   'medium',    // error-trace analysis
  compose_ts:          'high',      // code generation
  repair_ts:           'medium',    // compile error fixing
  validate_ts:         'low',       // validation commentary
  compose_rust:        'high',      // Rust codegen
  repair_rust:         'medium',    // cargo error repair
  compose_tla:         'high',      // formal specification — deep rigor, balanced latency
  repair_tla:          'medium',    // targeted SANY error fixing
});

// Stages that produce structured JSON output.
// Tier 1: json_schema — exact schema enforced by the API, zero parsing failures.
// Tier 2: json_object — valid JSON guaranteed, shape validated downstream.
// Text stages use no response_format — they need free-form reasoning output.
const STAGE_JSON_SCHEMA = new Set([
  'fact_extraction',
  'diagram_plan',
  'decompose',
  'validate_ts',
]);

const STAGE_JSON_OBJECT = new Set([
  'semantic_repair',
  'compose_ts',
  'repair_ts',
]);

// Union for backward compat — any stage that needs structured output
const STAGE_STRUCTURED_OUTPUT = new Set([...STAGE_JSON_SCHEMA, ...STAGE_JSON_OBJECT]);

// JSON schemas for Tier 1 stages — enforced by OpenAI structured outputs.
// This eliminates JSON parsing failures and reduces reasoning overhead
// (the model doesn't waste tokens guessing the output shape).
const STAGE_JSON_SCHEMAS = {
  fact_extraction: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['actor', 'service', 'store', 'gateway', 'broker', 'cache', 'queue', 'external', 'decision', 'boundary'] },
            responsibility: { type: 'string' },
          },
          required: ['name', 'type', 'responsibility'],
          additionalProperties: false,
        },
      },
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            verb: { type: 'string' },
            edgeType: { type: 'string' },
          },
          required: ['from', 'to', 'verb', 'edgeType'],
          additionalProperties: false,
        },
      },
      boundaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            members: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'members'],
          additionalProperties: false,
        },
      },
      failurePaths: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            trigger: { type: 'string' },
            condition: { type: 'string' },
            handler: { type: 'string' },
            recovery: { type: 'string' },
          },
          required: ['trigger', 'condition', 'handler', 'recovery'],
          additionalProperties: false,
        },
      },
      diagramType: { type: 'string', enum: ['flowchart', 'sequence', 'state', 'er', 'gantt', 'mindmap'] },
    },
    required: ['entities', 'relationships', 'boundaries', 'failurePaths', 'diagramType'],
    additionalProperties: false,
  },

  diagram_plan: {
    type: 'object',
    properties: {
      directive: { type: 'string' },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            shape: { type: 'string', enum: ['rectangle', 'stadium', 'cylinder', 'diamond', 'hexagon', 'rounded'] },
            entityRef: { type: 'string' },
          },
          required: ['id', 'label', 'shape', 'entityRef'],
          additionalProperties: false,
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            label: { type: 'string' },
            style: { type: 'string', enum: ['solid', 'dashed', 'thick'] },
            relationRef: { type: 'string' },
          },
          required: ['from', 'to', 'label', 'style', 'relationRef'],
          additionalProperties: false,
        },
      },
      subgraphs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            nodeIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title', 'nodeIds'],
          additionalProperties: false,
        },
      },
      classDefs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            style: { type: 'string' },
          },
          required: ['name', 'style'],
          additionalProperties: false,
        },
      },
    },
    required: ['directive', 'nodes', 'edges', 'subgraphs', 'classDefs'],
    additionalProperties: false,
  },

  decompose: {
    type: 'object',
    properties: {
      views: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            viewName: { type: 'string' },
            viewDescription: { type: 'string' },
            suggestedType: { type: 'string' },
            entities: { type: 'array', items: { type: 'string' } },
            relationships: { type: 'array', items: { type: 'string' } },
          },
          required: ['viewName', 'viewDescription', 'suggestedType', 'entities', 'relationships'],
          additionalProperties: false,
        },
      },
    },
    required: ['views'],
    additionalProperties: false,
  },

  validate_ts: {
    type: 'object',
    properties: {
      valid: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['error', 'warning', 'info'] },
            message: { type: 'string' },
            location: { type: 'string' },
          },
          required: ['severity', 'message'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string' },
    },
    required: ['valid', 'issues', 'summary'],
    additionalProperties: false,
  },
};

// Stages that benefit most from local AI bootstrapping. The premium chain
// remains a fallback when local providers are unavailable, but giving local
// AI first crack at extracting facts and proposing a diagram plan builds the
// "depth of model" before the premium API does final composition.
//
// Note: `copilot_suggest` and `copilot_enhance` are deliberately NOT in this
// set. They are interactive UX features that must respond in under 2 seconds.
// Routing them to a 20B local model on cold-start would block the textarea
// for tens of seconds and feel broken to the user. Premium-first keeps the
// click-to-result latency in the 700–1500ms range while local remains a
// fallback if no premium key is configured.
const LOCAL_PREFERRED_STAGES = new Set([
  'fact_extraction',
  'diagram_plan',
]);

// Stages where the final architectural quality is most sensitive — these
// escalate to the orchestrator tier whenever the run's depth tier is
// `medium` or `deep`, even without the user-facing Max toggle.
const DEPTH_ESCALATING_STAGES = new Set([
  'composition',
  'max_composition',
  'merge_composition',
]);

/**
 * Pick the model for a stage, taking the current depth tier into account.
 * Falls back to STAGE_MODEL_MAP, then to PREMIUM_MODEL.
 */
function _selectModelForStage(stage) {
  const baseModel = STAGE_MODEL_MAP[stage] || PREMIUM_MODEL;
  if (!DEPTH_ESCALATING_STAGES.has(stage)) return baseModel;
  if (_depthTier === 'medium' || _depthTier === 'deep') {
    return MODELS.orchestrator;
  }
  return baseModel;
}

function _selectReasoningEffort(stage) {
  return STAGE_REASONING_MAP[stage] || 'medium';
}

function _isStructuredStage(stage) {
  return STAGE_STRUCTURED_OUTPUT.has(stage);
}

// Resolve the response_format for a given stage.
// Returns { type: 'json_schema', json_schema: { ... } } for Tier 1 stages,
// { type: 'json_object' } for Tier 2, or undefined for text stages.
function _resolveResponseFormat(stage, override) {
  if (override) return override;
  if (STAGE_JSON_SCHEMA.has(stage) && STAGE_JSON_SCHEMAS[stage]) {
    return {
      type: 'json_schema',
      json_schema: {
        name: stage,
        schema: STAGE_JSON_SCHEMAS[stage],
        strict: true,
      },
    };
  }
  if (STAGE_JSON_OBJECT.has(stage)) {
    return { type: 'json_object' };
  }
  return undefined;
}

// P5: Per-stage token caps — right-size output budget to reduce waste.
// These caps include reasoning tokens for GPT-5.6 reasoning models.
// OpenAI recommends reserving at least 25K tokens for xhigh reasoning.
// Stages using xhigh/high reasoning get larger budgets; fast stages get less.
const STAGE_TOKEN_CAP = Object.freeze({
  fact_extraction:     8192,   // structured JSON — low reasoning
  diagram_plan:        8192,   // structured JSON — low reasoning
  composition:         16384,  // creative Mermaid — medium reasoning
  semantic_repair:     8192,   // targeted JSON fix — low reasoning
  copilot_suggest:     1024,   // short completion — minimal reasoning
  copilot_enhance:     16384,  // full enhancement — medium reasoning
  decompose:           12288,  // multi-view reasoning — medium
  render_prepare:      16384,  // one-shot Mermaid — medium
  model_repair:        8192,   // targeted fix — low reasoning
  max_composition:     32768,  // final quality — high reasoning, needs room
  merge_composition:   32768,  // merge all subviews — high reasoning
  repair_from_trace:   8192,   // error-trace repair — low
  compose_ts:          32768,  // runtime synthesis — high reasoning
  repair_ts:           16384,  // compile/test repair — medium
  validate_ts:         8192,   // validator commentary — low
  compose_tla:         32768,  // formal spec synthesis — xhigh reasoning, needs 25K+
  repair_tla:          16384,  // SANY error repair — medium reasoning
});

// Reasoning overhead multiplier — reasoning models burn tokens on invisible reasoning.
// Multiply the stage cap by this factor to ensure enough budget for output + reasoning.
const REASONING_TOKEN_MULTIPLIER = 2.0;

function _resolveTokenLimit(stage, model) {
  const baseCap = STAGE_TOKEN_CAP[stage] || 16384;
  const isReasoningModel = catalog.usesCompletionTokens(model);
  if (isReasoningModel) {
    return Math.min(baseCap * REASONING_TOKEN_MULTIPLIER, 65536);
  }
  return Math.min(baseCap, 8192);
}

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
async function _fetchWithRetry({ url, headers, body, timeoutMs, model, logPrefix, rateEvents, extractContent, stage, inputText, traceId, reasoningEffort, responseFormat }) {
  let lastError = null;
  let actionTag = null;
  let _usedDirectFallback = false;

  // Thread MERMATE run_id as X-Request-Id for Opseeq trace correlation
  const traceHeaders = { ...headers };
  if (traceId) traceHeaders['X-Request-Id'] = traceId;

  const rawFetch = async () => {
    const finalBody = { ...body };
    if (reasoningEffort) finalBody.reasoning_effort = reasoningEffort;
    if (responseFormat) finalBody.response_format = responseFormat;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      _activeConcurrency.count++;
      try {
        const res = await fetch(url, {
          method: 'POST', headers: traceHeaders,
          body: JSON.stringify(finalBody),
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

        if (res.status === 429 || res.status === 503 || (res.status >= 500 && res.status < 600)) {
          const retryAfterMs = _parseRetryAfter(res);
          const eventType = res.status === 429 ? '429_rate_limit' : `${res.status}_server_error`;

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

        // Track prompt caching stats from API response
        const usage = data.usage;
        if (usage && (usage.prompt_tokens_details?.cached_tokens || usage.cache_write_tokens)) {
          const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
          const cacheWriteTokens = usage.cache_write_tokens || 0;
          if (cachedTokens > 0 || cacheWriteTokens > 0) {
            rateEvents.push({
              type: 'prompt_cache',
              cached_tokens: cachedTokens,
              cache_write_tokens: cacheWriteTokens,
              model,
              stage: stage || logPrefix,
            });
            logger.info(`${logPrefix}.cache`, {
              model, cached: cachedTokens, written: cacheWriteTokens,
              stage: stage || logPrefix,
            });
          }
        }

        const content = extractContent(data);
        if (!content && data.choices?.[0]) {
          const choice = data.choices[0];
          logger.warn(`${logPrefix}.empty_content`, {
            model, stage: stage || logPrefix,
            finish_reason: choice.finish_reason,
            reasoning_tokens: data.usage?.completion_tokens_details?.reasoning_tokens,
            completion_tokens: data.usage?.completion_tokens,
            max_completion_tokens: finalBody.max_completion_tokens,
          });
        }
        return content;
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
    if (executed.result) return { content: executed.result, actionTag };
  } catch (rmErr) {
    logger.warn('provider.rate_master_fallback', { stage, model, error: rmErr?.message || 'unknown' });
    const content = await rawFetch();
    if (content) return { content, actionTag };
  }

  // Direct-OpenAI fallback: if the primary gateway exhausted, retry once against api.openai.com
  if (_useDirectFallback && url.startsWith(OPENAI_BASE_URL)) {
    const directUrl = url.replace(OPENAI_BASE_URL, OPENAI_DIRECT_URL);
    logger.info(`${logPrefix}.direct_fallback`, { model, from: OPENAI_BASE_URL, to: OPENAI_DIRECT_URL });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const finalBody = { ...body };
      finalBody.model = _normalizeDirectFallbackModel(finalBody.model);
      if (!_isReasoningModel(finalBody.model)) {
        delete finalBody.reasoning_effort;
        const tokenCap = finalBody.max_completion_tokens || finalBody.max_tokens || 4096;
        finalBody.max_tokens = Math.min(tokenCap, 4096);
        delete finalBody.max_completion_tokens;
      }
      if (reasoningEffort && _isReasoningModel(finalBody.model)) finalBody.reasoning_effort = reasoningEffort;
      if (responseFormat) finalBody.response_format = responseFormat;

      // OpenAI's json_object mode requires the word 'json' to appear in the
      // conversation. Append a lowercase reminder if the prompt only uses 'JSON'.
      if (finalBody.response_format?.type === 'json_object' && Array.isArray(finalBody.messages)) {
        const hasJson = finalBody.messages.some(m => typeof m.content === 'string' && /json/i.test(m.content));
        if (!hasJson) {
          finalBody.messages = finalBody.messages.concat({ role: 'user', content: 'Return valid json.' });
        }
      }

      const res = await fetch(directUrl, {
        method: 'POST', headers: traceHeaders,
        body: JSON.stringify(finalBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        logger.warn(`${logPrefix}.direct_fallback_http_error`, { model: finalBody.model, status: res.status, body: errText.slice(0, 200) });
      } else {
        const data = await res.json();
        const content = extractContent(data);
        if (content) {
          _fallbackEvents.push({ ts: Date.now(), stage: stage || logPrefix, model, from: OPENAI_BASE_URL, to: OPENAI_DIRECT_URL });
          return { content, actionTag, usedDirectFallback: true };
        }
      }
    } catch (err) {
      logger.warn(`${logPrefix}.direct_fallback_failed`, { error: err.message });
    } finally {
      clearTimeout(timer);
    }
  }

  return { content: null, actionTag };
}

/**
 * Call the premium API with an explicit API key (for role-based inference).
 * Includes 429/503 retry with exponential backoff.
 * @returns {Promise<{content: string|null, actionTag: object|null}>}
 */
async function _callPremiumWithKey(apiKey, systemPrompt, userPrompt, modelOverride, timeoutMs, rateEvents, stage, reasoningEffort, responseFormat) {
  const model = modelOverride || PREMIUM_MODEL;
  const events = rateEvents || [];
  const tokenLimit = _resolveTokenLimit(stage, model);
  const tokenParam = catalog.usesCompletionTokens(model) ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit };

  return _fetchWithRetry({
    url: `${OPENAI_BASE_URL}/chat/completions`,
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
    traceId: _traceId,
    reasoningEffort: reasoningEffort || _selectReasoningEffort(stage),
    responseFormat: responseFormat || _resolveResponseFormat(stage),
  });
}

/**
 * @returns {Promise<{content: string|null, actionTag: object|null}>}
 */
async function _callPremium(systemPrompt, userPrompt, modelOverride, timeoutMs, maxTokensOverride, rateEvents, stage, reasoningEffort, responseFormat) {
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
      traceId: _traceId,
    });
  }

  const tokenLimit = maxTokensOverride || _resolveTokenLimit(stage, model);
  const tokenParam = catalog.usesCompletionTokens(model)
    ? { max_completion_tokens: tokenLimit }
    : { max_tokens: Math.min(tokenLimit, 8192) };

  return _fetchWithRetry({
    url: `${OPENAI_BASE_URL}/chat/completions`,
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
    traceId: _traceId,
    reasoningEffort: reasoningEffort || _selectReasoningEffort(stage),
    responseFormat: responseFormat || _resolveResponseFormat(stage),
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
  _activeInferenceCount++;
  touchInferenceActivity();
  try {
  const promptConfig = context.systemPrompt
    ? { system: context.systemPrompt, temperature: 0 }
    : buildPrompt(stage);

  let systemPrompt = promptConfig.system;
  const userPrompt = context.userPrompt || '';
  const rateEvents = [];

  // Inject forward reasoning memory — compact context from prior pipeline stages
  const memoryBlock = getReasoningMemoryBlock();
  if (memoryBlock) {
    systemPrompt = `${systemPrompt}\n\n[FORWARD REASONING MEMORY — prior agent insights from this pipeline run]\n${memoryBlock}`;
  }

  const stageModel = _selectModelForStage(stage);
  const stageTokenCap = STAGE_TOKEN_CAP[stage] || undefined;

  const preferLocal = LOCAL_PREFERRED_STAGES.has(stage);

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
    { name: 'premium',  ok: premiumOk,  call: () => _callPremium(systemPrompt, userPrompt, stageModel, undefined, stageTokenCap, rateEvents, stage, context.reasoningEffort, context.responseFormat), isPremium: true },
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
    if (!prov.ok) {
      _emitInferenceTrace({ stage, provider: prov.name, model: prov.isPremium ? stageModel : (prov.name === 'ollama' ? OLLAMA_MODEL : 'enhancer'), result: 'skipped', latencyMs: 0, error: 'provider not available' });
      continue;
    }

    logger.info('provider.route', { provider: prov.name, stage, tier: prov.isPremium ? catalog.classifyTier(stageModel) : catalog.Tier.LOCAL });
    const callStart = Date.now();
    const callResult = await prov.call();
    const latencyMs = Date.now() - callStart;

    const output = prov.isPremium ? callResult?.content : callResult;
    const actionTag = prov.isPremium ? callResult?.actionTag : null;

    if (!output || !output.trim()) {
      logger.warn('provider.empty', { provider: prov.name, stage, ms: latencyMs });
      _emitInferenceTrace({ stage, provider: prov.name, model: prov.isPremium ? stageModel : (prov.name === 'ollama' ? OLLAMA_MODEL : 'enhancer'), result: 'empty', latencyMs });
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
      _emitInferenceTrace({ stage, provider: prov.name, model: prov.isPremium ? stageModel : (prov.name === 'ollama' ? OLLAMA_MODEL : 'enhancer'), result: 'noop', latencyMs, outputLen: output.length });
      continue;
    }

    const usedFallback = !!(prov.isPremium && callResult?.usedDirectFallback);
    logger.info('provider.ok', { provider: prov.name, stage, len: output.length, ms: latencyMs, model: prov.isPremium ? stageModel : undefined, tag: actionTag?.tag, usedDirectFallback: usedFallback || undefined });
    const resolvedModel = prov.isPremium ? stageModel : (prov.name === 'ollama' ? OLLAMA_MODEL : 'enhancer');
    _emitInferenceTrace({ stage, provider: prov.name, model: resolvedModel, result: 'ok', latencyMs, outputLen: output.length });
    // Append to forward reasoning memory for downstream stages
    appendReasoningMemory(stage, resolvedModel, output);
    return {
      output: output.trim(), provider: prov.name, noOp: false, latencyMs,
      model: resolvedModel,
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
      usedDirectFallback: usedFallback,
    };
  }

  logger.warn('provider.exhausted', { stage });
  _emitInferenceTrace({ stage, provider: 'none', model: 'none', result: 'error', latencyMs: 0, error: 'provider chain exhausted' });
  return { output: null, provider: 'none', noOp: true, latencyMs: 0, model: 'none', rateEvents: rateEvents.length ? rateEvents : undefined };
  } finally {
    _activeInferenceCount--;
    touchInferenceActivity();
  }
}

/**
 * Run inference using the strongest configured premium model (Max mode).
 * Falls back to default premium, then Ollama, then local.
 */
async function inferMax(stage, context = {}) {
  _activeInferenceCount++;
  touchInferenceActivity();
  try {
  const maxModel = PREMIUM_MAX_MODEL || PREMIUM_MODEL;
  if (!PREMIUM_API_KEY) {
    logger.info('provider.max.no_api_key', { stage, fallback: 'infer' });
    return infer(stage, context);
  }

  const promptConfig = context.systemPrompt
    ? { system: context.systemPrompt, temperature: 0 }
    : buildPrompt(stage);

  let systemPrompt = promptConfig.system;
  const userPrompt = context.userPrompt || '';
  const rateEvents = [];

  // Inject forward reasoning memory — compact context from prior pipeline stages
  const memoryBlock = getReasoningMemoryBlock();
  if (memoryBlock) {
    systemPrompt = `${systemPrompt}\n\n[FORWARD REASONING MEMORY — prior agent insights from this pipeline run]\n${memoryBlock}`;
  }

  logger.info('provider.max.attempting', { model: maxModel, stage });
  const callStart = Date.now();
  const callResult = await _callPremium(systemPrompt, userPrompt, maxModel, MAX_INFER_TIMEOUT_MS, undefined, rateEvents, stage, context.reasoningEffort, context.responseFormat);
  const latencyMs = Date.now() - callStart;
  const output = callResult?.content;
  const actionTag = callResult?.actionTag;

  if (output && output.trim() && output.trim() !== userPrompt.trim()) {
    const usedFallback = !!callResult?.usedDirectFallback;
    logger.info('provider.max.success', { model: maxModel, stage, outputLen: output.length, latencyMs, rmTag: actionTag?.tag, usedDirectFallback: usedFallback || undefined });
    _emitInferenceTrace({ stage, provider: `premium-max:${maxModel}`, model: maxModel, result: 'ok', latencyMs, outputLen: output.length });
    // Append to forward reasoning memory for downstream stages
    appendReasoningMemory(stage, maxModel, output);
    return {
      output: output.trim(), provider: `premium-max:${maxModel}`, noOp: false, latencyMs, model: maxModel,
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
      usedDirectFallback: usedFallback,
    };
  }

  if (rateEvents.length) {
    logger.warn('provider.max.rate_limited_downgrade', { model: maxModel, stage, events: rateEvents.length });
  }
  logger.warn('provider.max.failed', { model: maxModel, stage, fallback: 'default_infer', latencyMs });
  _emitInferenceTrace({ stage, provider: `premium-max:${maxModel}`, model: maxModel, result: 'error', latencyMs, error: 'max inference failed or returned unchanged input' });
  return infer(stage, context);
  } finally {
    _activeInferenceCount--;
    touchInferenceActivity();
  }
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
  _activeInferenceCount++;
  touchInferenceActivity();
  try {
  if (!ROLE_ALLOWED_STAGES.has(stage)) {
    logger.info('provider.role.stage_blocked', { stage, roleName, reason: 'stage not allowed for role inference' });
    _emitInferenceTrace({ stage, provider: `role:${roleName}`, model: 'none', result: 'error', latencyMs: 0, error: `stage ${stage} not allowed for role inference` });
    return infer(stage, context);
  }

  const registry = require('./role-registry');
  const role = registry.getRoleByName(roleName);

  if (!role || !role.enabled) {
    logger.info('provider.role.not_available', { roleName, found: !!role, enabled: role?.enabled });
    _emitInferenceTrace({ stage, provider: `role:${roleName}`, model: 'none', result: 'error', latencyMs: 0, error: `role ${roleName} not found or disabled` });
    return infer(stage, context);
  }

  const apiKey = role.apiKey;
  if (!apiKey || apiKey.startsWith('{')) {
    logger.info('provider.role.no_valid_key', { roleName, reason: 'unresolved or empty key' });
    _emitInferenceTrace({ stage, provider: `role:${roleName}`, model: role.model || 'unknown', result: 'error', latencyMs: 0, error: 'role has no valid api key' });
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
    const callResult = await _callPremiumWithKey(apiKey, systemPrompt, userPrompt, model, INFER_TIMEOUT_MS, rateEvents, stage, context.reasoningEffort, context.responseFormat);
    const latencyMs = Date.now() - callStart;
    const output = callResult?.content;
    const actionTag = callResult?.actionTag;

    if (!output || !output.trim()) {
      logger.warn('provider.role.empty_output', { roleName, stage, latencyMs });
      _emitInferenceTrace({ stage, provider: `role:${roleName}`, model, result: 'empty', latencyMs });
      return infer(stage, context);
    }

    if (output.trim() === userPrompt.trim()) {
      logger.warn('provider.role.no_op', { roleName, stage, latencyMs });
      _emitInferenceTrace({ stage, provider: `role:${roleName}`, model, result: 'noop', latencyMs, outputLen: output.length });
      return infer(stage, context);
    }

    logger.info('provider.role.success', { roleName, model, stage, outputLen: output.length, latencyMs, rmTag: actionTag?.tag });
    _emitInferenceTrace({ stage, provider: `role:${roleName}`, model, result: 'ok', latencyMs, outputLen: output.length });
    return {
      output: output.trim(), provider: `role:${roleName}:${model}`, noOp: false, latencyMs, model,
      rateEvents: rateEvents.length ? rateEvents : undefined,
      actionTag,
    };
  } catch (err) {
    const latencyMs = Date.now() - callStart;
    logger.warn('provider.role.error', { roleName, stage, error: err.message, latencyMs });
    _emitInferenceTrace({ stage, provider: `role:${roleName}`, model, result: 'error', latencyMs, error: err.message });
    return infer(stage, context);
  }
} finally {
    _activeInferenceCount--;
    touchInferenceActivity();
  }
}

function createRealInferenceProvider(config = {}) {
  const apiKey = config.apiKey || PREMIUM_API_KEY;
  const baseUrl = config.baseUrl || OPENAI_BASE_URL;

  return {
    infer: (stage, context) => infer(stage, context),
    inferMax: (stage, context) => inferMax(stage, context),
    inferWithRole: (stage, context, roleName) => inferWithRole(stage, context, roleName),
    isMaxAvailable,
    checkProviders,
    apiKey,
    baseUrl,
  };
}

module.exports = {
  infer, inferMax, inferWithRole, checkProviders, isMaxAvailable,
  setTraceId, setDepthTier, getDepthTier,
  getFallbackEvents, clearFallbackEvents,
  getLastInferenceAt, getActiveInferenceCount,
  clearReasoningMemory, getReasoningMemoryBlock, appendReasoningMemory,
  STAGE_JSON_SCHEMAS,
  createRealInferenceProvider,
};
