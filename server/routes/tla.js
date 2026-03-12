'use strict';

/**
 * TLA+ Route — POST /api/render/tla
 *
 * Post-render continuation: generates a TLA+ formal specification from
 * the same typed plan that produced the Mermaid diagram. Validates with
 * SANY/TLC and returns structured results.
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const tlaCompiler = require('../services/tla-compiler');
const tlaValidator = require('../services/tla-validator');
const { buildTlaRepairPrompt, buildTlaRepairUserPrompt, buildTlaEnrichPrompt, buildTlaEnrichUserPrompt } = require('../services/axiom-prompts-tla');
const provider = require('../services/inference-provider');
const runTracker = require('../services/run-tracker');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');

const router = Router();

// ---- Availability check ----------------------------------------------------

router.get('/render/tla/status', async (_req, res) => {
  const available = await tlaValidator.isAvailable();
  const [java, jar] = await Promise.all([
    tlaValidator.checkJava(),
    tlaValidator.checkJar(),
  ]);
  res.json({
    success: true,
    available,
    java,
    jar,
    jarPath: tlaValidator.JAR_PATH,
    sanyTimeoutMs: tlaValidator.SANY_TIMEOUT_MS,
    tlcTimeoutMs: tlaValidator.TLC_TIMEOUT_MS,
  });
});

// ---- Main TLA+ compilation endpoint ----------------------------------------

router.post('/render/tla', async (req, res) => {
  const { diagram_name, run_id } = req.body || {};

  if (!run_id) {
    return res.status(400).json({ success: false, error: 'run_id is required' });
  }

  // Check TLA+ toolchain availability
  const available = await tlaValidator.isAvailable();
  if (!available) {
    const [java, jar] = await Promise.all([tlaValidator.checkJava(), tlaValidator.checkJar()]);
    return res.status(503).json({
      success: false,
      error: 'TLA+ toolchain not available',
      details: {
        java,
        jar,
        hint: !jar ? 'Run: ./mermaid.sh tla-setup' : 'Java is required for TLA+ verification',
      },
    });
  }

  try {
    // Load run JSON to get facts + plan
    const runPath = path.join(RUNS_DIR, `${run_id}.json`);
    let runData;
    try {
      const raw = await fsp.readFile(runPath, 'utf8');
      runData = JSON.parse(raw);
    } catch {
      return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
    }

    // Extract facts and plan from agent_calls
    let facts = null;
    let plan = null;
    let originalInput = runData.user_request?.input || '';

    for (const call of (runData.agent_calls || [])) {
      if (call.stage === 'fact_extraction' && call.success) {
        try { facts = JSON.parse(call.output_text); } catch { /* skip */ }
      }
      if (call.stage === 'diagram_plan' && call.success) {
        try { plan = JSON.parse(call.output_text); } catch { /* skip */ }
      }
    }

    if (!facts || !facts.entities || facts.entities.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Run does not contain typed facts. TLA+ requires an HPC-GoT render with fact extraction.',
      });
    }

    const name = diagram_name || runData.user_request?.diagram_name || 'spec';
    const moduleName = tlaCompiler._sanitizeId(name).replace(/^v/, 'M') || 'Spec';
    const tlaDir = path.join(FLOWS_DIR, name);
    await fsp.mkdir(tlaDir, { recursive: true });

    logger.info('tla.compile_start', { moduleName, run_id: run_id.slice(0, 8), entities: facts.entities.length });

    // Phase: COMPILE — deterministic mapping
    const { tlaSource, variables, actions, invariants } = tlaCompiler.factsToTlaModule(facts, plan, moduleName);
    const cfgSource = tlaCompiler.factsToTlaCfg(invariants, moduleName);

    // Phase: VALIDATE — SANY + TLC with optional repair
    const repairFn = async (source, errors) => {
      const { system } = buildTlaRepairPrompt();
      const userPrompt = buildTlaRepairUserPrompt(source, errors);
      const _repairStart = Date.now();
      const result = await provider.infer('repair_from_trace', { systemPrompt: system, userPrompt });
      logger.info('tla.repair.timing', { ms: Date.now() - _repairStart, provider: result.provider, hasOutput: !!result.output, noOp: result.noOp });
      if (result.output && !result.noOp) {
        let repaired = result.output.trim();
        if (repaired.startsWith('```')) {
          repaired = repaired.replace(/^```(?:tla\+?)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        return repaired;
      }
      return null;
    };

    const validation = await tlaValidator.fullValidation(tlaSource, cfgSource, tlaDir, moduleName, repairFn);

    // Phase: PERSIST — write artifacts
    const tlaPath = path.join(tlaDir, `${moduleName}.tla`);
    const cfgPath = path.join(tlaDir, `${moduleName}.cfg`);
    await fsp.writeFile(tlaPath, validation.tlaSource, 'utf8');
    await fsp.writeFile(cfgPath, cfgSource, 'utf8');

    // Compute quality metrics
    const metrics = tlaCompiler.computeTlaMetrics(variables, actions, invariants, facts);
    metrics.sanyPassedFirstAttempt = validation.sany.repairAttempts === 0 && validation.sany.valid;
    metrics.tlcCompleted = validation.tlc.checked;
    metrics.tlcViolations = validation.tlc.violations.length;
    metrics.tlcStatesExplored = validation.tlc.statesExplored;
    metrics.tlcWallClockMs = validation.tlc.wallClockMs;

    // Update run JSON with TLA+ metrics
    try {
      runData.tla_metrics = metrics;
      runData.tla_artifacts = {
        tla: `/flows/${name}/${moduleName}.tla`,
        cfg: `/flows/${name}/${moduleName}.cfg`,
        trace: validation.tracePath ? `/flows/${name}/trace.json` : null,
      };
      await fsp.writeFile(runPath, JSON.stringify(runData, null, 2), 'utf8');
    } catch (err) {
      logger.warn('tla.run_update_failed', { error: err.message });
    }

    logger.info('tla.compile_complete', {
      moduleName,
      sanyValid: validation.sany.valid,
      repairAttempts: validation.sany.repairAttempts,
      tlcChecked: validation.tlc.checked,
      violations: validation.tlc.violations.length,
      statesExplored: validation.tlc.statesExplored,
      wallClockMs: validation.tlc.wallClockMs,
    });

    // Phase: OUTPUT — structured response
    res.json({
      success: true,
      module_name: moduleName,
      tla_source: validation.tlaSource,
      cfg_source: cfgSource,
      sany: validation.sany,
      tlc: {
        checked: validation.tlc.checked,
        success: validation.tlc.success,
        invariantsChecked: validation.tlc.invariantsChecked,
        violations: validation.tlc.violations,
        statesExplored: validation.tlc.statesExplored,
        wallClockMs: validation.tlc.wallClockMs,
        timedOut: validation.tlc.timedOut,
      },
      metrics,
      paths: {
        tla: `/flows/${name}/${moduleName}.tla`,
        cfg: `/flows/${name}/${moduleName}.cfg`,
        trace: validation.tracePath ? `/flows/${name}/trace.json` : null,
      },
      progressionUpdate: {
        stage: 'tla',
        unlockedStages: validation.sany.valid
          ? ['idea', 'md', 'mmd', 'tla', 'ts']
          : ['idea', 'md', 'mmd', 'tla'],
        nextRecommended: validation.sany.valid ? 'ts' : undefined,
        confidence: validation.sany.valid
          ? (validation.tlc.success ? 0.95 : 0.7)
          : 0.3,
      },
    });
  } catch (err) {
    logger.error('tla.compile_error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
