'use strict';

/**
 * Agent route — orchestrates multi-step architecture refinement.
 *
 * POST /api/agent/run
 *   Stages: ingest -> planning -> refinement -> validation render -> preview_ready
 *   Pauses before Max render so the user can add final notes.
 *
 * POST /api/agent/finalize
 *   Accepts { current_text, mode, user_notes } and runs the final Max render
 *   with the user's notes merged into the context.
 *
 * GET /api/agent/modes
 *   Returns available agent modes with their prompt skeletons.
 */

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { analyze } = require('../services/input-analyzer');
const provider = require('../services/inference-provider');
const logger = require('../utils/logger');

const router = Router();

const ASSETS_DIR = path.resolve(__dirname, '..', '..', '.cursor', 'assets');

const AGENT_MODES = {
  'code-review': {
    id: 'code-review',
    label: 'Code Review',
    description: 'Recover architecture from a live codebase',
    icon: 'code',
    file: 'CODE-REVIEW-MODE.txt',
  },
  'thinking': {
    id: 'thinking',
    label: 'Thinking',
    description: 'Build architecture from ideas, notes, or problem statements',
    icon: 'lightbulb',
    file: 'THINKING-MODE.txt',
  },
  'optimize-mmd': {
    id: 'optimize-mmd',
    label: 'Optimize',
    description: 'Improve existing Mermaid or markdown without breaking intent',
    icon: 'tune',
    file: 'OPTIMIZE-MMD-MODE.txt',
  },
};

async function _loadModePrompt(modeId) {
  const mode = AGENT_MODES[modeId];
  if (!mode) return null;
  try {
    return await fsp.readFile(path.join(ASSETS_DIR, mode.file), 'utf-8');
  } catch {
    return null;
  }
}

function _buildAgentSystemPrompt(modePromptSkeleton) {
  return [
    'You are a senior enterprise architect. Given the user\'s prompt and the operating mode, produce an improved architecture description.',
    'Output ONLY the improved architecture text — no markdown fences, no explanations, no Mermaid syntax.',
    'Write clear, structured English that describes the system architecture with actors, services, stores, flows, failure paths, and boundaries.',
    'Preserve everything the user already specified. Add specificity, structure, and missing architectural concerns.',
    modePromptSkeleton ? '\n--- MODE INSTRUCTIONS ---\n' + modePromptSkeleton.slice(0, 2000) : '',
  ].join('\n');
}

function _extractText(output) {
  if (!output) return null;
  let text = output;
  try {
    const parsed = JSON.parse(text);
    if (parsed.enhanced_source) text = parsed.enhanced_source;
  } catch { /* not JSON */ }
  return text.trim();
}

router.get('/agent/modes', (_req, res) => {
  const modes = Object.values(AGENT_MODES).map(m => ({
    id: m.id, label: m.label, description: m.description, icon: m.icon,
  }));
  return res.json({ success: true, modes });
});

// ---- Phase 1: Run through planning, refinement, and preview ----

router.post('/agent/run', async (req, res) => {
  const { prompt, mode, current_text } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }
  if (!mode || !AGENT_MODES[mode]) {
    return res.status(400).json({ success: false, error: 'invalid agent mode' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendEvent(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    sendEvent('stage', { stage: 'ingest', message: 'Reading prompt and mode configuration...' });

    const modePromptSkeleton = await _loadModePrompt(mode);
    const startText = current_text || prompt;
    const systemPrompt = _buildAgentSystemPrompt(modePromptSkeleton);

    // ---- Planning ----
    sendEvent('stage', { stage: 'planning', message: 'Analyzing architecture and generating plan...' });

    const profile = analyze(startText, 'idea');
    sendEvent('analysis', {
      maturity: profile.maturity,
      quality: profile.qualityScore,
      completeness: profile.completenessScore,
      entities: profile.shadow?.entities?.length || 0,
      relationships: profile.shadow?.relationships?.length || 0,
      gaps: profile.shadow?.gaps || [],
    });

    const planningUserPrompt = [
      '[USER PROMPT]', prompt, '',
      current_text && current_text !== prompt ? '[CURRENT DRAFT]\n' + current_text : '',
      '', '[ANALYSIS]',
      `Maturity: ${profile.maturity}`, `Quality: ${profile.qualityScore}`,
      `Entities: ${profile.shadow?.entities?.length || 0}`,
      `Gaps: ${(profile.shadow?.gaps || []).join('; ') || 'none'}`, '',
      'Produce a stronger architecture description. Be specific about services, data stores, flows, and failure handling.',
    ].filter(Boolean).join('\n');

    const planResult = await provider.infer('copilot_enhance', {
      systemPrompt, userPrompt: planningUserPrompt,
    });

    let draftText = startText;
    if (planResult.output && planResult.output.trim() !== startText.trim()) {
      draftText = _extractText(planResult.output) || draftText;
      sendEvent('draft_update', { text: draftText, original: startText, reason: 'Agent planned a stronger architecture' });
    }

    // ---- Refinement ----
    sendEvent('stage', { stage: 'refining', message: 'Refining architecture structure...' });

    const refinedProfile = analyze(draftText, 'idea');
    if (refinedProfile.qualityScore < 0.6 || refinedProfile.completenessScore < 0.6) {
      const refineResult = await provider.infer('copilot_enhance', {
        systemPrompt,
        userPrompt: `[CURRENT DRAFT]\n${draftText}\n\n[ANALYSIS]\nQuality: ${refinedProfile.qualityScore}\nGaps: ${(refinedProfile.shadow?.gaps || []).join('; ')}\n\nImprove this further. Add missing failure paths, boundaries, and specificity.`,
      });
      if (refineResult.output && refineResult.output.trim() !== draftText.trim()) {
        const prevDraft = draftText;
        draftText = _extractText(refineResult.output) || draftText;
        sendEvent('draft_update', { text: draftText, original: prevDraft, reason: 'Refined architecture with additional detail' });
      }
    }

    // ---- Validation / preview render (cheap mode) ----
    sendEvent('stage', { stage: 'preview', message: 'Running preview render...' });

    const PORT = process.env.PORT || 3333;
    const previewResp = await fetch(`http://localhost:${PORT}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mermaid_source: draftText, enhance: true, input_mode: 'idea', max_mode: false }),
    });
    const previewData = await previewResp.json();

    // Track preview diagram_name so finalize can overwrite it
    let previewDiagramName = null;
    if (previewData.success) {
      previewDiagramName = previewData.diagram_name;
      sendEvent('preview_render', {
        success: true,
        paths: previewData.paths,
        metrics: previewData.mmd_metrics,
        diagram_name: previewData.diagram_name,
        diagram_type: previewData.diagram_type,
        attempts: previewData.render_meta?.attempts,
      });
    } else {
      sendEvent('preview_render', {
        success: false,
        error: previewData.details || previewData.error,
      });
    }

    // ---- Pause: wait for user notes before Max render ----
    sendEvent('preview_ready', {
      message: 'Preview ready. Add optional notes before final Max render.',
      draft_text: draftText,
      diagram_name: previewDiagramName,
    });

  } catch (err) {
    logger.error('agent.run.error', { error: err.message });
    sendEvent('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ---- Phase 2: Finalize with Max render (after user notes) ----

router.post('/agent/finalize', async (req, res) => {
  const { current_text, mode, user_notes } = req.body || {};

  if (!current_text || typeof current_text !== 'string') {
    return res.status(400).json({ success: false, error: 'current_text is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendEvent(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    let draftText = current_text.trim();

    // If user provided notes, do one more refinement pass incorporating them
    if (user_notes && user_notes.trim()) {
      sendEvent('stage', { stage: 'incorporating_notes', message: 'Applying your notes to the architecture...' });

      const modePromptSkeleton = mode ? await _loadModePrompt(mode) : null;
      const systemPrompt = _buildAgentSystemPrompt(modePromptSkeleton);

      const noteResult = await provider.infer('copilot_enhance', {
        systemPrompt,
        userPrompt: [
          '[CURRENT ARCHITECTURE DRAFT]', draftText, '',
          '[USER REVIEW NOTES]', user_notes.trim(), '',
          'Apply the user\'s review notes to improve the architecture. Preserve the existing structure. Focus on what the user asked to improve.',
        ].join('\n'),
      });

      if (noteResult.output && noteResult.output.trim() !== draftText.trim()) {
        const prevDraft = draftText;
        draftText = _extractText(noteResult.output) || draftText;
        sendEvent('draft_update', { text: draftText, original: prevDraft, reason: 'Applied review notes' });
      }
    }

    // ---- Final Max render ----
    sendEvent('stage', { stage: 'finalizing', message: 'Running final Max render...' });

    const PORT = process.env.PORT || 3333;
    // Pass diagram_name from the body so the final render overwrites the preview
    const diagramName = req.body.diagram_name || undefined;
    const finalResp = await fetch(`http://localhost:${PORT}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mermaid_source: draftText,
        diagram_name: diagramName,
        enhance: true,
        input_mode: 'idea',
        max_mode: true,
      }),
    });
    const finalData = await finalResp.json();

    if (finalData.success) {
      sendEvent('final_render', {
        success: true,
        diagram_name: finalData.diagram_name,
        diagram_type: finalData.diagram_type,
        paths: finalData.paths,
        metrics: finalData.mmd_metrics,
        max_mode: finalData.render_meta?.max_mode,
        attempts: finalData.render_meta?.attempts,
        provider: finalData.enhance_meta?.provider,
      });
    } else {
      sendEvent('final_render', {
        success: false,
        error: finalData.details || finalData.error,
      });
    }

    sendEvent('stage', { stage: 'complete', message: 'Agent workflow complete' });
    sendEvent('done', { final_text: draftText });

  } catch (err) {
    logger.error('agent.finalize.error', { error: err.message });
    sendEvent('error', { message: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
