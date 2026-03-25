'use strict';

/**
 * Run Exporter — mirrors completed run artifacts to the MERMATE dump directory.
 *
 * After every finalized run, exports:
 *   - run JSON (complete lineage)
 *   - compiled .mmd, .tla, .cfg, .ts, .harness.ts
 *   - rendered SVG and PNG
 *   - manifest.json summarizing all artifacts
 *
 * Export is fire-and-forget — failures are logged but never block the pipeline.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DUMP_DIR = process.env.MERMATE_DUMP_DIR
  || path.resolve(require('node:os').homedir(), 'Desktop', 'MERMATE', 'dumps');
const RETENTION_DAYS = parseInt(process.env.MERMATE_DUMP_RETENTION_DAYS || '30', 10);

async function _safeCopy(src, dest) {
  try {
    await fsp.copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

async function exportRun(runId, runData) {
  if (!runData || !runId) return;

  const dumpPath = path.join(DUMP_DIR, runId);

  try {
    await fsp.mkdir(dumpPath, { recursive: true });

    await fsp.writeFile(
      path.join(dumpPath, 'run.json'),
      JSON.stringify(runData, null, 2),
      'utf8',
    );

    const copied = [];
    const diagramName = runData.final_artifact?.diagram_name;

    if (diagramName) {
      const flowDir = path.join(PROJECT_ROOT, 'flows', diagramName);

      const pairs = [
        [`${diagramName}.mmd`, 'diagram.mmd'],
        [`${diagramName}.svg`, 'diagram.svg'],
        [`${diagramName}.png`, 'diagram.png'],
      ];
      for (const [src, dest] of pairs) {
        if (await _safeCopy(path.join(flowDir, src), path.join(dumpPath, dest))) {
          copied.push(dest);
        }
      }
    }

    if (runData.tla_artifacts?.tla) {
      const tlaPath = path.join(PROJECT_ROOT, runData.tla_artifacts.tla.replace(/^\//, ''));
      if (await _safeCopy(tlaPath, path.join(dumpPath, 'spec.tla'))) copied.push('spec.tla');
    }
    if (runData.tla_artifacts?.cfg) {
      const cfgPath = path.join(PROJECT_ROOT, runData.tla_artifacts.cfg.replace(/^\//, ''));
      if (await _safeCopy(cfgPath, path.join(dumpPath, 'spec.cfg'))) copied.push('spec.cfg');
    }

    if (runData.ts_artifacts?.source) {
      const tsPath = path.join(PROJECT_ROOT, runData.ts_artifacts.source.replace(/^\//, ''));
      if (await _safeCopy(tsPath, path.join(dumpPath, 'runtime.ts'))) copied.push('runtime.ts');
    }
    if (runData.ts_artifacts?.harness) {
      const hPath = path.join(PROJECT_ROOT, runData.ts_artifacts.harness.replace(/^\//, ''));
      if (await _safeCopy(hPath, path.join(dumpPath, 'runtime.harness.ts'))) copied.push('runtime.harness.ts');
    }

    const manifest = {
      run_id: runId,
      exported_at: new Date().toISOString(),
      status: runData.status,
      pipeline: runData.controller?.pipeline,
      diagram_name: runData.final_artifact?.diagram_name,
      agent_calls: runData.agent_calls?.length || 0,
      total_cost: runData.totals?.total_cost_est || 0,
      wall_clock_ms: runData.totals?.wall_clock_ms || 0,
      artifacts: copied,
      tla_metrics: runData.tla_metrics || null,
      ts_metrics: runData.ts_metrics || null,
    };

    await fsp.writeFile(
      path.join(dumpPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    logger.info('run_exporter.exported', {
      runId: runId.slice(0, 8),
      artifacts: copied.length,
      path: dumpPath,
    });
  } catch (err) {
    logger.warn('run_exporter.error', { runId: runId.slice(0, 8), error: err.message });
  }
}

async function cleanup() {
  try {
    await fsp.mkdir(DUMP_DIR, { recursive: true });
    const entries = await fsp.readdir(DUMP_DIR, { withFileTypes: true });
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(DUMP_DIR, entry.name);
      try {
        const stat = await fsp.stat(dirPath);
        if (stat.mtimeMs < cutoff) {
          await fsp.rm(dirPath, { recursive: true, force: true });
          removed++;
        }
      } catch { /* skip */ }
    }

    if (removed > 0) {
      logger.info('run_exporter.cleanup', { removed, retentionDays: RETENTION_DAYS });
    }
  } catch { /* dump dir may not exist */ }
}

module.exports = { exportRun, cleanup, DUMP_DIR };
