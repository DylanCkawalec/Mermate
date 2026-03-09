'use strict';

const { detect, CONTENT_STATES } = require('./input-detector');
const { classify } = require('./mermaid-classifier');
const { selectDiagramType } = require('./diagram-selector');
const { validate } = require('./mermaid-validator');
const enhancerBridge = require('./gpt-enhancer-bridge');
const logger = require('../utils/logger');

// ---- Local text-to-mmd fallback (no enhancer required) ----------------------

const FLOW_VERB_RE = /\b(sends?\s+(?:request\s+)?to|calls?|connects?\s+to|routes?\s+to|triggers?|requests?|reads?\s+from|writes?\s+to|stores?\s+in|queries?|goes?\s+to|flows?\s+to|talks?\s+to|uses?|emits?\s+(?:event\s+)?to|publishes?\s+to|subscribes?\s+to|forwards?\s+to|fetches?\s+from|posts?\s+to|logs?\s+(?:in\s+)?to|redirects?\s+to|proxies?\s+to|delegates?\s+to|dispatches?\s+to|passes?\s+to)\b/i;
const DECISION_RE  = /\b(if|when|validate|check|approve|reject|gate|decision|condition|verify)\b/i;
const STORE_RE     = /\b(database|db|cache|redis|mongo|postgres|mysql|queue|bucket|s3|store|storage|index|kafka|dynamo)\b/i;
const EXTERNAL_RE  = /\b(user|client|browser|admin|operator|customer|external)\b/i;

function _cleanLabel(str) {
  return str.trim()
    .replace(/['"]/g, '')
    .replace(/[^a-zA-Z0-9\s\-_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1)
    .slice(0, 4)
    .join(' ');
}

function _nodeShape(label) {
  if (DECISION_RE.test(label)) return `{"${label}"}`;
  if (STORE_RE.test(label))    return `[("${label}")]`;
  if (EXTERNAL_RE.test(label)) return `(["${label}"])`;
  return `["${label}"]`;
}

function localTextToMmd(source) {
  const diagramHint = selectDiagramType(source);
  const directive   = diagramHint.directive || 'flowchart TB';

  if (directive === 'sequenceDiagram') return _localSequence(source);

  const sentences = source
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  const nodeMap = new Map(); // label -> id
  const edges   = [];
  let   counter = 0;

  function getOrCreate(raw) {
    const label = _cleanLabel(raw);
    if (!label) return null;
    if (!nodeMap.has(label)) nodeMap.set(label, 'N' + (++counter));
    return nodeMap.get(label);
  }

  for (const sentence of sentences) {
    const m = sentence.match(
      new RegExp(`^(.+?)\\s+${FLOW_VERB_RE.source}\\s+(.+?)$`, 'i'),
    );
    if (m) {
      const fromId = getOrCreate(m[1]);
      const toId   = getOrCreate(m[m.length - 1]);
      if (fromId && toId && fromId !== toId) edges.push({ from: fromId, to: toId });
    }
  }

  // Fallback: extract noun-like chunks from sentences
  if (edges.length === 0) {
    const STOP = new Set(['the','a','an','is','are','was','were','and','or','but','with','for','in','on','at','to','of','by','that','this','which','it','its','be','has','have','had','not','no','from','as','into','via','through','through','against','before','after']);
    const chunks = sentences.map(s =>
      s.split(/\s+/)
        .filter(w => w.length > 2 && !STOP.has(w.toLowerCase()) && /^[a-zA-Z]/.test(w))
        .slice(0, 3)
        .join(' '),
    ).filter(c => c.length > 2);
    const unique = [...new Set(chunks)].slice(0, 8);
    const ids = unique.map(c => getOrCreate(c)).filter(Boolean);
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ from: ids[i], to: ids[i + 1] });
    }
  }

  let mmd = directive + '\n';
  for (const [label, id] of nodeMap) mmd += `    ${id}${_nodeShape(label)}\n`;
  for (const edge of edges)          mmd += `    ${edge.from} --> ${edge.to}\n`;
  return mmd;
}

function _localSequence(source) {
  const ACTOR_RE = /\b(user|client|browser|server|api|service|database|gateway|auth)\b/gi;
  const actors = [
    ...new Set(
      (source.match(ACTOR_RE) || ['Client', 'Server'])
        .map(a => a.charAt(0).toUpperCase() + a.slice(1).toLowerCase()),
    ),
  ].slice(0, 6);

  let mmd = 'sequenceDiagram\n';
  actors.forEach(a => { mmd += `    participant ${a}\n`; });
  for (let i = 0; i < actors.length - 1; i++) {
    mmd += `    ${actors[i]}->>${actors[i + 1]}: request\n`;
    mmd += `    ${actors[i + 1]}-->>${actors[i]}: response\n`;
  }
  return mmd;
}

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
    if (!enhance || !enhancerUp) {
      // Local fallback: convert plain text to a basic diagram without the enhancer
      logger.info('input.local_fallback', { reason: enhance ? 'enhancer_unavailable' : 'enhance_off' });
      const mmdSource = localTextToMmd(source);
      stagesExecuted.push('local_text_to_mmd');
      return buildResult(mmdSource, state, false, null, stagesExecuted, startMs, source);
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
