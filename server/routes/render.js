'use strict';

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { archive, archiveCompiled } = require('../services/mermaid-archiver');
const { validate: validateMmd } = require('../services/mermaid-validator');
const { route, renderPrepare, renderHPCGoT, renderMaxUpgrade, decomposeAndRender, compileWithRetry, RouterError, _setAuditEmitter, _setRunId } = require('../services/input-router');
const enhancerBridge = require('../services/gpt-enhancer-bridge');
const provider = require('../services/inference-provider');
const runTracker = require('../services/run-tracker');
const visualProvider = require('../services/visual-provider');
const { buildPrompt } = require('../services/axiom-prompts');
const { analyze } = require('../services/input-analyzer');
const { compileMarkdownArtifact } = require('../services/markdown-compiler');
const { deriveDiagramName } = require('../utils/naming');
const opseeq = require('../services/opseeq-bridge');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';
const ENHANCER_TIMEOUT_MS = parseInt(process.env.MERMAID_ENHANCER_TIMEOUT || '15000', 10);

const router = Router();
const COPILOT_STAGES = new Set(['copilot_suggest', 'copilot_enhance']);

const _MERMAID_DIRECTIVE_RE = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\b|mindmap|timeline|journey|C4Context|C4Container|C4Dynamic|quadrantChart|sankey-beta|xychart-beta|block-beta|gitgraph)\b/i;

/**
 * Post-processing safety net for Mermaid enhance output.
 *
 * When a weaker model (e.g. gpt-oss:20b) ignores the "output Mermaid only"
 * instruction and returns prose with arrows, this function:
 *   1. Extracts Mermaid from ```mermaid code blocks if present
 *   2. If the output starts with a valid directive, keeps it as-is
 *   3. If lines look like Mermaid edges (A --> B), prepends the original
 *      diagram directive from the user's input
 *   4. Otherwise falls back to the original input — better to return valid
 *      Mermaid unchanged than replace it with an English description
 */
function _sanitizeMmdOutput(output, originalInput) {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) return originalInput;

  // Already valid — starts with a Mermaid directive
  if (_MERMAID_DIRECTIVE_RE.test(trimmedOutput)) {
    return trimmedOutput;
  }

  // Try to extract from ```mermaid ... ``` code block
  const codeBlockMatch = trimmedOutput.match(/```(?:mermaid)?\s*\n([\s\S]*?)\n```/i);
  if (codeBlockMatch) {
    const extracted = codeBlockMatch[1].trim();
    if (_MERMAID_DIRECTIVE_RE.test(extracted)) {
      return extracted;
    }
  }

  // Try to extract lines that look like Mermaid edges (A --> B, A -.-> B, etc.)
  const lines = trimmedOutput.split('\n');
  const edgeLines = lines.filter(l => /^\s*\w+.*(-->)|(-\.->)|(==>)|(--x)|(--o)|(\.-\.)\s*\w+/i.test(l.trim()));

  if (edgeLines.length >= 2) {
    // Try to get the directive from the original input
    const origFirstLine = originalInput.split('\n').find(l => l.trim());
    const directiveMatch = origFirstLine && origFirstLine.match(_MERMAID_DIRECTIVE_RE);
    const directive = directiveMatch ? origFirstLine.trim() : 'flowchart TB';

    // Filter to only keep lines that look like valid Mermaid (edges, nodes, subgraph, etc.)
    const mermaidLines = lines.filter(l => {
      const t = l.trim();
      if (!t || t.startsWith('%%')) return true; // comments
      if (_MERMAID_DIRECTIVE_RE.test(t)) return true; // directives
      if (/^(subgraph|end|classDef|class|style|linkStyle)\b/i.test(t)) return true;
      if (/^\w+.*(-->)|(-\.->)|(==>)|(--x)|(--o)|(\.-\.)\s*\w+/i.test(t)) return true;
      if (/^\w+\[.*\]|^\w+\(.*\)|^\w+\{.*\}|^\w+>".*"/.test(t)) return true;
      return false;
    });

    if (mermaidLines.length >= 2) {
      return [directive, ...mermaidLines].join('\n');
    }
  }

  // Fall back to original input — the model produced prose, not Mermaid
  logger.warn('copilot.enhance.mmd_prose_fallback', {
    outputLen: trimmedOutput.length,
    outputPreview: trimmedOutput.slice(0, 100),
  });
  return originalInput;
}

// #region agent log
function _dbgPipeline(hypothesisId, location, message, data) {
  if (process.env.MERMATE_DEBUG_PIPELINE !== '1') return;
  fetch('http://127.0.0.1:7647/ingest/a2d7b582-6018-42c8-abf3-55f08db02976', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '984aae' },
    body: JSON.stringify({
      sessionId: '984aae',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

async function callEnhancer(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCER_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENHANCER_URL}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/copilot/health
 * Frontend-safe health probe: reports available if ANY provider in the chain
 * can serve copilot requests (Ollama, QGoT, premium API, or Python enhancer).
 */
router.get('/copilot/health', async (_req, res) => {
  try {
    const providers = await provider.checkProviders();
    const available = providers.ollama || providers.premium || providers.enhancer || providers.qgot;
    const maxAvailable = provider.isMaxAvailable();
    const visualAvailable = visualProvider.isAvailable();
    return res.status(available ? 200 : 503).json({
      success: available,
      available,
      providers,
      maxAvailable,
      visual: visualAvailable,
    });
  } catch (err) {
    logger.warn('copilot.health.error', { error: err.message });
    return res.status(503).json({
      success: false,
      available: false,
    });
  }
});

/**
 * GET /api/visual/styles
 * Returns available visual style presets for the Gemini visualization layer.
 */
router.get('/visual/styles', (_req, res) => {
  return res.json({
    success: true,
    available: visualProvider.isAvailable(),
    styles: visualProvider.getStyles(),
    default_style: process.env.GEMINI_VISUAL_STYLE || 'tech-dark',
  });
});

/**
 * POST /api/analyze
 * Returns an InputProfile for the given text — maturity, quality, completeness,
 * intent, shadow model, recommendation, and hint. Called by the frontend on
 * debounced input changes to power intelligent suggestion gating and hints.
 */
router.post('/analyze', (req, res) => {
  const text = req.body?.text;
  const mode = req.body?.mode || 'idea';
  if (!text || typeof text !== 'string') {
    return res.json({ success: true, profile: analyze('', mode) });
  }
  const profile = analyze(text.trim(), mode);
  return res.json({ success: true, profile });
});

/**
 * POST /api/copilot/enhance
 * Proxies copilot suggest/enhance requests to enhancer service.
 */
router.post('/copilot/enhance', async (req, res) => {
  const stage = req.body?.stage;
  if (!COPILOT_STAGES.has(stage)) {
    return res.status(400).json({
      success: false,
      error: 'invalid_stage',
      details: 'stage must be copilot_suggest or copilot_enhance',
    });
  }

  const prompt = buildPrompt(stage);

  // Compute shadow model for context injection into copilot enhance calls
  const sourceText = req.body?.full_text || req.body?.raw_source || '';
  let shadowContext = null;
  if (stage === 'copilot_enhance' && sourceText) {
    const profile = analyze(sourceText, 'idea');
    shadowContext = {
      entities: (profile.shadow?.entities || []).slice(0, 20).map(e => e.name),
      relationships: (profile.shadow?.relationships || []).slice(0, 15).map(r => `${r.from} ${r.verb} ${r.to}`),
      gaps: profile.shadow?.gaps || [],
      maturity: profile.maturity,
      qualityScore: profile.qualityScore,
    };
  }

  // Try the Python enhancer first, then fall through to the provider chain
  const enhancerAvailable = await enhancerBridge.isAvailable();
  if (enhancerAvailable) {
    const payload = {
      ...req.body,
      stage,
      content_state: req.body?.content_state || 'text',
      mode: req.body?.mode || 'idea',
      raw_source: req.body?.raw_source || req.body?.full_text || '',
      system_prompt: prompt.system,
      temperature: prompt.temperature,
      ...(shadowContext ? { shadow_context: shadowContext } : {}),
    };

    try {
      const upstream = await callEnhancer(payload);
      const responseText = await upstream.text();
      let data = null;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = null;
      }

      if (upstream.ok && data) {
        // No-op detection for copilot_enhance
        if (stage === 'copilot_enhance') {
          const inputText = (req.body?.selected_text || req.body?.full_text || req.body?.raw_source || '').trim();
          const outputText = (data.enhanced_source || '').trim();
          if (!inputText || !outputText || inputText !== outputText) {
            // Sanitize Mermaid output if mode is mmd
            if (req.body?.mode === 'mmd' && data.enhanced_source) {
              data.enhanced_source = _sanitizeMmdOutput(data.enhanced_source, inputText);
            }
            return res.json({ success: true, ...data });
          }
          logger.warn('copilot.enhance.no_op_enhancer', { stage });
          // Fall through to provider chain below
        } else if (stage === 'copilot_suggest') {
          const suggestion = (data.suggestion || '').trim();
          const confidence = data.confidence || 'low';
          if (suggestion || confidence === 'low') {
            return res.json({ success: true, ...data });
          }
          logger.warn('copilot.suggest.empty_enhancer', { stage });
          // Fall through to provider chain below
        } else {
          return res.json({ success: true, ...data });
        }
      }
    } catch (err) {
      logger.warn('copilot.enhancer_failed', { stage, error: err.message });
    }
  }

  // ---- Provider chain fallback (see inference-provider.js for the order) ----
  // Build a user prompt that includes shadow context
  let userPrompt = sourceText;
  if (shadowContext) {
    const contextLines = [];
    if (shadowContext.entities.length > 0) contextLines.push(`[ENTITIES] ${shadowContext.entities.join(', ')}`);
    if (shadowContext.relationships.length > 0) contextLines.push(`[RELATIONSHIPS] ${shadowContext.relationships.join('; ')}`);
    if (shadowContext.gaps.length > 0) contextLines.push(`[GAPS] ${shadowContext.gaps.join('; ')}`);
    if (contextLines.length > 0) userPrompt = contextLines.join('\n') + '\n\n' + sourceText;
  }

  if (stage === 'copilot_suggest') {
    const activeLine = req.body?.active_line || '';
    const suggestUserPrompt = `Stage: copilot_suggest\n\nFull text: ${sourceText}\n\nActive line: ${activeLine}\n\nReturn valid JSON only.`;
    const _suggestStart = Date.now();
    const result = await provider.infer('copilot_suggest', {
      systemPrompt: prompt.system,
      userPrompt: suggestUserPrompt,
    });
    logger.info('copilot.suggest.timing', { ms: Date.now() - _suggestStart, provider: result.provider, hasOutput: !!result.output });

    if (result.output) {
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.suggestion) return res.json({ success: true, ...parsed, provider: result.provider });
      } catch {
        // Not valid JSON — treat as raw suggestion text
        if (result.output.length <= 120) {
          return res.json({ success: true, suggestion: result.output.trim(), confidence: 'medium', provider: result.provider });
        }
      }
    }
    return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No provider could generate a suggestion.' });
  }

  if (stage === 'copilot_enhance') {
    // Three-flavor router. The right system prompt depends on what the
    // user actually pasted into the prompt bar:
    //
    //   • SHORT SEED (< 240 chars, sparse)  → 'expand'  — bloom into spec
    //   • MEDIUM PROSE (240–4000 chars)     → 'refine'  — sharpen what's there
    //   • LARGE DUMP / STRUCTURED MARKUP    → 'distill' — compress losslessly
    //
    // Distill is what makes the Enhance button work on whitepapers, LaTeX,
    // long markdown, and multi-section spec dumps. Without it those inputs
    // would either get truncated (old client slice(0,2000)) or send the
    // model into refine mode, which produces a one-line restatement and
    // feels broken to the user.
    const requestedMode = req.body?.enhance_mode || 'full';
    const isSelection = requestedMode === 'selection';
    const trimmed = sourceText.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const sentenceCount = trimmed.split(/[.!?]\s+|\n+/).filter(s => s.trim().length > 3).length;
    const entityCount = shadowContext?.entities?.length || 0;

    // The mode field from the client tells us which tab the user is on.
    // Structured formats (mmd, md, tla, ts) must always return in that format.
    const targetFormat = req.body?.mode || 'idea';
    const isStructuredFormat = ['mmd', 'md', 'tla', 'ts'].includes(targetFormat);

    // Heavy-markup detection: LaTeX commands, markdown headers, fenced code
    // blocks, bibliographic entries. These are the "this is a dump, not an
    // idea" signals.
    const latexHits = (trimmed.match(/\\(?:documentclass|begin\{|end\{|section|subsection|usepackage|bibitem|cite\{|lstlisting|item\b)/g) || []).length;
    const mdHeaderHits = (trimmed.match(/^\s{0,3}#{1,6}\s+\S/gm) || []).length;
    const fencedCodeHits = (trimmed.match(/```/g) || []).length;
    const markupScore = latexHits + mdHeaderHits + Math.floor(fencedCodeHits / 2);
    const isHeavyMarkup = markupScore >= 6;

    const isSparse = !isSelection && !isStructuredFormat
      && trimmed.length < 240
      && wordCount < 40
      && sentenceCount <= 1
      && entityCount < 3;
    const isLargeDump = !isSelection && !isStructuredFormat && (trimmed.length >= 2000 || isHeavyMarkup);

    let flavor;
    if (isSelection)        flavor = 'selection';
    else if (isStructuredFormat) flavor = 'refine';  // structured formats always refine
    else if (isLargeDump)   flavor = 'distill';
    else if (isSparse)      flavor = 'expand';
    else                    flavor = 'refine';

    const flavorPrompt = require('../services/axiom-prompts').buildCopilotEnhancePrompt(flavor, targetFormat);

    // Previous-text context: lets the user iterate on enhancements
    // (click → distill → tweak → click again to refine that distillation).
    const previousText = (req.body?.previous_text || '').slice(0, 1500);
    const previousBlock = previousText && previousText.trim() && previousText.trim() !== trimmed
      ? `\nPrevious version (for iterative context): ${previousText}\n`
      : '';

    // For distill mode, give the model the entire pasted source up to the
    // model's practical context window. 80K chars ≈ 20K tokens, leaving
    // plenty of room for the system prompt + reasoning + output.
    const sourceLimit = flavor === 'distill' ? 80000 : 8000;
    const sourceForPrompt = sourceText.length > sourceLimit
      ? sourceText.slice(0, sourceLimit) + `\n\n[…TRUNCATED ${sourceText.length - sourceLimit} chars…]`
      : sourceText;

    const formatDirective = isStructuredFormat
      ? targetFormat === 'mmd'
        ? `Target format: MMD — The input below IS Mermaid source code. Your output MUST also be valid Mermaid source code. Start with the same diagram directive (e.g. flowchart TB, sequenceDiagram, etc.). Do NOT describe the diagram in prose. Do NOT explain what the diagram does. Output ONLY Mermaid syntax — no English sentences, no descriptions, no explanations outside %% comments.`
        : `Target format: ${targetFormat.toUpperCase()} — the enhanced_source MUST be valid ${targetFormat === 'md' ? 'markdown' : targetFormat === 'tla' ? 'TLA+' : 'TypeScript'}. Do NOT convert to plain text or a different format.`
      : '';

    const enhanceUserPrompt = [
      `Stage: copilot_enhance`,
      `Enhance flavor: ${flavor}`,
      formatDirective,
      `Word count: ${wordCount}, sentences: ${sentenceCount}, named entities: ${entityCount}, markup score: ${markupScore}, raw chars: ${trimmed.length}`,
      previousBlock,
      `Full text: ${sourceForPrompt}`,
      `Selected text: ${req.body?.selected_text || ''}`,
      ``,
      `Return valid JSON only.`,
    ].filter(Boolean).join('\n');

    const _enhanceStart = Date.now();
    const result = await provider.infer('copilot_enhance', {
      systemPrompt: flavorPrompt.system,
      userPrompt: enhanceUserPrompt,
    });
    logger.info('copilot.enhance.timing', {
      ms: Date.now() - _enhanceStart,
      provider: result.provider,
      flavor,
      wordCount,
      sentenceCount,
      entityCount,
      markupScore,
      rawChars: trimmed.length,
      truncated: sourceText.length > sourceLimit,
      hasOutput: !!result.output,
      noOp: result.noOp,
    });

    if (result.output && !result.noOp) {
      let enhancedSource = null;
      let parsedExtras = {};
      try {
        const parsed = JSON.parse(result.output);
        enhancedSource = parsed.enhanced_source || null;
        parsedExtras = parsed;
      } catch {
        // Not JSON — use raw text as enhanced source
        enhancedSource = result.output.trim();
      }

      if (enhancedSource) {
        // Post-processing safety net for Mermaid mode: if the model returned
        // prose instead of Mermaid syntax, try to salvage it or fall back to
        // the original input. Better to return the user's valid Mermaid
        // unchanged than to replace it with an English description.
        if (targetFormat === 'mmd') {
          enhancedSource = _sanitizeMmdOutput(enhancedSource, trimmed);
        }

        return res.json({
          success: true,
          ...parsedExtras,
          enhanced_source: enhancedSource,
          flavor,
          provider: result.provider,
        });
      }
    }
    return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No provider could enhance the text.', flavor });
  }

  return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No copilot provider available.' });
});

/**
 * POST /api/render
 * Body: { mermaid_source: string, diagram_name?: string, enhance?: boolean }
 *
 * Accepts plain text, markdown, mermaid source, or hybrid content.
 * The input-router detects the content type and selects the correct pipeline.
 */
router.post('/render', async (req, res) => {
  const { mermaid_source, diagram_name, enhance, max_mode, input_mode, visual, visual_style } = req.body || {};

  if (!mermaid_source || typeof mermaid_source !== 'string' || !mermaid_source.trim()) {
    return res.status(400).json({
      success: false,
      error: 'missing_source',
      details: 'mermaid_source is required and must be a non-empty string',
    });
  }

  const source = mermaid_source.trim();

  if (source.length > 100_000) {
    return res.status(400).json({
      success: false,
      error: 'input_too_large',
      details: 'Input exceeds 100,000 characters',
    });
  }

  let runId = null;
  try {
    const classifiedAt = new Date().toISOString();
    const startMs = Date.now();

    // 1. Analyze input holistically (maturity, quality, shadow model, intent)
    const profile = analyze(source, input_mode || 'idea');

    const maxRequested = !!(max_mode && provider.isMaxAvailable());
    let useMax = maxRequested;

    // Create run for JSON lineage tracking
    const parentRunId = req.body.parent_run_id || null;
    const gotConfig = require('../services/got-config').getConfig();
    runId = await runTracker.create({
      parentRunId,
      mode: req.body.agent_mode || (useMax ? 'max' : 'direct'),
      maxMode: useMax,
      enhance: !!enhance,
      userInput: source.slice(0, 5000),
      userDiagramName: diagram_name || null,
      inputMode: input_mode || 'idea',
      gotConfig,
      models: {
        orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || 'gpt-5.6-sol',
        worker: process.env.MERMATE_WORKER_MODEL || 'gpt-5.6-terra',
        fast: process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-5.6-luna',
      },
    });
    runTracker.setProfile(runId, profile);

    // Lifecycle: ingest is implicitly already underway when create() returned
    // (input received, run skeleton on disk). Record it explicitly so the
    // timeline starts at a known anchor, then move into analyze.
    runTracker.recordPhase(runId, 'ingest');
    runTracker.completePhase(runId, 'ingest', true);
    runTracker.recordPhase(runId, 'analyze');

    const _tAfterCreate = Date.now();
    _dbgPipeline('H-E', 'render.js:/render', 'phase_init', {
      runId: runId.slice(0, 8),
      ms: _tAfterCreate - startMs,
      contentState: profile.contentState,
      enhance: !!enhance,
    });

    logger.info('render.analyzed', {
      maturity: profile.maturity,
      quality: profile.qualityScore,
      completeness: profile.completenessScore,
      recommendation: profile.recommendation,
      contentState: profile.contentState,
      complexity: profile.complexity,
      shouldDecompose: profile.shouldDecompose,
      maxMode: useMax,
    });

    // 2. Pre-extract typed facts for ALL provider-backed renders.
    // This ensures every run JSON has facts for downstream TLA+/TS stages,
    // regardless of which pipeline (HPC-GoT, decompose, renderPrepare) runs.
    let routeResult;
    const isTextOrMd = profile.contentState === 'text' || profile.contentState === 'md';
    // Hybrid content (markdown prose with some Mermaid-like signals) should also
    // use the provider-backed pipeline when enhance is requested — the agent's
    // draft is often classified as hybrid because it contains arrows or node-like
    // syntax in prose. Without this, hybrid falls through to route() which only
    // uses the Python enhancer (often down) or bestEffortExtract (fails on prose).
    const shouldUseProvider = (isTextOrMd || profile.contentState === 'hybrid') && enhance;

    if (shouldUseProvider && profile.shadow?.entities?.length >= 2) {
      const { buildFactExtractionUserPrompt } = require('../services/axiom-prompts');
      const factUserPrompt = buildFactExtractionUserPrompt(source, profile);
      const _factStart = Date.now();
      const factResult = await provider.infer('fact_extraction', { userPrompt: factUserPrompt });
      const _factMs = Date.now() - _factStart;

      if (factResult.output && !factResult.noOp) {
        try {
          let parsed = factResult.output.trim();
          if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          const facts = JSON.parse(parsed);
          if (facts?.entities?.length > 0) {
            runTracker.recordAgentCall(runId, {
              stage: 'fact_extraction', model: factResult.model, provider: factResult.provider,
              promptText: factUserPrompt, outputText: factResult.output,
              latencyMs: factResult.latencyMs || _factMs, success: true, outputType: 'json',
            });
            logger.info('render.facts_extracted', {
              entities: facts.entities.length,
              relationships: (facts.relationships || []).length,
              failurePaths: (facts.failurePaths || []).length,
              ms: _factMs,
            });
          }
        } catch { /* parse failed — facts will be extracted by HPC-GoT if applicable */ }
      }
      _dbgPipeline('H-E', 'render.js:/render', 'phase_fact_extraction', {
        runId: runId.slice(0, 8),
        ms: Date.now() - _factStart,
        attempted: true,
      });
    }

    if (shouldUseProvider) {
      // ---- Provider-backed render: HPC-GoT bounded pipeline ----
      const wantsDecompose = profile.shouldDecompose;
      const strongEnoughForSingleShot = profile.qualityScore >= 0.6
        && (profile.shadow?.entities?.length || 0) <= 15
        && profile.completenessScore >= 0.5;
      const useDecompose = wantsDecompose && !strongEnoughForSingleShot;

      // Use the 3-stage HPC-GoT pipeline (fact→plan→compose) for all
      // non-trivial inputs. Only truly trivial inputs (≤2 entities) skip
      // to single-shot renderPrepare. This prevents prose-fragment nodes
      // by forcing typed fact extraction before Mermaid composition.
      const entityCount = profile.shadow?.entities?.length || 0;
      const useHPCGoT = !useDecompose && !maxRequested && entityCount >= 3;

      const pipelineName = useDecompose ? 'decompose'
        : maxRequested ? 'max_upgrade'
        : useHPCGoT ? 'hpc_got'
        : 'render_prepare';

      logger.info('render.routing', {
        pipeline: pipelineName,
        shouldDecompose: wantsDecompose,
        strongEnoughForSingleShot,
        useDecompose,
        useHPCGoT,
        entityCount,
        complexity: profile.complexity,
        quality: profile.qualityScore,
        completeness: profile.completenessScore,
      });

      // Wire audit emitter if caller passed an audit_run_id (from agent route)
      const auditRunId = req.body.audit_run_id;
      if (auditRunId) {
        const auditTracker = require('../services/audit-tracker');
        _setAuditEmitter((type, data) => auditTracker.emit(auditRunId, type, data));
      }

      // Wire run-tracker context + trace ID for Opseeq correlation
      _setRunId(runId);
      provider.setTraceId(runId);
      provider.setDepthTier(profile.architectureDepthTier || null);
      provider.clearReasoningMemory();
      runTracker.setPipeline(runId, pipelineName);
      runTracker.setDepth(runId, {
        score: profile.architectureDepthScore,
        tier: profile.architectureDepthTier,
        factors: profile.architectureDepthFactors,
      });

      // Lifecycle: analyze → plan → compose. The actual LLM work below is
      // the compose phase; we open it here so any Opseeq Studio observer
      // can see the run transition without parsing stages.
      runTracker.completePhase(runId, 'analyze', true);
      runTracker.recordPhase(runId, 'plan');
      runTracker.completePhase(runId, 'plan', true);
      runTracker.recordPhase(runId, 'compose');

      runTracker.recordUIStage(runId, { stage: pipelineName, message: `Pipeline: ${pipelineName}` });
      opseeq.reportStage(runId, {
        stage: 'render_start',
        pipeline: pipelineName,
        input_length: source.length,
        depth_score: profile.architectureDepthScore,
        depth_tier: profile.architectureDepthTier,
      });

      const { createProductionPorts } = require('../services/ports');
      const ports = createProductionPorts();

      const _prepStart = Date.now();
      let prepResult;
      try {
      if (useDecompose) {
        prepResult = await decomposeAndRender(source, profile, ports, maxRequested);
      } else if (maxRequested) {
        // Max mode: always run the full Max upgrade pipeline.
        // No gate — the user explicitly asked for Max. renderMaxUpgrade
        // runs normal HPC-GoT internally as baseline, then recomposes
        // via the strongest model with an architect-grade prompt.
        prepResult = await renderMaxUpgrade(source, profile);
      } else if (useHPCGoT) {
        prepResult = await renderHPCGoT(source, profile, ports, false);
      } else {
        // Simple idea: single-shot render is faster and more reliable
        prepResult = await renderPrepare(source, profile, ports, false);
      }

      } finally {
        _setRunId(null);
        provider.setTraceId(null);
        provider.setDepthTier(null);
        if (auditRunId) _setAuditEmitter(null);
      }
      runTracker.completeUIStage(runId, pipelineName);

      // Lifecycle: compose is done (mmd source produced); next is compile.
      runTracker.completePhase(runId, 'compose', !!prepResult?.mmdSource);
      runTracker.recordPhase(runId, 'compile');

      _dbgPipeline('H-B', 'render.js:/render', 'phase_prep_pipeline', {
        runId: runId.slice(0, 8),
        prepMs: Date.now() - _prepStart,
        wallMs: Date.now() - startMs,
        pipeline: pipelineName,
      });

      routeResult = {
        mmdSource: prepResult.mmdSource,
        diagramType: '',
        contentState: profile.contentState,
        enhanced: prepResult.enhanced,
        enhanceMeta: prepResult.enhanced ? {
          transformation: pipelineName,
          provider: prepResult.provider,
          hpcScore: prepResult.hpcScore || null,
        } : null,
        stagesExecuted: prepResult.stagesExecuted,
        totalEnhanceMs: Date.now() - startMs,
        validation: null,
        diagramSelection: profile.diagramSelection,
        subviews: prepResult.subviews || null,
      };
    } else {
      // ---- Existing route() for mmd, hybrid, and non-enhance paths ----
      // Trace envelope symmetry: the provider branch reports render_start
      // above; this branch must too, or local renders leave a trace with
      // render_complete and no start (tandem readback expects both).
      opseeq.reportStage(runId, {
        stage: 'render_start',
        pipeline: 'local_route',
        input_length: source.length,
        content_state: profile.contentState,
        enhance: !!enhance,
      });
      try {
        routeResult = await route(source, { enhance: !!enhance });
      } catch (err) {
        if (err instanceof RouterError) {
          return res.status(422).json({
            success: false,
            error: err.code,
            details: err.message,
          });
        }
        throw err;
      }
    }

    const {
      mmdSource,
      contentState,
      enhanced: wasEnhanced,
      enhanceMeta,
      stagesExecuted,
      totalEnhanceMs,
      validation: preCompileValidation,
      diagramSelection,
    } = routeResult;

    // Re-classify after potential transformation
    const diagramType = routeResult.diagramType || require('../services/mermaid-classifier').classify(mmdSource);

    logger.info('input.routed', {
      content_state: contentState,
      diagram_type: diagramType,
      enhanced: wasEnhanced,
      stages: stagesExecuted,
      enhance_ms: totalEnhanceMs,
    });

    // 3. Derive name
    const diagramName = deriveDiagramName(mmdSource, diagram_name);

    // 4+5. Archive and compile in parallel — they write to different directories.
    // Role split: Render compiles; Enhance transforms. A user-pasted .mmd with
    // Enhance OFF gets deterministic repair only — no silent LLM rewrite.
    const allowModelRepair = !(contentState === 'mmd' && !enhance);
    const outputDir = path.join(FLOWS_DIR, diagramName);
    const _acStart = Date.now();
    const [archivePaths, compileOutcome] = await Promise.all([
      archive(source, diagramName, diagramType),
      compileWithRetry(mmdSource, outputDir, diagramName, null, { allowModelRepair }),
    ]);
    _dbgPipeline('H-C', 'render.js:/render', 'phase_archive_compile', {
      runId: runId ? runId.slice(0, 8) : null,
      acMs: Date.now() - _acStart,
      wallMs: Date.now() - startMs,
    });

    if (!compileOutcome.result.ok) {
      if (runId) {
        opseeq.reportStage(runId, {
          stage: 'render_failed',
          reason: 'compilation_failed',
          error: _sanitizeError(compileOutcome.result.error),
        });
        await runTracker.finalize(runId, 'failed').catch(() => {});
      }
      return res.status(422).json({
        success: false,
        error: 'compilation_failed',
        details: _sanitizeError(compileOutcome.result.error),
        diagram_type: diagramType,
        content_state: contentState,
        attempts: compileOutcome.attempts,
        repair_changes: compileOutcome.repairChanges,
        enhance_meta: wasEnhanced ? {
          transformation: enhanceMeta?.transformation,
          content_state: contentState,
          stages_executed: stagesExecuted,
          total_enhance_ms: totalEnhanceMs,
        } : null,
      });
    }

    // 6. Post-render: archive compiled + organize subviews + copy .md (all in parallel)
    const compiledAt = new Date().toISOString();
    const finalMmd = compileOutcome.mmdSource;
    const finalDiagramType = finalMmd === mmdSource
      ? diagramType
      : require('../services/mermaid-classifier').classify(finalMmd);

    const _organizeSubviews = async () => {
      const paths = [];
      if (!routeResult.subviews || routeResult.subviews.length === 0) return paths;
      const subviewsDir = path.join(outputDir, 'subviews');
      await fsp.mkdir(subviewsDir, { recursive: true }).catch(() => {});

      await Promise.all(routeResult.subviews.map(async (sv, i) => {
        const svSlug = (sv.viewName || `subview-${i}`).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 40);
        const svDir = path.join(subviewsDir, svSlug);
        await fsp.mkdir(svDir, { recursive: true }).catch(() => {});

        const mmdPath = path.join(svDir, `${svSlug}.mmd`);
        await fsp.writeFile(mmdPath, sv.mmdSource, 'utf8').catch(() => {});

        if (sv.outputDir) {
          await Promise.all(['png', 'svg', 'mmd'].map(ext => {
            const srcFile = path.join(sv.outputDir, `subview.${ext}`);
            const destFile = path.join(svDir, `${svSlug}.${ext === 'mmd' ? 'compiled.mmd' : ext}`);
            return fsp.copyFile(srcFile, destFile).catch(() => {});
          }));
          await fsp.rm(sv.outputDir, { recursive: true, force: true }).catch(() => {});
        }

        paths.push({
          name: sv.viewName || svSlug,
          mmd: `/flows/${diagramName}/subviews/${svSlug}/${svSlug}.mmd`,
          png: `/flows/${diagramName}/subviews/${svSlug}/${svSlug}.png`,
          svg: `/flows/${diagramName}/subviews/${svSlug}/${svSlug}.svg`,
        });
      }));

      if (paths.length > 0) {
        logger.info('render.subviews_organized', { diagramName, subviewCount: paths.length });
      }
      return paths;
    };

    const _copyMd = async () => {
      if (!archivePaths.mdPath) return;
      const mdSourcePath = path.join(PROJECT_ROOT, archivePaths.mdPath);
      const mdDestPath = path.join(outputDir, `${diagramName}.md`);
      await fsp.copyFile(mdSourcePath, mdDestPath).catch(() => {});
    };

    const _cmStart = Date.now();
    const canonicalMarkdown = compileMarkdownArtifact({
      diagramName,
      inputMode: input_mode || profile.contentState || 'idea',
      diagramType: finalDiagramType || diagramType,
      originalSource: source,
      facts: routeResult.facts || null,
      plan: routeResult.plan || null,
      mmdSource: finalMmd,
    });
    _dbgPipeline('H-D', 'render.js:/render', 'phase_compile_markdown_sync', {
      runId: runId ? runId.slice(0, 8) : null,
      cmMs: Date.now() - _cmStart,
      mdChars: canonicalMarkdown.markdownSource?.length || 0,
    });
    const canonicalMarkdownPath = path.join(outputDir, 'architecture.md');
    const _writeCanonicalMarkdown = async () => {
      await fsp.writeFile(canonicalMarkdownPath, canonicalMarkdown.markdownSource, 'utf8');
    };

    const _postStart = Date.now();
    const [compiledArchivePath, subviewPaths] = await Promise.all([
      archiveCompiled(finalMmd, diagramName, {
        provider: enhanceMeta?.provider || null,
        attempts: compileOutcome.attempts,
        maxMode: useMax,
      }),
      _organizeSubviews(),
      _copyMd(),
      _writeCanonicalMarkdown(),
    ]);
    _dbgPipeline('H-F', 'render.js:/render', 'phase_post_compile_parallel', {
      runId: runId ? runId.slice(0, 8) : null,
      postMs: Date.now() - _postStart,
      wallMs: Date.now() - startMs,
      subviewCount: routeResult.subviews?.length || 0,
    });

    const postRenderValidation = validateMmd(finalMmd);
    const mmdMetrics = {
      nodeCount: postRenderValidation.stats?.nodeCount || 0,
      edgeCount: postRenderValidation.stats?.edgeCount || 0,
      subgraphCount: postRenderValidation.stats?.subgraphCount || 0,
      charCount: finalMmd.length,
      structurallyValid: postRenderValidation.valid,
    };

    // 7. Optional: presentation-oriented image via the Gemini visual provider
    let visualResult = null;
    if (visual && visualProvider.isAvailable()) {
      try {
        const entities = (profile.shadow?.entities || []).map(e => e.name);
        const relationships = (profile.shadow?.relationships || []).map(r => `${r.from} ${r.verb} ${r.to}`);

        visualResult = await visualProvider.render({
          description: source,
          diagramName,
          outputDir: outputDir,
          diagramType: finalDiagramType || diagramType,
          title: diagram_name || diagramName,
          style: visual_style || undefined,
          entities,
          relationships,
        });
      } catch (err) {
        logger.warn('render.visual.error', { error: err.message });
        visualResult = { success: false, error: err.message };
      }
    }

    // 8. Finalize run JSON and respond
    if (runId) {
      const manifest = runTracker.getManifest(runId);
      if (manifest) {
        manifest.markdown_artifacts = {
          canonical: `/flows/${diagramName}/architecture.md`,
          manifest: canonicalMarkdown.manifest,
        };
      }

      runTracker.setFinalArtifact(runId, {
        diagramName,
        diagramType: finalDiagramType || diagramType,
        mmdSource: finalMmd,
        metrics: {
          ...mmdMetrics,
          stage: 'render',
          diagram_name: diagramName,
          artifact_type: 'architecture_diagram',
          node_count: mmdMetrics?.nodeCount,
          edge_count: mmdMetrics?.edgeCount,
          structurally_valid: postRenderValidation.valid,
        },
        validation: {
          structurallyValid: postRenderValidation.valid,
          svgValid: compileOutcome.result.svg?.valid || false,
          pngValid: compileOutcome.result.png?.valid || false,
        },
        artifacts: {
          mmd: archivePaths.mmdPath,
          compiled_mmd: compiledArchivePath,
          md: archivePaths.mdPath,
          architecture_md: `/flows/${diagramName}/architecture.md`,
          png: `/flows/${diagramName}/${diagramName}.png`,
          svg: `/flows/${diagramName}/${diagramName}.svg`,
        },
        compileAttempts: compileOutcome.attempts,
        provider: enhanceMeta?.provider || 'local',
      });
      opseeq.reportStage(runId, {
        stage: 'render_complete',
        diagram_name: diagramName,
        nodes: mmdMetrics?.nodeCount,
        edges: mmdMetrics?.edgeCount,
        valid: postRenderValidation.valid,
        provider: enhanceMeta?.provider || 'local',
        elapsed_ms: compiledAt ? Date.now() - new Date(classifiedAt).getTime() : undefined,
      });

      // Close the compile phase before finalize() opens its own.
      runTracker.completePhase(runId, 'compile', postRenderValidation.valid);

      await runTracker.finalize(runId, 'completed');
    }

    _dbgPipeline('H-B', 'render.js:/render', 'phase_render_total', {
      runId: runId ? runId.slice(0, 8) : null,
      totalMs: Date.now() - startMs,
      enhanced: wasEnhanced,
      diagramName,
    });

    return res.json({
      success: true,
      diagram_name: diagramName,
      diagram_type: finalDiagramType || diagramType,
      classified_at: classifiedAt,
      compiled_at: compiledAt,
      enhanced: wasEnhanced,
      enhance_meta: wasEnhanced ? {
        transformation: enhanceMeta?.transformation,
        content_state: contentState,
        maturity: enhanceMeta?.maturity || profile.maturity,
        stages_executed: stagesExecuted,
        total_enhance_ms: totalEnhanceMs,
        warnings: enhanceMeta?.warnings || [],
        provider: enhanceMeta?.provider || null,
      } : null,
      content_state: contentState,
      enhance_note: (enhance && contentState === 'mmd' && !wasEnhanced)
        ? 'Render compiles Mermaid source as-is. To optimize it with AI, use the Enhance button before rendering.'
        : undefined,
      paths: {
        png: `/flows/${diagramName}/${diagramName}.png`,
        svg: `/flows/${diagramName}/${diagramName}.svg`,
        visual: visualResult?.success ? `/flows/${diagramName}/${diagramName}-visual.png` : null,
        mmd: archivePaths.mmdPath,
        md: archivePaths.mdPath,
        md_local: archivePaths.mdPath ? `/flows/${diagramName}/${diagramName}.md` : null,
        architecture_md: `/flows/${diagramName}/architecture.md`,
        compiled_mmd: compiledArchivePath,
        subviews: subviewPaths.length > 0 ? subviewPaths : undefined,
      },
      compiled_source: finalMmd,
      markdown_source: canonicalMarkdown.markdownSource,
      visual: visualResult ? {
        success: visualResult.success,
        style: visualResult.style || null,
        error: visualResult.error || null,
      } : null,
      validation: {
        svg_valid: compileOutcome.result.svg.valid,
        png_valid: compileOutcome.result.png.valid,
        svg_bytes: compileOutcome.result.svg.bytes,
        png_bytes: compileOutcome.result.png.bytes,
      },
      render_meta: {
        attempts: compileOutcome.attempts,
        repair_changes: compileOutcome.repairChanges,
        max_mode: useMax,
        depth_score: profile.architectureDepthScore ?? null,
        depth_tier: profile.architectureDepthTier ?? null,
      },
      depth_score: profile.architectureDepthScore ?? null,
      depth_tier: profile.architectureDepthTier ?? null,
      mmd_metrics: mmdMetrics,
      axiom_analysis: {
        pre_compile: {
          valid: preCompileValidation?.valid ?? true,
          errors: (preCompileValidation?.errors || []).length,
          warnings: (preCompileValidation?.warnings || []).length,
          stats: preCompileValidation?.stats || {},
        },
        diagram_selection: diagramSelection || profile.diagramSelection || null,
      },
      run_id: runId || undefined,
      run_json_path: runId ? `/runs/${runId}.json` : undefined,
      fallback_events: provider.getFallbackEvents().length > 0
        ? provider.getFallbackEvents() : undefined,
      progressionUpdate: runId ? {
        stage: 'mmd',
        unlockedStages: ['idea', 'md', 'mmd', 'tsx', 'tla'],
        nextRecommended: 'tsx',
        confidence: postRenderValidation.valid ? 0.95 : 0.5,
      } : undefined,
    });
  } catch (err) {
    if (runId) {
      opseeq.reportStage(runId, { stage: 'render_failed', error: err.message });
      await runTracker.finalize(runId, 'failed').catch(() => {});
    }
    logger.error('render.error', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      details: err.message,
    });
  }
});

/**
 * GET /api/diagrams
 * Returns list of previously rendered diagrams from flows/.
 */
router.get('/diagrams', async (_req, res) => {
  try {
    await fsp.mkdir(FLOWS_DIR, { recursive: true });
    const entries = await fsp.readdir(FLOWS_DIR, { withFileTypes: true });
    const diagrams = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('_tmp_')) continue;
      const dirPath = path.join(FLOWS_DIR, name);
      const files = await fsp.readdir(dirPath);
      const hasPng = files.some(f => f.endsWith('.png'));
      const hasSvg = files.some(f => f.endsWith('.svg'));
      if (hasPng || hasSvg) {
        const stat = await fsp.stat(dirPath);
        let diagramType = '';
        try {
          const mmdPath = path.join(PROJECT_ROOT, 'archs', `${name}.mmd`);
          const mmdHead = await fsp.readFile(mmdPath, 'utf8').then(s => s.slice(0, 200));
          const firstLine = mmdHead.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
          if (firstLine) {
            const directive = firstLine.trim().split(/[\s{(]/)[0].toLowerCase();
            if (['flowchart', 'graph', 'sequencediagram', 'classDiagram', 'statediagram', 'erdiagram', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline', 'c4context'].some(d => directive.startsWith(d.toLowerCase()))) {
              diagramType = directive === 'graph' ? 'flowchart' : directive;
            }
          }
        } catch { /* no .mmd file — skip type detection */ }
        let runId = null;
        try {
          const runFiles = await fsp.readdir(RUNS_DIR).catch(() => []);
          for (let i = runFiles.length - 1; i >= 0 && !runId; i--) {
            if (!runFiles[i].endsWith('.json')) continue;
            const raw = await fsp.readFile(path.join(RUNS_DIR, runFiles[i]), 'utf8');
            const rd = JSON.parse(raw);
            const rdName = rd.final_artifact?.diagram_name || rd.user_request?.diagram_name;
            if (rdName === name) runId = rd.run_id;
          }
        } catch { /* run lookup is best-effort */ }

        diagrams.push({
          name,
          has_png: hasPng,
          has_svg: hasSvg,
          diagram_type: diagramType,
          paths: {
            png: hasPng ? `/flows/${name}/${name}.png` : null,
            svg: hasSvg ? `/flows/${name}/${name}.svg` : null,
          },
          created_at: stat.birthtime.toISOString(),
          run_id: runId,
        });
      }
    }

    diagrams.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return res.json({ success: true, diagrams });
  } catch (err) {
    logger.error('diagrams.list.error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/diagrams/:name
 * Remove a diagram's compiled outputs and archived source.
 */
router.delete('/diagrams/:name', async (req, res) => {
  const name = require('../utils/naming').safeSegment(req.params.name);
  if (!name) {
    return res.status(400).json({ success: false, error: 'invalid_name' });
  }

  try {
    const flowDir = path.join(FLOWS_DIR, name);
    await fsp.rm(flowDir, { recursive: true, force: true }).catch(() => {});

    const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');
    await fsp.rm(path.join(ARCHS_DIR, `${name}.mmd`), { force: true }).catch(() => {});
    await fsp.rm(path.join(ARCHS_DIR, `${name}.compiled.mmd`), { force: true }).catch(() => {});

    const mdFiles = await fsp.readdir(ARCHS_DIR).catch(() => []);
    for (const f of mdFiles) {
      if (f.endsWith(`-${name}.md`)) {
        await fsp.rm(path.join(ARCHS_DIR, f), { force: true }).catch(() => {});
      }
    }

    logger.info('diagram.deleted', { name });
    return res.json({ success: true });
  } catch (err) {
    logger.error('diagram.delete.error', { name, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/diagrams/:name
 * Rename a diagram's folder, compiled outputs, and archived sources.
 */
router.patch('/diagrams/:name', async (req, res) => {
  const oldName = req.params.name;
  const newNameRaw = req.body?.new_name;
  if (!oldName || /[\/\\]/.test(oldName)) {
    return res.status(400).json({ success: false, error: 'invalid_name' });
  }
  if (!newNameRaw || typeof newNameRaw !== 'string' || !newNameRaw.trim()) {
    return res.status(400).json({ success: false, error: 'new_name is required' });
  }

  const { slugify } = require('../utils/naming');
  const newName = slugify(newNameRaw.trim());
  if (!newName || newName.length < 2) {
    return res.status(400).json({ success: false, error: 'new_name too short' });
  }
  if (newName === oldName) {
    return res.json({ success: true, new_name: oldName, paths: { png: `/flows/${oldName}/${oldName}.png`, svg: `/flows/${oldName}/${oldName}.svg` } });
  }

  try {
    const oldFlowDir = path.join(FLOWS_DIR, oldName);
    const newFlowDir = path.join(FLOWS_DIR, newName);

    const oldExists = await fsp.stat(oldFlowDir).then(() => true).catch(() => false);
    if (oldExists) {
      await fsp.rename(oldFlowDir, newFlowDir);
      const files = await fsp.readdir(newFlowDir);
      for (const f of files) {
        if (f.startsWith(oldName)) {
          const suffix = f.slice(oldName.length);
          await fsp.rename(path.join(newFlowDir, f), path.join(newFlowDir, newName + suffix));
        }
      }
    }

    const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');
    await fsp.rename(path.join(ARCHS_DIR, `${oldName}.mmd`), path.join(ARCHS_DIR, `${newName}.mmd`)).catch(() => {});
    await fsp.rename(path.join(ARCHS_DIR, `${oldName}.compiled.mmd`), path.join(ARCHS_DIR, `${newName}.compiled.mmd`)).catch(() => {});

    const archFiles = await fsp.readdir(ARCHS_DIR).catch(() => []);
    for (const f of archFiles) {
      if (f.endsWith(`-${oldName}.md`)) {
        const newF = f.replace(`-${oldName}.md`, `-${newName}.md`);
        await fsp.rename(path.join(ARCHS_DIR, f), path.join(ARCHS_DIR, newF)).catch(() => {});
      }
    }

    logger.info('diagram.renamed', { oldName, newName });
    return res.json({
      success: true,
      new_name: newName,
      paths: {
        png: `/flows/${newName}/${newName}.png`,
        svg: `/flows/${newName}/${newName}.svg`,
      },
    });
  } catch (err) {
    logger.error('diagram.rename.error', { oldName, newName, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Strip environment noise (security-monitor banners, ANSI codes, stack traces)
 * from compiler error messages before returning them to the user.
 */
function _sanitizeError(raw) {
  if (!raw || typeof raw !== 'string') return 'Compilation failed';
  let cleaned = raw
    .replace(/\u001b\[[0-9;]*m/g, '')                        // ANSI escape codes
    .replace(/\[npm-security-monitor\][^\n]*/g, '')           // security-monitor lines
    .replace(/═{3,}[^═]*═{3,}/gs, '')                        // banner blocks
    .replace(/⚠️[^\n]*/g, '')                                // alert headers
    .replace(/Explanation:[\s\S]*?Action Taken:[\s\S]*?\n/g, '') // full alert bodies
    .replace(/•[^\n]*/g, '')                                  // bullet explanations
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')                    // stack trace frames
    .replace(/\n{3,}/g, '\n\n')                               // collapse blank runs
    .trim();
  // Extract the meaningful Mermaid error with its context lines (offending
  // text, caret, "Expecting …") — the first line alone is useless to the user.
  const mermaidErr = cleaned.match(/((?:UnknownDiagramError|Error|Parse error)[^\n]*(?:\n(?!\s*at\s)[^\n]+){0,3})/);
  if (mermaidErr) return mermaidErr[1].trim().slice(0, 500);
  return cleaned.slice(0, 300) || 'Compilation failed';
}

module.exports = router;
