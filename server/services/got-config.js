'use strict';

/**
 * GoT Controller Configuration — single authoritative owner of ALL
 * HPC-GoT controller constants for Mermate.
 *
 * Every controller parameter lives here. No hardcoded constants in
 * input-router.js, mermaid-validator.js, or anywhere else.
 *
 * Values are loaded from process.env (GOT_* vars) with safe defaults
 * that match the canonical GoT.tex specification:
 *   depth=3, branch=3, budget=40, tau=0.85, merge top-k=3, LLM stages=4
 *
 * The returned config object is frozen — it cannot be mutated at runtime.
 */

const logger = require('../utils/logger');

function _bool(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  return ['true', '1', 'yes'].includes(String(val).toLowerCase());
}

function _int(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function _float(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

function _str(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  return String(val);
}

let _config = null;

function _load() {
  const e = process.env;
  return Object.freeze({
    // Master switch
    controllerEnabled:    _bool(e.GOT_CONTROLLER_ENABLED, false),
    mode:                 _str(e.GOT_MODE, 'hpc_got'),

    // Bounded tree parameters (GoT.tex canonical)
    maxDepth:             _int(e.GOT_MAX_DEPTH, 3),
    maxBranch:            _int(e.GOT_MAX_BRANCH, 3),
    stateBudget:          _int(e.GOT_STATE_BUDGET, 40),

    // Pruning
    pruneThreshold:       _float(e.GOT_PRUNE_THRESHOLD, 0.85),

    // Merge
    mergeEnabled:         _bool(e.GOT_MERGE_ENABLED, true),
    mergeTopK:            _int(e.GOT_MERGE_TOP_K, 3),

    // LLM stage budget
    llmStageLimit:        _int(e.GOT_LLM_STAGE_LIMIT, 4),

    // Scoring weights (canonical: 0.5 structural + 0.5 invariant)
    scoreStructuralWeight: _float(e.GOT_SCORE_STRUCTURAL_WEIGHT, 0.5),
    scoreInvariantWeight:  _float(e.GOT_SCORE_INVARIANT_WEIGHT, 0.5),

    // Router score mode
    routerScoreMode:      _str(e.GOT_ROUTER_SCORE_MODE, 'canonical'),

    // Completeness and skill gates
    requireSemanticCompleteness: _bool(e.GOT_REQUIRE_SEMANTIC_COMPLETENESS, true),
    requireSkillAlignment:       _bool(e.GOT_REQUIRE_SKILL_ALIGNMENT, true),

    // Inference
    compilerFormat:       _str(e.GOT_COMPILER_FORMAT, 'harmony'),
    primaryLocalModel:    _str(e.GOT_PRIMARY_LOCAL_MODEL, 'gpt-oss:20b'),

    // Debate / result policy
    debateMemory:         _str(e.GOT_DEBATE_MEMORY, 'last_reasoning_chain'),
    resultPolicy:         _str(e.GOT_RESULT_POLICY, 'enhanced_simple_idea_only'),

    // Derived constants (used by input-router and mermaid-validator)
    maxRepairAttempts:    Math.max(1, Math.min(_int(e.GOT_LLM_STAGE_LIMIT, 4) - 3, 2)),
    maxEntities:          50,
    maxRelationships:     60,
    proseWordLimit:       6,
    edgeLabelWordLimit:   6,
  });
}

function getConfig() {
  if (!_config) {
    _config = _load();
    logger.info('got.config.loaded', {
      controllerEnabled: _config.controllerEnabled,
      maxDepth: _config.maxDepth,
      maxBranch: _config.maxBranch,
      stateBudget: _config.stateBudget,
      pruneThreshold: _config.pruneThreshold,
      scoreWeights: `${_config.scoreStructuralWeight}/${_config.scoreInvariantWeight}`,
      primaryLocalModel: _config.primaryLocalModel,
    });
  }
  return _config;
}

function _reset() {
  _config = null;
}

module.exports = { getConfig, _reset };
