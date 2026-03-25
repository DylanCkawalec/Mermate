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

    // Extract facts and plan from agent_calls (HPC-GoT path)
    let facts = null;
    let plan = null;
    let originalInput = runData.request?.user_input || runData.user_request?.input || '';

    for (const call of (runData.agent_calls || [])) {
      if (call.stage === 'fact_extraction' && call.success) {
        try { facts = JSON.parse(call.output_text); } catch { /* skip */ }
      }
      if (call.stage === 'diagram_plan' && call.success) {
        try { plan = JSON.parse(call.output_text); } catch { /* skip */ }
      }
    }

    // If facts not found in agent_calls (e.g. decompose pipeline), extract them now
    if (!facts || !facts.entities || facts.entities.length === 0) {
      if (!originalInput) {
        return res.status(422).json({
          success: false,
          error: 'Run does not contain typed facts or original input for extraction.',
        });
      }

      logger.info('tla.extracting_facts', { run_id: run_id.slice(0, 8), reason: 'not found in agent_calls' });
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

      // Also extract plan if possible
      if (!plan) {
        const planPrompt = buildPrompt('diagram_plan');
        const { buildDiagramPlanUserPrompt } = require('../services/axiom-prompts');
        const planUserPrompt = buildDiagramPlanUserPrompt(facts, profile);
        const planResult = await provider.infer('diagram_plan', {
          systemPrompt: planPrompt.system,
          userPrompt: planUserPrompt,
        });
        if (planResult.output && !planResult.noOp) {
          try {
            let parsed = planResult.output.trim();
            if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            plan = JSON.parse(parsed);
          } catch { /* plan extraction is optional */ }
        }
      }
    }

    const name = diagram_name || runData.user_request?.diagram_name || 'spec';
    const moduleName = tlaCompiler._sanitizeId(name).replace(/^v/, 'M') || 'Spec';
    const tlaDir = path.join(FLOWS_DIR, name);
    await fsp.mkdir(tlaDir, { recursive: true });

    logger.info('tla.compile_start', { moduleName, run_id: run_id.slice(0, 8), entities: facts.entities.length });

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

    const boundaries = facts?.boundaries || [];
    const useSplit = boundaries.length >= 2;
    let validation, cfgSource, variables, actions, invariants;
    let submoduleResults = [];

    if (useSplit) {
      // Subsystem-level splitting: one .tla per boundary
      logger.info('tla.split_mode', { boundaries: boundaries.length, moduleName });
      const splitResult = tlaCompiler.factsToTlaSubmodules(facts, plan, moduleName);

      const subDir = path.join(tlaDir, 'tla');
      await fsp.mkdir(subDir, { recursive: true });

      // Validate each submodule with SANY independently (parallel)
      const subValidations = await Promise.all(splitResult.submodules.map(async (sub) => {
        const subSany = await tlaValidator.validateWithRepair(
          sub.tlaSource, subDir, sub.name, repairFn,
        );
        await fsp.writeFile(path.join(subDir, `${sub.name}.tla`), subSany.tlaSource, 'utf8');
        await fsp.writeFile(path.join(subDir, `${sub.name}.cfg`), sub.cfgSource, 'utf8');
        return { name: sub.name, boundary: sub.boundary, sany: subSany.sany };
      }));

      submoduleResults = subValidations;

      // Write and validate master module with TLC
      const master = splitResult.masterModule;
      cfgSource = master.cfgSource;
      validation = await tlaValidator.fullValidation(master.tlaSource, cfgSource, tlaDir, moduleName, repairFn);

      const masterResult = tlaCompiler.factsToTlaModule(facts, plan, moduleName);
      variables = masterResult.variables;
      actions = masterResult.actions;
      invariants = masterResult.invariants;
    } else {
      // Single-module path (no splitting)
      const result = tlaCompiler.factsToTlaModule(facts, plan, moduleName);
      variables = result.variables;
      actions = result.actions;
      invariants = result.invariants;
      cfgSource = tlaCompiler.factsToTlaCfg(invariants, moduleName);
      validation = await tlaValidator.fullValidation(result.tlaSource, cfgSource, tlaDir, moduleName, repairFn);
    }

    // Phase: PERSIST — write artifacts to flows/
    const tlaPath = path.join(tlaDir, `${moduleName}.tla`);
    const cfgPath = path.join(tlaDir, `${moduleName}.cfg`);
    await fsp.writeFile(tlaPath, validation.tlaSource, 'utf8');
    await fsp.writeFile(cfgPath, cfgSource, 'utf8');

    // Phase: TLA-DUMP — separate copy for archival
    const TLA_DUMP_DIR = path.join(PROJECT_ROOT, 'tla-dump');
    const dumpDir = path.join(TLA_DUMP_DIR, name);
    try {
      // Archive existing dump if it exists
      try {
        await fsp.access(dumpDir);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = path.join(TLA_DUMP_DIR, '_archive', `${name}_${ts}`);
        await fsp.mkdir(path.dirname(archiveDir), { recursive: true });
        await fsp.rename(dumpDir, archiveDir);
        logger.info('tla.archive_old', { from: name, to: archiveDir });
      } catch { /* no previous dump */ }

      await fsp.mkdir(dumpDir, { recursive: true });
      await fsp.writeFile(path.join(dumpDir, `${moduleName}.tla`), validation.tlaSource, 'utf8');
      await fsp.writeFile(path.join(dumpDir, `${moduleName}.cfg`), cfgSource, 'utf8');
      if (validation.tracePath) {
        try {
          const traceData = await fsp.readFile(path.join(tlaDir, 'trace.json'), 'utf8');
          await fsp.writeFile(path.join(dumpDir, 'trace.json'), traceData, 'utf8');
        } catch { /* trace copy is best-effort */ }
      }
      if (useSplit && submoduleResults.length > 0) {
        const subDumpDir = path.join(dumpDir, 'submodules');
        await fsp.mkdir(subDumpDir, { recursive: true });
        const srcSubDir = path.join(tlaDir, 'tla');
        for (const sub of submoduleResults) {
          try {
            const src = await fsp.readFile(path.join(srcSubDir, `${sub.name}.tla`), 'utf8');
            await fsp.writeFile(path.join(subDumpDir, `${sub.name}.tla`), src, 'utf8');
          } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      logger.warn('tla.dump_failed', { error: err.message });
    }

    // Compute quality metrics
    const metrics = tlaCompiler.computeTlaMetrics(variables, actions, invariants, facts);
    metrics.sanyPassedFirstAttempt = validation.sany.repairAttempts === 0 && validation.sany.valid;
    metrics.tlcCompleted = validation.tlc.checked;
    metrics.tlcViolations = validation.tlc.violations.length;
    metrics.tlcStatesExplored = validation.tlc.statesExplored;
    metrics.tlcWallClockMs = validation.tlc.wallClockMs;
    if (useSplit) {
      metrics.splitMode = true;
      metrics.submoduleCount = submoduleResults.length;
      metrics.submodulesSanyValid = submoduleResults.filter(s => s.sany?.valid).length;
    }

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
      splitMode: useSplit,
      submodules: submoduleResults.length,
      sanyValid: validation.sany.valid,
      repairAttempts: validation.sany.repairAttempts,
      tlcChecked: validation.tlc.checked,
      violations: validation.tlc.violations.length,
      statesExplored: validation.tlc.statesExplored,
      wallClockMs: validation.tlc.wallClockMs,
    });

    const tlaConfidence = validation.sany.valid
      ? (validation.tlc.success ? 0.95 : 0.7)
      : 0.3;

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
      submodules: useSplit ? submoduleResults.map(s => ({
        name: s.name,
        boundary: s.boundary,
        sany: s.sany,
      })) : undefined,
      paths: {
        tla: `/flows/${name}/${moduleName}.tla`,
        cfg: `/flows/${name}/${moduleName}.cfg`,
        trace: validation.tracePath ? `/flows/${name}/trace.json` : null,
        dump: `/tla-dump/${name}/`,
      },
      progressionUpdate: {
        stage: 'tla',
        unlockedStages: validation.sany.valid
          ? ['idea', 'md', 'mmd', 'tla', 'ts']
          : ['idea', 'md', 'mmd', 'tla'],
        nextRecommended: validation.sany.valid ? 'ts' : undefined,
        confidence: tlaConfidence,
      },
    });
  } catch (err) {
    logger.error('tla.compile_error', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
