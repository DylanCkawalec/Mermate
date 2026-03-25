'use strict';

/**
 * Model Catalog — single source of truth for model identity, cost,
 * token estimation, capability flags, and endpoint routing.
 *
 * Consumed by: inference-provider, inference-telemetry, run-tracker,
 *              rate-master-bridge, agent.js
 *
 * Zero duplication: every module imports from here.
 */

// ---- Token Estimation ------------------------------------------------------

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---- Cost Model ------------------------------------------------------------

const COST_PER_1K = Object.freeze({
  'gpt-5.1':     { input: 0.01,    output: 0.03   },
  'gpt-5.2':     { input: 0.015,   output: 0.04   },
  'gpt-5.4':     { input: 0.03,    output: 0.06   },
  'gpt-4o':      { input: 0.0025,  output: 0.01   },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4.1':     { input: 0.002,   output: 0.008  },
  'gpt-4.1-mini':{ input: 0.0004,  output: 0.0016 },
  'gpt-4.1-nano':{ input: 0.0001,  output: 0.0004 },
  'o1':          { input: 0.015,   output: 0.06   },
  'o1-mini':     { input: 0.003,   output: 0.012  },
  'o3':          { input: 0.01,    output: 0.04   },
  'o3-mini':     { input: 0.0011,  output: 0.0044 },
  'o4-mini':     { input: 0.0011,  output: 0.0044 },
  'gpt-oss:20b': { input: 0.0,     output: 0.0    },
  'enhancer':    { input: 0.0,     output: 0.0    },
});

function estimateCost(model, tokensIn, tokensOut) {
  const rates = COST_PER_1K[model] || COST_PER_1K['gpt-4o-mini'];
  return +((tokensIn / 1000) * rates.input + (tokensOut / 1000) * rates.output).toFixed(6);
}

// ---- Capability Flags ------------------------------------------------------

const COMPLETION_TOKEN_MODELS = /^(gpt-[45]\.[1-9]|gpt-5$|o[1-4])/;

function usesCompletionTokens(model) {
  return COMPLETION_TOKEN_MODELS.test(model);
}

// ---- Tier Classification ---------------------------------------------------
// Models are classified into 4 tiers that map to rate-master endpoints.

const Tier = Object.freeze({
  ORCHESTRATOR: 'openai-orchestrator',
  WORKER:       'openai-worker',
  FAST:         'openai-fast',
  LOCAL:        'local-llm',
});

const _tierCache = new Map();

function classifyTier(model) {
  if (!model) return Tier.WORKER;
  const cached = _tierCache.get(model);
  if (cached) return cached;

  const orchModel  = process.env.MERMATE_ORCHESTRATOR_MODEL || process.env.MERMATE_AI_MAX_MODEL || 'gpt-4o';
  const workModel  = process.env.MERMATE_WORKER_MODEL       || process.env.MERMATE_AI_MODEL     || 'gpt-4o';
  const fastModel  = process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-4o-mini';
  const localModel = process.env.LOCAL_LLM_MODEL || process.env.MERMATE_OLLAMA_MODEL || 'gpt-oss:20b';

  let tier = Tier.WORKER;
  if (model === orchModel && orchModel !== workModel) tier = Tier.ORCHESTRATOR;
  else if (model === workModel) tier = Tier.WORKER;
  else if (model === fastModel) tier = Tier.FAST;
  else if (model === localModel || model === 'enhancer') tier = Tier.LOCAL;
  else if (/^gpt-5\.[3-9]|^gpt-5$|^o[1-9]/.test(model)) tier = Tier.ORCHESTRATOR;
  else if (/^gpt-5\.[0-2]|^gpt-4o$/.test(model)) tier = Tier.WORKER;
  else if (/mini|nano/.test(model)) tier = Tier.FAST;

  _tierCache.set(model, tier);
  return tier;
}

// ---- Pipeline Stage Taxonomy -----------------------------------------------
// Canonical verb:noun naming for every pipeline stage.
// Used by rate-master-bridge, narrator, telemetry, run-tracker.

const Stage = Object.freeze({
  EXTRACT_FACTS:     'extract:facts',
  PLAN_DIAGRAM:      'plan:diagram',
  COMPOSE_BRANCH:    'compose:branch',
  COMPOSE_MAX:       'compose:max',
  COMPOSE_MERGE:     'compose:merge',
  REPAIR_SEMANTIC:   'repair:semantic',
  REPAIR_MODEL:      'repair:model',
  REPAIR_TRACE:      'repair:trace',
  DECOMPOSE_VIEWS:   'decompose:views',
  RENDER_PREPARE:    'render:prepare',
  COPILOT_SUGGEST:   'copilot:suggest',
  COPILOT_ENHANCE:   'copilot:enhance',
  NARRATE_SUMMARY:   'narrate:summary',
  COMPOSE_TLA:       'compose:tla',
  REPAIR_TLA:        'repair:tla',
  VALIDATE_TLA:      'validate:tla',
  COMPOSE_TS:        'compose:ts',
  REPAIR_TS:         'repair:ts',
  VALIDATE_TS:       'validate:ts',
});

const STAGE_LEGACY_MAP = Object.freeze({
  fact_extraction:   Stage.EXTRACT_FACTS,
  diagram_plan:      Stage.PLAN_DIAGRAM,
  composition:       Stage.COMPOSE_BRANCH,
  max_composition:   Stage.COMPOSE_MAX,
  merge_composition: Stage.COMPOSE_MERGE,
  semantic_repair:   Stage.REPAIR_SEMANTIC,
  model_repair:      Stage.REPAIR_MODEL,
  repair_from_trace: Stage.REPAIR_TRACE,
  decompose:         Stage.DECOMPOSE_VIEWS,
  render_prepare:    Stage.RENDER_PREPARE,
  copilot_suggest:   Stage.COPILOT_SUGGEST,
  copilot_enhance:   Stage.COPILOT_ENHANCE,
  compose_tla:       Stage.COMPOSE_TLA,
  repair_tla:        Stage.REPAIR_TLA,
  validate_tla:      Stage.VALIDATE_TLA,
  compose_ts:        Stage.COMPOSE_TS,
  repair_ts:         Stage.REPAIR_TS,
  validate_ts:       Stage.VALIDATE_TS,
});

function canonicalStage(legacyName) {
  return STAGE_LEGACY_MAP[legacyName] || legacyName;
}

// ---- Context Window Profiles -----------------------------------------------
// Predicted token budgets per stage for queue ordering and prefetch.

const CONTEXT_PROFILE = Object.freeze({
  [Stage.EXTRACT_FACTS]:   { avgIn: 2000,  avgOut: 1500  },
  [Stage.PLAN_DIAGRAM]:    { avgIn: 3000,  avgOut: 2000  },
  [Stage.COMPOSE_BRANCH]:  { avgIn: 4000,  avgOut: 6000  },
  [Stage.COMPOSE_MAX]:     { avgIn: 8000,  avgOut: 12000 },
  [Stage.COMPOSE_MERGE]:   { avgIn: 12000, avgOut: 12000 },
  [Stage.REPAIR_SEMANTIC]: { avgIn: 5000,  avgOut: 4000  },
  [Stage.REPAIR_MODEL]:    { avgIn: 3000,  avgOut: 3000  },
  [Stage.REPAIR_TRACE]:    { avgIn: 3000,  avgOut: 3000  },
  [Stage.DECOMPOSE_VIEWS]: { avgIn: 3000,  avgOut: 4000  },
  [Stage.RENDER_PREPARE]:  { avgIn: 2000,  avgOut: 5000  },
  [Stage.COPILOT_SUGGEST]: { avgIn: 500,   avgOut: 100   },
  [Stage.COPILOT_ENHANCE]: { avgIn: 3000,  avgOut: 6000  },
  [Stage.NARRATE_SUMMARY]: { avgIn: 800,   avgOut: 200   },
  [Stage.COMPOSE_TLA]:     { avgIn: 4000,  avgOut: 6000  },
  [Stage.REPAIR_TLA]:      { avgIn: 5000,  avgOut: 5000  },
  [Stage.VALIDATE_TLA]:    { avgIn: 2500,  avgOut: 1000  },
  [Stage.COMPOSE_TS]:      { avgIn: 6000,  avgOut: 9000  },
  [Stage.REPAIR_TS]:       { avgIn: 7000,  avgOut: 7000  },
  [Stage.VALIDATE_TS]:     { avgIn: 2500,  avgOut: 1500  },
});

const MAX_CONTEXT_WINDOW = 128000;

function estimateContext(stage, inputText) {
  const canonical = STAGE_LEGACY_MAP[stage] || stage;
  const profile = CONTEXT_PROFILE[canonical] || { avgIn: 2000, avgOut: 4000 };
  const actualIn = inputText ? Math.ceil(inputText.length / CHARS_PER_TOKEN) : profile.avgIn;
  return {
    inputTokensEst:     actualIn,
    outputTokensEst:    profile.avgOut,
    totalTokensEst:     actualIn + profile.avgOut,
    contextUtilization: actualIn / MAX_CONTEXT_WINDOW,
  };
}

// ---- Priority Taxonomy -----------------------------------------------------

const Priority = Object.freeze({
  CRITICAL:   0,
  HIGH:       1,
  NORMAL:     2,
  LOW:        3,
  BACKGROUND: 4,
});

const STAGE_PRIORITY = Object.freeze({
  [Stage.COMPOSE_MAX]:     Priority.CRITICAL,
  [Stage.COMPOSE_MERGE]:   Priority.CRITICAL,
  [Stage.COMPOSE_BRANCH]:  Priority.HIGH,
  [Stage.RENDER_PREPARE]:  Priority.HIGH,
  [Stage.COPILOT_ENHANCE]: Priority.HIGH,
  [Stage.DECOMPOSE_VIEWS]: Priority.NORMAL,
  [Stage.EXTRACT_FACTS]:   Priority.NORMAL,
  [Stage.PLAN_DIAGRAM]:    Priority.NORMAL,
  [Stage.REPAIR_SEMANTIC]: Priority.NORMAL,
  [Stage.REPAIR_MODEL]:    Priority.NORMAL,
  [Stage.REPAIR_TRACE]:    Priority.NORMAL,
  [Stage.COPILOT_SUGGEST]: Priority.LOW,
  [Stage.NARRATE_SUMMARY]: Priority.BACKGROUND,
  [Stage.COMPOSE_TLA]:     Priority.HIGH,
  [Stage.REPAIR_TLA]:      Priority.NORMAL,
  [Stage.VALIDATE_TLA]:    Priority.NORMAL,
  [Stage.COMPOSE_TS]:      Priority.HIGH,
  [Stage.REPAIR_TS]:       Priority.NORMAL,
  [Stage.VALIDATE_TS]:     Priority.NORMAL,
});

const PRIORITY_LABELS = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'];

function stagePriority(stage) {
  const canonical = STAGE_LEGACY_MAP[stage] || stage;
  return STAGE_PRIORITY[canonical] ?? Priority.NORMAL;
}

function priorityLabel(p) {
  return PRIORITY_LABELS[p] || 'NORMAL';
}

module.exports = {
  estimateTokens,
  estimateCost,
  COST_PER_1K,
  usesCompletionTokens,
  Tier,
  classifyTier,
  Stage,
  STAGE_LEGACY_MAP,
  canonicalStage,
  CONTEXT_PROFILE,
  estimateContext,
  Priority,
  STAGE_PRIORITY,
  stagePriority,
  priorityLabel,
  MAX_CONTEXT_WINDOW,
  CHARS_PER_TOKEN,
};
