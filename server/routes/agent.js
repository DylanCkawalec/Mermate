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
const { analyze } = require('../services/input-analyzer');
const provider = require('../services/inference-provider');
const roleRegistry = require('../services/role-registry');
const telemetry = require('../services/inference-telemetry');
const auditTracker = require('../services/audit-tracker');
const narrator = require('../services/terminal-narrator');
const runTracker = require('../services/run-tracker');
const rmBridge = require('../services/rate-master-bridge');
const catalog = require('../services/model-catalog');
const logger = require('../utils/logger');

// Render timeout: separate from inference timeout so long HPC-GoT pipelines
// don't hit undici's default 300s headersTimeout when called agent→render.
const RENDER_TIMEOUT_MS = parseInt(process.env.MERMATE_RENDER_TIMEOUT || '660000', 10);

const router = Router();

const ASSETS_DIR = path.resolve(__dirname, '..', '..', '.cursor', 'assets');

const AGENT_MODES = {
  'code-review': {
    id: 'code-review',
    label: 'Code Review',
    description: 'Recover architecture from a live codebase',
    icon: 'code',
    file: 'CODE-REVIEW-MODE.txt',
  },
  'thinking': {
    id: 'thinking',
    label: 'Thinking',
    description: 'Build architecture from ideas, notes, or problem statements',
    icon: 'lightbulb',
    file: 'THINKING-MODE.txt',
  },
  'optimize-mmd': {
    id: 'optimize-mmd',
    label: 'Optimize',
    description: 'Improve existing Mermaid or markdown without breaking intent',
    icon: 'tune',
    file: 'OPTIMIZE-MMD-MODE.txt',
  },
};

async function _loadModePrompt(modeId) {
  const mode = AGENT_MODES[modeId];
  if (!mode) return null;
  try {
    return await fsp.readFile(path.join(ASSETS_DIR, mode.file), 'utf-8');
  } catch {
    return null;
  }
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
    parts.push(`Reason as a specialist in ${domain}. Apply deep expertise in this domain when analysing the architecture.`);
  }
  if (stage === 'planning') {
    parts.push(`[STAGE: Architecture Planning — analyse structure, constraints, entities, failure paths, and boundaries.]`);
  } else if (stage === 'refining') {
    parts.push(`[STAGE: Architecture Refinement — strengthen missing failure paths, boundaries, observability, and specificity.]`);
  }
  if (modePromptSkeleton) {
    parts.push(`\n[MODE CONTEXT]\n${modePromptSkeleton.slice(0, 1500)}`);
  }
  return parts.join('\n');
}

/**
 * Internal fetch to the render endpoint.
 *
 * Uses a dedicated AbortController with RENDER_TIMEOUT_MS so long HPC-GoT
 * pipelines don't hit undici's default 300s headersTimeout.  The parent
 * abort (client disconnect) is also wired in so a tab-close still cancels.
 */
async function _fetchRender(urlPath, body, parentAbort) {
  const renderAbort = new AbortController();
  const timer = setTimeout(() => renderAbort.abort(new Error('render_timeout')), RENDER_TIMEOUT_MS);
  const parentListener = () => renderAbort.abort();
  parentAbort.signal.addEventListener('abort', parentListener, { once: true });
  try {
    const PORT = process.env.PORT || 3333;
    const resp = await fetch(`http://localhost:${PORT}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: renderAbort.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timer);
    parentAbort.signal.removeEventListener('abort', parentListener);
  }
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

const MODE_ROLE_DOMAINS = {
  'thinking':     ['formal_reasoning', 'systems_compilers', 'human_centric_systems'],
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

function _composeThinkingSummary(role, stage) {
  const info = STAGE_SUMMARIES[stage] || { verb: 'reasoning about', fallback: 'Processing' };
  if (!role || role === 'default') return info.fallback;
  const shortName = role.name.replace(/^Doctor_/, 'Dr. ').replace(/_/g, ' ');
  const domainLabel = (role.domain || 'general').replace(/_/g, ' ');
  return `${shortName} — ${info.verb} ${domainLabel}`;
}

router.get('/agent/modes', (_req, res) => {
  const modes = Object.values(AGENT_MODES).map(m => ({
    id: m.id, label: m.label, description: m.description, icon: m.icon,
  }));
  return res.json({ success: true, modes });
});

// ---- Phase 1: Run through planning, refinement, and preview ----

router.post('/agent/run', async (req, res) => {
  const { prompt, mode, current_text, diagram_name } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }
  if (!mode || !AGENT_MODES[mode]) {
    return res.status(400).json({ success: false, error: 'invalid agent mode' });
  }

  const userDiagramName = diagram_name?.trim() || undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Abort controller — cancelled when the client disconnects (browser
  // refresh, tab close, or frontend stop). Propagated into all fetch calls
  // so in-flight LLM requests are torn down immediately.
  //
  // IMPORTANT: must use res.on('close'), NOT req.on('close').
  // req 'close' fires as soon as the request body is consumed (immediately
  // after JSON parsing), which would abort the pipeline before it starts.
  // res 'close' fires when the SSE connection actually drops.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished && !abort.signal.aborted) {
      logger.info('agent.run.client_disconnected');
      abort.abort();
    }
  });

  function sendEvent(type, data) {
    if (abort.signal.aborted) return;
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  }

  const runId = telemetry.createRun(`agent:${mode}`);
  const auditId = auditTracker.createRun(runId, `agent:${mode}`);

  const gotConfig = require('../services/got-config').getConfig();
  const startText = current_text || prompt;

  // Parallel init: run tracker creation + mode prompt load + analysis all concurrently
  const [parentRunId, modePromptSkeleton, profile] = await Promise.all([
    runTracker.create({
      mode,
      maxMode: true,
      enhance: true,
      userInput: prompt.slice(0, 5000),
      userDiagramName: userDiagramName,
      inputMode: 'idea',
      gotConfig,
      models: {
        orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || 'gpt-4o',
        worker: process.env.MERMATE_WORKER_MODEL || 'gpt-4o',
        fast: process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-4o-mini',
      },
    }).catch(() => null),
    _loadModePrompt(mode),
    Promise.resolve(analyze(startText, 'idea')),
  ]);

  // Wire narrator: emits 'narration' events from audit stream → SSE
  const stopNarrator = narrator.watchRun(auditId, runId, sendEvent, auditTracker);

  try {
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'ingest' });
    sendEvent('stage', { stage: 'ingest', message: 'Reading prompt and mode configuration...' });
    const modeRoles = _selectRolesForMode(mode);

    // ---- Planning ----
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'planning' });
    sendEvent('stage', { stage: 'planning', message: 'Analyzing architecture and generating plan...' });
    sendEvent('analysis', {
      maturity: profile.maturity,
      quality: profile.qualityScore,
      completeness: profile.completenessScore,
      entities: profile.shadow?.entities?.length || 0,
      relationships: profile.shadow?.relationships?.length || 0,
      gaps: profile.shadow?.gaps || [],
    });

    const planningUserPrompt = [
      '[USER PROMPT]', prompt, '',
      current_text && current_text !== prompt ? '[CURRENT DRAFT]\n' + current_text : '',
      '', '[ANALYSIS]',
      `Maturity: ${profile.maturity}`, `Quality: ${profile.qualityScore}`,
      `Entities: ${profile.shadow?.entities?.length || 0}`,
      `Gaps: ${(profile.shadow?.gaps || []).join('; ') || 'none'}`, '',
      'Produce a stronger architecture description. Be specific about services, data stores, flows, and failure handling.',
    ].filter(Boolean).join('\n');

    if (abort.signal.aborted) return;

    // P7: Multi-role planning — run up to 3 roles concurrently, score, pick best
    const planRoles = modeRoles.slice(0, 3).filter(Boolean);
    if (planRoles.length === 0) planRoles.push(null);

    auditTracker.emit(auditId, 'agent:batch_start', { roleCount: planRoles.length, level: 0, stage: 'planning' });

    for (const r of planRoles) {
      sendEvent('thinking', {
        role: r?.name || 'default',
        domain: r?.domain || 'general',
        stage: 'planning',
        summary: _composeThinkingSummary(r, 'planning'),
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
      const planCtx = catalog.estimateContext('copilot_enhance', planningUserPrompt);
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
      const refineSummary = _composeThinkingSummary(refineRole, 'refining');

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

    // ---- Validation / preview render (cheap mode) ----
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'agent:stage_enter', { stage: 'preview' });
    auditTracker.emit(auditId, 'render:prepare', { maxMode: false });
    sendEvent('stage', { stage: 'preview', message: 'Running preview render...' });

    // Heartbeat keeps the SSE connection alive during long renders.
    const heartbeatInterval = setInterval(() => {
      if (!abort.signal.aborted) sendEvent('heartbeat', {});
    }, 15_000);

    // For optimize-mmd mode the draft is already valid Mermaid — use 'mmd'
    // so the render endpoint skips the HPC-GoT LLM pipeline and goes straight
    // to compile.  All other modes keep 'idea' to trigger full enhancement.
    const previewInputMode = mode === 'optimize-mmd' ? 'mmd' : 'idea';

    let previewData;
    try {
      previewData = await _fetchRender('/api/render', {
        mermaid_source: draftText,
        diagram_name: userDiagramName,
        enhance: previewInputMode !== 'mmd',
        input_mode: previewInputMode,
        max_mode: false,
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
      diagram_name: previewDiagramName,
      run_id: parentRunId,
    });

  } catch (err) {
    if (abort.signal.aborted) return;
    auditTracker.emit(auditId, 'sys:error', { message: err.message, stage: 'run' });
    logger.error('agent.run.error', { error: err.message });
    sendEvent('error', { message: err.message });
    if (parentRunId) await runTracker.finalize(parentRunId, 'failed').catch(() => {});
  } finally {
    stopNarrator();
    auditTracker.closeRun(auditId);
    res.end();
  }
});

// ---- Phase 2: Finalize with Max render (after user notes) ----

router.post('/agent/finalize', async (req, res) => {
  const { current_text, mode, user_notes } = req.body || {};

  if (!current_text || typeof current_text !== 'string') {
    return res.status(400).json({ success: false, error: 'current_text is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished && !abort.signal.aborted) {
      logger.info('agent.finalize.client_disconnected');
      abort.abort();
    }
  });

  function sendEvent(type, data) {
    if (abort.signal.aborted) return;
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  }

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
    sendEvent('stage', { stage: 'finalizing', message: 'Running final Max render...' });

    const heartbeatInterval = setInterval(() => {
      if (!abort.signal.aborted) sendEvent('heartbeat', {});
    }, 15_000);

    const diagramName = req.body.diagram_name || undefined;
    const agentParentRunId = req.body.agent_parent_run_id || null;
    const finalInputMode = mode === 'optimize-mmd' ? 'mmd' : 'idea';
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
      sendEvent('final_render', {
        success: true,
        diagram_name: finalData.diagram_name,
        diagram_type: finalData.diagram_type,
        paths: finalData.paths,
        metrics: finalData.mmd_metrics,
        max_mode: finalData.render_meta?.max_mode,
        attempts: finalData.render_meta?.attempts,
        provider: finalData.enhance_meta?.provider,
      });
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
    sendEvent('done', { final_text: draftText, run_id: agentParentRunId || finalData.run_id });

  } catch (err) {
    if (abort.signal.aborted) return;
    auditTracker.emit(finalizeAuditId, 'sys:error', { message: err.message, stage: 'finalize' });
    logger.error('agent.finalize.error', { error: err.message });
    sendEvent('error', { message: err.message });
  } finally {
    stopNarrator();
    auditTracker.closeRun(finalizeAuditId);
    res.end();
  }
});

module.exports = router;
