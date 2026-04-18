'use strict';

/**
 * Trace route — stage event ingest and readback.
 *
 * POST /api/mermate/stage   — append a stage event to a run trace
 * GET  /api/mermate/trace/:run_id — read back the full trace for a run
 * GET  /api/mermate/trace-stats   — summary of in-memory trace store
 */

const { Router } = require('express');
const traceStore = require('../services/trace-store');

const router = Router();

router.post('/mermate/stage', (req, res) => {
  const { run_id, ...event } = req.body || {};
  if (!run_id) return res.status(400).json({ success: false, error: 'run_id is required' });
  traceStore.append(run_id, event);
  return res.json({ success: true, stored: true });
});

router.get('/mermate/trace/:run_id', async (req, res) => {
  const { run_id } = req.params;
  const events = await traceStore.load(run_id);
  return res.json({
    success: true,
    run_id,
    events,
    count: events.length,
  });
});

router.get('/mermate/trace-stats', (_req, res) => {
  return res.json({ success: true, ...traceStore.stats() });
});

module.exports = router;
