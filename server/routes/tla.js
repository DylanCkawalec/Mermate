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
const { buildTlaRepairPrompt, buildTlaRepairUserPrompt } = require('../services/axiom-prompts-tla');
const provider = require('../services/inference-provider');
const speculaLlm = require('../services/specula-llm');
const { buildSpeculaBundle } = require('../services/specula-bundle');
const {
  loadRunData,
  persistRunData,
  extractFactsAndPlan,
  getOriginalInput,
  resolveDiagramName,
  loadCanonicalMarkdown,
  readTextArtifact,
} = require('../services/run-artifact-loader');
const opseeq = require('../services/opseeq-bridge');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');

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
    specula: speculaLlm.getConfig(),
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
    let runPath;
    let runData;
    try {
      const loaded = await loadRunData(run_id);
      runPath = loaded.runPath;
      runData = loaded.runData;
    } catch {
      return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
    }

    provider.setTraceId(run_id);

    // Extract facts and plan from agent_calls (HPC-GoT path)
    let { facts, plan } = extractFactsAndPlan(runData);
    const originalInput = getOriginalInput(runData);

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

    const name = diagram_name || resolveDiagramName(runData, 'spec');
    const moduleName = tlaCompiler._sanitizeId(name).replace(/^v/, 'M') || 'Spec';
    const tlaDir = path.join(FLOWS_DIR, name);
    await fsp.mkdir(tlaDir, { recursive: true });

    const markdownSource = await loadCanonicalMarkdown(runData, name);
    let tsxManifest = null;
    try {
      if (runData?.tsx_artifacts?.manifest) {
        tsxManifest = JSON.parse(await readTextArtifact(runData.tsx_artifacts.manifest));
      }
    } catch (err) {
      logger.warn('tla.tsx_manifest_unavailable', { error: err.message });
    }

    logger.info('tla.compile_start', { moduleName, run_id: run_id.slice(0, 8), entities: facts.entities.length });

    const repairFn = async (source, errors) => {
      const { system } = buildTlaRepairPrompt();
      const userPrompt = buildTlaRepairUserPrompt(source, errors);
      const _repairStart = Date.now();
      const result = await speculaLlm.inferTlaStage('repair_tla', { systemPrompt: system, userPrompt });
      logger.info('tla.repair.timing', {
        ms: Date.now() - _repairStart,
        provider: result.provider,
        hasOutput: !!result.output,
        available: result.available,
        error: result.error || null,
      });
      if (result.output) {
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
        return { name: sub.name, boundary: sub.boundary, sany: subSany.sanyResult, repairAttempts: subSany.repairAttempts };
      }));

      submoduleResults = subValidations;

      // Write and validate master module with TLC
      const master = splitResult.masterModule;
      cfgSource = master.cfgSource;

      let masterTlaSource = master.tlaSource;
      if (speculaLlm.isAvailable()) {
        const claudeResult = await speculaLlm.generateTlaSpec(facts, plan, moduleName, masterTlaSource);
        if (claudeResult.tlaSource) masterTlaSource = claudeResult.tlaSource;
      }

      validation = await tlaValidator.fullValidation(masterTlaSource, cfgSource, tlaDir, moduleName, repairFn);

      const masterResult = tlaCompiler.factsToTlaModule(facts, plan, moduleName);
      variables = masterResult.variables;
      actions = masterResult.actions;
      invariants = masterResult.invariants;
    } else {
      // Single-module path: deterministic seed -> Claude refinement -> validation
      const result = tlaCompiler.factsToTlaModule(facts, plan, moduleName);
      variables = result.variables;
      actions = result.actions;
      invariants = result.invariants;
      cfgSource = tlaCompiler.factsToTlaCfg(invariants, moduleName);

      let tlaSource = result.tlaSource;

      // Promote Claude to primary TLA+ writer when available
      if (speculaLlm.isAvailable()) {
        logger.info('tla.claude_primary', { moduleName, seedLen: tlaSource.length });
        const claudeResult = await speculaLlm.generateTlaSpec(facts, plan, moduleName, tlaSource);
        if (claudeResult.tlaSource) {
          tlaSource = claudeResult.tlaSource;
          logger.info('tla.claude_spec_accepted', { moduleName, len: tlaSource.length, ms: claudeResult.latencyMs });
        } else {
          logger.info('tla.claude_unavailable_fallback', { error: claudeResult.error });
        }
      }

      validation = await tlaValidator.fullValidation(tlaSource, cfgSource, tlaDir, moduleName, repairFn);
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

    const speculaBundle = buildSpeculaBundle({
      runId: run_id,
      diagramName: name,
      moduleName,
      facts,
      plan,
      variables,
      actions,
      invariants,
      markdownPath: `/flows/${name}/architecture.md`,
      markdownSource,
      tsxManifest,
      tsxPaths: runData?.tsx_artifacts || null,
      baseTlaSource: validation.tlaSource,
      baseCfgSource: cfgSource,
      validation,
    });
    await fsp.mkdir(path.join(tlaDir, 'specula'), { recursive: true });
    await Promise.all(speculaBundle.files.map((file) => (
      fsp.writeFile(path.join(tlaDir, file.relativePath), file.content, 'utf8')
    )));

    // Update run JSON with TLA+ metrics
    try {
      runData.tla_metrics = metrics;
      runData.tla_artifacts = {
        tla: `/flows/${name}/${moduleName}.tla`,
        cfg: `/flows/${name}/${moduleName}.cfg`,
        trace: validation.tracePath ? `/flows/${name}/trace.json` : null,
      };
      runData.specula_artifacts = {
        base_tla: `/flows/${name}/specula/base.tla`,
        base_cfg: `/flows/${name}/specula/base.cfg`,
        modeling_brief_md: `/flows/${name}/specula/modeling-brief.md`,
        modeling_brief_json: `/flows/${name}/specula/modeling-brief.json`,
        mc_tla: `/flows/${name}/specula/MC.tla`,
        mc_cfg: `/flows/${name}/specula/MC.cfg`,
        trace_tla: `/flows/${name}/specula/Trace.tla`,
        trace_cfg: `/flows/${name}/specula/Trace.cfg`,
        instrumentation_spec: `/flows/${name}/specula/instrumentation-spec.md`,
        validation_loop: `/flows/${name}/specula/validation-loop.json`,
        hunt_cfgs: speculaBundle.huntConfigs.map((config) => `/flows/${name}/specula/${config.fileName}`),
      };
      runData.tla_env = {
        claude: speculaLlm.getConfig(),
      };
      await persistRunData(runPath, runData);
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

    opseeq.reportStage(run_id, {
      stage: 'tla_complete',
      module_name: moduleName,
      sany_valid: validation.sany.valid,
      sany_repair_attempts: validation.sany.repairAttempts,
      tlc_success: validation.tlc.success,
      tlc_violations: (validation.tlc.violations || []).length,
      tlc_errors: validation.tlc.errors || [],
      tlc_deadlock: validation.tlc.deadlockReached || false,
      states_explored: validation.tlc.statesExplored,
      wall_clock_ms: validation.tlc.wallClockMs,
      confidence: tlaConfidence,
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
        errors: validation.tlc.errors || [],
        deadlockReached: validation.tlc.deadlockReached || false,
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
        specula: {
          root: `/flows/${name}/specula/`,
          modeling_brief_md: `/flows/${name}/specula/modeling-brief.md`,
          modeling_brief_json: `/flows/${name}/specula/modeling-brief.json`,
          mc_tla: `/flows/${name}/specula/MC.tla`,
          mc_cfg: `/flows/${name}/specula/MC.cfg`,
          trace_tla: `/flows/${name}/specula/Trace.tla`,
          trace_cfg: `/flows/${name}/specula/Trace.cfg`,
          instrumentation_spec: `/flows/${name}/specula/instrumentation-spec.md`,
          validation_loop: `/flows/${name}/specula/validation-loop.json`,
          hunt_cfgs: speculaBundle.huntConfigs.map((config) => `/flows/${name}/specula/${config.fileName}`),
        },
      },
      specula: {
        upstream: speculaBundle.upstream,
        env: speculaLlm.getConfig(),
        modeling_brief: speculaBundle.modelingBrief,
        modeling_brief_markdown: speculaBundle.modelingBriefMarkdown,
        mc: {
          module_name: speculaBundle.mc.moduleName,
          source: speculaBundle.mc.source,
          cfg_source: speculaBundle.mc.cfgSource,
          hunt_configs: speculaBundle.huntConfigs,
        },
        trace_spec: {
          module_name: speculaBundle.trace.moduleName,
          source: speculaBundle.trace.source,
          cfg_source: speculaBundle.trace.cfgSource,
        },
        instrumentation: {
          markdown: speculaBundle.instrumentationMarkdown,
        },
        validation_loop: speculaBundle.validationLoop,
      },
      progressionUpdate: {
        stage: 'tla',
        unlockedStages: validation.sany.valid
          ? ['idea', 'md', 'mmd', 'tsx', 'tla', 'ts']
          : ['idea', 'md', 'mmd', 'tsx', 'tla'],
        nextRecommended: validation.sany.valid ? 'ts' : undefined,
        confidence: tlaConfidence,
      },
    });
  } catch (err) {
    logger.error('tla.compile_error', { error: err.message, stack: err.stack });
    opseeq.reportStage(run_id, { stage: 'tla_failed', error: err.message });
    res.status(500).json({ success: false, error: err.message });
  } finally {
    provider.setTraceId(null);
  }
});

// ---- TLA+ errors: structured read-back for a run -------------------------

router.get('/render/tla/errors/:run_id', async (req, res) => {
  const { run_id } = req.params;

  try {
    const { runData } = await loadRunData(run_id);

    if (!runData.tla_artifacts?.tla) {
      return res.status(404).json({ success: false, error: 'No TLA+ artifacts for this run' });
    }

    const tlaPath = path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, ''));
    let tlaSource = '';
    try { tlaSource = await fsp.readFile(tlaPath, 'utf8'); } catch { /* missing file */ }

    const metrics = runData.tla_metrics || {};
    const speculaCfg = runData.tla_env?.claude || {};

    return res.json({
      success: true,
      run_id,
      tla_source: tlaSource,
      artifacts: runData.tla_artifacts,
      metrics,
      sany: {
        passed_first: metrics.sanyPassedFirstAttempt ?? null,
      },
      tlc: {
        completed: metrics.tlcCompleted ?? null,
        violations: metrics.tlcViolations ?? 0,
        states_explored: metrics.tlcStatesExplored ?? 0,
        wall_clock_ms: metrics.tlcWallClockMs ?? 0,
      },
      specula: speculaCfg,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- TLA+ revalidate: re-run SANY+TLC on existing spec without regenerating

router.post('/render/tla/revalidate', async (req, res) => {
  const { run_id } = req.body || {};

  if (!run_id) {
    return res.status(400).json({ success: false, error: 'run_id is required' });
  }

  const available = await tlaValidator.isAvailable();
  if (!available) {
    return res.status(503).json({ success: false, error: 'TLA+ toolchain not available' });
  }

  try {
    const { runPath, runData } = await loadRunData(run_id);

    if (!runData.tla_artifacts?.tla || !runData.tla_artifacts?.cfg) {
      return res.status(422).json({ success: false, error: 'No TLA+ artifacts to revalidate' });
    }

    const tlaArtPath = path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, ''));
    const cfgArtPath = path.join(PROJECT_ROOT, runData.tla_artifacts.cfg.replace(/^\//, ''));
    const tlaDir = path.dirname(tlaArtPath);
    const moduleName = path.basename(tlaArtPath, '.tla');

    const tlaSource = await fsp.readFile(tlaArtPath, 'utf8');
    const cfgSource = await fsp.readFile(cfgArtPath, 'utf8');

    provider.setTraceId(run_id);
    try {
      const repairFn = async (source, errors) => {
        const { system } = buildTlaRepairPrompt();
        const userPrompt = buildTlaRepairUserPrompt(source, errors);
        const result = await speculaLlm.inferTlaStage('repair_tla', { systemPrompt: system, userPrompt });
        if (result.output) {
          let repaired = result.output.trim();
          if (repaired.startsWith('```')) {
            repaired = repaired.replace(/^```(?:tla\+?)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          return repaired;
        }
        return null;
      };

      const validation = await tlaValidator.fullValidation(tlaSource, cfgSource, tlaDir, moduleName, repairFn);

      if (validation.tlaSource !== tlaSource) {
        await fsp.writeFile(tlaArtPath, validation.tlaSource, 'utf8');
      }

      runData.tla_metrics = {
        ...(runData.tla_metrics || {}),
        revalidated_at: new Date().toISOString(),
        sanyPassedFirstAttempt: validation.sany.repairAttempts === 0 && validation.sany.valid,
        tlcCompleted: validation.tlc.checked,
        tlcViolations: validation.tlc.violations.length,
        tlcStatesExplored: validation.tlc.statesExplored,
        tlcWallClockMs: validation.tlc.wallClockMs,
      };
      await persistRunData(runPath, runData);

      opseeq.reportStage(run_id, {
        stage: validation.sany.valid ? 'tla_revalidated' : 'tla_revalidate_failed',
        sany_valid: validation.sany.valid,
        tlc_success: validation.tlc.success,
        repair_attempts: validation.sany.repairAttempts,
        states_explored: validation.tlc.statesExplored,
        errors: validation.tlc.errors || [],
      });

      return res.json({
        success: validation.sany.valid,
        repaired: validation.tlaSource !== tlaSource,
        sany: validation.sany,
        tlc: {
          checked: validation.tlc.checked,
          success: validation.tlc.success,
          violations: validation.tlc.violations,
          errors: validation.tlc.errors || [],
          statesExplored: validation.tlc.statesExplored,
          wallClockMs: validation.tlc.wallClockMs,
        },
        tla_source: validation.tlaSource,
      });
    } finally {
      provider.setTraceId(null);
    }
  } catch (err) {
    logger.error('tla.revalidate_error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- TLA+ spec edit: update source, revalidate, persist -------------------

router.post('/render/tla/edit', async (req, res) => {
  const { run_id, tla_source, cfg_source } = req.body || {};

  if (!run_id || !tla_source) {
    return res.status(400).json({ success: false, error: 'run_id and tla_source are required' });
  }

  const available = await tlaValidator.isAvailable();
  if (!available) {
    return res.status(503).json({ success: false, error: 'TLA+ toolchain not available' });
  }

  try {
    const { runPath, runData } = await loadRunData(run_id);

    if (!runData.tla_artifacts?.tla) {
      return res.status(422).json({ success: false, error: 'No TLA+ artifacts to edit' });
    }

    const tlaArtPath = path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, ''));
    const cfgArtPath = path.join(PROJECT_ROOT, runData.tla_artifacts.cfg.replace(/^\//, ''));
    const tlaDir = path.dirname(tlaArtPath);
    const moduleName = path.basename(tlaArtPath, '.tla');

    const effectiveCfg = cfg_source || await fsp.readFile(cfgArtPath, 'utf8');

    provider.setTraceId(run_id);
    try {
      const validation = await tlaValidator.fullValidation(tla_source, effectiveCfg, tlaDir, moduleName);

      await fsp.writeFile(tlaArtPath, validation.tlaSource, 'utf8');
      if (cfg_source) {
        await fsp.writeFile(cfgArtPath, effectiveCfg, 'utf8');
      }

      runData.tla_metrics = {
        ...(runData.tla_metrics || {}),
        edited_at: new Date().toISOString(),
        sanyPassedFirstAttempt: validation.sany.repairAttempts === 0 && validation.sany.valid,
        tlcCompleted: validation.tlc.checked,
        tlcViolations: validation.tlc.violations.length,
        tlcStatesExplored: validation.tlc.statesExplored,
        tlcWallClockMs: validation.tlc.wallClockMs,
      };
      await persistRunData(runPath, runData);

      opseeq.reportStage(run_id, {
        stage: validation.sany.valid ? 'tla_edited' : 'tla_edit_failed',
        sany_valid: validation.sany.valid,
        tlc_success: validation.tlc.success,
        states_explored: validation.tlc.statesExplored,
        errors: validation.tlc.errors || [],
      });

      return res.json({
        success: validation.sany.valid,
        sany: validation.sany,
        tlc: {
          checked: validation.tlc.checked,
          success: validation.tlc.success,
          violations: validation.tlc.violations,
          errors: validation.tlc.errors || [],
          statesExplored: validation.tlc.statesExplored,
          wallClockMs: validation.tlc.wallClockMs,
        },
        tla_source: validation.tlaSource,
        cfg_source: effectiveCfg,
      });
    } finally {
      provider.setTraceId(null);
    }
  } catch (err) {
    logger.error('tla.edit_error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---- TLA+ SANY-only check: quick syntax validation without TLC -----------

router.post('/render/tla/check', async (req, res) => {
  const { tla_source, module_name } = req.body || {};

  if (!tla_source) {
    return res.status(400).json({ success: false, error: 'tla_source is required' });
  }

  const available = await tlaValidator.isAvailable();
  if (!available) {
    return res.status(503).json({ success: false, error: 'TLA+ toolchain not available' });
  }

  try {
    const tmpDir = path.join(PROJECT_ROOT, 'flows', '_tla_check_tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const name = module_name || 'CheckSpec';
    const tlaPath = path.join(tmpDir, `${name}.tla`);
    await fsp.writeFile(tlaPath, tla_source, 'utf8');

    const sanyResult = await tlaValidator.runSany(tlaPath);

    try { await fsp.rm(tmpDir, { recursive: true }); } catch { /* best-effort cleanup */ }

    return res.json({
      success: sanyResult.valid,
      sany: {
        valid: sanyResult.valid,
        errors: sanyResult.errors,
        wallClockMs: sanyResult.wallClockMs,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
