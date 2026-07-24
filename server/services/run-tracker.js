'use strict';

/**
 * Run Tracker — canonical JSON lineage persistence for every MERMATE run.
 *
 * Produces one JSON file per run in the `runs/` directory. The JSON captures
 * the full render tree: request, controller state, agent calls, branches,
 * subviews, merge decisions, rate events, validation, and final artifacts.
 *
 * Design principles:
 *   - Append-only arrays (agent_calls, branches, subviews, rate_events, ui_stages)
 *   - Atomic writes (write to .tmp then rename)
 *   - Incremental persistence (skeleton on create, append on record, finalize at end)
 *   - Completeness checks on finalize (warn on missing fields, never block)
 *   - 30-day retention with cleanup on startup
 */

const { randomUUID, createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const logger = require('../utils/logger');
const catalog = require('./model-catalog');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
let RUNS_DIR = path.join(PROJECT_ROOT, 'runs');

function _setRunsDir(dir) { RUNS_DIR = dir; }
const SCHEMA_VERSION = '1.0.0';
const MAX_MMD_INLINE = 200_000; // ~200KB; above this, store as file reference
const RETENTION_DAYS = parseInt(process.env.MERMATE_RUN_RETENTION_DAYS || '30', 10);

const _activeRuns = new Map();

function _hash16(text) {
  if (!text) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const _estimateTokens = catalog.estimateTokens;
const _estimateCost = catalog.estimateCost;

// ---- Atomic file write -----------------------------------------------------

async function _atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp';
  const tSer = Date.now();
  // Compact JSON: faster stringify + smaller writes for large manifests (many agent_calls).
  // Parsers are unaffected; use jq or MERMATE_RUN_JSON_PRETTY=1 only if you need diffs.
  const json = process.env.MERMATE_RUN_JSON_PRETTY === '1'
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  const serMs = Date.now() - tSer;
  // #region agent log
  if (process.env.MERMATE_DEBUG_PIPELINE === '1') fetch('http://127.0.0.1:7647/ingest/a2d7b582-6018-42c8-abf3-55f08db02976', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '984aae' },
    body: JSON.stringify({
      sessionId: '984aae',
      hypothesisId: 'H-A',
      location: 'run-tracker.js:_atomicWrite',
      message: 'manifest_serialize_write',
      data: {
        serMs,
        jsonChars: json.length,
        jsonKb: Math.round(json.length / 1024),
        status: data.status,
        agentCalls: (data.agent_calls && data.agent_calls.length) || 0,
        runId: (data.run_id || '').slice(0, 8),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  const tWr = Date.now();
  await fsp.writeFile(tmpPath, json, 'utf8');
  const writeMs = Date.now() - tWr;
  const tRen = Date.now();
  await fsp.rename(tmpPath, filePath);
  const renameMs = Date.now() - tRen;
  // #region agent log
  if (process.env.MERMATE_DEBUG_PIPELINE === '1' && (writeMs + renameMs > 5 || json.length > 20_000)) {
    fetch('http://127.0.0.1:7647/ingest/a2d7b582-6018-42c8-abf3-55f08db02976', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '984aae' },
      body: JSON.stringify({
        sessionId: '984aae',
        hypothesisId: 'H-A',
        location: 'run-tracker.js:_atomicWrite',
        message: 'manifest_fs_io',
        data: { writeMs, renameMs, runId: (data.run_id || '').slice(0, 8) },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion
}

// ---- Run lifecycle ---------------------------------------------------------

/**
 * Create a new run and persist the initial skeleton to disk.
 *
 * @param {object} opts
 * @param {string} [opts.parentRunId]
 * @param {string} [opts.mode]       - thinking | code-review | optimize-mmd | direct
 * @param {boolean} [opts.maxMode]
 * @param {boolean} [opts.enhance]
 * @param {string} [opts.userInput]
 * @param {string} [opts.userDiagramName]
 * @param {string} [opts.inputMode]
 * @param {object} [opts.gotConfig]  - frozen got-config snapshot
 * @param {object} [opts.models]     - { orchestrator, worker, fast }
 * @returns {Promise<string>} runId
 */
// Canonical lifecycle phases — every run progresses through these in order.
// Recorded explicitly so any consumer (Opseeq Studio, dashboards, replays)
// can answer "where is/was this run?" without parsing stages_executed.
const LIFECYCLE_PHASES = Object.freeze([
  'ingest',    // user input received, profile analyzed
  'analyze',   // depth score, complexity, intent inferred
  'plan',      // pipeline chosen, decompose / single-shot decided
  'compose',   // LLM(s) produce mmd source(s)
  'compile',   // mermaid-cli renders SVG/PNG, repair loop
  'finalize',  // totals, exports, downstream artifacts
]);

async function create(opts = {}) {
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  const runId = randomUUID();
  const now = new Date().toISOString();

  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    parent_run_id: opts.parentRunId || null,
    created_at: now,
    completed_at: null,
    status: 'running',

    // Flat scannable labels — initialized at create, refreshed at finalize.
    // Every consumer can index/filter by these without descending into the
    // sub-objects below. This is the axiomatic identity of the run.
    tags: {
      mode: opts.mode || 'direct',
      max_mode: !!opts.maxMode,
      enhance: !!opts.enhance,
      input_mode: opts.inputMode || null,
      domain: 'unknown',           // refreshed once profile is set
      depth_tier: 'unknown',       // refreshed when depth is set
      pipeline: null,              // refreshed by setPipeline
      was_decomposed: false,       // refreshed when subviews exist
      has_diagram: false,          // refreshed at finalize
      has_tla: false,              // refreshed when TLA artifacts attach
      has_typescript: false,       // refreshed when TS artifacts attach
      has_tsx: false,              // refreshed when TSX artifacts attach
    },

    settings: {
      mode: opts.mode || 'direct',
      max_mode: !!opts.maxMode,
      enhance: !!opts.enhance,
      got_config: opts.gotConfig || null,
      models: opts.models || null,
    },

    request: {
      user_input: opts.userInput || null,
      user_diagram_name: opts.userDiagramName || null,
      input_mode: opts.inputMode || null,
      user_notes: null,
      profile: null,
    },

    controller: {
      pipeline: null,
      state_count: 0,
      state_budget: opts.gotConfig?.stateBudget || 40,
      depth_reached: 0,
      max_depth: opts.gotConfig?.maxDepth || 3,
      stages_executed: [],
      depth_score: null,
      depth_tier: null,
      depth_factors: null,
    },

    // Ordered lifecycle phases. Each is { phase, started_at, completed_at, ok }.
    // _recordPhase() appends a phase as it begins; _completePhase() closes it.
    // Computed at finalize so partial runs still produce a coherent timeline.
    lifecycle: {
      phases: [],
      current_phase: null,
      phase_seq: 0,
    },

    // Architecture composition metrics — quantifies how many distinct
    // architecture instances the run combined and how cleanly they merged.
    // Filled in by _computeComposition() at finalize.
    composition: null,

    // Single-glance integrity verdict — { ok, issues[] } computed at finalize.
    sum_check: null,

    opseeq_session_id: opts.opseeqSessionId || null,

    agent_calls: [],
    branches: [],
    subviews: [],

    merge: null,

    final_artifact: null,
    prior_artifacts: [],

    rate_events: [],
    ui_stages: [],
    warnings: [],

    totals: null,
  };

  _activeRuns.set(runId, manifest);
  await _atomicWrite(path.join(RUNS_DIR, `${runId}.json`), manifest);
  logger.info('run_tracker.created', { runId: runId.slice(0, 8), parent: opts.parentRunId?.slice(0, 8) });
  return runId;
}

/**
 * Get the in-memory manifest for an active run.
 */
function getManifest(runId) {
  return _activeRuns.get(runId) || null;
}

// ---- Profile recording -----------------------------------------------------

function setProfile(runId, profile) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.request.profile = {
    maturity: profile.maturity,
    quality_score: profile.qualityScore,
    completeness_score: profile.completenessScore,
    content_state: profile.contentState,
    complexity: profile.complexity,
    should_decompose: profile.shouldDecompose,
    architecture_depth_score: profile.architectureDepthScore ?? null,
    architecture_depth_tier: profile.architectureDepthTier ?? null,
    entity_count: profile.shadow?.entities?.length || 0,
    shadow: {
      entities: (profile.shadow?.entities || []).slice(0, 30).map(e => ({ name: e.name, type: e.type })),
      relationships: (profile.shadow?.relationships || []).slice(0, 25).map(r => ({ from: r.from, verb: r.verb, to: r.to })),
      gaps: (profile.shadow?.gaps || []).slice(0, 10),
    },
  };

  if (profile.architectureDepthScore != null) {
    m.controller.depth_score = profile.architectureDepthScore;
    m.controller.depth_tier = profile.architectureDepthTier || null;
    m.controller.depth_factors = profile.architectureDepthFactors || null;
    m.tags.depth_tier = profile.architectureDepthTier || 'unknown';
  }

  // Surface inferred problem domain on the tags so consumers see a flat
  // label like 'fabrication' or 'distributed-systems' without descending.
  if (profile.intent?.problemDomain) {
    m.tags.domain = profile.intent.problemDomain;
  }
}

// ---- Pipeline recording ----------------------------------------------------

function setPipeline(runId, pipeline) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.controller.pipeline = pipeline;
  m.tags.pipeline = pipeline || null;
}

function setDepth(runId, { score, tier, factors }) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  if (typeof score === 'number') m.controller.depth_score = score;
  if (tier) {
    m.controller.depth_tier = tier;
    m.tags.depth_tier = tier;
  }
  if (factors) m.controller.depth_factors = factors;
}

// ---- Lifecycle phase tracking ----------------------------------------------

/**
 * Mark the start of a lifecycle phase. Closes any prior open phase first
 * (idempotent — calling twice on the same phase is a no-op). Phase names
 * outside LIFECYCLE_PHASES are still accepted but logged so we notice
 * drift between code and the canonical list.
 */
function recordPhase(runId, phase) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  if (!LIFECYCLE_PHASES.includes(phase)) {
    logger.debug('run_tracker.phase_unknown', { runId: runId.slice(0, 8), phase });
  }

  // Close any in-flight phase before opening the new one.
  const open = m.lifecycle.phases.find(p => !p.completed_at);
  if (open && open.phase === phase) return;
  if (open) open.completed_at = new Date().toISOString();

  m.lifecycle.phases.push({
    phase,
    seq: m.lifecycle.phase_seq,
    started_at: new Date().toISOString(),
    completed_at: null,
    ok: null,
  });
  m.lifecycle.current_phase = phase;
  m.lifecycle.phase_seq += 1;
}

/**
 * Mark a phase complete. `ok` is optional — when omitted we infer from
 * the run's status at finalize time.
 */
function completePhase(runId, phase, ok = true) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  const p = [...m.lifecycle.phases].reverse().find(x => x.phase === phase && !x.completed_at);
  if (!p) return;
  p.completed_at = new Date().toISOString();
  p.ok = ok;
  if (m.lifecycle.current_phase === phase) m.lifecycle.current_phase = null;
}

function setOpseeqSession(runId, sessionId) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.opseeq_session_id = sessionId || null;
}

function addStage(runId, stage) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  if (!m.controller.stages_executed.includes(stage)) {
    m.controller.stages_executed.push(stage);
  }
}

// ---- Agent call recording --------------------------------------------------

/**
 * Record a single LLM inference call.
 * @returns {string} callId
 */
function recordAgentCall(runId, {
  stage, role = 'default', model = 'unknown', provider = 'unknown',
  promptText = '', outputText = '', latencyMs = 0,
  success = true, error = null, outputType = 'text',
  validation = null, decision = 'retained',
  parentStateId = 'root', batchId = null,
  rateLimit = null,
  depthTier = null, contextEst = null, actionTag = null,
}) {
  const m = _activeRuns.get(runId);
  if (!m) return null;

  const callId = randomUUID();
  const tokensIn = _estimateTokens(promptText);
  const tokensOut = _estimateTokens(outputText);

  m.agent_calls.push({
    call_id: callId,
    seq: m.agent_calls.length,
    stage,
    role,
    model,
    provider,
    depth_tier: depthTier || m.controller.depth_tier || null,
    prompt_hash: _hash16(promptText),
    prompt_tokens_est: tokensIn,
    output_tokens_est: tokensOut,
    cost_est: _estimateCost(model, tokensIn, tokensOut),
    latency_ms: Math.round(latencyMs),
    started_at: new Date(Date.now() - latencyMs).toISOString(),
    completed_at: new Date().toISOString(),
    success,
    error: error ? String(error).slice(0, 200) : null,
    rate_limit: rateLimit || null,
    output_type: outputType,
    validation: validation || null,
    decision,
    parent_state_id: parentStateId,
    batch_id: batchId,
    context_est: contextEst || null,
    action_tag: actionTag || null,
  });

  return callId;
}

/**
 * Summarize agent calls for a run: per-stage counts and totals.
 * Used by GET /api/runs/:run_id/summary (Opseeq Studio).
 */
function summarizeAgentCalls(runId) {
  const m = _activeRuns.get(runId);
  if (!m) return null;

  const byStage = {};
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0, totalLatency = 0;

  for (const call of m.agent_calls) {
    const stage = call.stage || 'unknown';
    if (!byStage[stage]) {
      byStage[stage] = { count: 0, success: 0, failed: 0, tokens_in: 0, tokens_out: 0, cost_est: 0, latency_ms: 0, providers: {} };
    }
    const s = byStage[stage];
    s.count += 1;
    if (call.success) s.success += 1; else s.failed += 1;
    s.tokens_in += call.prompt_tokens_est || 0;
    s.tokens_out += call.output_tokens_est || 0;
    s.cost_est += call.cost_est || 0;
    s.latency_ms += call.latency_ms || 0;
    const prov = call.provider || 'unknown';
    s.providers[prov] = (s.providers[prov] || 0) + 1;

    totalTokensIn += call.prompt_tokens_est || 0;
    totalTokensOut += call.output_tokens_est || 0;
    totalCost += call.cost_est || 0;
    totalLatency += call.latency_ms || 0;
  }

  for (const s of Object.values(byStage)) {
    s.cost_est = +s.cost_est.toFixed(6);
  }

  return {
    run_id: runId,
    status: m.status,
    tags: m.tags || null,
    depth_score: m.controller.depth_score,
    depth_tier: m.controller.depth_tier,
    pipeline: m.controller.pipeline,
    opseeq_session_id: m.opseeq_session_id || null,
    lifecycle: m.lifecycle || null,
    composition: m.composition || null,
    sum_check: m.sum_check || null,
    totals: {
      agent_calls: m.agent_calls.length,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_est: +totalCost.toFixed(6),
      latency_ms: totalLatency,
    },
    by_stage: byStage,
  };
}

// ---- Branch recording ------------------------------------------------------

function recordBranch(runId, {
  parentStateId = 'root', level = 0, label = '',
  agentCallId = null, score = null, decision = 'retained',
  mergedInto = null,
}) {
  const m = _activeRuns.get(runId);
  if (!m) return null;

  const branchId = randomUUID();
  m.branches.push({
    branch_id: branchId,
    parent_state_id: parentStateId,
    level,
    label,
    agent_call_id: agentCallId,
    score: score || null,
    decision,
    pruned_at: decision === 'pruned' ? new Date().toISOString() : null,
    merged_into: mergedInto,
  });

  m.controller.state_count++;
  m.controller.depth_reached = Math.max(m.controller.depth_reached, level);

  return branchId;
}

// ---- Subview recording -----------------------------------------------------

function addSubview(runId, {
  viewName, viewDescription = '', agentCallIds = [],
  mmdSource = '', score = null, compileResult = null,
  artifacts = null, retained = true, mergeEligible = true,
}) {
  const m = _activeRuns.get(runId);
  if (!m) return null;

  const subviewId = randomUUID();
  const mmdField = mmdSource.length > MAX_MMD_INLINE
    ? `[file:${artifacts?.mmd || 'too-large-inline'}]`
    : mmdSource;

  m.subviews.push({
    subview_id: subviewId,
    seq: m.subviews.length,
    view_name: viewName,
    view_description: viewDescription.slice(0, 500),
    artifact_type: 'architecture_subview',
    agent_call_ids: agentCallIds,
    mmd_source: mmdField,
    score: score || null,
    compile_result: compileResult || null,
    artifacts: artifacts || null,
    retained,
    merge_eligible: mergeEligible,
  });

  // Flip the decomposition tag so the run is filterable as multi-instance.
  m.tags.was_decomposed = true;

  return subviewId;
}

// ---- Merge recording -------------------------------------------------------

function recordMerge(runId, {
  strategy = 'llm_synthesis', inputSubviewIds = [],
  agentCallId = null, preMergeBestScore = 0, postMergeScore = 0,
  accepted = false, rejectionReason = null, truncatedSubviews = null,
}) {
  const m = _activeRuns.get(runId);
  if (!m) return;

  m.merge = {
    required: true,
    strategy,
    input_subview_ids: inputSubviewIds,
    agent_call_id: agentCallId,
    pre_merge_best_score: preMergeBestScore,
    post_merge_score: postMergeScore,
    accepted,
    rejection_reason: rejectionReason,
    truncated_subviews: truncatedSubviews,
  };
}

// ---- Rate event recording --------------------------------------------------

function recordRateEvent(runId, {
  agentCallId = null, type = '429_rate_limit', httpStatus = 429,
  retryAfterMs = 0, retryCount = 0, concurrencyWindow = 0,
  deferred = false, downgradedTo = null, impactMs = 0,
}) {
  const m = _activeRuns.get(runId);
  if (!m) return;

  m.rate_events.push({
    event_id: randomUUID(),
    agent_call_id: agentCallId,
    type,
    http_status: httpStatus,
    retry_after_ms: retryAfterMs,
    retry_count: retryCount,
    concurrency_window: concurrencyWindow,
    deferred,
    downgraded_to: downgradedTo,
    impact_ms: impactMs,
  });
}

// ---- UI stage recording ----------------------------------------------------

function recordUIStage(runId, { stage, message, activeRender = null }) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.ui_stages.push({
    seq: m.ui_stages.length,
    stage,
    message,
    started_at: new Date().toISOString(),
    completed_at: null,
    active_render: activeRender,
  });
}

function completeUIStage(runId, stage) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  const s = [...m.ui_stages].reverse().find(u => u.stage === stage && !u.completed_at);
  if (s) s.completed_at = new Date().toISOString();
}

// ---- Final artifact recording -----------------------------------------------

function setFinalArtifact(runId, {
  diagramName, diagramType, mmdSource = '', metrics = {},
  validation = {}, artifacts = {}, compileAttempts = 1, provider = '',
}) {
  const m = _activeRuns.get(runId);
  if (!m) return;

  if (m.final_artifact) {
    m.prior_artifacts.push(m.final_artifact);
  }

  m.final_artifact = {
    diagram_name: diagramName,
    diagram_type: diagramType,
    mmd_source: mmdSource.length <= MAX_MMD_INLINE ? mmdSource : null,
    mmd_source_hash: _hash16(mmdSource),
    mmd_char_count: mmdSource.length,
    metrics: {
      node_count: metrics.nodeCount || 0,
      edge_count: metrics.edgeCount || 0,
      subgraph_count: metrics.subgraphCount || 0,
    },
    validation: {
      structurally_valid: validation.structurallyValid ?? true,
      svg_valid: validation.svgValid ?? false,
      png_valid: validation.pngValid ?? false,
    },
    artifacts,
    compile_attempts: compileAttempts,
    provider,
  };
}

// ---- User notes ------------------------------------------------------------

function setUserNotes(runId, notes) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.request.user_notes = notes || null;
}

// ---- Persistence (incremental) ---------------------------------------------

async function persist(runId) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  await _atomicWrite(path.join(RUNS_DIR, `${m.run_id}.json`), m);
}

// ---- Finalize: completeness check + totals + persist -----------------------

function _runCompletenessCheck(m) {
  const warnings = [];

  for (const call of m.agent_calls) {
    if (!call.completed_at) warnings.push(`agent_call ${call.call_id.slice(0, 8)} missing completed_at`);
  }
  for (const br of m.branches) {
    if (!br.decision) warnings.push(`branch ${br.branch_id.slice(0, 8)} missing decision`);
  }
  for (const sv of m.subviews) {
    if (sv.compile_result?.ok && !sv.artifacts?.mmd) {
      warnings.push(`subview ${sv.subview_id.slice(0, 8)} compiled ok but missing artifact paths`);
    }
  }
  if (m.merge?.required && !m.merge.accepted && !m.merge.rejection_reason) {
    warnings.push('merge marked required but neither accepted nor rejected');
  }
  if (!m.final_artifact) {
    warnings.push('run completed without final_artifact');
  }

  return warnings;
}

function _computeTotals(m) {
  const calls = m.agent_calls;
  return {
    wall_clock_ms: m.completed_at
      ? new Date(m.completed_at).getTime() - new Date(m.created_at).getTime()
      : Date.now() - new Date(m.created_at).getTime(),
    total_inference_ms: calls.reduce((s, c) => s + (c.latency_ms || 0), 0),
    total_tokens_in: calls.reduce((s, c) => s + (c.prompt_tokens_est || 0), 0),
    total_tokens_out: calls.reduce((s, c) => s + (c.output_tokens_est || 0), 0),
    total_cost_est: +calls.reduce((s, c) => s + (c.cost_est || 0), 0).toFixed(6),
    total_agent_calls: calls.length,
    total_retries: m.rate_events.filter(e => e.type === 'retry').length,
    total_rate_events: m.rate_events.length,
    branches_created: m.branches.length,
    branches_pruned: m.branches.filter(b => b.decision === 'pruned').length,
    subviews_created: m.subviews.length,
    subviews_retained: m.subviews.filter(s => s.retained).length,
    merge_attempted: !!m.merge,
    merge_accepted: !!m.merge?.accepted,
  };
}

/**
 * Quantify how many distinct architecture instances were combined and how
 * cleanly they merged. This is the single number that answers
 * "did the system actually combine multiple architectures into one?".
 *
 *   architecture_instances           = retained subviews count (≥1, =1 for single-shot)
 *   instance_combination_factor      = post_merge_score / max(pre_merge_score, ε)
 *                                      → ≥1.0 when merge improved on the best subview
 *                                      → <1.0 when merge underperformed (regression)
 *   merge_quality                    = 'unattempted' | 'accepted' | 'rejected' | 'regression'
 */
function _computeComposition(m) {
  const subviewCount = m.subviews.length;
  const retainedCount = m.subviews.filter(s => s.retained).length;
  const isSingleShot = subviewCount <= 1;

  let combinationFactor = null;
  let mergeQuality = 'unattempted';

  if (m.merge?.required) {
    const pre = +m.merge.pre_merge_best_score || 0;
    const post = +m.merge.post_merge_score || 0;
    if (pre > 0) {
      combinationFactor = +(post / pre).toFixed(3);
    }

    if (m.merge.accepted) {
      mergeQuality = combinationFactor != null && combinationFactor < 1
        ? 'regression' // accepted but quality dropped — still worth flagging
        : 'accepted';
    } else {
      mergeQuality = 'rejected';
    }
  }

  // Subview score variance — a low variance after retention means the
  // model produced consistent quality across instances; a high variance
  // means one instance dominated. Useful for tuning concurrency caps.
  const scores = m.subviews
    .map(s => +(s.score || 0))
    .filter(x => Number.isFinite(x) && x > 0);
  let scoreVariance = null;
  if (scores.length >= 2) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
    scoreVariance = +variance.toFixed(4);
  }

  return {
    is_single_shot: isSingleShot,
    architecture_instances: retainedCount,
    subview_count: subviewCount,
    subview_retained_count: retainedCount,
    merge_strategy: m.merge?.strategy || null,
    merge_quality: mergeQuality,
    instance_combination_factor: combinationFactor,
    subview_score_variance: scoreVariance,
  };
}

/**
 * End-to-end sum check — flat boolean + concrete issues list. Designed so
 * a downstream consumer (Opseeq Studio, dashboards, CI smoke tests) can
 * answer "is this run trustworthy?" with one field read.
 *
 * Issues are advisory; they do not change the run status. A finalized
 * run with `ok=false` issues is still a valid record — the issues call
 * out gaps in tagging, missing artifacts, or partial pipelines.
 */
function _computeSumCheck(m) {
  const issues = [];

  // Tagging: every finalized run should know its mode, depth tier, and
  // pipeline. 'unknown' values usually mean a stage was skipped.
  if (!m.tags.mode) issues.push('tags.mode missing');
  if (m.tags.depth_tier === 'unknown') issues.push('tags.depth_tier was never set');
  if (!m.tags.pipeline) issues.push('tags.pipeline was never set');

  // Lifecycle: at least ingest + finalize phases must exist.
  const phaseSet = new Set(m.lifecycle.phases.map(p => p.phase));
  if (!phaseSet.has('ingest')) issues.push('lifecycle.ingest phase missing');
  if (!phaseSet.has('finalize')) issues.push('lifecycle.finalize phase missing');

  // Composition consistency: if subviews exist, was_decomposed must be true.
  if (m.subviews.length > 1 && !m.tags.was_decomposed) {
    issues.push('subviews present but tags.was_decomposed is false');
  }

  // Artifact presence vs tags consistency.
  if (m.tags.has_diagram && !m.final_artifact) {
    issues.push('tags.has_diagram=true but final_artifact is null');
  }

  // Token / cost sanity: a successful run with zero agent calls is suspicious.
  if (m.status === 'completed' && m.agent_calls.length === 0) {
    issues.push('completed status with zero agent_calls');
  }

  return {
    ok: issues.length === 0,
    issues,
    counts: {
      agent_calls: m.agent_calls.length,
      branches: m.branches.length,
      subviews: m.subviews.length,
      stages_executed: m.controller.stages_executed.length,
      lifecycle_phases: m.lifecycle.phases.length,
      rate_events: m.rate_events.length,
      warnings: m.warnings.length,
    },
  };
}

// Downstream artifact keys that external routes (TLA+, TS, TSX) persist
// directly to runs/<id>.json via persistRunData, bypassing the in-memory
// manifest. On finalize we merge these back so _atomicWrite does not clobber
// them. Only keys ABSENT from the in-memory manifest are copied from disk.
const _EXTERNAL_ARTIFACT_KEYS = [
  'tla_artifacts', 'tla_metrics', 'tla_verification', 'tla_env',
  'ts_artifacts', 'ts_metrics',
  'tsx_artifacts', 'tsx_metrics',
  'specula_artifacts', 'structural_signature',
];

/**
 * Merge externally-persisted artifact keys from the on-disk run.json into the
 * in-memory manifest `m`. Disk wins ONLY for keys the in-memory copy lacks;
 * populated in-memory keys are never overwritten. Advisory — never throws.
 * @param {object} m in-memory run manifest (mutated in place)
 */
async function _mergeExternalArtifacts(m) {
  try {
    const raw = await fsp.readFile(path.join(RUNS_DIR, `${m.run_id}.json`), 'utf8');
    const disk = JSON.parse(raw);
    for (const key of _EXTERNAL_ARTIFACT_KEYS) {
      const memHas = m[key] && (typeof m[key] !== 'object' || Object.keys(m[key]).length > 0);
      const diskHas = disk[key] && (typeof disk[key] !== 'object' || Object.keys(disk[key]).length > 0);
      if (!memHas && diskHas) {
        m[key] = disk[key];
        logger.info('run_tracker.merged_external_artifact', { runId: m.run_id.slice(0, 8), key });
      }
    }
  } catch { /* no on-disk run.json yet, or unreadable — nothing to merge */ }
}

/**
 * Finalize a run: mark complete, compute totals, run completeness check, persist.
 * @param {string} runId
 * @param {string} [status='completed']
 */
async function finalize(runId, status = 'completed') {
  const m = _activeRuns.get(runId);
  if (!m) return;

  m.status = status;
  m.completed_at = new Date().toISOString();

  // Open the finalize phase (and close any prior in-flight phase) so the
  // lifecycle timeline is always closed-out, even on early exits.
  recordPhase(runId, 'finalize');

  // Merge externally-persisted artifacts back into the in-memory manifest.
  // The TLA+ and TS routes write directly to runs/<id>.json on disk via
  // persistRunData — bypassing this in-memory manifest. Without this merge,
  // the _atomicWrite below would clobber those artifacts with an in-memory
  // copy that never saw them (the run.json clobber bug). Only copy keys the
  // in-memory manifest lacks, so fresher in-memory data always wins.
  await _mergeExternalArtifacts(m);

  // Refresh artifact-presence tags from whatever made it onto the manifest.
  // These tags are the cheapest possible filter for downstream tools.
  m.tags.has_diagram = !!(m.final_artifact && m.final_artifact.diagram_name);
  m.tags.has_tla = !!(m.tla_artifacts && (m.tla_artifacts.tla || m.tla_artifacts.cfg));
  m.tags.has_typescript = !!(m.ts_artifacts && (m.ts_artifacts.source || m.ts_artifacts.harness));
  m.tags.has_tsx = !!(m.tsx_artifacts && m.tsx_artifacts.app);
  m.tags.was_decomposed = m.subviews.length > 1;

  m.warnings = _runCompletenessCheck(m);
  m.totals = _computeTotals(m);
  m.composition = _computeComposition(m);

  // Mark the finalize phase complete before the sum_check evaluates the
  // lifecycle, so the closure timestamp is included in the count.
  completePhase(runId, 'finalize', status === 'completed');

  m.sum_check = _computeSumCheck(m);

  // Compute structural signature for the final artifact
  if (m.final_artifact?.mmd_source) {
    try {
      const sigExtractor = require('./structural-signature');
      m.structural_signature = sigExtractor.extract(m.final_artifact.mmd_source);
    } catch { /* signature extraction is advisory */ }
  }

  // Snapshot rate-master metrics at finalization (only if already initialized)
  try {
    const rmBridge = require('./rate-master-bridge');
    const rmMetrics = rmBridge.getMetrics();  // returns null if not initialized
    if (rmMetrics && rmMetrics.uptimeMs > 0) {
      m.rate_master_snapshot = {
        uptimeMs: rmMetrics.uptimeMs,
        totalQueueDepth: rmMetrics.totalQueueDepth,
        totalActive: rmMetrics.totalActive,
        oodaCycles: rmMetrics.oodaCycles,
        endpoints: Object.fromEntries(
          Object.entries(rmMetrics.endpoints || {}).map(([k, v]) => [k, {
            currentLimit: v.currentLimit,
            totalExecuted: v.totalExecuted,
            totalErrors: v.totalErrors,
            errorRate: v.errorRate,
            queueDepth: v.queueDepth,
            throughputRps: v.throughputRps,
          }])
        ),
      };
    }
  } catch { /* rate-master may not be available */ }

  await _atomicWrite(path.join(RUNS_DIR, `${m.run_id}.json`), m);
  _activeRuns.delete(runId);

  // Persist trace store events to disk
  try { require('./trace-store').persist(runId); } catch { /* optional */ }

  // Non-blocking post-finalization hooks (fire-and-forget)
  if (status === 'completed') {
    try { require('./meta-gateway-bridge').auditRun(runId).catch(() => {}); } catch { /* optional */ }
    try { require('./run-exporter').exportRun(runId, m).catch(() => {}); } catch { /* optional */ }
    try { require('../backend/ingester').ingestRun(runId).catch(e => logger.warn('db.ingest_failed', { error: e.message })); } catch { /* DuckDB optional */ }
  }

  logger.info('run_tracker.finalized', {
    runId: runId.slice(0, 8),
    status,
    warnings: m.warnings.length,
    calls: m.totals.total_agent_calls,
    wallMs: m.totals.wall_clock_ms,
    cost: m.totals.total_cost_est,
  });
}

// ---- Cleanup on startup ----------------------------------------------------

async function cleanup() {
  try {
    await fsp.mkdir(RUNS_DIR, { recursive: true });
    const entries = await fsp.readdir(RUNS_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const fp = path.join(RUNS_DIR, entry);
      try {
        const stat = await fsp.stat(fp);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(fp);
          removed++;
        }
      } catch { /* skip unreadable files */ }
    }

    if (removed > 0) {
      logger.info('run_tracker.cleanup', { removed, retentionDays: RETENTION_DAYS });
    }
  } catch (err) {
    logger.warn('run_tracker.cleanup_error', { error: err.message });
  }
}

// ---- Query: list recent runs -----------------------------------------------

async function listRuns({ limit = 20 } = {}) {
  try {
    const entries = await fsp.readdir(RUNS_DIR);
    const jsonFiles = entries.filter(e => e.endsWith('.json') && !e.endsWith('.tmp'));
    const stats = await Promise.all(
      jsonFiles.map(async f => {
        const fp = path.join(RUNS_DIR, f);
        const stat = await fsp.stat(fp);
        return { file: f, mtime: stat.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats.slice(0, limit).map(s => s.file.replace('.json', ''));
  } catch {
    return [];
  }
}

async function loadRun(runId) {
  try {
    const fp = path.join(RUNS_DIR, `${runId}.json`);
    const raw = await fsp.readFile(fp, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Flatten a run manifest into a deterministic tab-oriented trace.
 *
 * This is the canonical output for the OODA universal tracer:
 * one JSON that captures the full idea → md → mmd → tla → ts lifecycle,
 * every inference call, rate event, and toolchain outcome.
 */
function getTrace(runId, manifest = null) {
  const m = manifest || _activeRuns.get(runId);
  if (!m) return null;

  const calls = (m.agent_calls || []).map(c => ({
    call_id: c.call_id,
    seq: c.seq,
    stage: c.stage,
    role: c.role,
    model: c.model,
    provider: c.provider,
    latency_ms: c.latency_ms,
    success: c.success,
    error: c.error,
    output_type: c.output_type,
    prompt_tokens_est: c.prompt_tokens_est,
    output_tokens_est: c.output_tokens_est,
    cost_est: c.cost_est,
    action_tag: c.action_tag,
    context_est: c.context_est,
  }));

  const phases = (m.lifecycle?.phases || []).map(p => ({
    phase: p.phase,
    seq: p.seq,
    started_at: p.started_at,
    completed_at: p.completed_at,
    ok: p.ok,
  }));

  const tabs = {};
  const inputMode = m.settings?.input_mode || m.tags?.input_mode || null;
  const tabMap = {
    idea: inputMode === 'idea',
    md: inputMode === 'md',
    mmd: !!(m.final_artifact?.mmd_source || m.final_artifact?.mmd_source_hash),
    tla: m.tags?.has_tla,
    ts: m.tags?.has_typescript,
  };
  for (const [tab, present] of Object.entries(tabMap)) {
    tabs[tab] = {
      present: !!present,
      artifact: null,
      ok: null,
      provider: null,
      model: null,
      latency_ms: null,
    };
  }

  if (m.final_artifact) {
    tabs.mmd = {
      present: true,
      artifact: m.final_artifact.mmd_source_hash || null,
      ok: !!m.final_artifact.mmd_source,
      provider: m.final_artifact.provider || null,
      model: null,
      latency_ms: null,
    };
  }

  const failures = [];
  for (const c of calls) {
    if (!c.success) {
      failures.push({
        type: 'inference',
        stage: c.stage,
        tab: _stageToTab(c.stage),
        error_class: _classifyError(c.error),
        message: c.error,
        call_id: c.call_id,
      });
    }
  }
  for (const w of (m.warnings || [])) {
    failures.push({ type: 'completeness', stage: null, tab: null, error_class: 'completeness', message: w });
  }

  return {
    run_id: m.run_id,
    status: m.status,
    created_at: m.created_at,
    completed_at: m.completed_at,
    tags: m.tags,
    tabs,
    phases,
    calls,
    branches: m.branches || [],
    subviews: m.subviews || [],
    rate_events: m.rate_events || [],
    failures,
    consistency: {
      has_diagram: !!m.tags?.has_diagram,
      has_tla: !!m.tags?.has_tla,
      has_typescript: !!m.tags?.has_typescript,
      entity_drift: [],
      state_variable_drift: [],
    },
    totals: m.totals,
    sum_check: m.sum_check,
  };
}

function _stageToTab(stage) {
  if (!stage) return null;
  const s = String(stage);
  if (/tla/i.test(s)) return 'tla';
  if (/ts/i.test(s)) return 'ts';
  if (/mmd|render|compose|plan|extract/i.test(s)) return 'mmd';
  if (/md|markdown/i.test(s)) return 'md';
  return 'idea';
}

function _classifyError(error) {
  if (!error) return 'unknown';
  const e = String(error).toLowerCase();
  if (e.includes('timeout') || e.includes('abort')) return 'timeout';
  if (e.includes('429') || e.includes('rate') || e.includes('too many')) return 'rate_limit';
  if (e.includes('parse') || e.includes('json') || e.includes('syntax')) return 'parse';
  if (e.includes('schema') || e.includes('contract')) return 'schema';
  if (e.includes('exhausted') || e.includes('unavailable') || e.includes('enotfound')) return 'provider_exhausted';
  if (e.includes('refus')) return 'model_refusal';
  return 'unknown';
}

module.exports = {
  create,
  getManifest,
  setProfile,
  setPipeline,
  setDepth,
  setOpseeqSession,
  addStage,
  recordPhase,
  completePhase,
  recordAgentCall,
  summarizeAgentCalls,
  recordBranch,
  addSubview,
  recordMerge,
  recordRateEvent,
  recordUIStage,
  completeUIStage,
  setFinalArtifact,
  setUserNotes,
  persist,
  finalize,
  cleanup,
  listRuns,
  loadRun,
  getTrace,
  LIFECYCLE_PHASES,
  get RUNS_DIR() { return RUNS_DIR; },
  _setRunsDir,
};
