'use strict';

/**
 * Specula LLM — TLA+ specification writer with a two-link provider chain.
 *
 * PRIMARY:  OpenAI gpt-5.6-sol (orchestrator tier) via inference-provider's
 *           full machinery — Opseeq gateway, direct fallback, retries,
 *           rate-master telemetry, xhigh reasoning for compose_tla.
 * FALLBACK: Anthropic Claude (direct API) when the primary chain returns
 *           nothing or only a non-premium (local) answer.
 *
 * Every result carries provenance: { provider, model, latencyMs,
 * fallbackUsed } so the verification stamp can name the spec's author.
 */

const logger = require('../utils/logger');
const inferenceProvider = require('./inference-provider');
const speculaEngine = require('./specula-engine-bridge');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_KEY_PRESENT = Boolean(process.env.OPENAI_API_KEY || process.env.MERMATE_AI_API_KEY);
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.MERMATE_TLA_CLAUDE_MODEL
  || process.env.CLAUDE_MODEL
  || 'claude-sonnet-4-20250514';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.MERMATE_TLA_CLAUDE_TIMEOUT_MS || '120000', 10);
const SOL_MODEL = process.env.MERMATE_ORCHESTRATOR_MODEL || process.env.MERMATE_AI_MAX_MODEL || 'gpt-5.6-sol';

// Maps specula stage names to inference-provider routing stages.
const STAGE_ROUTE = {
  generate_tla_spec: 'compose_tla',
  repair_tla: 'repair_tla',
};

function getConfig() {
  return {
    chain: [
      { provider: 'openai', model: SOL_MODEL, available: OPENAI_KEY_PRESENT, role: 'primary' },
      { provider: 'anthropic', model: CLAUDE_MODEL, available: Boolean(CLAUDE_API_KEY), role: 'fallback' },
    ],
    // Legacy shape kept for existing consumers of specula.env:
    provider: OPENAI_KEY_PRESENT ? 'openai' : 'anthropic',
    apiKeyPresent: OPENAI_KEY_PRESENT || Boolean(CLAUDE_API_KEY),
    model: OPENAI_KEY_PRESENT ? SOL_MODEL : CLAUDE_MODEL,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  };
}

function isAvailable() {
  return OPENAI_KEY_PRESENT || Boolean(CLAUDE_API_KEY);
}

// ---- Fallback link: direct Anthropic call ---------------------------------

async function _callClaude(stage, { systemPrompt, userPrompt, maxTokens = 8192 }) {
  if (!CLAUDE_API_KEY) {
    return { output: null, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: 0, error: 'CLAUDE_API_KEY is not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        system: systemPrompt || '',
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: userPrompt || '',
          },
        ],
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    const text = Array.isArray(payload.content)
      ? payload.content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text || '')
        .join('\n')
        .trim()
      : null;

    if (!response.ok) {
      const details = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      logger.warn('specula_llm.claude_failed', { stage, details });
      return { output: null, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: Date.now() - startedAt, error: details };
    }

    return { output: text, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: Date.now() - startedAt, error: null };
  } catch (err) {
    logger.warn('specula_llm.claude_error', { stage, error: err.message });
    return { output: null, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: Date.now() - startedAt, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Chain entry point -----------------------------------------------------

/**
 * Run a TLA+ inference stage through the sol-primary chain.
 *
 * Order: (1) inference-provider premium (gpt-5.6-sol via gateway/retries),
 * (2) direct Claude, (3) any non-premium output the primary chain produced
 * (ollama/enhancer) as last resort — SANY+repair downstream catches quality.
 *
 * @returns {Promise<{available: boolean, provider: string, model: string,
 *   output: string|null, error: string|null, latencyMs: number,
 *   fallbackUsed: boolean}>}
 */
async function inferTlaStage(stage, { systemPrompt, userPrompt, maxTokens = 8192 }) {
  if (!isAvailable()) {
    return {
      available: false,
      provider: 'none',
      model: null,
      output: null,
      error: 'No TLA+ provider configured (need OPENAI_API_KEY or CLAUDE_API_KEY)',
      latencyMs: 0,
      fallbackUsed: false,
    };
  }

  const routeStage = STAGE_ROUTE[stage] || 'compose_tla';
  const startedAt = Date.now();

  // Link 1: sol primary through the full provider chain
  let primary = null;
  if (OPENAI_KEY_PRESENT) {
    try {
      primary = await inferenceProvider.infer(routeStage, { systemPrompt, userPrompt });
    } catch (err) {
      logger.warn('specula_llm.primary_error', { stage, routeStage, error: err.message });
      primary = null;
    }
    if (primary?.output && primary.provider === 'premium') {
      logger.info('specula_llm.sol_primary_ok', { stage, model: primary.model, ms: primary.latencyMs });
      return {
        available: true,
        provider: 'openai',
        model: primary.model || SOL_MODEL,
        output: primary.output,
        error: null,
        latencyMs: primary.latencyMs || (Date.now() - startedAt),
        fallbackUsed: false,
      };
    }
    logger.warn('specula_llm.sol_primary_miss', { stage, provider: primary?.provider || 'none' });
  }

  // Link 2: Claude direct fallback
  const claude = await _callClaude(stage, { systemPrompt, userPrompt, maxTokens });
  if (claude.output) {
    return {
      available: true,
      provider: 'anthropic',
      model: claude.model,
      output: claude.output,
      error: null,
      latencyMs: claude.latencyMs,
      fallbackUsed: OPENAI_KEY_PRESENT,
    };
  }

  // Link 3: accept a non-premium (local) answer from the primary chain —
  // SANY + the bounded repair loop downstream are the quality gate.
  if (primary?.output) {
    logger.info('specula_llm.local_last_resort', { stage, provider: primary.provider });
    return {
      available: true,
      provider: primary.provider,
      model: primary.model || 'local',
      output: primary.output,
      error: null,
      latencyMs: primary.latencyMs || (Date.now() - startedAt),
      fallbackUsed: true,
    };
  }

  return {
    available: true,
    provider: OPENAI_KEY_PRESENT ? 'openai' : 'anthropic',
    model: OPENAI_KEY_PRESENT ? SOL_MODEL : CLAUDE_MODEL,
    output: null,
    error: claude.error || 'all TLA+ providers returned empty output',
    latencyMs: Date.now() - startedAt,
    fallbackUsed: true,
  };
}

const TLA_GEN_SYSTEM = `You are a TLA+ formal specification expert trained by Leslie Lamport's methodology.
Given a system architecture description (typed entities, relationships, failure paths, and boundaries),
produce a complete, syntactically valid TLA+ module that SANY will accept without errors.

STRICT RULES:
- Module header: ---- MODULE <Name> ---- (exactly 4+ dashes each side)
- Footer: ==== (exactly 4+ equals signs)
- EXTENDS Naturals only (do NOT use Sequences or FiniteSets unless the spec actually uses them)
- Every variable referenced in actions MUST be declared in VARIABLES
- Every action MUST include UNCHANGED for all variables it does not modify
- Do NOT include THEOREM statements
- All string literals use double quotes
- Invariant expressions use => (implication), /\\ (conjunction), \\/ (disjunction)
- State sets use {"state1", "state2"} syntax
- Use \\in for set membership in TypeInvariant
- Output ONLY the TLA+ module text. No markdown fencing, no explanation.`;

/**
 * Generate a complete TLA+ specification using Claude/Anthropic.
 * The deterministic compiler output is provided as a scaffold for Claude
 * to refine into a syntactically valid spec.
 *
 * @param {object} facts - Typed architecture facts (entities, relationships, failurePaths, boundaries)
 * @param {object} plan - Architecture plan (nodes, edges, subgraphs)
 * @param {string} moduleName - TLA+ module name
 * @param {string} deterministicSeed - Output from tla-compiler.js as reference
 * @returns {Promise<{tlaSource: string|null, provider: string, latencyMs: number}>}
 */
async function generateTlaSpec(facts, plan, moduleName, deterministicSeed) {
  if (!isAvailable()) {
    return { tlaSource: null, provider: 'none', latencyMs: 0, error: 'No TLA+ provider configured (need OPENAI_API_KEY or CLAUDE_API_KEY)' };
  }

  // Enrich the TLA writer prompt with the pinned Specula methodology when the
  // submodule is present. This keeps Mermate's instructions aligned with the
  // upstream Specula spec-generation guide without hard-cording its text.
  const speculaGuide = await speculaEngine.getSpecGenerationGuide();
  const systemPrompt = speculaGuide
    ? `${TLA_GEN_SYSTEM}\n\n--- UPSTREAM SPECOLA METHODOLOGY ---\n${speculaGuide}`
    : TLA_GEN_SYSTEM;

  const entities = (facts?.entities || []).map(e => `- ${e.name} (${e.type})`).join('\n');
  const relationships = (facts?.relationships || []).map(r =>
    `- ${r.from} --[${r.verb || 'interacts'}]--> ${r.to} (${r.edgeType || 'sync'})`
  ).join('\n');
  const failurePaths = (facts?.failurePaths || []).map(fp =>
    `- trigger: ${fp.trigger}, condition: ${fp.condition}, handler: ${fp.handler}, recovery: ${fp.recovery}`
  ).join('\n');
  const boundaries = (facts?.boundaries || []).map(b =>
    `- ${b.name}: [${(b.members || []).join(', ')}]`
  ).join('\n');

  const userPrompt = `Generate a TLA+ module named "${moduleName}" for this architecture:

ENTITIES:
${entities || '(none)'}

RELATIONSHIPS:
${relationships || '(none)'}

FAILURE PATHS:
${failurePaths || '(none)'}

BOUNDARIES:
${boundaries || '(none)'}

Here is a deterministic scaffold for reference (refine this into valid TLA+):

${deterministicSeed || '(no scaffold provided)'}

Output the complete TLA+ module text only.`;

  logger.info('specula_llm.generate_tla_spec', { moduleName, entities: (facts?.entities || []).length, primary: OPENAI_KEY_PRESENT ? SOL_MODEL : CLAUDE_MODEL });

  const result = await inferTlaStage('generate_tla_spec', {
    systemPrompt,
    userPrompt,
    maxTokens: 16384,
  });

  if (result.output) {
    let src = result.output.trim();
    if (src.startsWith('```')) src = src.replace(/^```(?:tla\+?)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    logger.info('specula_llm.tla_spec_generated', { moduleName, len: src.length, provider: result.provider, model: result.model, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed });
    return { tlaSource: src, provider: result.provider, model: result.model, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed };
  }

  logger.warn('specula_llm.tla_spec_failed', { moduleName, error: result.error });
  return { tlaSource: null, provider: result.provider, model: result.model, latencyMs: result.latencyMs, error: result.error };
}

module.exports = {
  getConfig,
  isAvailable,
  inferTlaStage,
  generateTlaSpec,
};
