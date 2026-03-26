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
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';
const ENHANCER_TIMEOUT_MS = parseInt(process.env.MERMAID_ENHANCER_TIMEOUT || '15000', 10);

const router = Router();
const COPILOT_STAGES = new Set(['copilot_suggest', 'copilot_enhance']);

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
 * can serve copilot requests (Ollama, premium API, or Python enhancer).
 */
router.get('/copilot/health', async (_req, res) => {
  try {
    const providers = await provider.checkProviders();
    const available = providers.ollama || providers.premium || providers.enhancer;
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

  // ---- Provider chain fallback (Ollama / premium API) ----
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
    const enhanceUserPrompt = `Stage: copilot_enhance\nEnhance mode: ${req.body?.enhance_mode || 'full'}\n\nFull text: ${sourceText}\n\nSelected text: ${req.body?.selected_text || ''}\n\nReturn valid JSON only.`;
    const _enhanceStart = Date.now();
    const result = await provider.infer('copilot_enhance', {
      systemPrompt: prompt.system,
      userPrompt: enhanceUserPrompt,
    });
    logger.info('copilot.enhance.timing', { ms: Date.now() - _enhanceStart, provider: result.provider, hasOutput: !!result.output, noOp: result.noOp });

    if (result.output && !result.noOp) {
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.enhanced_source) return res.json({ success: true, ...parsed, provider: result.provider });
      } catch {
        // Not JSON — use raw text as enhanced source
        return res.json({
          success: true,
          enhanced_source: result.output.trim(),
          intent_preserved: true,
          provider: result.provider,
        });
      }
    }
    return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No provider could enhance the text.' });
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
        orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || 'gpt-4o',
        worker: process.env.MERMATE_WORKER_MODEL || 'gpt-4o',
        fast: process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-4o-mini',
      },
    });
    runTracker.setProfile(runId, profile);

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
    const shouldUseProvider = isTextOrMd && enhance;

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

      // Wire run-tracker context
      _setRunId(runId);
      runTracker.setPipeline(runId, pipelineName);
      runTracker.recordUIStage(runId, { stage: pipelineName, message: `Pipeline: ${pipelineName}` });

      let prepResult;
      try {
      if (useDecompose) {
        prepResult = await decomposeAndRender(source, profile, maxRequested);
      } else if (maxRequested) {
        // Max mode: always run the full Max upgrade pipeline.
        // No gate — the user explicitly asked for Max. renderMaxUpgrade
        // runs normal HPC-GoT internally as baseline, then recomposes
        // via the strongest model with an architect-grade prompt.
        prepResult = await renderMaxUpgrade(source, profile);
      } else if (useHPCGoT) {
        prepResult = await renderHPCGoT(source, profile, false);
      } else {
        // Simple idea: single-shot render is faster and more reliable
        prepResult = await renderPrepare(source, profile, false);
      }

      } finally {
        _setRunId(null);
        if (auditRunId) _setAuditEmitter(null);
      }
      runTracker.completeUIStage(runId, pipelineName);

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

    // 4+5. Archive and compile in parallel — they write to different directories
    const outputDir = path.join(FLOWS_DIR, diagramName);
    const [archivePaths, compileOutcome] = await Promise.all([
      archive(source, diagramName, diagramType),
      compileWithRetry(mmdSource, outputDir, diagramName),
    ]);

    if (!compileOutcome.result.ok) {
      if (runId) await runTracker.finalize(runId, 'failed').catch(() => {});
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
    const finalDiagramType = require('../services/mermaid-classifier').classify(finalMmd);

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

    const canonicalMarkdown = compileMarkdownArtifact({
      diagramName,
      inputMode: input_mode || profile.contentState || 'idea',
      diagramType: finalDiagramType || diagramType,
      originalSource: source,
      facts: routeResult.facts || null,
      plan: routeResult.plan || null,
      mmdSource: finalMmd,
    });
    const canonicalMarkdownPath = path.join(outputDir, 'architecture.md');
    const _writeCanonicalMarkdown = async () => {
      await fsp.writeFile(canonicalMarkdownPath, canonicalMarkdown.markdownSource, 'utf8');
    };

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

    const postRenderValidation = validateMmd(finalMmd);
    const mmdMetrics = {
      nodeCount: postRenderValidation.stats?.nodeCount || 0,
      edgeCount: postRenderValidation.stats?.edgeCount || 0,
      subgraphCount: postRenderValidation.stats?.subgraphCount || 0,
      charCount: finalMmd.length,
      structurallyValid: postRenderValidation.valid,
    };

    // 7. Optional: generate polished visual via Gemini (nanobanana layer)
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
        metrics: mmdMetrics,
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
      await runTracker.finalize(runId, 'completed');
    }

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
      },
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
      progressionUpdate: runId ? {
        stage: 'mmd',
        unlockedStages: ['idea', 'md', 'mmd', 'tsx', 'tla'],
        nextRecommended: 'tsx',
        confidence: postRenderValidation.valid ? 0.95 : 0.5,
      } : undefined,
    });
  } catch (err) {
    if (runId) await runTracker.finalize(runId, 'failed').catch(() => {});
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
  const name = req.params.name;
  if (!name || /[\/\\]/.test(name)) {
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
  // Extract the meaningful Mermaid error line
  const mermaidErr = cleaned.match(/((?:UnknownDiagramError|Error|Parse error)[^\n]+)/);
  if (mermaidErr) return mermaidErr[1].trim();
  return cleaned.slice(0, 300) || 'Compilation failed';
}

module.exports = router;
