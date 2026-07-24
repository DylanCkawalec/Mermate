'use strict';

/**
 * Specula Engine API — exposes the pinned Specula submodule to the rest of the
 * Mermate server and to the frontend for diagnostics.
 *
 * Endpoints:
 *   GET  /api/specula/health      - availability + config
 *   GET  /api/specula/skills/:skill/:file - raw skill markdown (cached)
 *   POST /api/specula/validate-tlc - invoke Specula's TLC runner (optional)
 */

const { Router } = require('express');
const speculaBridge = require('../services/specula-engine-bridge');
const logger = require('../utils/logger');

const router = Router();

router.get('/specula/health', async (_req, res) => {
  const available = await speculaBridge.isAvailable();
  res.json({
    success: true,
    available: available.available,
    setupComplete: available.setupComplete,
    cliAvailable: available.cliAvailable,
    uvRunAvailable: available.uvRunAvailable,
    config: speculaBridge.getConfig(),
  });
});

router.get('/specula/skills/:skill/:file', async (req, res) => {
  const { skill, file } = req.params;
  const text = await speculaBridge.getSkillText(skill, file);
  if (text === null) {
    return res.status(404).json({ success: false, error: 'Skill file not found' });
  }
  res.setHeader('Content-Type', 'text/markdown');
  res.send(text);
});

router.post('/specula/validate-tlc', async (req, res) => {
  const { spec_path, cfg_path, memory, workers, timeout_minutes, deadlock, json_trace } = req.body || {};
  if (!spec_path || !cfg_path) {
    return res.status(400).json({ success: false, error: 'spec_path and cfg_path are required' });
  }

  try {
    const result = await speculaBridge.runSpeculaTlc(spec_path, cfg_path, {
      memory,
      workers,
      timeoutMinutes: timeout_minutes,
      deadlock,
      jsonTrace: json_trace,
    });
    res.json({ success: true, result });
  } catch (err) {
    logger.error('specula.validate_tlc_error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
