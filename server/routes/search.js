'use strict';

const { Router } = require('express');
const query = require('../backend/query');
const logger = require('../utils/logger');

const router = Router();

router.get('/search', async (req, res) => {
  const { q, limit, project, type } = req.query;
  if (!q) return res.status(400).json({ success: false, error: 'q (query) is required' });

  try {
    const results = await query.searchSimilar(q, {
      limit: parseInt(limit) || 10,
      projectFilter: project || undefined,
      typeFilter: type || undefined,
    });
    res.json({ success: true, results });
  } catch (err) {
    logger.error('search.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/projects', async (req, res) => {
  const { limit, offset, sort } = req.query;
  try {
    const projects = await query.listProjects({
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      sortBy: sort || 'updated_at',
    });
    res.json({ success: true, projects });
  } catch (err) {
    logger.error('projects.list.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/projects/:id', async (req, res) => {
  try {
    const project = await query.getProject(req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    res.json({ success: true, project });
  } catch (err) {
    logger.error('projects.get.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/projects/:id/history', async (req, res) => {
  try {
    const history = await query.getProjectHistory(req.params.id);
    res.json({ success: true, history });
  } catch (err) {
    logger.error('projects.history.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/projects/:id/verify', async (req, res) => {
  try {
    const result = await query.verifyIntegrity(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('projects.verify.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/projects/:id/pipeline', async (req, res) => {
  try {
    const status = await query.getProjectPipelineStatus(req.params.id);
    if (!status) return res.status(404).json({ success: false, error: 'Project not found' });
    res.json({ success: true, pipeline: status });
  } catch (err) {
    logger.error('projects.pipeline.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/scoreboard', async (req, res) => {
  try {
    const { limit } = req.query;
    const scoreboard = await query.getGoTScoreboard(parseInt(limit) || 20);
    res.json({ success: true, scoreboard });
  } catch (err) {
    logger.error('scoreboard.error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
