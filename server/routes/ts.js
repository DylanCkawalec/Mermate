'use strict';

/**
 * TypeScriptRuntime Route — POST /api/render/ts
 *
 * Continuation after /tla:
 *   validated architecture + validated TLA+ -> monolithic TypeScript runtime
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');

const tsCompiler = require('../services/ts-compiler');
const tsValidator = require('../services/ts-validator');
const speculaLlm = require('../services/specula-llm');
const provider = require('../services/inference-provider');
const opseeq = require('../services/opseeq-bridge');
const logger = require('../utils/logger');
const {
  buildTsRepairPrompt,
  buildTsRepairUserPrompt,
} = require('../services/axiom-prompts-ts');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const {
  resolveArtifactPath: _resolveArtifactPath,
  persistRunData,
  extractFactsAndPlan: _extractFactsAndPlan,
  loadRunData: _loadRunData,
} = require('../services/run-artifact-loader');

const router = Router();

function _safeJsonParse(text) {
  if (!text || typeof text !== 'string') return null;

  try {
    return JSON.parse(text);
  } catch {
    // Try to recover from fenced output.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

router.get('/render/ts/status', async (_req, res) => {
  const available = await tsValidator.isAvailable();
  res.json({
    success: true,
    available,
    tscTimeoutMs: tsValidator.TSC_TIMEOUT_MS,
    testTimeoutMs: tsValidator.TEST_TIMEOUT_MS,
  });
});

router.post('/render/ts', async (req, res) => {
  const { run_id, diagram_name } = req.body || {};

  if (!run_id) {
    return res.status(400).json({ success: false, error: 'run_id is required' });
  }

  const available = await tsValidator.isAvailable();
  if (!available) {
    return res.status(503).json({
      success: false,
      error: 'TypeScript toolchain not available',
      details: {
        hint: 'Install dev dependencies: npm install -D typescript tsx',
      },
    });
  }

  let runPath;
  let runData;

  try {
    const loaded = await _loadRunData(run_id);
    runPath = loaded.runPath;
    runData = loaded.runData;
  } catch {
    return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
  }

  let { facts, plan } = _extractFactsAndPlan(runData);

  // On-demand fact extraction when HPC-GoT path wasn't used (e.g. decompose pipeline)
  if (!facts || !facts.entities || facts.entities.length === 0) {
    const originalInput = runData.request?.user_input || '';
    if (!originalInput) {
      return res.status(422).json({
        success: false,
        error: 'Run does not contain typed facts or original input for extraction.',
      });
    }

    logger.info('ts.extracting_facts', { run_id: run_id.slice(0, 8), reason: 'not found in agent_calls' });
    const { buildPrompt } = require('../services/axiom-prompts');
    const { buildFactExtractionUserPrompt } = require('../services/axiom-prompts');
    const { analyze } = require('../services/input-analyzer');

    const profile = analyze(originalInput, 'idea');
    const factPrompt = buildPrompt('fact_extraction');
    const factUserPrompt = buildFactExtractionUserPrompt(originalInput, profile);
    const factResult = await provider.infer('fact_extraction', {
      systemPrompt: factPrompt.system,
      userPrompt: factUserPrompt,
    });

    if (factResult.output && !factResult.noOp) {
      try {
        let parsed = factResult.output.trim();
        if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        facts = JSON.parse(parsed);
      } catch { /* parse failed */ }
    }

    if (!facts || !facts.entities || facts.entities.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Could not extract typed facts from the original input.',
      });
    }
  }

  if (!runData.tla_artifacts?.tla || !runData.tla_artifacts?.cfg) {
    return res.status(422).json({
      success: false,
      error: 'TLA+ artifacts not found for this run. Execute /api/render/tla first.',
    });
  }

  const tlaPath = _resolveArtifactPath(runData.tla_artifacts.tla);
  const cfgPath = _resolveArtifactPath(runData.tla_artifacts.cfg);
  if (!tlaPath || !cfgPath) {
    return res.status(422).json({
      success: false,
      error: 'Invalid or unsafe TLA+ artifact path in run data',
    });
  }

  let tlaSource = '';
  let cfgSource = '';
  try {
    tlaSource = await fsp.readFile(tlaPath, 'utf8');
    cfgSource = await fsp.readFile(cfgPath, 'utf8');
  } catch (err) {
    return res.status(422).json({
      success: false,
      error: 'Failed to load TLA+ artifacts from disk',
      details: err.message,
    });
  }

  const name = diagram_name || runData.user_request?.diagram_name || runData.request?.user_diagram_name || 'runtime';
  const flowDir = path.join(FLOWS_DIR, name, 'ts-runtime');
  await fsp.mkdir(flowDir, { recursive: true });

  provider.setTraceId(run_id);
  try {
    const moduleName = path.basename(tlaPath, path.extname(tlaPath)) || 'Spec';
    const compilationContext = {
      runId: run_id,
      diagramName: name,
      moduleName,
      facts,
      plan,
      structuralSignature: runData.structural_signature || null,
      tla: {
        source: tlaSource,
        cfg: cfgSource,
        metrics: runData.tla_metrics || null,
      },
    };

    logger.info('ts.compile_start', {
      runId: run_id.slice(0, 8),
      diagramName: name,
      entities: (facts.entities || []).length,
      relationships: (facts.relationships || []).length,
      failurePaths: (facts.failurePaths || []).length,
    });

    let compiled = tsCompiler.compileCompilationContext(compilationContext);

    // Claude review: check TS against TLA+ spec for semantic correctness
    if (speculaLlm.isAvailable() && tlaSource) {
      logger.info('ts.claude_review_start', { className: compiled.className });
      const reviewResult = await speculaLlm.inferTlaStage('review_ts', {
        systemPrompt: 'You are a TypeScript/TLA+ alignment reviewer. Given a TLA+ spec and a TypeScript runtime class, check that every TLA+ action is implemented as a method, every invariant is checked, and all state transitions match. If corrections are needed, output the COMPLETE corrected TypeScript source. If the code is correct, output "LGTM" and nothing else.',
        userPrompt: `TLA+ SPEC:\n${tlaSource.slice(0, 8000)}\n\nTYPESCRIPT SOURCE:\n${compiled.tsSource.slice(0, 12000)}\n\nReview and correct if needed.`,
        maxTokens: 16384,
      });
      if (reviewResult.output && !reviewResult.output.trim().startsWith('LGTM')) {
        let reviewed = reviewResult.output.trim();
        if (reviewed.startsWith('```')) reviewed = reviewed.replace(/^```(?:typescript|ts)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        if (reviewed.length > compiled.tsSource.length * 0.5) {
          compiled = { ...compiled, tsSource: reviewed };
          logger.info('ts.claude_review_applied', { className: compiled.className, len: reviewed.length, ms: reviewResult.latencyMs });
        }
      } else {
        logger.info('ts.claude_review_lgtm', { ms: reviewResult.latencyMs });
      }
    }

    const repairFn = async (input) => {
      const { system } = buildTsRepairPrompt();
      const userPrompt = buildTsRepairUserPrompt({
        ...input,
        tsSource: input.tsSource,
        harnessSource: input.harnessSource,
      });
      const _repairStart = Date.now();
      const result = await provider.infer('repair_ts', {
        systemPrompt: system,
        userPrompt,
      });
      logger.info('ts.repair.timing', { ms: Date.now() - _repairStart, provider: result.provider, hasOutput: !!result.output, noOp: result.noOp, kind: input.kind, attempt: input.attempt });

      if (!result.output || result.noOp) return null;

      const parsed = _safeJsonParse(result.output.trim());
      if (!parsed || !parsed.ts_source) return null;
      return {
        tsSource: parsed.ts_source,
        harnessSource: parsed.harness_source || input.harnessSource,
      };
    };

    const validation = await tsValidator.fullValidation(
      compiled.tsSource,
      compiled.harnessSource,
      flowDir,
      compiled.fileBase,
      compiled.coverageSpec,
      repairFn,
    );

    const sourcePath = path.join(flowDir, `${compiled.fileBase}.ts`);
    const harnessPath = path.join(flowDir, `${compiled.fileBase}.harness.ts`);
    const reportPath = path.join(flowDir, `${compiled.fileBase}.validation.json`);

    await fsp.writeFile(sourcePath, validation.tsSource, 'utf8');
    await fsp.writeFile(harnessPath, validation.harnessSource, 'utf8');
    await fsp.writeFile(reportPath, JSON.stringify({
      success: validation.success,
      compile: validation.compile,
      tests: validation.tests,
      coverage: validation.coverage,
      traces: validation.traces,
      metrics: compiled.metrics,
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    const metrics = {
      ...compiled.metrics,
      compilePassed: validation.compile.success,
      compileRepairs: validation.compile.repairs,
      testPassed: validation.tests.success,
      testRepairs: validation.tests.repairs,
      coverage: validation.coverage,
      success: validation.success,
    };

    runData.ts_metrics = metrics;
    runData.ts_artifacts = {
      source: `/flows/${name}/ts-runtime/${compiled.fileBase}.ts`,
      harness: `/flows/${name}/ts-runtime/${compiled.fileBase}.harness.ts`,
      validation: `/flows/${name}/ts-runtime/${compiled.fileBase}.validation.json`,
    };

    await persistRunData(runPath, runData);

    logger.info('ts.compile_complete', {
      runId: run_id.slice(0, 8),
      success: validation.success,
      className: compiled.className,
      compileRepairs: validation.compile.repairs,
      testRepairs: validation.tests.repairs,
      traces: validation.traces.length,
    });

    const tsConfidence = validation.success ? 0.95 : (validation.compile.success ? 0.6 : 0.2);

    const responsePayload = {
      success: validation.success,
      class_name: compiled.className,
      ts_source: validation.tsSource,
      harness_source: validation.harnessSource,
      compile: validation.compile,
      tests: validation.tests,
      coverage: validation.coverage,
      traces: validation.traces,
      metrics,
      paths: {
        source: `/flows/${name}/ts-runtime/${compiled.fileBase}.ts`,
        harness: `/flows/${name}/ts-runtime/${compiled.fileBase}.harness.ts`,
        validation: `/flows/${name}/ts-runtime/${compiled.fileBase}.validation.json`,
      },
      progressionUpdate: {
        stage: 'ts',
        unlockedStages: ['idea', 'md', 'mmd', 'tsx', 'tla', 'ts'],
        confidence: tsConfidence,
      },
    };

    opseeq.reportStage(run_id, {
      stage: validation.success ? 'ts_complete' : 'ts_partial',
      class_name: compiled.className,
      compile_success: validation.compile?.success,
      tests_passed: validation.tests?.passed,
      confidence: tsConfidence,
    });
    if (!validation.success) {
      return res.status(422).json(responsePayload);
    }
    return res.json(responsePayload);
  } catch (err) {
    logger.error('ts.compile_error', { error: err.message, stack: err.stack });
    opseeq.reportStage(run_id, { stage: 'ts_failed', error: err.message });
    return res.status(500).json({
      success: false,
      error: 'TypeScriptRuntime compilation failed',
      details: err.message,
    });
  } finally {
    provider.setTraceId(null);
  }
});

module.exports = router;
