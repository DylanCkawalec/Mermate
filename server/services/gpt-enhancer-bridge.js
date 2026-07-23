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
 * @param {string} [stage]         - Pipeline stage: text_to_md, md_to_mmd, validate_mmd, repair, render, copilot_suggest, copilot_enhance, decompose, repair_from_trace
 * @param {string} [contentState]  - Detected input type: text, md, mmd, hybrid
 * @param {object} [options]       - Additional options: { dump_id, use_max, context, shadow_context, compile_error, original_description }
 * @returns {Promise<{source: string, enhanced: boolean, meta: object}>}
 */
async function enhance(rawSource, diagramType, stage, contentState, options = {}) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const promptConfig = buildPrompt(stage || 'validate_mmd');

    const body = {
      raw_source: rawSource,
      diagram_type: diagramType || null,
      stage: stage || null,
      content_state: contentState || null,
      system_prompt: promptConfig.system,
      temperature: promptConfig.temperature,
    };

    // Hybrid routing options
    if (options.dump_id) body.dump_id = options.dump_id;
    if (options.use_max) body.use_max = options.use_max;
    if (options.context) body.context = options.context;
    if (options.shadow_context) body.shadow_context = options.shadow_context;
    if (options.compile_error) body.compile_error = options.compile_error;
    if (options.original_description) body.original_description = options.original_description;

    const res = await fetch(`${ENHANCER_URL}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

/**
 * Audit a dump or a realtime call pair.
 * @param {object} params - { dump_id } or { request_body, response_body, stage }
 * @returns {Promise<object>}
 */
async function audit(params = {}) {
  try {
    const res = await fetch(`${ENHANCER_URL}/mermaid/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) return { error: `Audit returned ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Organize dump cache.
 * @param {string} [dumpId] - Specific dump to organize, or null for all
 * @returns {Promise<object>}
 */
async function organize(dumpId = null) {
  try {
    const res = await fetch(`${ENHANCER_URL}/mermaid/organize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dump_id: dumpId }),
    });
    if (!res.ok) return { error: `Organize returned ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get telemetry stats.
 * @returns {Promise<object>}
 */
async function getTelemetryStats() {
  try {
    const res = await fetch(`${ENHANCER_URL}/telemetry/stats`);
    if (!res.ok) return { error: `Telemetry returned ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * List all available dumps.
 * @returns {Promise<object>}
 */
async function listDumps() {
  try {
    const res = await fetch(`${ENHANCER_URL}/dumps`);
    if (!res.ok) return { error: `Dumps returned ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { isAvailable, enhance, audit, organize, getTelemetryStats, listDumps };
