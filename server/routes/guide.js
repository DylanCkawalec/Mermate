'use strict';

const { Router } = require('express');
const opseeq = require('../services/opseeq-bridge');
const logger = require('../utils/logger');

const router = Router();

router.get('/guide/status', async (_req, res) => {
  const h = await opseeq.health();
  res.json({ success: true, opseeqUrl: opseeq.getUrl(), ...h });
});

router.post('/guide/connect', async (_req, res) => {
  const h = await opseeq.health();
  if (!h.healthy) {
    return res.json({ success: false, error: h.error || 'Opseeq unreachable', url: opseeq.getUrl() });
  }
  const models = await opseeq.listModels();
  res.json({ success: true, healthy: true, models, url: opseeq.getUrl() });
});

router.post('/guide/evaluate', async (req, res) => {
  const { uiState } = req.body || {};

  const h = await opseeq.health();
  if (!h.healthy) {
    return res.json({ success: true, source: 'heuristic', fallback: true, suggestions: _heuristicFallback(uiState) });
  }

  try {
    const prompt = JSON.stringify({
      currentMode: uiState?.currentMode,
      isLoading: uiState?.isLoading,
      agentState: uiState?.agentState,
      agentModeActive: uiState?.agentModeActive,
      hasInput: uiState?.hasInput,
      hasName: uiState?.hasName,
      hasResult: uiState?.hasResult,
      enhanceChecked: uiState?.enhanceChecked,
      maxMode: uiState?.maxMode,
      notesDirty: uiState?.notesDirty,
      currentRunId: !!uiState?.currentRunId,
      currentDiagramName: uiState?.currentDiagramName || null,
      unlockedStages: uiState?.unlockedStages,
      completedStages: uiState?.completedStages,
      errorVisible: uiState?.errorVisible,
    });

    const result = await opseeq.inference([
      { role: 'system', content: GUIDE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 250 });

    const parsed = _parseGuideResponse(result.content);

    if (parsed.length > 0) {
      return res.json({ success: true, source: 'opseeq-ai', model: result.model, suggestions: parsed });
    }

    return res.json({ success: true, source: 'opseeq-heuristic', suggestions: _heuristicFallback(uiState) });
  } catch (err) {
    logger.warn('guide.evaluate_failed', { error: err.message });
    return res.json({ success: false, source: 'opseeq-heuristic', fallback: true, suggestions: _heuristicFallback(uiState) });
  }
});

const GUIDE_SYSTEM_PROMPT = `You are the Mermate Auto Guide — a tutor that helps users build architecture diagrams and formal specifications through a pipeline: Idea > Mermaid Diagram > TLA+ Specification > TypeScript Runtime > Download Bundle.

Given the current UI state as JSON, return a JSON array of 1-3 suggested next actions, ordered by priority. Each action has:
- "target": CSS selector of the element to highlight (e.g. "#btn-render", "#mermaid-input", ".pipeline-segment[data-stage=\\"tla\\"]")
- "hint": short instruction (max 60 chars)
- "weight": priority 20-100

If the system is loading or an agent is running, return: [{"target":null,"hint":"","weight":0,"pause":true}]

Return ONLY the JSON array, no explanation.`;

function _parseGuideResponse(content) {
  try {
    const trimmed = (content || '').trim();
    const jsonStr = trimmed.startsWith('[') ? trimmed : (trimmed.match(/\[[\s\S]*\]/)?.[0] || null);
    if (jsonStr) return JSON.parse(jsonStr);
  } catch { /* parse failed */ }
  return [];
}

function _heuristicFallback(state) {
  if (!state) return [];
  const results = [];
  if (state.isLoading) return [{ target: null, hint: '', weight: 0, pause: true }];
  if (state.agentState === 'running' || state.agentState === 'finalizing') return [{ target: null, hint: '', weight: 0, pause: true }];
  if (state.errorVisible) results.push({ target: '#btn-dismiss-error', hint: 'Dismiss the error', weight: 100 });

  const mode = state.currentMode || 'idea';
  const inputModes = ['idea', 'md', 'mmd'];

  if (inputModes.includes(mode) && !state.hasInput) {
    if (!state.hasName && mode === 'idea') results.push({ target: '#diagram-name-input', hint: 'Name your project', weight: 80 });
    results.push({ target: '#mermaid-input', hint: 'Describe your system', weight: 80 });
  } else if (inputModes.includes(mode) && state.hasInput && !state.hasResult) {
    results.push({ target: '#btn-render', hint: 'Render your diagram', weight: 80 });
    if (!state.enhanceChecked) results.push({ target: '#btn-enhance', hint: 'Enable AI enhancement', weight: 50 });
  }

  if (state.agentModeActive && state.hasInput && state.agentState === 'idle') {
    results.push({ target: '#btn-agent-run', hint: 'Run the agent', weight: 80 });
  }

  if (state.hasResult && state.unlockedStages?.includes('tla') && inputModes.includes(mode)) {
    results.push({ target: '.pipeline-segment[data-stage="tla"]', hint: 'Continue to TLA+', weight: 80 });
  }

  if (state.completedStages?.includes('tla') && state.unlockedStages?.includes('ts') && mode !== 'ts') {
    results.push({ target: '.pipeline-segment[data-stage="ts"]', hint: 'Continue to TypeScript', weight: 80 });
  }

  if (state.completedStages?.includes('ts')) {
    results.push({ target: '#btn-download', hint: 'Download your codebase', weight: 80 });
  }

  results.sort((a, b) => b.weight - a.weight);
  return results.slice(0, 3);
}

module.exports = router;
