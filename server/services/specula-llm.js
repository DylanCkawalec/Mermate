'use strict';

const logger = require('../utils/logger');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.MERMATE_TLA_CLAUDE_MODEL
  || process.env.CLAUDE_MODEL
  || 'claude-sonnet-4-20250514';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.MERMATE_TLA_CLAUDE_TIMEOUT_MS || '120000', 10);

function getConfig() {
  return {
    provider: 'anthropic',
    apiKeyPresent: Boolean(CLAUDE_API_KEY),
    model: CLAUDE_MODEL,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  };
}

function isAvailable() {
  return Boolean(CLAUDE_API_KEY);
}

async function inferTlaStage(stage, { systemPrompt, userPrompt, maxTokens = 8192 }) {
  if (!CLAUDE_API_KEY) {
    return {
      available: false,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: null,
      error: 'CLAUDE_API_KEY is not configured',
    };
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
      logger.warn('specula_llm.request_failed', { stage, details });
      return {
        available: true,
        provider: 'anthropic',
        model: CLAUDE_MODEL,
        output: null,
        error: details,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      available: true,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: text,
      error: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    logger.warn('specula_llm.request_error', { stage, error: err.message });
    return {
      available: true,
      provider: 'anthropic',
      model: CLAUDE_MODEL,
      output: null,
      error: err.message,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
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
    return { tlaSource: null, provider: 'none', latencyMs: 0, error: 'CLAUDE_API_KEY not configured' };
  }

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

  logger.info('specula_llm.generate_tla_spec', { moduleName, entities: (facts?.entities || []).length, model: CLAUDE_MODEL });

  const result = await inferTlaStage('generate_tla_spec', {
    systemPrompt: TLA_GEN_SYSTEM,
    userPrompt,
    maxTokens: 16384,
  });

  if (result.output) {
    let src = result.output.trim();
    if (src.startsWith('```')) src = src.replace(/^```(?:tla\+?)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    logger.info('specula_llm.tla_spec_generated', { moduleName, len: src.length, latencyMs: result.latencyMs });
    return { tlaSource: src, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: result.latencyMs };
  }

  logger.warn('specula_llm.tla_spec_failed', { moduleName, error: result.error });
  return { tlaSource: null, provider: 'anthropic', model: CLAUDE_MODEL, latencyMs: result.latencyMs, error: result.error };
}

module.exports = {
  getConfig,
  isAvailable,
  inferTlaStage,
  generateTlaSpec,
};
