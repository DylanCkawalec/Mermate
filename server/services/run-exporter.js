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
const DEFAULT_DUMP_DIR = path.resolve(require('node:os').homedir(), 'Desktop', 'MERMATE', 'dumps');
const DUMP_DIR = process.env.MERMATE_DUMP_DIR || DEFAULT_DUMP_DIR;
const RETENTION_DAYS = parseInt(process.env.MERMATE_DUMP_RETENTION_DAYS || '30', 10);

// Warn once at startup if MERMATE_DUMP_DIR points outside the writable home tree.
// Silent failures here are a major debugging trap when dumps don't appear.
let _warnedDumpDir = false;
function _warnIfUnsafeDumpDir() {
  if (_warnedDumpDir) return;
  _warnedDumpDir = true;
  const home = require('node:os').homedir();
  if (!DUMP_DIR.startsWith(home)) {
    logger.warn('run_exporter.unsafe_dump_dir', {
      dump_dir: DUMP_DIR,
      home,
      hint: 'MERMATE_DUMP_DIR is outside the user home tree. Mermate may not have write permission. Set MERMATE_DUMP_DIR to a path under your home directory.',
    });
  }
}

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

  _warnIfUnsafeDumpDir();
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

    if (runData.specula_artifacts) {
      const speculaDump = path.join(dumpPath, 'specula');
      await fsp.mkdir(speculaDump, { recursive: true }).catch(() => {});
      const speculaCopies = await Promise.all(
        Object.entries(runData.specula_artifacts).map(async ([, relPath]) => {
          if (!relPath || typeof relPath !== 'string') return null;
          const absPath = path.join(PROJECT_ROOT, relPath.replace(/^\//, ''));
          const basename = path.basename(relPath);
          const ok = await _safeCopy(absPath, path.join(speculaDump, basename));
          return ok ? `specula/${basename}` : null;
        }),
      );
      for (const entry of speculaCopies) {
        if (entry) copied.push(entry);
      }
    }

    // Three labeled outcomes — the canonical Mermate output set.
    // Each entry only appears when its artifacts exist on disk.
    const outcomes = [];

    if (diagramName) {
      outcomes.push({
        artifact_type: 'architecture_diagram',
        diagram_name: diagramName,
        files: {
          mmd: copied.includes('diagram.mmd') ? `dumps/${runId}/diagram.mmd` : null,
          svg: copied.includes('diagram.svg') ? `dumps/${runId}/diagram.svg` : null,
          png: copied.includes('diagram.png') ? `dumps/${runId}/diagram.png` : null,
        },
        metrics: runData.final_artifact?.metrics || null,
        depth_tier: runData.controller?.depth_tier || null,
      });
    }

    if (runData.tla_artifacts?.tla) {
      outcomes.push({
        artifact_type: 'tla_specification',
        module_name: runData.tla_metrics?.module_name || null,
        files: {
          tla: copied.includes('spec.tla') ? `dumps/${runId}/spec.tla` : null,
          cfg: copied.includes('spec.cfg') ? `dumps/${runId}/spec.cfg` : null,
        },
        metrics: runData.tla_metrics || null,
      });
    }

    if (runData.ts_artifacts?.source) {
      outcomes.push({
        artifact_type: 'typescript_runtime',
        class_name: runData.ts_metrics?.class_name || null,
        files: {
          source: copied.includes('runtime.ts') ? `dumps/${runId}/runtime.ts` : null,
          harness: copied.includes('runtime.harness.ts') ? `dumps/${runId}/runtime.harness.ts` : null,
        },
        metrics: runData.ts_metrics || null,
      });
    }

    if (runData.tsx_artifacts?.app) {
      outcomes.push({
        artifact_type: 'tsx_scaffold',
        diagram_name: diagramName,
        files: {
          app: runData.tsx_artifacts.app,
          spec: runData.tsx_artifacts.spec,
          manifest: runData.tsx_artifacts.manifest,
        },
        metrics: runData.tsx_metrics || null,
      });
    }

    // Axiomatic dump manifest. Order is intentional — top-level scannable
    // identity first (run_id, schema_version, tags), then sequenced
    // lifecycle, then composition, then sum_check, then materialized
    // outcomes. A consumer should be able to answer most questions from
    // the first ~40 lines without descending into agent_calls.
    const manifest = {
      // -- Identity --------------------------------------------------------
      run_id: runId,
      schema_version: runData.schema_version || '1.0.0',
      exported_at: new Date().toISOString(),
      status: runData.status,
      diagram_name: runData.final_artifact?.diagram_name || null,

      // -- Tags (flat scannable labels) ------------------------------------
      tags: runData.tags || null,

      // -- Lifecycle (ordered phases) --------------------------------------
      lifecycle: runData.lifecycle || null,

      // -- Composition (architecture instance combination metric) ----------
      composition: runData.composition || null,

      // -- Sum check (single-glance integrity verdict) ---------------------
      sum_check: runData.sum_check || null,

      // -- Routing decisions ----------------------------------------------
      pipeline: runData.controller?.pipeline || null,
      depth_score: runData.controller?.depth_score ?? null,
      depth_tier: runData.controller?.depth_tier ?? null,
      opseeq_session_id: runData.opseeq_session_id || null,

      // -- Outcomes (materialized artifacts on disk) ----------------------
      outcomes,

      // -- Coarse stats ----------------------------------------------------
      agent_calls: runData.agent_calls?.length || 0,
      total_cost: runData.totals?.total_cost_est || 0,
      wall_clock_ms: runData.totals?.wall_clock_ms || 0,
      artifacts: copied,

      // -- Downstream module metrics (preserved for backward compat) ------
      tla_metrics: runData.tla_metrics || null,
      ts_metrics: runData.ts_metrics || null,
      tsx_metrics: runData.tsx_metrics || null,
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
