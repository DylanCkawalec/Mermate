'use strict';

/**
 * Rust Binary Route — POST /api/render/rust
 *
 * Stage 6 continuation after /api/render/ts:
 *   validated architecture + TLA+ + TypeScript -> Rust binary
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');

const rustCompiler = require('../services/rust-compiler');
const rustValidator = require('../services/rust-validator');
const iconGen = require('../services/icon-generator');
const landingGen = require('../services/landing-page-generator');
const provider = require('../services/inference-provider');
const opseeq = require('../services/opseeq-bridge');
const logger = require('../utils/logger');
const {
  loadRunData,
  extractFactsAndPlan,
  getOriginalInput,
  resolveDiagramName,
  FLOWS_DIR,
  readTextArtifact,
  persistRunData,
} = require('../services/run-artifact-loader');

const router = Router();

function _jsonFlowArtifact(obj) {
  return process.env.MERMATE_RUN_JSON_PRETTY === '1'
    ? JSON.stringify(obj, null, 2)
    : JSON.stringify(obj);
}

/** Best-effort: confirm expected outputs exist under repo (or binary path) before responding. */
async function _verifyPackagingPaths(label, paths) {
  const checks = await Promise.all((paths || []).map(async (p) => {
    if (!p) return { ok: true, skip: true };
    try {
      await fsp.access(p);
      return { ok: true, path: p };
    } catch {
      return { ok: false, path: p };
    }
  }));
  const missing = checks.filter((c) => c.path && !c.ok).map((c) => c.path);
  if (missing.length) logger.warn('rust.packaging_path_missing', { label, missing });
  else logger.debug('rust.packaging_paths_ok', { label, checked: checks.filter((c) => c.path).length });
}

router.get('/render/rust/status', async (_req, res) => {
  const available = await rustValidator.isAvailable();
  res.json({ success: true, available });
});

router.post('/render/rust', async (req, res) => {
  const { run_id, diagram_name } = req.body || {};

  if (!run_id) return res.status(400).json({ success: false, error: 'run_id is required' });

  const available = await rustValidator.isAvailable();
  if (!available) {
    return res.status(503).json({ success: false, error: 'Rust toolchain not available', details: { hint: 'Install Rust: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh' } });
  }

  let runData, runPath;
  try {
    ({ runPath, runData } = await loadRunData(run_id));
  } catch {
    return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
  }

  provider.setTraceId(run_id);
  try {
  let { facts, plan } = extractFactsAndPlan(runData);

  // On-demand fact extraction if not in agent_calls
  if (!facts || !facts.entities?.length) {
    const originalInput = getOriginalInput(runData);
    if (!originalInput) return res.status(422).json({ success: false, error: 'Run has no typed facts or original input' });

    const { buildPrompt, buildFactExtractionUserPrompt } = require('../services/axiom-prompts');
    const { analyze } = require('../services/input-analyzer');
    const profile = analyze(originalInput, 'idea');
    const factPrompt = buildPrompt('fact_extraction');
    const factResult = await provider.infer('fact_extraction', { systemPrompt: factPrompt.system, userPrompt: buildFactExtractionUserPrompt(originalInput, profile) });
    if (factResult.output && !factResult.noOp) {
      try { let p = factResult.output.trim(); if (p.startsWith('```')) p = p.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''); facts = JSON.parse(p); } catch { /* skip */ }
    }
    if (!facts?.entities?.length) return res.status(422).json({ success: false, error: 'Could not extract typed facts' });
  }

  const baseName = resolveDiagramName(runData, diagram_name);
  const runSuffix = run_id.slice(0, 6);
  const name = `${baseName}-${runSuffix}`;
  const projectDir = path.join(FLOWS_DIR, name, 'rust-binary');

  try {
    const tlaSource = runData.tla_artifacts?.tla
      ? await readTextArtifact(runData.tla_artifacts.tla).catch(() => '')
      : '';

    const moduleName = runData.tla_artifacts?.tla
      ? path.basename(runData.tla_artifacts.tla, '.tla')
      : 'Spec';

    logger.info('rust.compile_start', { runId: run_id.slice(0, 8), diagramName: name, entities: facts.entities.length });

    const compiled = rustCompiler.compileToRust({
      runId: run_id, diagramName: name, moduleName, facts, plan,
      tla: { source: tlaSource },
    });

    // Repair function for cargo check failures
    const repairFn = async (input) => {
      const result = await provider.infer('repair_rust', {
        systemPrompt: 'You are a Rust compiler error repair engine. Fix the Rust source code so it compiles. Output ONLY the complete fixed main.rs. No markdown fencing.',
        userPrompt: `[RUST SOURCE]\n${input.rustSource}\n\n[CARGO ERRORS]\n${input.stderr || input.diagnostics?.map(d => d.raw).join('\n')}\n\nFix the compile errors and output the complete corrected main.rs.`,
      });
      if (result.output && !result.noOp) {
        let fixed = result.output.trim();
        if (fixed.startsWith('```')) fixed = fixed.replace(/^```(?:rust)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        return { rustSource: fixed };
      }
      return null;
    };

    const binaryName = compiled.cargoToml.match(/name = "([^"]+)"/)?.[1] || 'mermate-runtime';

    const validation = await rustValidator.fullValidation(
      compiled.mainRs, compiled.cargoToml, projectDir, binaryName, repairFn,
    );

    // Persist final source
    await fsp.writeFile(path.join(projectDir, 'src', 'main.rs'), validation.mainRs, 'utf8');

    const metrics = {
      ...compiled.metrics,
      compilePassed: validation.build.success,
      checkRepairs: validation.check.repairs,
      binaryRunPassed: validation.run?.success || false,
      miracleAchieved: validation.run?.miracleAchieved || false,
      buildWallClockMs: validation.build.wallClockMs || 0,
      success: validation.success,
    };

    // ---- Full app packaging pipeline ----
    let appBundlePath = null;
    let desktopPath = null;
    const fullBinaryPath = path.join(projectDir, 'target', 'release', binaryName);
    const tlaValid = !!(runData.tla_artifacts?.tla);
    const tsValid = !!(runData.ts_metrics?.success ?? runData.rust_artifacts);
    const originalInput = getOriginalInput(runData) || '';
    const appPort = 19000 + Math.floor(Math.random() * 999);

    if (validation.build.success) {
      const imgCtx = { entities: facts.entities || [], description: originalInput.slice(0, 300) };
      const [iconPath, heroPath] = await Promise.all([
        iconGen.generateIcon(projectDir, name, imgCtx),
        iconGen.generateHeroImage(projectDir, name, imgCtx),
      ]);

      // 3. Pre-run the engine binary to capture initial output for the dashboard
      let engineOutput = '';
      if (validation.run?.success) {
        engineOutput = (validation.run.stdout || '') + (validation.run.stderr || '');
      }
      if (!engineOutput && fullBinaryPath) {
        try {
          const { execSync } = require('node:child_process');
          engineOutput = execSync(fullBinaryPath, { timeout: 10_000, encoding: 'utf8' });
        } catch (e) { engineOutput = e.stdout || e.message || ''; }
      }

      // 4. Generate landing page HTML with pre-loaded engine output
      const landingHtml = landingGen.generateLandingPage({
        appName: binaryName,
        diagramName: name,
        entities: facts.entities || [],
        relationships: facts.relationships || [],
        facts,
        metrics,
        tlaValid,
        tsValid,
        rustValid: validation.success,
        miracleAchieved: validation.run?.miracleAchieved,
        hasHero: !!heroPath,
        hasIcon: !!iconPath,
        runId: run_id,
        engineOutput,
        description: originalInput.slice(0, 400),
      });

      // 4. Generate launcher script (opens browser dashboard on double-click)
      const launcherScript = landingGen.generateLauncherScript(binaryName, appPort);

      // 5. Generate Opseeq skill manifest
      const skillManifest = landingGen.generateSkillManifest({
        appName: binaryName,
        diagramName: name,
        entities: facts.entities || [],
        relationships: facts.relationships || [],
        runId: run_id,
        tlaModuleName: runData.tla_artifacts?.tla ? path.basename(runData.tla_artifacts.tla, '.tla') : null,
        metrics,
      });

      appBundlePath = await iconGen.createMacOSApp(fullBinaryPath, iconPath, binaryName, projectDir, { launcherScript });

      const flowSkillPath = path.join(FLOWS_DIR, name, 'skill.json');
      if (appBundlePath) {
        const resDir = path.join(appBundlePath, 'Contents', 'Resources');
        const skillBody = _jsonFlowArtifact(skillManifest);
        await Promise.all([
          fsp.writeFile(path.join(resDir, 'index.html'), landingHtml, 'utf8'),
          fsp.writeFile(path.join(resDir, 'skill.json'), skillBody, 'utf8'),
          heroPath
            ? fsp.copyFile(heroPath, path.join(resDir, 'hero.png')).catch(() => {})
            : Promise.resolve(),
        ]);
        await _verifyPackagingPaths('app_resources', [
          fullBinaryPath,
          path.join(resDir, 'index.html'),
          path.join(resDir, 'skill.json'),
        ]);
      }

      desktopPath = await iconGen.deployToDesktop(appBundlePath, fullBinaryPath, binaryName);

      await fsp.writeFile(flowSkillPath, _jsonFlowArtifact(skillManifest), 'utf8').catch(() => {});
      await _verifyPackagingPaths('flow_skill', [flowSkillPath]);

      if (desktopPath) {
        logger.info('rust.deployed_to_desktop', { desktopPath, appBundle: !!appBundlePath, port: appPort });
      }
    }

    // Update run JSON
    runData.rust_metrics = metrics;
    runData.rust_artifacts = {
      source: `/flows/${name}/rust-binary/src/main.rs`,
      cargo_toml: `/flows/${name}/rust-binary/Cargo.toml`,
      binary: validation.binaryPath ? `/flows/${name}/rust-binary/target/release/${binaryName}` : null,
      app_bundle: appBundlePath || null,
      desktop_path: desktopPath || null,
      skill_manifest: `/flows/${name}/skill.json`,
    };
    await persistRunData(runPath, runData);

    logger.info('rust.compile_complete', {
      runId: run_id.slice(0, 8), success: validation.success,
      structName: compiled.structName, repairs: validation.check.repairs,
      miracleAchieved: validation.run?.miracleAchieved,
      buildMs: validation.build.wallClockMs,
      desktopPath: desktopPath || null,
    });

    const responsePayload = {
      success: validation.success,
      struct_name: compiled.structName,
      rust_source: validation.mainRs,
      check: validation.check,
      build: validation.build,
      run: validation.run || {},
      metrics,
      traces: validation.traces,
      paths: {
        source: `/flows/${name}/rust-binary/src/main.rs`,
        cargo_toml: `/flows/${name}/rust-binary/Cargo.toml`,
        binary: validation.binaryPath ? `/flows/${name}/rust-binary/target/release/${binaryName}` : null,
        app_bundle: appBundlePath ? `/flows/${name}/rust-binary/${binaryName}.app` : null,
        desktop: desktopPath || null,
        skill_manifest: `/flows/${name}/skill.json`,
      },
      progressionUpdate: {
        stage: 'rust',
        unlockedStages: ['idea', 'md', 'mmd', 'tla', 'ts', 'rust'],
        confidence: validation.success ? 0.99 : (validation.build.success ? 0.7 : 0.2),
      },
    };

    opseeq.reportStage(run_id, {
      stage: validation.success ? 'rust_complete' : 'rust_partial',
      struct_name: compiled.structName,
      build_success: validation.build.success,
      miracle_achieved: validation.run?.miracleAchieved,
      build_ms: validation.build.wallClockMs,
      desktop_path: desktopPath,
    });
    return validation.success
      ? res.json(responsePayload)
      : res.status(422).json(responsePayload);
  } catch (err) {
    logger.error('rust.compile_error', { error: err.message, stack: err.stack });
    opseeq.reportStage(run_id, { stage: 'rust_failed', error: err.message });
    return res.status(500).json({ success: false, error: 'Rust compilation failed', details: err.message });
  }
  } finally {
    provider.setTraceId(null);
  }
});

module.exports = router;
