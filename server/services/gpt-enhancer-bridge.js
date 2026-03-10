'use strict';

/**
 * GPT Enhancer Bridge
 *
 * Optional integration with the GPT-OSS Mermaid Enhancer service (port 8100).
 * Degrades gracefully to passthrough if the service is not running.
 *
 * Supports stage-aware routing: text_to_md, md_to_mmd, validate_mmd, repair.
 * Sends axiom-derived prompt templates with each request.
 */

const { buildPrompt } = require('./axiom-prompts');

const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';
const TIMEOUT_MS = parseInt(process.env.MERMAID_ENHANCER_TIMEOUT || '15000', 10);

/**
 * Check if the enhancer service is available.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${ENHANCER_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Enhance source via the GPT-OSS enhancer service.
 * Returns the original source unchanged if the service is unavailable.
 *
 * @param {string} rawSource       - Raw input text
 * @param {string} [diagramType]   - Pre-classified mermaid type (optional)
 * @param {string} [stage]         - Pipeline stage: text_to_md, md_to_mmd, validate_mmd, repair
 *                                   null defaults to validate_mmd for backward compat
 * @param {string} [contentState]  - Detected input type: text, md, mmd, hybrid
 * @returns {Promise<{source: string, enhanced: boolean, meta: object}>}
 */
async function enhance(rawSource, diagramType, stage, contentState) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const promptConfig = buildPrompt(stage || 'validate_mmd');

    const res = await fetch(`${ENHANCER_URL}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_source: rawSource,
        diagram_type: diagramType || null,
        stage: stage || null,
        content_state: contentState || null,
        system_prompt: promptConfig.system,
        temperature: promptConfig.temperature,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return passthrough(rawSource, `Enhancer returned ${res.status}`);
    }

    const data = await res.json();
    const nextSource = data.enhanced_source || rawSource;
    const transformed = typeof data.transformation === 'string'
      ? data.transformation !== 'passthrough'
      : nextSource !== rawSource;

    return {
      source: nextSource,
      enhanced: transformed,
      meta: {
        transformation: data.transformation,
        outputFormat: data.output_format || 'mmd',
        diagramType: data.diagram_type,
        complexity: data.complexity,
        maturity: data.maturity,
        warnings: data.warnings,
        log: data.transformation_log,
      },
    };
  } catch (err) {
    return passthrough(rawSource, err.message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Passthrough fallback — returns source unchanged with reason.
 */
function passthrough(source, reason) {
  return {
    source,
    enhanced: false,
    meta: {
      transformation: 'passthrough',
      outputFormat: 'mmd',
      reason,
    },
  };
}

module.exports = { isAvailable, enhance };
