'use strict';

const { detect, CONTENT_STATES } = require('./input-detector');
const { classify } = require('./mermaid-classifier');
const { selectDiagramType } = require('./diagram-selector');
const { validate } = require('./mermaid-validator');
const enhancerBridge = require('./gpt-enhancer-bridge');
const logger = require('../utils/logger');

const FENCED_MERMAID_RE = /```mermaid\s*\n([\s\S]*?)```/g;

/**
 * Extract fenced ```mermaid blocks from markdown content.
 * @param {string} mdSource
 * @returns {string|null}
 */
function extractFencedMermaid(mdSource) {
  const blocks = [];
  let match;
  while ((match = FENCED_MERMAID_RE.exec(mdSource)) !== null) {
    const block = match[1].trim();
    if (block) blocks.push(block);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Best-effort extraction for hybrid content:
 * scan for longest contiguous block of Mermaid-like syntax.
 * @param {string} source
 * @returns {string|null}
 */
function bestEffortExtract(source) {
  const lines = source.split('\n');
  const mermaidLineRe = /-->|==>|---|-.->|\w+\[|\w+\(|\w+\{|subgraph\s|classDef\s|class\s|end\b|style\s/;

  let bestRun = [];
  let currentRun = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentRun.length > 0) currentRun.push(line);
      continue;
    }
    if (mermaidLineRe.test(trimmed) || trimmed.startsWith('%%')) {
      currentRun.push(line);
    } else {
      if (currentRun.length > bestRun.length) bestRun = [...currentRun];
      currentRun = [];
    }
  }
  if (currentRun.length > bestRun.length) bestRun = [...currentRun];

  if (bestRun.length < 2) return null;

  let extracted = bestRun.join('\n').trim();
  const firstLine = extracted.split('\n')[0].trim();
  const hasDirective = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey)\b/i.test(firstLine);

  if (!hasDirective) {
    const hasEdges = /-->|==>/.test(extracted);
    extracted = (hasEdges ? 'flowchart TD\n' : 'flowchart LR\n') + extracted;
  }

  return extracted;
}

/**
 * Route user input through the intelligent pipeline.
 *
 * @param {string} source     - Trimmed user input
 * @param {object} [options]
 * @param {boolean} [options.enhance=false] - Whether enhancer is requested
 * @returns {Promise<{
 *   mmdSource: string,
 *   diagramType: string,
 *   contentState: string,
 *   enhanced: boolean,
 *   enhanceMeta: object|null,
 *   stagesExecuted: string[],
 *   totalEnhanceMs: number
 * }>}
 */
async function route(source, options = {}) {
  const enhance = options.enhance === true;
  const { state, signals } = detect(source);
  const stagesExecuted = [];
  const startMs = Date.now();

  let mmdSource = source;
  let enhanced = false;
  let enhanceMeta = null;
  let enhancerUp = false;

  if (enhance) {
    enhancerUp = await enhancerBridge.isAvailable();
  }

  logger.info('input.detected', { content_state: state, enhance, enhancer_available: enhancerUp });

  // ---- PATH C: mmd input ----
  if (state === CONTENT_STATES.MMD) {
    if (enhance && enhancerUp) {
      const result = await enhancerBridge.enhance(source, classify(source), 'validate_mmd', state);
      stagesExecuted.push('validate_mmd');
      enhanced = result.enhanced;
      enhanceMeta = result.meta;
      mmdSource = result.source;
    }
    return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
  }

  // ---- PATH B: md input ----
  if (state === CONTENT_STATES.MD) {
    if (enhance && enhancerUp) {
      const result = await enhancerBridge.enhance(source, null, 'md_to_mmd', state);
      stagesExecuted.push('md_to_mmd');
      enhanced = result.enhanced;
      enhanceMeta = result.meta;
      mmdSource = result.source;
    } else {
      const extracted = extractFencedMermaid(source);
      if (extracted) {
        mmdSource = extracted;
        stagesExecuted.push('extract_fenced');
      } else {
        throw new RouterError(
          'enhancer_required',
          'Markdown input without fenced mermaid blocks requires the GPT enhancer. ' +
          'Start the enhancer service or include a ```mermaid code block.',
        );
      }
    }
    return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
  }

  // ---- PATH A: text input ----
  if (state === CONTENT_STATES.TEXT) {
    if (!enhance) {
      throw new RouterError(
        'enhancer_required',
        'Plain text input requires the Enhance option to convert your idea into a diagram. ' +
        'Check the Enhance box and try again, or paste Mermaid source directly.',
      );
    }
    if (!enhancerUp) {
      throw new RouterError(
        'enhancer_unavailable',
        'Plain text input requires the GPT enhancer service, which is currently unavailable. ' +
        'Start the enhancer or paste Mermaid source directly.',
      );
    }

    const diagramHint = selectDiagramType(source);
    logger.info('diagram.selected', { type: diagramHint.type, directive: diagramHint.directive, reason: diagramHint.reason });

    // Stage 1: text -> md
    const mdResult = await enhancerBridge.enhance(source, diagramHint.type, 'text_to_md', state);
    stagesExecuted.push('text_to_md');
    let mdOutput = mdResult.source;

    // Stage 2: md -> mmd
    const mmdResult = await enhancerBridge.enhance(mdOutput, diagramHint.type, 'md_to_mmd', 'md');
    stagesExecuted.push('md_to_mmd');
    enhanced = true;
    enhanceMeta = mmdResult.meta;
    mmdSource = mmdResult.source;

    return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
  }

  // ---- PATH D: hybrid input ----
  if (state === CONTENT_STATES.HYBRID) {
    if (enhance && enhancerUp) {
      const repairResult = await enhancerBridge.enhance(source, null, 'repair', state);
      stagesExecuted.push('repair');

      const repairedSource = repairResult.source;
      const outputFormat = repairResult.meta?.outputFormat || 'mmd';

      if (outputFormat === 'md') {
        const mmdResult = await enhancerBridge.enhance(repairedSource, null, 'md_to_mmd', 'md');
        stagesExecuted.push('md_to_mmd');
        mmdSource = mmdResult.source;
      } else {
        mmdSource = repairedSource;
      }
      enhanced = true;
      enhanceMeta = repairResult.meta;
    } else {
      const extracted = bestEffortExtract(source);
      if (extracted) {
        mmdSource = extracted;
        stagesExecuted.push('best_effort_extract');
      } else {
        throw new RouterError(
          'extraction_failed',
          'Could not extract a valid Mermaid diagram from the mixed input. ' +
          'Enable Enhance for intelligent repair, or paste cleaner Mermaid source.',
        );
      }
    }
    return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
  }

  return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
}

function buildResult(mmdSource, contentState, enhanced, enhanceMeta, stagesExecuted, startMs, originalSource) {
  const diagramType = classify(mmdSource);
  const validation = validate(mmdSource);

  const diagramSelection = (contentState === 'text' && originalSource)
    ? selectDiagramType(originalSource)
    : null;

  if (validation.warnings.length > 0) {
    logger.info('mmd.validation.warnings', {
      warnings: validation.warnings.map(w => w.message),
    });
  }
  if (!validation.valid) {
    logger.warn('mmd.validation.errors', {
      errors: validation.errors.map(e => e.message),
    });
  }

  return {
    mmdSource,
    diagramType,
    contentState,
    enhanced,
    enhanceMeta,
    stagesExecuted,
    totalEnhanceMs: Date.now() - startMs,
    validation,
    diagramSelection,
  };
}

class RouterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { route, detect, extractFencedMermaid, bestEffortExtract, RouterError };
