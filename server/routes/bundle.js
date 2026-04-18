'use strict';

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
const { DUMP_DIR } = require('../services/run-exporter');

const router = Router();

async function _tryRead(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch {
    return null;
  }
}

async function _dirExists(dirPath) {
  try {
    const stat = await fsp.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function _bundleFromDump(dumpPath) {
  const manifestRaw = await _tryRead(path.join(dumpPath, 'manifest.json'));
  const manifest = manifestRaw ? JSON.parse(manifestRaw.toString()) : {};
  const diagramName = manifest.diagram_name || 'diagram';

  const files = {};
  const artifactMap = {
    'diagram.mmd':        `${diagramName}/diagram.mmd`,
    'diagram.svg':        `${diagramName}/diagram.svg`,
    'diagram.png':        `${diagramName}/diagram.png`,
    'spec.tla':           `${diagramName}/spec/MC.tla`,
    'spec.cfg':           `${diagramName}/spec/spec.cfg`,
    'runtime.ts':         `${diagramName}/src/index.ts`,
    'runtime.harness.ts': `${diagramName}/src/harness.ts`,
    'manifest.json':      `${diagramName}/manifest.json`,
    'run.json':           `${diagramName}/run.json`,
  };

  for (const [local, zipPath] of Object.entries(artifactMap)) {
    const data = await _tryRead(path.join(dumpPath, local));
    if (data) files[zipPath] = data.toString('base64');
  }

  const speculaDir = path.join(dumpPath, 'specula');
  try {
    const speculaFiles = await fsp.readdir(speculaDir);
    const speculaReads = await Promise.all(speculaFiles.map(async (f) => {
      const data = await _tryRead(path.join(speculaDir, f));
      return data ? { f, data } : null;
    }));
    for (const row of speculaReads) {
      if (row) files[`${diagramName}/spec/${row.f}`] = row.data.toString('base64');
    }
  } catch { /* no specula dir */ }

  return { diagramName, files, manifest };
}

async function _bundleFromLive(runId) {
  const runPath = path.join(RUNS_DIR, `${runId}.json`);
  const runRaw = await _tryRead(runPath);
  if (!runRaw) return null;

  const runData = JSON.parse(runRaw.toString());
  const diagramName = runData.final_artifact?.diagram_name
    || runData.user_request?.diagram_name
    || runData.request?.user_diagram_name
    || 'diagram';

  const flowDir = path.join(PROJECT_ROOT, 'flows', diagramName);
  const files = {};

  const flowFiles = {
    [`${diagramName}.mmd`]: `${diagramName}/diagram.mmd`,
    [`${diagramName}.svg`]: `${diagramName}/diagram.svg`,
    [`${diagramName}.png`]: `${diagramName}/diagram.png`,
  };
  for (const [src, zipPath] of Object.entries(flowFiles)) {
    const data = await _tryRead(path.join(flowDir, src));
    if (data) files[zipPath] = data.toString('base64');
  }

  if (runData.tla_artifacts?.tla) {
    const tlaPath = path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, ''));
    const data = await _tryRead(tlaPath);
    if (data) files[`${diagramName}/spec/MC.tla`] = data.toString('base64');
  }
  if (runData.tla_artifacts?.cfg) {
    const cfgPath = path.join(PROJECT_ROOT, runData.tla_artifacts.cfg.replace(/^\//, ''));
    const data = await _tryRead(cfgPath);
    if (data) files[`${diagramName}/spec/spec.cfg`] = data.toString('base64');
  }
  if (runData.tla_artifacts?.trace) {
    const tracePath = path.join(PROJECT_ROOT, runData.tla_artifacts.trace.replace(/^\//, ''));
    const data = await _tryRead(tracePath);
    if (data) files[`${diagramName}/spec/Trace.tla`] = data.toString('base64');
  }

  if (runData.ts_artifacts?.source) {
    const tsPath = path.join(PROJECT_ROOT, runData.ts_artifacts.source.replace(/^\//, ''));
    const data = await _tryRead(tsPath);
    if (data) files[`${diagramName}/src/index.ts`] = data.toString('base64');
  }
  if (runData.ts_artifacts?.harness) {
    const hPath = path.join(PROJECT_ROOT, runData.ts_artifacts.harness.replace(/^\//, ''));
    const data = await _tryRead(hPath);
    if (data) files[`${diagramName}/src/harness.ts`] = data.toString('base64');
  }

  const speculaDir = path.join(flowDir, 'specula');
  const speculaBasenames = new Set();
  try {
    const speculaFiles = await fsp.readdir(speculaDir);
    const speculaReads = await Promise.all(speculaFiles.map(async (f) => {
      const data = await _tryRead(path.join(speculaDir, f));
      return data ? { f, data } : null;
    }));
    for (const row of speculaReads) {
      if (row) {
        speculaBasenames.add(row.f);
        files[`${diagramName}/spec/${row.f}`] = row.data.toString('base64');
      }
    }
  } catch { /* no specula dir */ }

  if (runData.specula_artifacts) {
    const artifactReads = await Promise.all(
      Object.entries(runData.specula_artifacts).map(async ([key, relPath]) => {
        if (!relPath || typeof relPath !== 'string') return null;
        const basename = path.basename(relPath);
        if (speculaBasenames.has(basename)) return null;
        const absPath = path.join(PROJECT_ROOT, relPath.replace(/^\//, ''));
        const data = await _tryRead(absPath);
        return data ? { basename, data } : null;
      }),
    );
    for (const row of artifactReads) {
      if (row) files[`${diagramName}/spec/${row.basename}`] = row.data.toString('base64');
    }
  }

  files[`${diagramName}/run.json`] = Buffer.from(JSON.stringify(runData, null, 2)).toString('base64');

  const manifest = {
    run_id: runId,
    exported_at: new Date().toISOString(),
    status: runData.status || 'live',
    diagram_name: diagramName,
    tla_metrics: runData.tla_metrics || null,
    ts_metrics: runData.ts_metrics || null,
    artifacts: Object.keys(files).map(p => p.replace(`${diagramName}/`, '')),
  };
  files[`${diagramName}/manifest.json`] = Buffer.from(JSON.stringify(manifest, null, 2)).toString('base64');

  return { diagramName, files, manifest };
}

function _generateReadme(diagramName, manifest) {
  return [
    `# ${diagramName}`,
    '',
    `Generated by MERMATE on ${new Date().toISOString().split('T')[0]}`,
    '',
    '## Pipeline',
    '',
    `- **Artifacts**: ${(manifest.artifacts || []).join(', ')}`,
    manifest.tla_metrics ? `- **TLA+ variables**: ${manifest.tla_metrics.variableCount || '?'}, **actions**: ${manifest.tla_metrics.actionCount || '?'}` : '',
    manifest.ts_metrics ? `- **TypeScript**: compile ${manifest.ts_metrics.compile_ok ? 'pass' : 'fail'}, tests ${manifest.ts_metrics.tests_ok ? 'pass' : 'fail'}` : '',
    '',
    '## Structure',
    '',
    '```',
    `${diagramName}/`,
    '  diagram.mmd       # Mermaid architecture source',
    '  diagram.svg        # Rendered SVG',
    '  diagram.png        # Rendered PNG',
    '  spec/',
    '    MC.tla           # TLA+ model-checking specification',
    '    spec.cfg         # TLC configuration',
    '  src/',
    '    index.ts         # TypeScript runtime',
    '    harness.ts       # Test harness',
    '  manifest.json      # Build metadata',
    '```',
  ].filter(Boolean).join('\n');
}

router.get('/runs/:runId/bundle', async (req, res) => {
  const { runId } = req.params;
  if (!runId || runId.includes('..')) {
    return res.status(400).json({ success: false, error: 'invalid run_id' });
  }

  try {
    let result = null;

    const dumpPath = path.join(DUMP_DIR, runId);
    if (await _dirExists(dumpPath)) {
      result = await _bundleFromDump(dumpPath);
    }

    if (!result || Object.keys(result.files).length === 0) {
      result = await _bundleFromLive(runId);
    }

    if (!result || Object.keys(result.files).length === 0) {
      return res.status(404).json({ success: false, error: 'no artifacts found for this run' });
    }

    const { diagramName, files, manifest } = result;
    files[`${diagramName}/README.md`] = Buffer.from(_generateReadme(diagramName, manifest)).toString('base64');

    return res.json({ success: true, diagram_name: diagramName, files, manifest });
  } catch (err) {
    logger.error('bundle.error', { runId, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
