'use strict';

const { detect, CONTENT_STATES } = require('./input-detector');
const { classify } = require('./mermaid-classifier');
const { selectDiagramType } = require('./diagram-selector');
const { validate } = require('./mermaid-validator');
const { repair: deterministicRepair } = require('./mermaid-repairer');
const { extractShadow, analyze } = require('./input-analyzer');
const { buildRenderPrepareUserPrompt, buildModelRepairUserPrompt } = require('./axiom-prompts');
const provider = require('./inference-provider');
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

const LOCAL_SAFE_DIRECTIVES = new Set([
  'flowchart TB', 'flowchart TD', 'flowchart LR', 'flowchart RL', 'flowchart BT',
  'graph TB', 'graph TD', 'graph LR', 'graph RL', 'graph BT',
  'sequenceDiagram', 'stateDiagram-v2',
]);

function localTextToMmd(source, shadow) {
  const diagramHint = selectDiagramType(source);
  let directive = diagramHint.directive || 'flowchart TB';

  if (!LOCAL_SAFE_DIRECTIVES.has(directive)) {
    directive = 'flowchart TB';
  }

  if (directive === 'sequenceDiagram') return _localSequence(source, shadow);

  if (shadow && shadow.entities.length >= 2 && shadow.relationships.length >= 1) {
    return _shadowToFlowchart(directive, shadow);
  }

  const sentences = source
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  const nodeMap = new Map();
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

function _shadowToFlowchart(directive, shadow) {
  const nodeMap = new Map();
  let counter = 0;

  function _toId(name) {
    const clean = name.replace(/[^a-zA-Z0-9]/g, '');
    const id = clean.charAt(0).toUpperCase() + clean.slice(1);
    return id || ('N' + (++counter));
  }

  function getOrCreate(name, type) {
    const key = name.toLowerCase().trim();
    if (nodeMap.has(key)) return nodeMap.get(key).id;
    const id = _toId(name);
    nodeMap.set(key, { id, name: name.trim(), type: type || 'component' });
    return id;
  }

  for (const entity of shadow.entities) {
    getOrCreate(entity.name, entity.type);
  }

  const edges = [];
  for (const rel of shadow.relationships) {
    const fromId = getOrCreate(rel.from, 'component');
    const toId = getOrCreate(rel.to, 'component');
    if (fromId !== toId) {
      const edgeStyle = rel.type === 'async' ? '-.->' : '-->';
      const label = rel.verb ? `|${rel.verb}|` : '';
      edges.push({ from: fromId, to: toId, style: edgeStyle, label });
    }
  }

  // Add failure path edges as dashed
  for (const fp of shadow.failurePaths) {
    const desc = fp.description.toLowerCase();
    const failNode = getOrCreate('Error Handler', 'decision');
    const lastRuntimeEdge = edges.find(e => e.style === '-->');
    if (lastRuntimeEdge) {
      edges.push({ from: lastRuntimeEdge.from, to: failNode, style: '-.->', label: '|failure|' });
    }
  }

  let mmd = directive + '\n';
  for (const [, node] of nodeMap) {
    mmd += `    ${node.id}${_nodeShape(node.name)}\n`;
  }
  for (const edge of edges) {
    mmd += `    ${edge.from} ${edge.style}${edge.label} ${edge.to}\n`;
  }
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

// ---- Compile with retry loop ------------------------------------------------

const { compile } = require('./mermaid-compiler');

const VALID_DIRECTIVE_RE = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey|C4Context|C4Container|C4Component|C4Dynamic|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta)\b/i;

function _sanitizeCompileError(raw) {
  if (!raw || typeof raw !== 'string') return 'Compilation failed';
  let cleaned = raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\[npm-security-monitor\][^\n]*/g, '')
    .replace(/═{3,}[^═]*═{3,}/gs, '')
    .replace(/⚠️[^\n]*/g, '')
    .replace(/Explanation:[\s\S]*?Action Taken:[\s\S]*?\n/g, '')
    .replace(/•[^\n]*/g, '')
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const mermaidErr = cleaned.match(/((?:UnknownDiagramError|Error|Parse error)[^\n]+)/);
  if (mermaidErr) return mermaidErr[1].trim();
  return cleaned.slice(0, 300) || 'Compilation failed';
}

/**
 * Compile Mermaid source with a disciplined retry loop:
 *   Attempt 1: compile as-is
 *   Attempt 2: deterministic repair + recompile
 *   Attempt 3: model-assisted repair + deterministic repair + recompile
 *
 * @param {string} mmdSource
 * @param {string} outputDir
 * @param {string} baseName
 * @returns {Promise<{result: object, mmdSource: string, attempts: number, repairChanges: string[]}>}
 */
async function compileWithRetry(mmdSource, outputDir, baseName) {
  const repairChanges = [];

  // Attempt 1: compile as-is
  let result = await compile(mmdSource, outputDir, baseName);
  if (result.ok) return { result, mmdSource, attempts: 1, repairChanges };

  const attempt1Error = _sanitizeCompileError(result.error);
  logger.warn('compile.attempt1_failed', { baseName, error: attempt1Error });

  // Attempt 2: deterministic repair + recompile
  const repaired = deterministicRepair(mmdSource);
  if (repaired.changes.length > 0) {
    repairChanges.push(...repaired.changes);
    logger.info('compile.deterministic_repair', { changes: repaired.changes });
    result = await compile(repaired.source, outputDir, baseName);
    if (result.ok) return { result, mmdSource: repaired.source, attempts: 2, repairChanges };
  }

  const sourceForModelRepair = repaired.changes.length > 0 ? repaired.source : mmdSource;
  const attempt2Error = _sanitizeCompileError(result.error);
  logger.warn('compile.attempt2_failed', { baseName, error: attempt2Error });

  // Attempt 3: model-assisted repair via provider + deterministic repair + recompile
  const repairUserPrompt = buildModelRepairUserPrompt(sourceForModelRepair, attempt2Error);
  const modelResult = await provider.infer('model_repair', { userPrompt: repairUserPrompt });

  if (modelResult.output && modelResult.output.trim() !== sourceForModelRepair.trim()) {
    const firstLine = modelResult.output.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    if (firstLine && VALID_DIRECTIVE_RE.test(firstLine.trim())) {
      repairChanges.push(`model-assisted repair via ${modelResult.provider}`);
      const reRepaired = deterministicRepair(modelResult.output);
      if (reRepaired.changes.length > 0) repairChanges.push(...reRepaired.changes);
      result = await compile(reRepaired.source, outputDir, baseName);
      if (result.ok) return { result, mmdSource: reRepaired.source, attempts: 3, repairChanges };
    }
  }

  logger.error('compile.all_attempts_failed', { baseName, attempts: 3 });
  return { result, mmdSource, attempts: 3, repairChanges };
}

// ---- Provider-backed render-prepare for text/md inputs --------------------

/**
 * Use the inference provider to convert text or markdown into valid Mermaid.
 * Falls back to localTextToMmd if provider returns unusable output.
 *
 * @param {string} source - Raw user text
 * @param {object} profile - InputProfile from input-analyzer
 * @returns {Promise<{mmdSource: string, enhanced: boolean, provider: string, stagesExecuted: string[]}>}
 */
async function renderPrepare(source, profile, useMax = false) {
  const stagesExecuted = [];
  const userPrompt = buildRenderPrepareUserPrompt(source, profile);

  const inferFn = useMax ? provider.inferMax : provider.infer;
  const result = await inferFn('render_prepare', { userPrompt });
  stagesExecuted.push(useMax ? 'render_prepare_max' : 'render_prepare');

  if (result.output) {
    const firstLine = result.output.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    if (firstLine && VALID_DIRECTIVE_RE.test(firstLine.trim())) {
      logger.info('render_prepare.success', { provider: result.provider, outputLen: result.output.length });
      return {
        mmdSource: result.output,
        enhanced: true,
        provider: result.provider,
        stagesExecuted,
      };
    }
    logger.warn('render_prepare.invalid_output', { provider: result.provider, firstLine: firstLine?.slice(0, 80) });
  }

  // Fallback: local conversion
  const shadow = profile?.shadow || extractShadow(source);
  const mmdSource = localTextToMmd(source, shadow);
  stagesExecuted.push('local_fallback');
  return { mmdSource, enhanced: false, provider: 'local', stagesExecuted };
}

// ---- Decompose-and-render for complex inputs --------------------------------

async function decomposeAndRender(source, profile, useMax = false) {
  const stagesExecuted = [];
  const { buildDecomposeUserPrompt } = require('./axiom-prompts');

  const decomposePrompt = buildDecomposeUserPrompt(source, profile);
  const decomposeResult = await provider.infer('decompose', { userPrompt: decomposePrompt });
  stagesExecuted.push('decompose');

  let subViews = null;
  if (decomposeResult.output) {
    try {
      const raw = decomposeResult.output.trim();
      const jsonStart = raw.indexOf('[');
      const jsonEnd = raw.lastIndexOf(']');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        subViews = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      }
    } catch { /* invalid JSON */ }
  }

  if (!Array.isArray(subViews) || subViews.length < 2) {
    logger.warn('decompose.fallback', { reason: 'invalid or insufficient sub-views' });
    return renderPrepare(source, profile, useMax);
  }

  logger.info('decompose.success', { viewCount: subViews.length, provider: decomposeResult.provider });

  const results = [];
  for (const view of subViews.slice(0, 4)) {
    const viewDesc = view.viewDescription || view.description || '';
    if (!viewDesc) continue;

    const viewProfile = analyze(viewDesc, 'idea');
    const prep = await renderPrepare(viewDesc, viewProfile, useMax);
    stagesExecuted.push(`render_subview:${view.viewName || 'unnamed'}`);

    const outputDir = require('node:path').join(require('node:path').resolve(__dirname, '..', '..'), 'flows', '_tmp_subview_' + Date.now());
    const compileOut = await compileWithRetry(prep.mmdSource, outputDir, 'subview');

    if (!compileOut.result.ok) {
      const { buildRepairFromTraceUserPrompt } = require('./axiom-prompts');
      const tracePrompt = buildRepairFromTraceUserPrompt(
        prep.mmdSource,
        compileOut.result.error || 'compilation failed',
        profile.shadow,
        viewDesc,
      );
      const repairResult = await provider.infer('repair_from_trace', { userPrompt: tracePrompt });
      stagesExecuted.push('repair_from_trace');

      if (repairResult.output) {
        const repairedCompile = await compileWithRetry(repairResult.output, outputDir, 'subview');
        if (repairedCompile.result.ok) {
          results.push({ mmdSource: repairedCompile.mmdSource, score: 1.0, viewName: view.viewName, compileResult: repairedCompile.result });
          continue;
        }
      }
      results.push({ mmdSource: prep.mmdSource, score: 0.0, viewName: view.viewName, compileResult: compileOut.result });
    } else {
      const mmdMetrics = require('./mermaid-validator').validate(compileOut.mmdSource);
      const nodeCount = mmdMetrics.stats?.nodeCount || 0;
      const edgeCount = mmdMetrics.stats?.edgeCount || 0;
      const score = mmdMetrics.valid ? (0.5 + 0.3 * Math.min(1, nodeCount / 8) + 0.2 * Math.min(1, edgeCount / 6)) : 0.3;
      results.push({ mmdSource: compileOut.mmdSource, score, viewName: view.viewName, compileResult: compileOut.result });
    }
  }

  if (results.length === 0) {
    logger.warn('decompose.no_results', { reason: 'all sub-views failed' });
    return renderPrepare(source, profile, useMax);
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  logger.info('decompose.selected', { viewName: best.viewName, score: best.score });

  return {
    mmdSource: best.mmdSource,
    enhanced: true,
    provider: decomposeResult.provider,
    stagesExecuted,
  };
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

      // Postcondition: output must start with a valid Mermaid directive
      const mdMmdOutput = result.source;
      const mdFirstLine = mdMmdOutput.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
      const mdHasDirective = mdFirstLine && /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey)\b/i.test(mdFirstLine.trim());

      if (mdHasDirective && mdMmdOutput.trim() !== source.trim()) {
        enhanced = result.enhanced;
        enhanceMeta = result.meta;
        mmdSource = mdMmdOutput;
      } else {
        logger.warn('stage.postcondition_failed', { stage: 'md_to_mmd', path: 'md' });
        // Fallback: try fenced extraction, then local conversion
        const extracted = extractFencedMermaid(source);
        if (extracted) {
          mmdSource = extracted;
          stagesExecuted.push('extract_fenced_fallback');
        } else {
          const shadow = extractShadow(source);
          mmdSource = localTextToMmd(source, shadow);
          stagesExecuted.push('local_md_to_mmd_fallback');
        }
      }
    } else {
      const extracted = extractFencedMermaid(source);
      if (extracted) {
        mmdSource = extracted;
        stagesExecuted.push('extract_fenced');
      } else {
        // Instead of throwing, try local conversion as last resort
        const shadow = extractShadow(source);
        mmdSource = localTextToMmd(source, shadow);
        stagesExecuted.push('local_md_to_mmd_fallback');
      }
    }
    return buildResult(mmdSource, state, enhanced, enhanceMeta, stagesExecuted, startMs, source);
  }

  // ---- PATH A: text input ----
  if (state === CONTENT_STATES.TEXT) {
    if (!enhance || !enhancerUp) {
      logger.info('input.local_fallback', { reason: enhance ? 'enhancer_unavailable' : 'enhance_off' });
      const shadow = extractShadow(source);
      const mmdSource = localTextToMmd(source, shadow);
      stagesExecuted.push('local_text_to_mmd');
      return buildResult(mmdSource, state, false, null, stagesExecuted, startMs, source);
    }

    const diagramHint = selectDiagramType(source);
    logger.info('diagram.selected', { type: diagramHint.type, directive: diagramHint.directive, reason: diagramHint.reason });

    // Stage 1: text -> md
    const mdResult = await enhancerBridge.enhance(source, diagramHint.type, 'text_to_md', state);
    stagesExecuted.push('text_to_md');
    let mdOutput = mdResult.source;

    // Postcondition: if text_to_md returned the input unchanged, fall back locally
    if (mdOutput.trim() === source.trim()) {
      logger.warn('stage.no_op', { stage: 'text_to_md' });
      const shadow = extractShadow(source);
      mmdSource = localTextToMmd(source, shadow);
      stagesExecuted.push('local_text_to_mmd_fallback');
      return buildResult(mmdSource, state, false, null, stagesExecuted, startMs, source);
    }

    // Stage 2: md -> mmd
    const mmdResult = await enhancerBridge.enhance(mdOutput, diagramHint.type, 'md_to_mmd', 'md');
    stagesExecuted.push('md_to_mmd');

    // Postcondition: md_to_mmd output must start with a valid Mermaid directive
    const mmdOutput = mmdResult.source;
    const firstMmdLine = mmdOutput.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    const hasValidDirective = firstMmdLine && /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitgraph|mindmap|timeline|journey|C4Context|C4Container|C4Component|C4Dynamic|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta)\b/i.test(firstMmdLine.trim());

    if (!hasValidDirective) {
      logger.warn('stage.postcondition_failed', { stage: 'md_to_mmd', reason: 'output is not valid Mermaid' });
      const shadow = extractShadow(source);
      mmdSource = localTextToMmd(source, shadow);
      stagesExecuted.push('local_text_to_mmd_fallback');
      return buildResult(mmdSource, state, false, null, stagesExecuted, startMs, source);
    }

    enhanced = true;
    enhanceMeta = mmdResult.meta;
    mmdSource = mmdOutput;

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
  // Run deterministic repairer before validation/classification
  const repairResult = deterministicRepair(mmdSource);
  if (repairResult.changes.length > 0) {
    mmdSource = repairResult.source;
    stagesExecuted.push('deterministic_repair');
    logger.info('deterministic.repair', { changes: repairResult.changes });
  }

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

module.exports = {
  route,
  renderPrepare,
  decomposeAndRender,
  compileWithRetry,
  detect,
  extractFencedMermaid,
  bestEffortExtract,
  RouterError,
};
