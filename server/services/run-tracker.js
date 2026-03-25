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
  const json = JSON.stringify(data, null, 2);
  await fsp.writeFile(tmpPath, json, 'utf8');
  await fsp.rename(tmpPath, filePath);
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
    },

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
    entity_count: profile.shadow?.entities?.length || 0,
    shadow: {
      entities: (profile.shadow?.entities || []).slice(0, 30).map(e => ({ name: e.name, type: e.type })),
      relationships: (profile.shadow?.relationships || []).slice(0, 25).map(r => ({ from: r.from, verb: r.verb, to: r.to })),
      gaps: (profile.shadow?.gaps || []).slice(0, 10),
    },
  };
}

// ---- Pipeline recording ----------------------------------------------------

function setPipeline(runId, pipeline) {
  const m = _activeRuns.get(runId);
  if (!m) return;
  m.controller.pipeline = pipeline;
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
  });

  return callId;
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
    agent_call_ids: agentCallIds,
    mmd_source: mmdField,
    score: score || null,
    compile_result: compileResult || null,
    artifacts: artifacts || null,
    retained,
    merge_eligible: mergeEligible,
  });

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
 * Finalize a run: mark complete, compute totals, run completeness check, persist.
 * @param {string} runId
 * @param {string} [status='completed']
 */
async function finalize(runId, status = 'completed') {
  const m = _activeRuns.get(runId);
  if (!m) return;

  m.status = status;
  m.completed_at = new Date().toISOString();
  m.warnings = _runCompletenessCheck(m);
  m.totals = _computeTotals(m);

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

  // Non-blocking post-finalization hooks (fire-and-forget)
  if (status === 'completed') {
    try { require('./meta-gateway-bridge').auditRun(runId).catch(() => {}); } catch { /* optional */ }
    try { require('./run-exporter').exportRun(runId, m).catch(() => {}); } catch { /* optional */ }
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

module.exports = {
  create,
  getManifest,
  setProfile,
  setPipeline,
  addStage,
  recordAgentCall,
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
  get RUNS_DIR() { return RUNS_DIR; },
  _setRunsDir,
};
