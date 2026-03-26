'use strict';

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');

const logger = require('../utils/logger');
const { compileMarkdownArtifact } = require('../services/markdown-compiler');
const { compileTsxArchitectureScaffold } = require('../services/tsx-compiler');
const {
  FLOWS_DIR,
  loadRunData,
  persistRunData,
  extractFactsAndPlan,
  getOriginalInput,
  resolveDiagramName,
  loadCompiledMmd,
  loadCanonicalMarkdown,
} = require('../services/run-artifact-loader');

const router = Router();

router.get('/render/tsx/status', (_req, res) => {
  res.json({
    success: true,
    available: true,
    mode: 'deterministic-template',
  });
});

router.post('/render/tsx', async (req, res) => {
  const { run_id, diagram_name } = req.body || {};

  if (!run_id) {
    return res.status(400).json({ success: false, error: 'run_id is required' });
  }

  try {
    const { runPath, runData } = await loadRunData(run_id);
    const { facts, plan } = extractFactsAndPlan(runData);
    const name = diagram_name || resolveDiagramName(runData, 'architecture');
    const outputDir = path.join(FLOWS_DIR, name, 'tsx-app');
    const srcDir = path.join(outputDir, 'src');
    await fsp.mkdir(srcDir, { recursive: true });

    const mmdSource = await loadCompiledMmd(runData, name);
    const originalSource = getOriginalInput(runData);
    let markdownSource = await loadCanonicalMarkdown(runData, name);

    if (!markdownSource) {
      markdownSource = compileMarkdownArtifact({
        diagramName: name,
        inputMode: runData?.request?.input_mode || 'idea',
        originalSource,
        facts,
        plan,
        mmdSource,
      }).markdownSource;
    }

    const markdownPath = `/flows/${name}/architecture.md`;
    const compiled = compileTsxArchitectureScaffold({
      diagramName: name,
      title: name,
      summary: markdownSource.split('\n').find((line) => line.trim() && !line.startsWith('#')) || 'Architecture scaffold',
      markdownPath,
      facts: facts || { entities: [], relationships: [], boundaries: [], failurePaths: [] },
      plan: plan || { nodes: [], edges: [], subgraphs: [] },
    });

    await Promise.all([
      fsp.writeFile(path.join(srcDir, 'App.tsx'), compiled.appSource, 'utf8'),
      fsp.writeFile(path.join(srcDir, 'spec.ts'), compiled.specSource, 'utf8'),
      fsp.writeFile(path.join(srcDir, 'index.css'), compiled.styleSource, 'utf8'),
      fsp.writeFile(path.join(outputDir, 'architecture.manifest.json'), JSON.stringify(compiled.manifest, null, 2), 'utf8'),
    ]);

    runData.tsx_artifacts = {
      app: `/flows/${name}/tsx-app/src/App.tsx`,
      spec: `/flows/${name}/tsx-app/src/spec.ts`,
      style: `/flows/${name}/tsx-app/src/index.css`,
      manifest: `/flows/${name}/tsx-app/architecture.manifest.json`,
    };
    runData.tsx_metrics = compiled.metrics;
    await persistRunData(runPath, runData);

    logger.info('tsx.compile_complete', {
      runId: run_id.slice(0, 8),
      diagramName: name,
      components: compiled.metrics.componentCount,
      boundaries: compiled.metrics.boundaryCount,
    });

    return res.json({
      success: true,
      markdown_source: markdownSource,
      manifest: compiled.manifest,
      app_source: compiled.appSource,
      spec_source: compiled.specSource,
      style_source: compiled.styleSource,
      metrics: compiled.metrics,
      paths: {
        app: `/flows/${name}/tsx-app/src/App.tsx`,
        spec: `/flows/${name}/tsx-app/src/spec.ts`,
        style: `/flows/${name}/tsx-app/src/index.css`,
        manifest: `/flows/${name}/tsx-app/architecture.manifest.json`,
      },
      progressionUpdate: {
        stage: 'tsx',
        unlockedStages: ['idea', 'md', 'mmd', 'tsx', 'tla'],
        nextRecommended: 'tla',
        confidence: 0.92,
      },
    });
  } catch (err) {
    logger.error('tsx.compile_error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      error: 'TSX scaffold generation failed',
      details: err.message,
    });
  }
});

module.exports = router;
