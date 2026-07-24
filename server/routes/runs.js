'use strict';

/**
 * Runs route — query interfaces for Mermate run lineage.
 *
 *   GET /api/runs                       List the most recent runs
 *   GET /api/runs/:run_id               Full run JSON (loaded from disk if not in memory)
 *   GET /api/runs/:run_id/summary       Per-stage agent-call summary for Opseeq Studio
 *
 * All endpoints are read-only and safe to call from external orchestrators.
 */

const { Router } = require('express');
const runTracker = require('../services/run-tracker');
const logger = require('../utils/logger');

const router = Router();

router.get('/runs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const runIds = await runTracker.listRuns({ limit });
  return res.json({ success: true, run_ids: runIds });
});

router.get('/runs/:run_id', async (req, res) => {
  const { run_id } = req.params;
  if (!run_id) return res.status(400).json({ success: false, error: 'run_id required' });

  let manifest = runTracker.getManifest(run_id);
  if (!manifest) manifest = await runTracker.loadRun(run_id);
  if (!manifest) return res.status(404).json({ success: false, error: `Run ${run_id} not found` });

  return res.json({ success: true, run: manifest });
});

router.get('/runs/:run_id/summary', async (req, res) => {
  const { run_id } = req.params;
  if (!run_id) return res.status(400).json({ success: false, error: 'run_id required' });

  // First try in-memory (live runs)
  let summary = runTracker.summarizeAgentCalls(run_id);

  // Fall back to disk for completed runs
  if (!summary) {
    try {
      const m = await runTracker.loadRun(run_id);
      if (!m) return res.status(404).json({ success: false, error: `Run ${run_id} not found` });

      const byStage = {};
      let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0, totalLatency = 0;

      for (const call of (m.agent_calls || [])) {
        const stage = call.stage || 'unknown';
        if (!byStage[stage]) {
          byStage[stage] = { count: 0, success: 0, failed: 0, tokens_in: 0, tokens_out: 0, cost_est: 0, latency_ms: 0, providers: {} };
        }
        const s = byStage[stage];
        s.count += 1;
        if (call.success) s.success += 1; else s.failed += 1;
        s.tokens_in += call.prompt_tokens_est || 0;
        s.tokens_out += call.output_tokens_est || 0;
        s.cost_est += call.cost_est || 0;
        s.latency_ms += call.latency_ms || 0;
        const prov = call.provider || 'unknown';
        s.providers[prov] = (s.providers[prov] || 0) + 1;

        totalTokensIn += call.prompt_tokens_est || 0;
        totalTokensOut += call.output_tokens_est || 0;
        totalCost += call.cost_est || 0;
        totalLatency += call.latency_ms || 0;
      }
      for (const s of Object.values(byStage)) s.cost_est = +s.cost_est.toFixed(6);

      summary = {
        run_id,
        status: m.status,
        tags: m.tags || null,
        depth_score: m.controller?.depth_score ?? null,
        depth_tier: m.controller?.depth_tier ?? null,
        pipeline: m.controller?.pipeline ?? null,
        opseeq_session_id: m.opseeq_session_id || null,
        lifecycle: m.lifecycle || null,
        composition: m.composition || null,
        sum_check: m.sum_check || null,
        totals: {
          agent_calls: (m.agent_calls || []).length,
          tokens_in: totalTokensIn,
          tokens_out: totalTokensOut,
          cost_est: +totalCost.toFixed(6),
          latency_ms: totalLatency,
        },
        by_stage: byStage,
      };
    } catch (err) {
      logger.warn('runs.summary_load_failed', { run_id, error: err.message });
      return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
    }
  }

  return res.json({ success: true, summary });
});

router.get('/runs/:run_id/trace', async (req, res) => {
  const { run_id } = req.params;
  if (!run_id) return res.status(400).json({ success: false, error: 'run_id required' });

  let manifest = runTracker.getManifest(run_id);
  if (!manifest) manifest = await runTracker.loadRun(run_id);
  if (!manifest) return res.status(404).json({ success: false, error: `Run ${run_id} not found` });

  let trace = runTracker.getTrace(run_id, manifest);
  if (!trace) {
    // Fallback: build a best-effort trace from loaded manifest fields
    trace = {
      run_id: manifest.run_id,
      status: manifest.status,
      created_at: manifest.created_at,
      completed_at: manifest.completed_at,
      tags: manifest.tags || null,
      phases: manifest.lifecycle?.phases || [],
      calls: manifest.agent_calls || [],
      rate_events: manifest.rate_events || [],
      totals: manifest.totals || null,
      sum_check: manifest.sum_check || null,
      note: 'trace computed from archived manifest; tab enrichment unavailable',
    };
  }
  if (!trace) return res.status(404).json({ success: false, error: `Trace for ${run_id} not available` });

  return res.json({ success: true, trace });
});

module.exports = router;
