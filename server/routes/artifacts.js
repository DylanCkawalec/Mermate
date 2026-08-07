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
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const VERSION_STAGES = ['idea', 'md', 'mmd', 'tla', 'ts'];
const SNAPSHOT_KEEP_PER_STAGE = 15;

const router = Router();

async function _readSafe(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

// ---- Per-tab version control ---------------------------------------------
// Two origins unified in one per-stage list:
//   run  — system versions from runs/*.json lineage (idea + mmd are fully
//          reconstructable; tla/ts when final_artifact carries sources)
//   edit — debounced snapshots in flows/<name>/versions/<ts>.<stage>.md
// Run lineage is immutable: deleting a run version means deleting the
// diagram (existing sidebar flow). Snapshots are individually deletable.

function _versionsDir(diagram) {
  // Prevent path escape; diagram names are slugs but never trust input.
  const safe = path.basename(diagram);
  return path.join(FLOWS_DIR, safe, 'versions');
}

async function _listSnapshots(diagram) {
  const dir = _versionsDir(diagram);
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2}T[\d.-]+Z)\.(\w+)\.md$/);
    if (!m || !VERSION_STAGES.includes(m[2])) continue;
    let chars = 0;
    try { chars = (await fsp.stat(path.join(dir, f))).size; } catch { /* skip */ }
    out.push({ id: `snap:${f}`, ts: m[1], stage: m[2], origin: 'edit', chars });
  }
  return out;
}

async function _listRunVersions(diagram) {
  let files = [];
  try { files = await fsp.readdir(RUNS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.trace.')) continue;
    let run;
    try { run = JSON.parse(await fsp.readFile(path.join(RUNS_DIR, f), 'utf8')); } catch { continue; }
    const name = run?.request?.user_diagram_name || run?.final_artifact?.diagram_name;
    if (name !== diagram) continue;
    const ts = run.created_at || null;
    const runId = run.run_id || f.replace('.json', '');
    const idea = run?.request?.user_input;
    if (typeof idea === 'string' && idea.trim()) {
      out.push({ id: `run:${runId}:idea`, ts, stage: 'idea', origin: 'run', run_id: runId, chars: idea.length });
    }
    const mmd = run?.final_artifact?.mmd_source;
    if (typeof mmd === 'string' && mmd.trim()) {
      out.push({ id: `run:${runId}:mmd`, ts, stage: 'mmd', origin: 'run', run_id: runId, chars: mmd.length });
    }
    for (const stage of ['tla', 'ts']) {
      const src = run?.final_artifact?.[`${stage}_source`];
      if (typeof src === 'string' && src.trim()) {
        out.push({ id: `run:${runId}:${stage}`, ts, stage, origin: 'run', run_id: runId, chars: src.length });
      }
    }
  }
  return out;
}

router.get('/versions/:diagram', async (req, res) => {
  try {
    const diagram = req.params.diagram;
    const all = [...await _listRunVersions(diagram), ...await _listSnapshots(diagram)];
    const stages = {};
    for (const s of VERSION_STAGES) stages[s] = [];
    for (const v of all) {
      if (v.ts) stages[v.stage].push(v);
    }
    for (const s of VERSION_STAGES) {
      stages[s].sort((a, b) => (a.ts < b.ts ? 1 : -1));
      stages[s] = stages[s].slice(0, 30);
    }
    res.json({ success: true, diagram, stages });
  } catch (err) {
    logger.error('versions.list_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'version_list_failed' });
  }
});

router.get('/versions/:diagram/content', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    if (id.startsWith('snap:')) {
      const file = path.basename(id.slice(5));
      const content = await _readSafe(path.join(_versionsDir(req.params.diagram), file));
      if (content == null) return res.status(404).json({ success: false, error: 'version not found' });
      return res.json({ success: true, content });
    }
    const m = id.match(/^run:([0-9a-f-]+):(idea|mmd|tla|ts)$/);
    if (!m) return res.status(400).json({ success: false, error: 'invalid version id' });
    const run = JSON.parse(await fsp.readFile(path.join(RUNS_DIR, `${m[1]}.json`), 'utf8'));
    const content = m[2] === 'idea'
      ? run?.request?.user_input
      : run?.final_artifact?.[`${m[2]}_source`];
    if (typeof content !== 'string') return res.status(404).json({ success: false, error: 'version not found' });
    res.json({ success: true, content });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'version not found' });
    logger.error('versions.content_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'version_content_failed' });
  }
});

router.post('/versions/:diagram/snapshot', async (req, res) => {
  try {
    const { stage, content } = req.body || {};
    if (!VERSION_STAGES.includes(stage)) return res.status(400).json({ success: false, error: 'invalid stage' });
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ success: false, error: 'content required' });
    if (content.length > 500_000) return res.status(413).json({ success: false, error: 'content too large' });
    const dir = _versionsDir(req.params.diagram);
    await fsp.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString();
    const file = `${ts.replace(/:/g, '-')}.${stage}.md`;
    await fsp.writeFile(path.join(dir, file), content, 'utf8');
    // Ring buffer: prune oldest beyond KEEP per stage
    const snaps = (await _listSnapshots(req.params.diagram)).filter(s => s.stage === stage);
    snaps.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    for (const old of snaps.slice(SNAPSHOT_KEEP_PER_STAGE)) {
      await fsp.unlink(path.join(dir, old.id.slice(5))).catch(() => {});
    }
    res.json({ success: true, id: `snap:${file}`, ts });
  } catch (err) {
    logger.error('versions.snapshot_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'snapshot_failed' });
  }
});

router.delete('/versions/:diagram/snapshot/:file', async (req, res) => {
  try {
    const file = path.basename(req.params.file);
    if (!/^\d{4}-\d{2}-\d{2}T[\d.:-]+Z\.\w+\.md$/.test(file)) {
      return res.status(400).json({ success: false, error: 'invalid snapshot id' });
    }
    await fsp.unlink(path.join(_versionsDir(req.params.diagram), file));
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'snapshot not found' });
    logger.error('versions.delete_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'delete_failed' });
  }
});

router.get('/artifacts/:run_id', async (req, res) => {
  const { run_id } = req.params;

  if (!run_id || run_id.length < 8 || !require('../utils/naming').safeSegment(run_id)) {
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
  // NOTE: run-tracker records agent calls hash-only (prompt_hash + token
  // estimates — no raw payloads, by design), so fact/plan text is not
  // reconstructable from lineage. Reported as unavailable by design.
  stages.architecture = {
    available: false,
    facts: null,
    plan: null,
    note: 'agent call payloads are hash-only by design (run-tracker)',
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
