'use strict';

/**
 * Agent route — orchestrates multi-step architecture refinement.
 *
 * POST /api/agent/run
 *   Stages: ingest -> planning -> refinement -> validation render -> preview_ready
 *   Pauses before Max render so the user can add final notes.
 *
 * POST /api/agent/finalize
 *   Accepts { current_text, mode, user_notes } and runs the final Max render
 *   with the user's notes merged into the context.
 *
 * GET /api/agent/modes
 *   Returns available agent modes with their prompt skeletons.
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { analyze } = require('../services/input-analyzer');
const provider = require('../services/inference-provider');
const roleRegistry = require('../services/role-registry');
const telemetry = require('../services/inference-telemetry');
const auditTracker = require('../services/audit-tracker');
const narrator = require('../services/terminal-narrator');
const runTracker = require('../services/run-tracker');
const rmBridge = require('../services/rate-master-bridge');
const catalog = require('../services/model-catalog');
const opseeq = require('../services/opseeq-bridge');
const agentLoader = require('../services/agent-loader');
const logger = require('../utils/logger');

// Render timeout: separate from inference timeout so long HPC-GoT pipelines
// don't hit undici's default 300s headersTimeout when called agent→render.
const RENDER_TIMEOUT_MS = parseInt(process.env.MERMATE_RENDER_TIMEOUT || '660000', 10);

const router = Router();

// Canonical artifacts envelope — attached to every SSE event that carries
// artifact sources. The frontend's normalizeAgentEvent prefers this shape;
// the legacy per-key fields (md_source, draft_text…) remain for older
// clients during the transition.
function _withArtifactsEnvelope(data) {
  if (!data) return data;
  const md = data.md_source || data.draft_text || '';
  const mmd = data.mmd_source || data.compiled_source || '';
  const tla = data.tla_source || '';
  const ts = data.ts_source || '';
  if (!md && !mmd && !tla && !ts) return data;
  return { ...data, artifacts: { md, mmd, tla, ts } };
}

// Mode prompt briefs: repo-tracked agents/modes/ is primary; legacy
// .cursor/assets kept as fallback for older local setups.
const MODE_PROMPT_DIRS = [
  path.resolve(__dirname, '..', '..', 'agents', 'modes'),
  path.resolve(__dirname, '..', '..', '.cursor', 'assets'),
];

const AGENT_MODES = {
  'code-review': {
    id: 'code-review',
    label: 'Code Review',
    description: 'Recover architecture from a live codebase',
    icon: 'code',
    file: 'CODE-REVIEW-MODE.txt',
    stage: 'mmd',
  },
  'thinking': {
    id: 'thinking',
    label: 'Thinking',
    description: 'Build architecture from ideas, notes, or problem statements',
    icon: 'lightbulb',
    file: 'THINKING-MODE.txt',
    stage: 'mmd',
  },
  'optimize-mmd': {
    id: 'optimize-mmd',
    label: 'Optimize',
    description: 'Improve existing Mermaid or markdown without breaking intent',
    icon: 'tune',
    file: 'OPTIMIZE-MMD-MODE.txt',
    stage: 'mmd',
  },
  'tla-verify': {
    id: 'tla-verify',
    label: 'Verify Spec',
    description: 'Validate and repair TLA+ specification',
    icon: 'check',
    file: 'TLA-VERIFY-MODE.txt',
    stage: 'tla',
  },
  'tla-optimize': {
    id: 'tla-optimize',
    label: 'Optimize TLA+',
    description: 'Strengthen invariants and state coverage',
    icon: 'tune',
    file: 'TLA-OPTIMIZE-MODE.txt',
    stage: 'tla',
  },
  'ts-generate': {
    id: 'ts-generate',
    label: 'Generate Runtime',
    description: 'Compile TLA+ spec to TypeScript',
    icon: 'build',
    file: 'TS-GENERATE-MODE.txt',
    stage: 'ts',
  },
  'ts-optimize': {
    id: 'ts-optimize',
    label: 'Optimize TS',
    description: 'Improve generated TypeScript quality',
    icon: 'tune',
    file: 'TS-OPTIMIZE-MODE.txt',
    stage: 'ts',
  },
  'full-build': {
    id: 'full-build',
    label: 'Full Build',
    description: 'Idea \u2192 Diagram \u2192 TLA+ \u2192 TypeScript \u2192 Bundle',
    icon: 'build_all',
    file: 'FULL-BUILD-MODE.txt',
    stage: 'mmd',
  },
};

const _modePromptCache = new Map();

async function _loadModePrompt(modeId) {
  const mode = AGENT_MODES[modeId];
  if (!mode) return null;
  if (_modePromptCache.has(modeId)) return _modePromptCache.get(modeId);
  let prompt = null;
  for (const dir of MODE_PROMPT_DIRS) {
    try {
      prompt = await fsp.readFile(path.join(dir, mode.file), 'utf-8');
      break;
    } catch { /* try next dir */ }
  }
  _modePromptCache.set(modeId, prompt);
  return prompt;
}

/**
 * Build the injected user-prompt header for a given agent role and stage.
 *
 * This is ADDED to the user prompt — it does NOT replace the stage's
 * axiom-based system prompt. The axiom system prompt defines the output
 * contract (JSON schema, Mermaid format, etc.). This header provides
 * agent identity and domain context so the model reasons from the correct
 * perspective while still honouring the exact return contract.
 */
function _buildAgentRoleHeader(role, stage, modePromptSkeleton) {
  const parts = [];
  if (role && role.name && role.name !== 'default') {
    const shortName = role.name.replace(/^Doctor_/, 'Dr. ').replace(/_/g, ' ');
    const domain = (role.domain || 'general').replace(/_/g, ' ');
    parts.push(`[REASONING ROLE: ${shortName} — domain: ${domain}]`);
    // Agent doctrine: identity + behavior + signature questions from
    // agents/agent_*.txt, matched by domain. Precomputed at load time
    // (~200 tokens max) — this is where the agent spec corpus actually
    // shapes inference.
    const doctrine = agentLoader.getAgentByDomain(role.domain);
    if (doctrine?.promptBlock) {
      parts.push(doctrine.promptBlock);
    } else {
      parts.push(`Reason as a senior specialist in ${domain}. Bring this domain's characteristic failure modes, constraints, and design patterns to bear; judge the architecture only through that lens.`);
    }
  }
  if (stage === 'planning') {
    parts.push(`[STAGE: Architecture Planning — decompose the input into entities, relationships, boundaries, and failure paths. Decide what is stateful vs structural, and name constraints before proposing structure.]`);
  } else if (stage === 'refining') {
    parts.push(`[STAGE: Architecture Refinement — close the gaps: missing failure paths, weak boundaries, absent observability, vague naming. Strengthen the draft without changing the user's intent.]`);
  }
  if (modePromptSkeleton) {
    parts.push(`\n[MODE CONTEXT]\n${modePromptSkeleton.trim().slice(0, 1500)}`);
  }
  return parts.join('\n');
}

/**
 * Internal POST to the render endpoint over node:http.
 *
 * Node's global fetch (undici) enforces a hard 300s headersTimeout that an
 * AbortController CANNOT extend — deep-spec renders exceeding 300s die with
 * a generic "fetch failed". node:http has no implicit timeout, so the only
 * limits are RENDER_TIMEOUT_MS and the parent abort (client stop).
 */
function _fetchRender(urlPath, body, parentAbort) {
  return new Promise((resolve, reject) => {
    const PORT = process.env.PORT || 3333;
    const payload = JSON.stringify(body);
    const req = http.request({
      host: 'localhost',
      port: PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        cleanup();
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(new Error(`render_response_parse_failed: ${e.message}`)); }
      });
      res.on('error', (e) => { cleanup(); reject(e); });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`render_timeout after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);
    const parentListener = () => req.destroy(new Error('aborted'));
    parentAbort.signal.addEventListener('abort', parentListener, { once: true });

    function cleanup() {
      clearTimeout(timer);
      parentAbort.signal.removeEventListener('abort', parentListener);
    }

    req.on('error', (e) => { cleanup(); reject(e); });
    req.write(payload);
    req.end();
  });
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Read the persisted TLA+/TS artifact sources for a run from disk. Used as a
 * fallback so pipeline/bundle SSE events always carry artifact text even when
 * a downstream fetch failed or returned partial data — the user should never
 * lose a spec that already exists on disk. Advisory — never throws.
 */
async function _readPersistedSources(runId) {
  const out = { tla: null, cfg: null, ts: null };
  if (!runId) return out;
  try {
    const runData = JSON.parse(await fsp.readFile(path.join(PROJECT_ROOT, 'runs', `${runId}.json`), 'utf-8'));
    const read = async (rel) => {
      if (!rel || typeof rel !== 'string') return null;
      try { return await fsp.readFile(path.join(PROJECT_ROOT, rel.replace(/^\//, '')), 'utf-8'); }
      catch { return null; }
    };
    out.tla = await read(runData.tla_artifacts?.tla);
    out.cfg = await read(runData.tla_artifacts?.cfg);
    out.ts = await read(runData.ts_artifacts?.source);
  } catch { /* run.json missing/unreadable — nothing to recover */ }
  return out;
}

// ---------------------------------------------------------------------------
//  Detached agent sessions — an agent run survives browser refresh.
//
//  The run executes server-side against a session-owned AbortController.
//  Every SSE event is buffered in the session AND broadcast to attached
//  listeners. If the browser disconnects (refresh / tab close), the run
//  keeps going for AGENT_SESSION_GRACE_MS; a reattaching client replays the
//  buffered events and continues live. Explicit stop is a separate route.
// ---------------------------------------------------------------------------

const AGENT_SESSION_GRACE_MS = parseInt(process.env.MERMATE_AGENT_GRACE || '300000', 10);
const AGENT_SESSION_RETAIN_MS = 10 * 60_000;
const _agentSessions = new Map();

function _createAgentSession(kind, mode) {
  const session = {
    id: randomUUID(),
    kind,                     // 'run' | 'finalize'
    mode: mode || null,
    status: 'running',        // running | done | error | stopped
    startedAt: Date.now(),
    events: [],               // buffered SSE frames for replay
    listeners: new Set(),     // attached http responses
    abort: new AbortController(),
    graceTimer: null,
  };
  _agentSessions.set(session.id, session);
  return session;
}

function _sessionSend(session, type, data) {
  const frame = `data: ${JSON.stringify({ type, ..._withArtifactsEnvelope(data) })}\n\n`;
  if (type !== 'heartbeat') {
    session.events.push(frame);
    if (session.events.length > 3000) session.events.splice(0, session.events.length - 3000);
  }
  for (const res of session.listeners) {
    try { res.write(frame); } catch {}
  }
}

function _sessionAttach(session, res) {
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }
  session.listeners.add(res);
  res.on('close', () => {
    session.listeners.delete(res);
    if (session.status !== 'running' || session.listeners.size > 0) return;
    logger.info('agent.session.detached', { session: session.id.slice(0, 8), graceMs: AGENT_SESSION_GRACE_MS });
    session.graceTimer = setTimeout(() => {
      if (session.status === 'running' && session.listeners.size === 0) {
        logger.info('agent.session.grace_expired', { session: session.id.slice(0, 8) });
        session.status = 'stopped';
        session.abort.abort();
      }
    }, AGENT_SESSION_GRACE_MS);
  });
}

function _sessionEnd(session, status) {
  if (session.status === 'running') session.status = status;
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }
  for (const res of session.listeners) {
    try { res.end(); } catch {}
  }
  session.listeners.clear();
  const t = setTimeout(() => _agentSessions.delete(session.id), AGENT_SESSION_RETAIN_MS);
  if (t.unref) t.unref();
}

function _extractText(output) {
  if (!output) return null;
  let text = output;
  try {
    const parsed = JSON.parse(text);
    if (parsed.enhanced_source) text = parsed.enhanced_source;
  } catch { /* not JSON */ }
  return text.trim();
}

// `thinking` and `full-build` get a 4-domain pool so we can run up to 4
// concurrent planners on deep architectures. Shallow inputs cap at 2-3.
const MODE_ROLE_DOMAINS = {
  'thinking':     ['formal_reasoning', 'systems_compilers', 'human_centric_systems', 'structural_precision'],
  'full-build':   ['formal_reasoning', 'systems_compilers', 'human_centric_systems', 'structural_precision'],
  'optimize-mmd': ['structural_precision', 'minimal_structure', 'programmatic_complexity'],
  'code-review':  ['systems_compilers', 'formal_reasoning', 'narrative_orchestration'],
};

const STAGE_SUMMARIES = {
  planning:  { verb: 'analyzing architecture structure for', fallback: 'Planning architecture structure' },
  refining:  { verb: 'strengthening boundaries and flows for', fallback: 'Refining architecture detail' },
  preview:   { verb: 'validating render readiness for', fallback: 'Preparing preview render' },
};

function _selectRolesForMode(mode) {
  const domains = MODE_ROLE_DOMAINS[mode] || MODE_ROLE_DOMAINS['thinking'];
  const roles = [];
  for (const domain of domains) {
    const found = roleRegistry.getRolesByDomain(domain);
    const enabled = found.find(r => r.enabled);
    if (enabled) roles.push(enabled);
  }
  return roles;
}

/**
 * Compose a dynamic "thinking" summary that includes the depth tier and
 * problem domain so Opseeq can render a meaningful per-role status line.
 */
function _composeThinkingSummary(role, stage, profile = null) {
  const info = STAGE_SUMMARIES[stage] || { verb: 'reasoning about', fallback: 'Processing' };
  const tier = profile?.architectureDepthTier;
  const domain = profile?.intent?.problemDomain;
  const tierTag = tier && tier !== 'shallow' ? ` [${tier} depth]` : '';
  const domainTag = domain && domain !== 'general' ? ` · ${domain}` : '';
  if (!role || role === 'default') return `${info.fallback}${tierTag}${domainTag}`;
  const shortName = role.name.replace(/^Doctor_/, 'Dr. ').replace(/_/g, ' ');
  const domainLabel = (role.domain || 'general').replace(/_/g, ' ');
  return `${shortName} — ${info.verb} ${domainLabel}${tierTag}${domainTag}`;
}

router.get('/agent/modes', (_req, res) => {
  const modes = Object.values(AGENT_MODES).map(m => ({
    id: m.id, label: m.label, description: m.description, icon: m.icon, stage: m.stage,
  }));
  return res.json({ success: true, modes });
});

// ---- Phase 1: Run through planning, refinement, and preview ----

router.post('/agent/run', async (req, res) => {
  const { prompt, mode, current_text, current_stage, current_run_id, diagram_name } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }
  if (!mode || !AGENT_MODES[mode]) {
    return res.status(400).json({ success: false, error: 'invalid agent mode' });
  }

  const userDiagramName = diagram_name?.trim() || undefined;

  logger.info('agent.run.start', { mode, current_stage, current_run_id, diagram_name: userDiagramName, promptLength: prompt.length });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Detached session — the run is owned by the session, NOT the SSE
  // connection. A browser refresh detaches the listener but the pipeline
  // keeps running; the client reattaches via GET /agent/attach/:id.
  // Explicit stop is POST /agent/stop/:id (used by the Pause button).
  const session = _createAgentSession('run', mode);
  const abort = session.abort;
  _sessionAttach(session, res);

  function sendEvent(type, data) {
    if (abort.signal.aborted) return;
    _sessionSend(session, type, data);
  }

  // First frame: hand the session id to the client so it can reattach
  // after a refresh instead of restarting the whole pipeline.
  sendEvent('agent_session', { session_id: session.id, mode, kind: 'run' });

  // Immediate feedback: emit ingest stage event BEFORE slow setup so the
  // client sees progression even if runTracker.create or analyze take 1-2s.
  // This prevents the "Starting agent..." message from appearing stuck.
  sendEvent('stage', { stage: 'ingest', message: `Reading ${current_stage || 'idea'} input and preparing ${mode} mode...` });

  const runId = telemetry.createRun(`agent:${mode}`);
  const auditId = auditTracker.createRun(runId, `agent:${mode}`);

  const gotConfig = require('../services/got-config').getConfig();
  const startText = current_text || prompt;
  const currentStage = ['idea', 'md', 'mmd', 'tla', 'ts'].includes(current_stage) ? current_stage : 'idea';

  // Parallel init: run tracker creation + mode prompt load + analysis all concurrently
  const [parentRunId, modePromptSkeleton, profile] = await Promise.all([
    runTracker.create({
      mode,
      maxMode: true,
      enhance: true,
      userInput: prompt.slice(0, 5000),
      userDiagramName: userDiagramName,
      inputMode: currentStage,
      gotConfig,
      models: {
        orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || 'gpt-5.6-sol',
        worker: process.env.MERMATE_WORKER_MODEL || 'gpt-5.6-terra',
        fast: process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-5.6-luna',
      },
    }).catch(() => null),
    _loadModePrompt(mode),
    Promise.resolve(analyze(startText, currentStage)),
  ]);

  // Wire narrator: emits 'narration' events from audit stream → SSE
  const stopNarrator = narrator.watchRun(auditId, runId, sendEvent, auditTracker);

  try {
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'ingest' });
    sendEvent('narration', {
      message: `Configured ${mode} mode for ${currentStage} stage`,
      source: 'system',
      eventType: 'agent:configured',
    });

    // Surface the architecture depth decision as soon as it's known so
    // Opseeq Studio can log it without having to wait for the planning stage.
    const depthScore = profile.architectureDepthScore ?? 0;
    const depthTier = profile.architectureDepthTier || 'shallow';
    auditTracker.emit(auditId, 'agent:depth_score', {
      score: depthScore,
      tier: depthTier,
      factors: profile.architectureDepthFactors || null,
      problem_domain: profile?.intent?.problemDomain || 'general',
    });
    sendEvent('depth', { score: depthScore, tier: depthTier });
    if (parentRunId) {
      runTracker.setDepth(parentRunId, {
        score: depthScore,
        tier: depthTier,
        factors: profile.architectureDepthFactors || null,
      });
      opseeq.reportStage(parentRunId, {
        stage: 'agent_depth_score',
        score: depthScore,
        tier: depthTier,
      });
    }

    const modeRoles = _selectRolesForMode(mode);

    // ---- Planning ----
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'planning' });
    opseeq.reportStage(parentRunId, {
      stage: 'agent_planning',
      mode,
      entities: profile.shadow?.entities?.length || 0,
      depth_tier: depthTier,
      depth_score: depthScore,
    });
    sendEvent('stage', { stage: 'planning', message: 'Analyzing architecture and generating plan...' });
    sendEvent('analysis', {
      maturity: profile.maturity,
      quality: profile.qualityScore,
      completeness: profile.completenessScore,
      entities: profile.shadow?.entities?.length || 0,
      relationships: profile.shadow?.relationships?.length || 0,
      gaps: profile.shadow?.gaps || [],
    });

    if (currentStage === 'tla' && (mode === 'tla-verify' || mode === 'tla-optimize')) {
      auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'tla_verify' });
      sendEvent('stage', { stage: 'tla_build', message: 'Validating current TLA+ artifact...' });
      const tlaData = await _fetchRender(
        current_run_id ? '/api/render/tla/edit' : '/api/render/tla/check',
        current_run_id
          ? { run_id: current_run_id, tla_source: startText }
          : { tla_source: startText, module_name: userDiagramName || 'AgentSpec' },
        abort,
      );
      sendEvent('pipeline_stage', {
        stage: 'tla',
        success: !!tlaData.success,
        run_id: current_run_id || null,
        diagram_name: userDiagramName,
        sany_valid: tlaData.sany?.valid ?? !!tlaData.success,
        tlc_checked: !!tlaData.tlc?.checked,
        violations: tlaData.tlc?.violations?.length || 0,
        tla_source: tlaData.tla_source || startText,
        cfg_source: tlaData.cfg_source || null,
        error: tlaData.error || null,
      });
      sendEvent('done', { final_text: tlaData.tla_source || startText, tla_source: tlaData.tla_source || '', cfg_source: tlaData.cfg_source || null });
      return;
    }

    if (currentStage === 'ts' && (mode === 'ts-generate' || mode === 'ts-optimize')) {
      auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'ts_build' });
      sendEvent('stage', { stage: 'ts_build', message: current_run_id ? 'Compiling TypeScript runtime from current run context...' : 'Reviewing current TypeScript artifact...' });
      let tsData = { success: false, ts_source: startText, error: 'No run context available for TypeScript compilation.' };
      if (current_run_id) {
        tsData = await _fetchRender('/api/render/ts', {
          run_id: current_run_id,
          diagram_name: userDiagramName,
        }, abort);
      }
      sendEvent('pipeline_stage', {
        stage: 'ts',
        success: !!tsData.success,
        run_id: current_run_id || null,
        diagram_name: userDiagramName,
        compile_ok: !!tsData.compile?.success,
        tests_ok: !!tsData.tests?.success,
        ts_source: tsData.ts_source || startText,
        error: tsData.error || tsData.details || null,
      });
      sendEvent('done', { final_text: tsData.ts_source || startText, ts_source: tsData.ts_source || '' });
      return;
    }

    // Preservation policy — when the input is already a mature, data-rich
    // specification (high quality/completeness, or a large structured doc),
    // the user's data is the source of truth. Planning may reorganize and
    // fill gaps but must NOT summarize or replace it with a simplification.
    const isMatureInput =
      (profile.qualityScore >= 0.7 && profile.completenessScore >= 0.7)
      || startText.length >= 6000;

    const planningDirective = isMatureInput
      ? [
          'The user input is already a rich, detailed specification. PRESERVE IT.',
          'Keep every entity, section, table, constraint, protocol, and named component from the input.',
          'Do NOT summarize, simplify, or drop data. Reorganize for clarity and fill genuine gaps only.',
          'The user\'s data is the source of truth — your output must contain at least as much information as the input.',
        ].join('\n')
      : 'Produce a stronger architecture description. Be specific about services, data stores, flows, and failure handling.';

    const planningUserPrompt = [
      `[CURRENT ARTIFACT STAGE] ${currentStage}`,
      '[USER PROMPT]', prompt, '',
      current_text && current_text !== prompt ? '[CURRENT DRAFT]\n' + current_text : '',
      '', '[ANALYSIS]',
      `Maturity: ${profile.maturity}`, `Quality: ${profile.qualityScore}`,
      `Entities: ${profile.shadow?.entities?.length || 0}`,
      `Gaps: ${(profile.shadow?.gaps || []).join('; ') || 'none'}`, '',
      planningDirective,
    ].filter(Boolean).join('\n');

    if (abort.signal.aborted) return;

    // P7: Multi-role planning — run roles concurrently, score, pick best.
    // Cap scales with depth: deep -> 4, medium -> 3, shallow -> 2.
    const planCap = depthTier === 'deep' ? 4 : depthTier === 'medium' ? 3 : 2;
    const planRoles = modeRoles.slice(0, planCap).filter(Boolean);
    if (planRoles.length === 0) planRoles.push(null);

    auditTracker.emit(auditId, 'agent:batch_start', { roleCount: planRoles.length, level: 0, stage: 'planning', depth_tier: depthTier });

    for (const r of planRoles) {
      sendEvent('thinking', {
        role: r?.name || 'default',
        domain: r?.domain || 'general',
        stage: 'planning',
        summary: _composeThinkingSummary(r, 'planning', profile),
      });
    }

    const planCallStart = Date.now();
    const planTasks = planRoles.map(role => {
      const header = _buildAgentRoleHeader(role, 'planning', modePromptSkeleton);
      const fullPrompt = header ? `${header}\n\n${planningUserPrompt}` : planningUserPrompt;
      auditTracker.emit(auditId, 'agent:role_start', {
        role: role?.name || 'default',
        domain: role?.domain || 'general',
        stage: 'planning',
      });
      const call = role
        ? provider.inferWithRole('copilot_enhance', { userPrompt: fullPrompt }, role.name)
        : provider.infer('copilot_enhance', { userPrompt: fullPrompt });
      return call.then(result => ({ role, result }));
    });

    const planResults = await Promise.all(planTasks);
    const planLatency = Date.now() - planCallStart;

    // Score each plan result by analyzing it
    const planCtx = catalog.estimateContext('copilot_enhance', planningUserPrompt);
    const scoredPlans = [];
    for (const { role, result } of planResults) {
      const roleName = role?.name || 'default';
      auditTracker.emit(auditId, 'agent:role_end', {
        role: roleName,
        stage: 'planning',
        latencyMs: result.latencyMs || planLatency,
        success: !!result.output,
        provider: result.provider,
      });
      telemetry.record(runId, {
        stage: 'planning',
        role: roleName,
        model: result.model || 'unknown',
        provider: result.provider || 'unknown',
        promptText: planningUserPrompt,
        outputText: result.output || '',
        latencyMs: result.latencyMs || planLatency,
        success: !!result.output,
      });

      auditTracker.emit(auditId, 'rm:action_tag', {
        stage: catalog.canonicalStage('copilot_enhance'),
        role: roleName,
        model: result.model || 'unknown',
        priority: catalog.stagePriority('copilot_enhance'),
        inTok: planCtx.inputTokensEst,
        outTok: planCtx.outputTokensEst,
        ctxPct: +(planCtx.contextUtilization * 100).toFixed(1),
        tag: result.actionTag?.tag || null,
      });

      if (result.output && result.output.trim() !== startText.trim()) {
        const extracted = _extractText(result.output);
        if (extracted) {
          // Shrinkage guard — a plan that loses more than 40% of a mature
          // input is a simplification, not an improvement. Reject it so the
          // user's data survives to the preview render.
          if (isMatureInput && extracted.length < startText.length * 0.6) {
            logger.info('agent.plan_rejected_shrinkage', {
              role: roleName,
              inputLen: startText.length,
              planLen: extracted.length,
            });
            auditTracker.emit(auditId, 'agent:plan_rejected', {
              role: roleName, reason: 'shrinkage', inputLen: startText.length, planLen: extracted.length,
            });
            continue;
          }
          const planProfile = analyze(extracted, 'idea');
          scoredPlans.push({
            text: extracted,
            score: planProfile.qualityScore + planProfile.completenessScore,
            role: roleName,
            provider: result.provider,
          });
        }
      }
    }

    auditTracker.emit(auditId, 'agent:batch_end', {
      survived: scoredPlans.length,
      total: planRoles.length,
      stage: 'planning',
    });

    // Emit phase_metric after planning batch
    {
      const runTotals = telemetry.getRunSummary(runId) || {};
      sendEvent('phase_metric', {
        level: 0,
        branches_active: scoredPlans.length,
        branches_pruned: planRoles.length - scoredPlans.length,
        sigma: scoredPlans.length > 0 ? +(scoredPlans[0]?.score || 0).toFixed(3) : 0,
        budget_used: planRoles.length,
        tokens_in: runTotals.totalTokensIn || 0,
        tokens_out: runTotals.totalTokensOut || 0,
        cost: runTotals.totalCost || 0,
        elapsed_ms: Date.now() - planCallStart,
      });
    }

    // Select best plan by combined quality+completeness score
    let draftText = startText;
    if (scoredPlans.length > 0) {
      scoredPlans.sort((a, b) => b.score - a.score);
      const best = scoredPlans[0];
      draftText = best.text;
      logger.info('agent.multi_role_planning', {
        candidates: scoredPlans.length,
        bestRole: best.role,
        bestScore: best.score,
        scores: scoredPlans.map(p => ({ role: p.role, score: +p.score.toFixed(3) })),
      });
      auditTracker.emit(auditId, 'agent:draft_update', { text: draftText, reason: 'planning', selectedRole: best.role });
      sendEvent('draft_update', { text: draftText, original: startText, reason: `Best of ${scoredPlans.length} plans (${best.role})` });
    }

    auditTracker.emit(auditId, 'got:level_complete', { level: 0, stage: 'planning' });

    // ---- Refinement ----
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'refining' });
    sendEvent('stage', { stage: 'refining', message: 'Refining architecture structure...' });

    const refinedProfile = analyze(draftText, 'idea');
    const q = refinedProfile.qualityScore;
    const c = refinedProfile.completenessScore;

    // Graduated refinement: heavy rewrite < 0.5, targeted gap-fill 0.5-0.7, skip > 0.7
    const needsHeavyRewrite = q < 0.5 || c < 0.5;
    const needsTargetedFill = !needsHeavyRewrite && (q < 0.7 || c < 0.7);
    const skipRefinement = !needsHeavyRewrite && !needsTargetedFill;

    if (!skipRefinement) {
      if (abort.signal.aborted) return;

      // Heavy rewrite uses a different role (index 2) for fresh perspective
      const refineRole = needsHeavyRewrite
        ? (modeRoles[2] || modeRoles[1] || modeRoles[0] || null)
        : (modeRoles[1] || modeRoles[0] || null);
      const refineSummary = _composeThinkingSummary(refineRole, 'refining', refinedProfile);

      auditTracker.emit(auditId, 'agent:role_start', {
        role: refineRole?.name || 'default',
        domain: refineRole?.domain || 'general',
        stage: 'refining',
        pressure: needsHeavyRewrite ? 'heavy' : 'targeted',
      });
      sendEvent('thinking', {
        role: refineRole?.name || 'default',
        domain: refineRole?.domain || 'general',
        stage: 'refining',
        summary: refineSummary,
      });

      const refineInstruction = needsHeavyRewrite
        ? 'This draft needs significant improvement. Rewrite with proper architectural decomposition, explicit failure paths, clear service boundaries, data stores, and operational concerns. Be thorough.'
        : 'This draft is developing well but has gaps. Add missing failure paths, strengthen boundary definitions, and improve observability coverage. Keep existing structure intact.';

      const refineRoleHeader = _buildAgentRoleHeader(refineRole, 'refining', null);
      const refineUserPrompt = [
        refineRoleHeader,
        `[CURRENT DRAFT]`,
        draftText,
        '',
        `[ANALYSIS]`,
        `Quality: ${q}`,
        `Completeness: ${c}`,
        `Gaps: ${(refinedProfile.shadow?.gaps || []).join('; ') || 'none'}`,
        `Refinement pressure: ${needsHeavyRewrite ? 'HEAVY' : 'TARGETED'}`,
        '',
        refineInstruction,
      ].filter(Boolean).join('\n');

      const refineCallStart = Date.now();
      const refineResult = refineRole
        ? await provider.inferWithRole('copilot_enhance', { userPrompt: refineUserPrompt }, refineRole.name)
        : await provider.infer('copilot_enhance', { userPrompt: refineUserPrompt });
      const refineLatency = refineResult.latencyMs || (Date.now() - refineCallStart);

      auditTracker.emit(auditId, 'agent:role_end', {
        role: refineRole?.name || 'default',
        stage: 'refining',
        latencyMs: refineLatency,
        success: !!refineResult.output,
        provider: refineResult.provider,
      });

      const refineCtx = catalog.estimateContext('copilot_enhance', refineUserPrompt);
      telemetry.record(runId, {
        stage: 'refining',
        role: refineRole?.name || 'default',
        model: refineResult.model || 'unknown',
        provider: refineResult.provider || 'unknown',
        promptText: refineUserPrompt,
        outputText: refineResult.output || '',
        latencyMs: refineLatency,
        success: !!refineResult.output,
      });

      auditTracker.emit(auditId, 'rm:action_tag', {
        stage: catalog.canonicalStage('copilot_enhance'),
        role: refineRole?.name || 'default',
        model: refineResult.model || 'unknown',
        priority: catalog.stagePriority('copilot_enhance'),
        inTok: refineCtx.inputTokensEst,
        outTok: refineCtx.outputTokensEst,
        ctxPct: +(refineCtx.contextUtilization * 100).toFixed(1),
        tag: refineResult.actionTag?.tag || null,
      });

      if (refineResult.output && refineResult.output.trim() !== draftText.trim()) {
        const prevDraft = draftText;
        draftText = _extractText(refineResult.output) || draftText;
        auditTracker.emit(auditId, 'agent:draft_update', { text: draftText, reason: 'refining' });
        sendEvent('draft_update', { text: draftText, original: prevDraft, reason: 'Refined architecture with additional detail' });
      }
    }

    auditTracker.emit(auditId, 'got:level_complete', { level: 1, stage: 'refining', skipped: skipRefinement });

    // Emit phase_metric after refinement
    {
      const runTotals = telemetry.getRunSummary(runId) || {};
      const refProfile = analyze(draftText, 'idea');
      sendEvent('phase_metric', {
        level: 1,
        sigma: +(refProfile.qualityScore || 0).toFixed(3),
        branches_active: scoredPlans.length,
        tokens_in: runTotals.totalTokensIn || 0,
        tokens_out: runTotals.totalTokensOut || 0,
        cost: runTotals.totalCost || 0,
        elapsed_ms: Date.now() - planCallStart,
      });
    }

    // ---- Validation / preview render (cheap mode) ----
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'preview' });
    auditTracker.emit(auditId, 'render:prepare', { maxMode: false });
    opseeq.reportStage(parentRunId, { stage: 'agent_preview', mode: mode });
    sendEvent('stage', { stage: 'preview', message: 'Running preview render...' });

    // Heartbeat keeps the SSE connection alive during long renders.
    const heartbeatInterval = setInterval(() => {
      if (!abort.signal.aborted) sendEvent('heartbeat', {});
    }, 15_000);

    // Stage-aware resume: if the user restarts the agent from Markdown,
    // treat it as Markdown; if they restart from Mermaid or choose optimize,
    // use the fast MMD compile/repair path. This preserves the user's current
    // tab context instead of forcing every run back through "simple idea".
    const previewInputMode = mode === 'optimize-mmd'
      ? (currentStage === 'md' ? 'md' : 'mmd')
      : (currentStage === 'md' || currentStage === 'mmd' ? currentStage : 'idea');

    let previewData;
    try {
      previewData = await _fetchRender('/api/render', {
        mermaid_source: draftText,
        diagram_name: userDiagramName,
        enhance: previewInputMode !== 'mmd',
        input_mode: previewInputMode,
        max_mode: true,
        audit_run_id: auditId,
        parent_run_id: parentRunId,
        agent_mode: mode,
      }, abort);
    } finally {
      clearInterval(heartbeatInterval);
    }

    // Track preview diagram_name so finalize can overwrite it
    let previewDiagramName = null;
    if (previewData.success) {
      previewDiagramName = previewData.diagram_name;
      auditTracker.emit(auditId, 'render:complete', {
        nodeCount: previewData.mmd_metrics?.nodeCount,
        edgeCount: previewData.mmd_metrics?.edgeCount,
        attempts: previewData.render_meta?.attempts,
      });
      sendEvent('preview_render', {
        success: true,
        paths: previewData.paths,
        run_id: previewData.run_id || parentRunId || undefined,
        md_source: previewData.markdown_source || draftText,
        mmd_source: previewData.compiled_source || '',
        artifact_paths: previewData.paths || {},
        metrics: previewData.mmd_metrics,
        diagram_name: previewData.diagram_name,
        diagram_type: previewData.diagram_type,
        attempts: previewData.render_meta?.attempts,
      });
    } else {
      auditTracker.emit(auditId, 'render:failed', { error: previewData.details || previewData.error });
      sendEvent('preview_render', {
        success: false,
        error: previewData.details || previewData.error,
      });
    }

    auditTracker.emit(auditId, 'got:level_complete', { level: 2, stage: 'preview' });

    // Emit phase_metric after preview render
    {
      const runTotals = telemetry.getRunSummary(runId) || {};
      sendEvent('phase_metric', {
        level: 2,
        sigma: previewData.success ? 1 : 0,
        sv: previewData.success ? 1 : 0,
        branches_active: scoredPlans.length,
        tokens_in: runTotals.totalTokensIn || 0,
        tokens_out: runTotals.totalTokensOut || 0,
        cost: runTotals.totalCost || 0,
        elapsed_ms: Date.now() - planCallStart,
      });
    }

    const runSummary = telemetry.getRunSummary(runId);
    if (runSummary) {
      sendEvent('telemetry', runSummary);
    }

    sendEvent('audit_summary', auditTracker.getAuditSummary(auditId));

    // Record agent call history in parent run JSON
    if (parentRunId) {
      for (const { role, result } of planResults) {
        runTracker.recordAgentCall(parentRunId, {
          stage: 'planning', role: role?.name || 'default',
          model: result.model || 'unknown', provider: result.provider || 'unknown',
          promptText: planningUserPrompt, outputText: result.output || '',
          latencyMs: result.latencyMs || planLatency, success: !!result.output,
        });
      }
      runTracker.addStage(parentRunId, 'planning');
      if (!skipRefinement) runTracker.addStage(parentRunId, 'refining');
      runTracker.addStage(parentRunId, 'preview');
      runTracker.recordUIStage(parentRunId, { stage: 'preview_ready', message: 'Preview complete, awaiting user notes' });
      await runTracker.persist(parentRunId).catch(() => {});
    }

    auditTracker.emit(auditId, 'agent:convergence', { pct: 60 });
    sendEvent('preview_ready', {
      message: 'Preview ready. Add optional notes before final Max render.',
      draft_text: draftText,
      md_source: previewData.markdown_source || draftText,
      mmd_source: previewData.compiled_source || '',
      diagram_name: previewDiagramName,
      run_id: parentRunId,
    });

  } catch (err) {
    if (!abort.signal.aborted) {
      auditTracker.emit(auditId, 'sys:error', { message: err.message, stage: 'run' });
      logger.error('agent.run.error', { error: err.message });
      sendEvent('error', { message: err.message });
      if (parentRunId) await runTracker.finalize(parentRunId, 'failed').catch(() => {});
    }
    stopNarrator();
    auditTracker.closeRun(auditId);
    _sessionEnd(session, abort.signal.aborted ? 'stopped' : 'error');
    return;
  }
  stopNarrator();
  auditTracker.closeRun(auditId);
  _sessionEnd(session, 'done');
});

// ---- Session reattach / stop / discovery ----

router.get('/agent/active', (_req, res) => {
  const sessions = [];
  for (const s of _agentSessions.values()) {
    sessions.push({
      session_id: s.id,
      kind: s.kind,
      mode: s.mode,
      status: s.status,
      started_at: s.startedAt,
      events: s.events.length,
    });
  }
  return res.json({ success: true, sessions });
});

router.get('/agent/attach/:sessionId', (req, res) => {
  const session = _agentSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'session_not_found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay everything the client missed, then continue live.
  for (const frame of session.events) {
    try { res.write(frame); } catch {}
  }

  if (session.status !== 'running') {
    try { res.end(); } catch {}
    return;
  }

  logger.info('agent.session.reattached', { session: session.id.slice(0, 8), buffered: session.events.length });
  _sessionAttach(session, res);
});

router.post('/agent/stop/:sessionId', (req, res) => {
  const session = _agentSessions.get(req.params.sessionId);
  if (!session) {
    return res.json({ success: true, status: 'gone' });
  }
  if (session.status === 'running') {
    session.status = 'stopped';
    session.abort.abort();
    logger.info('agent.session.stopped', { session: session.id.slice(0, 8) });
  }
  return res.json({ success: true, status: session.status });
});

// ---- Phase 2: Finalize with Max render (after user notes) ----

router.post('/agent/finalize', async (req, res) => {
  const { current_text, mode, user_notes, current_stage, current_run_id } = req.body || {};

  if (!current_text || typeof current_text !== 'string') {
    return res.status(400).json({ success: false, error: 'current_text is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Detached session — the final Max render is the longest step in the
  // pipeline; it must survive a browser refresh exactly like /agent/run.
  const session = _createAgentSession('finalize', mode);
  const abort = session.abort;
  _sessionAttach(session, res);

  function sendEvent(type, data) {
    if (abort.signal.aborted) return;
    _sessionSend(session, type, data);
  }

  sendEvent('agent_session', { session_id: session.id, mode, kind: 'finalize' });

  const finalizeAuditId = auditTracker.createRun(null, 'agent:finalize');
  const stopNarrator = narrator.watchRun(finalizeAuditId, null, sendEvent, auditTracker);

  try {
    let draftText = current_text.trim();
    const hasNotes = !!(user_notes && user_notes.trim());

    // ---- Note-decision audit event ----
    auditTracker.emit(finalizeAuditId, 'agent:note_decision', { hasNotes });

    // If user provided notes, do one more refinement pass incorporating them
    if (hasNotes) {
      if (abort.signal.aborted) return;
      auditTracker.emit(finalizeAuditId, 'agent:stage_enter', { stage: 'incorporating_notes' });
      sendEvent('stage', { stage: 'incorporating_notes', message: 'Applying your notes to the architecture...' });

      const _noteStart = Date.now();
      const noteResult = await provider.infer('copilot_enhance', {
        userPrompt: [
          '[CURRENT ARCHITECTURE DRAFT]', draftText, '',
          '[USER REVIEW NOTES]', user_notes.trim(), '',
          'Apply the user\'s review notes to improve the architecture.',
          'Preserve existing structure. Focus only on what the user asked to change.',
        ].join('\n'),
      });
      logger.info('agent.notes.timing', { ms: Date.now() - _noteStart, provider: noteResult.provider, hasOutput: !!noteResult.output, noOp: noteResult.noOp });

      if (noteResult.output && noteResult.output.trim() !== draftText.trim()) {
        const prevDraft = draftText;
        draftText = _extractText(noteResult.output) || draftText;
        auditTracker.emit(finalizeAuditId, 'agent:draft_update', { text: draftText, reason: 'notes' });
        sendEvent('draft_update', { text: draftText, original: prevDraft, reason: 'Applied review notes' });
      }
    }

    // ---- Final Max render ----
    if (abort.signal.aborted) return;
    auditTracker.emit(finalizeAuditId, 'agent:stage_enter', { stage: 'finalizing' });
    auditTracker.emit(finalizeAuditId, 'render:prepare', { maxMode: true });
    auditTracker.emit(finalizeAuditId, 'agent:convergence', { pct: 85 });
    opseeq.reportStage(req.body.agent_parent_run_id || current_run_id, { stage: 'agent_finalize', mode: req.body.mode });
    sendEvent('stage', { stage: 'finalizing', message: 'Running final Max render...' });

    const heartbeatInterval = setInterval(() => {
      if (!abort.signal.aborted) sendEvent('heartbeat', {});
    }, 15_000);

    const diagramName = req.body.diagram_name || undefined;
    const agentParentRunId = req.body.agent_parent_run_id || current_run_id || null;
    const currentStage = ['idea', 'md', 'mmd', 'tla', 'ts'].includes(current_stage) ? current_stage : 'idea';
    const finalInputMode = mode === 'optimize-mmd'
      ? (currentStage === 'md' ? 'md' : 'mmd')
      : (currentStage === 'md' || currentStage === 'mmd' ? currentStage : 'idea');
    let finalData;
    try {
      finalData = await _fetchRender('/api/render', {
        mermaid_source: draftText,
        diagram_name: diagramName,
        enhance: finalInputMode !== 'mmd',
        input_mode: finalInputMode,
        max_mode: true,
        audit_run_id: finalizeAuditId,
        parent_run_id: agentParentRunId,
        agent_mode: mode,
      }, abort);
    } finally {
      clearInterval(heartbeatInterval);
    }

    if (finalData.success) {
      auditTracker.emit(finalizeAuditId, 'render:complete', {
        nodeCount: finalData.mmd_metrics?.nodeCount,
        edgeCount: finalData.mmd_metrics?.edgeCount,
        maxMode: true,
      });
      auditTracker.emit(finalizeAuditId, 'agent:convergence', { pct: 100 });
      sendEvent('phase_metric', {
        level: 3,
        sigma: 1,
        sv: 1,
        elapsed_ms: Date.now() - (req._agentStartTime || Date.now()),
      });
      sendEvent('final_render', {
        success: true,
        diagram_name: finalData.diagram_name,
        diagram_type: finalData.diagram_type,
        paths: finalData.paths,
        run_id: finalData.run_id || agentParentRunId || undefined,
        md_source: finalData.markdown_source || draftText,
        mmd_source: finalData.compiled_source || '',
        artifact_paths: finalData.paths || {},
        metrics: finalData.mmd_metrics,
        max_mode: finalData.render_meta?.max_mode,
        attempts: finalData.render_meta?.attempts,
        provider: finalData.enhance_meta?.provider,
      });

      // ---- Full Build: chain TLA+ and TS after successful MMD render ----
      if (mode === 'full-build' && finalData.diagram_name && (finalData.run_id || agentParentRunId)) {
        const fbRunId = finalData.run_id || agentParentRunId;
        const fbName = finalData.diagram_name;

        if (!abort.signal.aborted) {
          sendEvent('stage', { stage: 'tla_build', message: 'Generating TLA+ specification via Specula...' });
          auditTracker.emit(finalizeAuditId, 'agent:stage_enter', { stage: 'tla' });
          try {
            const tlaData = await _fetchRender('/api/render/tla', {
              diagram_name: fbName,
              run_id: fbRunId,
              audit_run_id: finalizeAuditId,
            }, abort);

            // Guarantee artifact text on every downstream event: if the render
            // response didn't echo the source, read it back from disk so the
            // TLA+ tab always populates — even on partial/failed validation.
            let tlaSrc = tlaData.tla_source || null;
            let cfgSrc = tlaData.cfg_source || null;
            if (!tlaSrc) {
              const persisted = await _readPersistedSources(fbRunId);
              tlaSrc = persisted.tla;
              cfgSrc = cfgSrc || persisted.cfg;
            }

            sendEvent('pipeline_stage', {
              stage: 'tla',
              success: tlaData.success,
              sany_valid: tlaData.sany?.valid,
              tlc_checked: tlaData.tlc?.checked,
              violations: tlaData.tlc?.violations?.length || 0,
              tla_source: tlaSrc,
              cfg_source: cfgSrc,
            });

            if (tlaData.success && tlaData.sany?.valid && !abort.signal.aborted) {
              sendEvent('stage', { stage: 'ts_build', message: 'Compiling TypeScript runtime from TLA+ spec...' });
              auditTracker.emit(finalizeAuditId, 'agent:stage_enter', { stage: 'ts' });
              try {
                const tsData = await _fetchRender('/api/render/ts', {
                  diagram_name: fbName,
                  run_id: fbRunId,
                  audit_run_id: finalizeAuditId,
                }, abort);

                let tsSrc = tsData.ts_source || null;
                if (!tsSrc) tsSrc = (await _readPersistedSources(fbRunId)).ts;

                sendEvent('pipeline_stage', {
                  stage: 'ts',
                  success: tsData.success,
                  compile_ok: tsData.compile?.success,
                  tests_ok: tsData.tests?.success,
                  ts_source: tsSrc,
                });

                sendEvent('bundle_ready', {
                  diagram_name: fbName,
                  run_id: fbRunId,
                  stages_completed: ['mmd', 'tla', 'ts'],
                  tla_valid: tlaData.sany?.valid,
                  ts_compiled: tsData.compile?.success,
                  mmd_source: finalData.compiled_source || '',
                  tla_source: tlaSrc,
                  cfg_source: cfgSrc,
                  ts_source: tsSrc,
                });
              } catch (tsErr) {
                sendEvent('pipeline_stage', { stage: 'ts', success: false, error: tsErr.message });
                // TS failed, but TLA+ succeeded — still ship the verified spec
                // so the user keeps the artifact they already paid for.
                sendEvent('bundle_ready', {
                  diagram_name: fbName,
                  run_id: fbRunId,
                  stages_completed: ['mmd', 'tla'],
                  tla_valid: tlaData.sany?.valid,
                  ts_compiled: false,
                  mmd_source: finalData.compiled_source || '',
                  tla_source: tlaSrc,
                  cfg_source: cfgSrc,
                });
              }
            } else {
              // TLA+ ran but didn't fully validate — still ship whatever spec
              // was generated so the TLA+ tab populates for manual repair.
              sendEvent('bundle_ready', {
                diagram_name: fbName,
                run_id: fbRunId,
                stages_completed: ['mmd'],
                tla_valid: tlaData.sany?.valid || false,
                ts_compiled: false,
                mmd_source: finalData.compiled_source || '',
                tla_source: tlaSrc,
                cfg_source: cfgSrc,
              });
            }
          } catch (tlaErr) {
            sendEvent('pipeline_stage', { stage: 'tla', success: false, error: tlaErr.message });
            // Even if the TLA+ fetch threw, a prior partial spec may exist on
            // disk — recover it so the user isn't left with an empty tab.
            const persisted = await _readPersistedSources(fbRunId);
            sendEvent('bundle_ready', {
              diagram_name: fbName,
              run_id: fbRunId,
              stages_completed: ['mmd'],
              tla_valid: false,
              ts_compiled: false,
              mmd_source: finalData.compiled_source || '',
              tla_source: persisted.tla,
              cfg_source: persisted.cfg,
            });
          }
        }
      }

    } else {
      auditTracker.emit(finalizeAuditId, 'render:failed', { error: finalData.details || finalData.error });
      sendEvent('final_render', {
        success: false,
        error: finalData.details || finalData.error,
      });
    }

    // Finalize the agent parent run if it was passed from Phase 1
    if (agentParentRunId) {
      runTracker.addStage(agentParentRunId, 'finalize');
      if (finalData.success) {
        runTracker.setFinalArtifact(agentParentRunId, {
          diagramName: finalData.diagram_name || diagramName,
          diagramType: finalData.diagram_type || '',
          mmdSource: finalData.compiled_source || '',
          metrics: finalData.mmd_metrics || {},
          validation: {
            structurallyValid: true,
            svgValid: finalData.validation?.svg_valid || false,
            pngValid: finalData.validation?.png_valid || false,
          },
          artifacts: finalData.paths || {},
          compileAttempts: finalData.render_meta?.attempts || 1,
          provider: finalData.enhance_meta?.provider || '',
        });
      }
      await runTracker.finalize(agentParentRunId, finalData.success ? 'completed' : 'failed').catch(() => {});
    }

    auditTracker.emit(finalizeAuditId, 'agent:stage_enter', { stage: 'complete' });
    sendEvent('stage', { stage: 'complete', message: 'Agent workflow complete' });
    sendEvent('done', { final_text: draftText, md_source: draftText, mmd_source: finalData.compiled_source || '', run_id: agentParentRunId || finalData.run_id });

  } catch (err) {
    if (abort.signal.aborted) return;
    auditTracker.emit(finalizeAuditId, 'sys:error', { message: err.message, stage: 'finalize' });
    logger.error('agent.finalize.error', { error: err.message });
    sendEvent('error', { message: err.message });
  } finally {
    stopNarrator();
    auditTracker.closeRun(finalizeAuditId);
    _sessionEnd(session, abort.signal.aborted ? 'stopped' : 'done');
  }
});

module.exports = router;
