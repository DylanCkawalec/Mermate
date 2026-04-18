'use strict';

/**
 * Artifacts Route — stage-based artifact extraction for any completed run.
 *
 * GET /api/artifacts/:run_id
 *   Returns all stage outputs for a given run as first-class deliverables:
 *   - Original input (simple idea)
 *   - Enhanced markdown spec
 *   - Compiled Mermaid source (.mmd)
 *   - TLA+ specification (.tla + .cfg)
 *   - TypeScript runtime (.ts + harness)
 *   - Rendered diagram paths (SVG/PNG)
 *   - Run lineage JSON
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');

const router = Router();

async function _readSafe(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

router.get('/artifacts/:run_id', async (req, res) => {
  const { run_id } = req.params;

  if (!run_id || run_id.length < 8) {
    return res.status(400).json({ success: false, error: 'Invalid run_id' });
  }

  const runPath = path.join(RUNS_DIR, `${run_id}.json`);
  let runData;
  try {
    const raw = await fsp.readFile(runPath, 'utf8');
    runData = JSON.parse(raw);
  } catch {
    return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
  }

  const diagramName = runData.final_artifact?.diagram_name;
  const flowDir = diagramName ? path.join(PROJECT_ROOT, 'flows', diagramName) : null;

  const stages = {};

  // Stage 1: Simple Idea (original input)
  stages.idea = {
    available: !!runData.request?.user_input,
    content: runData.request?.user_input || null,
    inputMode: runData.request?.input_mode || null,
  };

  // Stage 2: Facts + Plan (typed architecture)
  let facts = null;
  let plan = null;
  for (const call of (runData.agent_calls || [])) {
    if (call.stage === 'fact_extraction' && call.success) {
      try { facts = JSON.parse(call.output_text); } catch { /* skip */ }
    }
    if (call.stage === 'diagram_plan' && call.success) {
      try { plan = JSON.parse(call.output_text); } catch { /* skip */ }
    }
  }
  stages.architecture = {
    available: !!(facts?.entities?.length),
    facts: facts || null,
    plan: plan || null,
    entityCount: facts?.entities?.length || 0,
    relationshipCount: facts?.relationships?.length || 0,
    failurePathCount: facts?.failurePaths?.length || 0,
  };

  // Stage 3: Mermaid Diagram
  let mmdSource = null;
  if (flowDir && diagramName) {
    mmdSource = await _readSafe(path.join(flowDir, `${diagramName}.mmd`));
    if (!mmdSource) {
      mmdSource = await _readSafe(path.join(PROJECT_ROOT, 'archs', `${diagramName}.compiled.mmd`));
    }
  }
  stages.mermaid = {
    available: !!mmdSource,
    source: mmdSource,
    diagramName,
    diagramType: runData.final_artifact?.diagram_type || null,
    metrics: runData.final_artifact?.metrics || null,
    paths: diagramName ? {
      svg: `/flows/${diagramName}/${diagramName}.svg`,
      png: `/flows/${diagramName}/${diagramName}.png`,
      mmd: `/flows/${diagramName}/${diagramName}.mmd`,
    } : null,
  };

  // Stage 4: TLA+ Specification
  let tlaSource = null;
  let cfgSource = null;
  if (runData.tla_artifacts?.tla) {
    tlaSource = await _readSafe(path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, '')));
  }
  if (runData.tla_artifacts?.cfg) {
    cfgSource = await _readSafe(path.join(PROJECT_ROOT, runData.tla_artifacts.cfg.replace(/^\//, '')));
  }
  stages.tla = {
    available: !!tlaSource,
    source: tlaSource,
    cfg: cfgSource,
    metrics: runData.tla_metrics || null,
    paths: runData.tla_artifacts || null,
  };

  // Stage 5: TypeScript Runtime
  let tsSource = null;
  let harnessSource = null;
  if (runData.ts_artifacts?.source) {
    tsSource = await _readSafe(path.join(PROJECT_ROOT, runData.ts_artifacts.source.replace(/^\//, '')));
  }
  if (runData.ts_artifacts?.harness) {
    harnessSource = await _readSafe(path.join(PROJECT_ROOT, runData.ts_artifacts.harness.replace(/^\//, '')));
  }
  stages.typescript = {
    available: !!tsSource,
    source: tsSource,
    harness: harnessSource,
    metrics: runData.ts_metrics || null,
    paths: runData.ts_artifacts || null,
  };

  // Run lineage summary
  const lineage = {
    run_id: runData.run_id,
    status: runData.status,
    pipeline: runData.controller?.pipeline,
    created_at: runData.created_at,
    completed_at: runData.completed_at,
    agent_calls: runData.agent_calls?.length || 0,
    totals: runData.totals || null,
    warnings: runData.warnings || [],
  };

  return res.json({
    success: true,
    run_id,
    stages,
    lineage,
    stagesAvailable: Object.entries(stages).filter(([, v]) => v.available).map(([k]) => k),
  });
});

module.exports = router;
