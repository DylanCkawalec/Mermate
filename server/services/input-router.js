'use strict';

const { detect, CONTENT_STATES } = require('./input-detector');
const { classify } = require('./mermaid-classifier');
const { selectDiagramType } = require('./diagram-selector');
const { validate } = require('./mermaid-validator');
const { repair: deterministicRepair } = require('./mermaid-repairer');
const { extractShadow, analyze } = require('./input-analyzer');
const {
  buildRenderPrepareUserPrompt, buildModelRepairUserPrompt,
  buildFactExtractionUserPrompt, buildDiagramPlanUserPrompt,
  buildCompositionUserPrompt, buildSemanticRepairUserPrompt,
  buildMaxCompositionUserPrompt,
} = require('./axiom-prompts');
const { validateInvariants, computeHPCScore, validateGraphProperties } = require('./mermaid-validator');
const provider = require('./inference-provider');
const enhancerBridge = require('./gpt-enhancer-bridge');
const rmBridge = require('./rate-master-bridge');
const catalog = require('./model-catalog');
const { Phase, createPhaseTracker } = require('./compiler-phases');
const structuralSig = require('./structural-signature');
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

function _nodeShape(label, entityType) {
  if (entityType === 'actor')      return `(["${label}"])`;
  if (entityType === 'technology') return `[("${label}")]`;
  if (DECISION_RE.test(label))     return `{"${label}"}`;
  if (STORE_RE.test(label))        return `[("${label}")]`;
  if (EXTERNAL_RE.test(label))     return `(["${label}"])`;
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
  for (const [label, id] of nodeMap) mmd += `    ${id}${_nodeShape(label, null)}\n`;
  for (const edge of edges)          mmd += `    ${edge.from} --> ${edge.to}\n`;
  return mmd;
}

function _shadowToFlowchart(directive, shadow) {
  const nodeMap = new Map();
  let counter = 0;
  const RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'style', 'class', 'click', 'default']);

  function _toId(name) {
    let clean = name.replace(/[^a-zA-Z0-9]/g, '');
    let id = clean.charAt(0).toUpperCase() + clean.slice(1);
    if (!id) id = 'N' + (++counter);
    if (RESERVED.has(id.toLowerCase())) id += 'Node';
    return id;
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
      const label = rel.verb ? `|"${rel.verb}"|` : '';
      edges.push({ from: fromId, to: toId, style: edgeStyle, label });
    }
  }

  const failureSourceNodes = new Set();
  for (const fp of shadow.failurePaths) {
    const desc = fp.description.toLowerCase();
    let sourceNode = null;
    for (const [key, node] of nodeMap) {
      if (desc.includes(key)) { sourceNode = node.id; break; }
    }
    if (!sourceNode) {
      const runtimeEdge = edges.find(e => e.style === '-->');
      sourceNode = runtimeEdge?.from;
    }
    if (sourceNode && !failureSourceNodes.has(sourceNode)) {
      failureSourceNodes.add(sourceNode);
      const failTarget = getOrCreate('Error Recovery', 'decision');
      const shortDesc = fp.description.slice(0, 30).replace(/"/g, "'");
      edges.push({ from: sourceNode, to: failTarget, style: '-.->', label: `|"${shortDesc}"|` });
    }
  }

  const hasBoundaries = shadow.boundaryTerms.length > 0;
  const boundaryMap = new Map();

  if (hasBoundaries) {
    for (const term of shadow.boundaryTerms) {
      boundaryMap.set(term.toLowerCase(), []);
    }
    for (const [key, node] of nodeMap) {
      let assigned = false;
      for (const [bTerm, bNodes] of boundaryMap) {
        if (key.includes(bTerm) || node.name.toLowerCase().includes(bTerm)) {
          bNodes.push(node);
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        const defaultBoundary = shadow.boundaryTerms[0].toLowerCase();
        boundaryMap.get(defaultBoundary)?.push(node);
      }
    }
  }

  let mmd = directive + '\n';

  if (hasBoundaries && boundaryMap.size > 0) {
    let sgIndex = 0;
    for (const [bTerm, bNodes] of boundaryMap) {
      if (bNodes.length === 0) continue;
      const sgId = 'SG' + (sgIndex++);
      const sgLabel = bTerm.charAt(0).toUpperCase() + bTerm.slice(1);
      mmd += `    subgraph ${sgId}["${sgLabel}"]\n`;
      for (const node of bNodes) {
        mmd += `        ${node.id}${_nodeShape(node.name, node.type)}\n`;
      }
      mmd += `    end\n`;
    }
  } else {
    for (const [, node] of nodeMap) {
      mmd += `    ${node.id}${_nodeShape(node.name, node.type)}\n`;
    }
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
  const rt = _rt();
  const phases = createPhaseTracker(_auditEmit, _activeRunId);
  phases.enter(Phase.ANALYZE);

  const inferFn = useMax ? provider.inferMax : provider.infer;
  const callStart = Date.now();
  const result = await inferFn('render_prepare', { userPrompt });
  stagesExecuted.push(useMax ? 'render_prepare_max' : 'render_prepare');

  if (rt) {
    const stageLabel = useMax ? 'render_prepare_max' : 'render_prepare';
    rt.addStage(_activeRunId, stageLabel);
    const contextEst = rmBridge.estimateContextSize('render_prepare', userPrompt);
    rt.recordAgentCall(_activeRunId, {
      stage: 'render_prepare', model: result.model, provider: result.provider,
      promptText: userPrompt, outputText: result.output || '',
      latencyMs: result.latencyMs || (Date.now() - callStart),
      success: !!result.output, outputType: 'text',
      actionTag: result.actionTag || null,
      contextEst,
    });
    if (result.rateEvents) {
      for (const re of result.rateEvents) rt.recordRateEvent(_activeRunId, re);
    }
  }

  if (result.output) {
    const firstLine = result.output.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    if (firstLine && VALID_DIRECTIVE_RE.test(firstLine.trim())) {
      const fragmentCheck = _checkForProseFragments(result.output);
      if (fragmentCheck.clean) {
        logger.info('render_prepare.success', { provider: result.provider, outputLen: result.output.length });
        return {
          mmdSource: result.output,
          enhanced: true,
          provider: result.provider,
          stagesExecuted,
        };
      }
      logger.warn('render_prepare.prose_fragments_detected', {
        provider: result.provider,
        fragments: fragmentCheck.fragments.slice(0, 5),
      });
    } else {
      logger.warn('render_prepare.invalid_output', { provider: result.provider, firstLine: firstLine?.slice(0, 80) });
    }
  }

  const shadow = profile?.shadow || extractShadow(source);
  const mmdSource = localTextToMmd(source, shadow);
  stagesExecuted.push('local_fallback');
  return { mmdSource, enhanced: false, provider: 'local', stagesExecuted };
}

// ---- HPC-GoT Bounded Render Pipeline ----------------------------------------

const { getConfig: getGotConfig } = require('./got-config');

/**
 * Parse strict JSON from LLM output, tolerating markdown fencing.
 */
function _parseStrictJSON(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();
  // Strip markdown fencing
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
}

/**
 * Validate Stage 1 facts structure.
 */
function _validateFacts(facts) {
  if (!facts || typeof facts !== 'object') return { valid: false, reason: 'not an object' };
  if (!Array.isArray(facts.entities) || facts.entities.length === 0) return { valid: false, reason: 'no entities' };
  if (!Array.isArray(facts.relationships)) return { valid: false, reason: 'relationships not an array' };

  const validTypes = new Set(['actor', 'service', 'store', 'gateway', 'broker', 'cache', 'queue', 'external', 'decision', 'boundary']);
  for (const e of facts.entities) {
    if (!e.name || !e.type) return { valid: false, reason: `entity missing name or type: ${JSON.stringify(e)}` };
    if (!validTypes.has(e.type)) {
      e.type = 'service'; // auto-correct to default
    }
  }
  return { valid: true };
}

/**
 * Validate Stage 2 plan structure against Stage 1 facts.
 */
function _validatePlan(plan, facts) {
  if (!plan || typeof plan !== 'object') return { valid: false, reason: 'not an object' };
  if (!plan.directive) return { valid: false, reason: 'missing directive' };
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) return { valid: false, reason: 'no nodes' };
  if (!Array.isArray(plan.edges)) return { valid: false, reason: 'edges not an array' };

  // Check plan nodes reference facts entities
  const factEntityNames = new Set((facts.entities || []).map(e => e.name.toLowerCase()));
  let planEntityCoverage = 0;
  for (const node of plan.nodes) {
    if (!node.id || !node.label) continue;
    const ref = (node.entityRef || node.label || '').toLowerCase();
    if (factEntityNames.has(ref) || [...factEntityNames].some(n => ref.includes(n) || n.includes(ref))) {
      planEntityCoverage++;
    }
  }
  const coverage = facts.entities.length > 0 ? planEntityCoverage / facts.entities.length : 1;

  // Check edge labels <= 6 words
  for (const edge of plan.edges) {
    if (edge.label && edge.label.split(/\s+/).length > 6) {
      edge.label = edge.label.split(/\s+/).slice(0, 6).join(' ');
    }
  }

  // Check nesting depth <= 3
  const subgraphs = plan.subgraphs || [];
  if (subgraphs.length > 10) {
    plan.subgraphs = subgraphs.slice(0, 10);
  }

  return { valid: true, coverage: +coverage.toFixed(3) };
}

/**
 * HPC-GoT bounded render pipeline: 3-stage fact→plan→compose with
 * deterministic invariant validation and structured semantic repair.
 *
 * @param {string} source - User's original text
 * @param {object} profile - InputProfile from input-analyzer
 * @param {boolean} [useMax=false] - Use Max-tier inference
 * @returns {Promise<{mmdSource: string, enhanced: boolean, provider: string, stagesExecuted: string[], facts?: object, plan?: object, hpcScore?: object}>}
 */
let _auditEmit = null;
let _activeRunId = null;

function _setAuditEmitter(fn) { _auditEmit = fn; }
function _audit(type, data) { if (_auditEmit) _auditEmit(type, data); }
function _setRunId(runId) { _activeRunId = runId; }

let _runTrackerRef = null;
function _rt() {
  if (!_activeRunId) return null;
  if (!_runTrackerRef) {
    try { _runTrackerRef = require('./run-tracker'); } catch { return null; }
  }
  return _runTrackerRef;
}

async function renderHPCGoT(source, profile, useMax = false) {
  const stagesExecuted = [];
  const inferFn = useMax ? provider.inferMax : provider.infer;
  const gotCfg = getGotConfig();
  const rt = _rt();
  const phases = createPhaseTracker(_auditEmit, _activeRunId);

  let stateCount = 1;
  _audit('got:root_init', { stateBudget: gotCfg.stateBudget, depth: gotCfg.maxDepth });

  // ════════════════════════════════════════════════════════════════════════
  // Phase: ANALYZE — extract facts, build diagram plan
  // ════════════════════════════════════════════════════════════════════════
  phases.enter(Phase.ANALYZE, { useMax });
  _audit('render:hpc_stage1', { stage: 'fact_extraction', useMax });
  if (rt) rt.addStage(_activeRunId, 'fact_extraction');
  const factUserPrompt = buildFactExtractionUserPrompt(source, profile);
  const factCallStart = Date.now();
  const factResult = await inferFn('fact_extraction', { userPrompt: factUserPrompt });
  stagesExecuted.push('fact_extraction');

  if (rt) {
    const factContextEst = rmBridge.estimateContextSize('fact_extraction', factUserPrompt);
    rt.recordAgentCall(_activeRunId, {
      stage: 'fact_extraction', model: factResult.model, provider: factResult.provider,
      promptText: factUserPrompt, outputText: factResult.output || '',
      latencyMs: factResult.latencyMs || (Date.now() - factCallStart),
      success: !!factResult.output, outputType: 'json',
      actionTag: factResult.actionTag || null,
      contextEst: factContextEst,
    });
    if (factResult.rateEvents) for (const re of factResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
  }

  const facts = _parseStrictJSON(factResult.output);
  const factValidation = _validateFacts(facts);

  if (!factValidation.valid) {
    logger.warn('hpc.stage1_failed', { reason: factValidation.reason, provider: factResult.provider });
    // Fall back to legacy renderPrepare
    return renderPrepare(source, profile, useMax);
  }

  // Enrich facts with shadow data if available
  if (profile?.shadow) {
    const shadow = profile.shadow;
    // Add any shadow entities not already in facts
    const factEntityNames = new Set(facts.entities.map(e => e.name.toLowerCase()));
    for (const se of (shadow.entities || [])) {
      if (!factEntityNames.has(se.name.toLowerCase())) {
        facts.entities.push({ name: se.name, type: se.type || 'service', responsibility: 'detected' });
      }
    }
  }

  if (facts.entities.length > gotCfg.maxEntities) {
    logger.info('hpc.capping_entities', { original: facts.entities.length, capped: gotCfg.maxEntities });
    facts.entities = facts.entities.slice(0, gotCfg.maxEntities);
  }
  if ((facts.relationships || []).length > gotCfg.maxRelationships) {
    logger.info('hpc.capping_relationships', { original: facts.relationships.length, capped: gotCfg.maxRelationships });
    facts.relationships = facts.relationships.slice(0, gotCfg.maxRelationships);
  }

  logger.info('hpc.stage1_complete', {
    entities: facts.entities.length,
    relationships: (facts.relationships || []).length,
    boundaries: (facts.boundaries || []).length,
    failurePaths: (facts.failurePaths || []).length,
    provider: factResult.provider,
  });

  // ---- Stage 2: Diagram Plan ---
  _audit('render:hpc_stage2', { stage: 'diagram_plan', entities: facts.entities.length });
  if (rt) rt.addStage(_activeRunId, 'diagram_plan');
  const planUserPrompt = buildDiagramPlanUserPrompt(facts, profile);
  const planCallStart = Date.now();
  const planResult = await inferFn('diagram_plan', { userPrompt: planUserPrompt });
  stagesExecuted.push('diagram_plan');

  if (rt) {
    const planContextEst = rmBridge.estimateContextSize('diagram_plan', planUserPrompt);
    rt.recordAgentCall(_activeRunId, {
      stage: 'diagram_plan', model: planResult.model, provider: planResult.provider,
      promptText: planUserPrompt, outputText: planResult.output || '',
      latencyMs: planResult.latencyMs || (Date.now() - planCallStart),
      success: !!planResult.output, outputType: 'json',
      actionTag: planResult.actionTag || null,
      contextEst: planContextEst,
    });
    if (planResult.rateEvents) for (const re of planResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
  }

  const plan = _parseStrictJSON(planResult.output);
  const planValidation = _validatePlan(plan, facts);

  if (!planValidation.valid) {
    logger.warn('hpc.stage2_failed', { reason: planValidation.reason, provider: planResult.provider });
    return renderPrepare(source, profile, useMax);
  }

  logger.info('hpc.stage2_complete', {
    nodes: plan.nodes.length,
    edges: plan.edges.length,
    subgraphs: (plan.subgraphs || []).length,
    coverage: planValidation.coverage,
    provider: planResult.provider,
  });

  // ---- Stage 3: 2-Branch Composition (GoT branching at composition level) ---
  _audit('render:hpc_stage3', { stage: 'composition', nodes: plan.nodes.length, edges: plan.edges.length, branches: 2 });
  const compUserPrompt = buildCompositionUserPrompt(plan, facts);

  // Branch: generate 2 structurally competing compositions concurrently.
  // Branch A: top-down layout grouped by architectural boundary (default).
  // Branch B: left-right layout grouped by data-flow stage for genuine divergence.
  _audit('got:branch_start', { level: 2, branchCount: 2 });
  const branchBDirective = [
    '',
    '%% BRANCH-B COMPOSITION DIRECTIVE — structural alternative',
    '%% Use LR (left-to-right) layout direction instead of TB.',
    '%% Group nodes by data-flow stage rather than architectural boundary.',
    '%% Prioritize edge label clarity over subgraph nesting depth.',
    '%% Prefer flat subgraph structure with explicit cross-stage edges.',
  ].join('\n');
  if (rt) rt.addStage(_activeRunId, 'composition');
  const compCallStart = Date.now();
  const [compResultA, compResultB] = await Promise.all([
    inferFn('composition', { userPrompt: compUserPrompt }),
    inferFn('composition', { userPrompt: compUserPrompt + branchBDirective }),
  ]);
  stagesExecuted.push('composition_branch_a', 'composition_branch_b');
  stateCount += 2;
  _audit('got:branch_end', { branchCount: 2, stateCount });

  if (rt) {
    const compLatency = Date.now() - compCallStart;
    const compContextEstA = rmBridge.estimateContextSize('composition', compUserPrompt);
    const compContextEstB = rmBridge.estimateContextSize('composition', compUserPrompt + branchBDirective);
    rt.recordAgentCall(_activeRunId, {
      stage: 'composition', role: 'branch_a', model: compResultA.model, provider: compResultA.provider,
      promptText: compUserPrompt, outputText: compResultA.output || '',
      latencyMs: compResultA.latencyMs || compLatency, success: !!compResultA.output, outputType: 'text',
      batchId: 'composition_branches',
      actionTag: compResultA.actionTag || null,
      contextEst: compContextEstA,
    });
    rt.recordAgentCall(_activeRunId, {
      stage: 'composition', role: 'branch_b', model: compResultB.model, provider: compResultB.provider,
      promptText: compUserPrompt + branchBDirective, outputText: compResultB.output || '',
      latencyMs: compResultB.latencyMs || compLatency, success: !!compResultB.output, outputType: 'text',
      batchId: 'composition_branches',
      actionTag: compResultB.actionTag || null,
      contextEst: compContextEstB,
    });
    for (const r of [compResultA, compResultB]) {
      if (r.rateEvents) for (const re of r.rateEvents) rt.recordRateEvent(_activeRunId, re);
    }
  }

  function _cleanComposition(raw) {
    if (!raw) return null;
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:mermaid)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const fl = cleaned.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    if (!fl || !VALID_DIRECTIVE_RE.test(fl.trim())) return null;
    return cleaned;
  }

  const candidateA = _cleanComposition(compResultA.output);
  const candidateB = _cleanComposition(compResultB.output);

  // ════════════════════════════════════════════════════════════════════════
  // Phase: VALIDATE — score branches via HPC (structural + invariant)
  // ════════════════════════════════════════════════════════════════════════
  phases.enter(Phase.VALIDATE);

  const scoreA = candidateA ? computeHPCScore(candidateA, facts) : { score: 0, sv: 0, ic: 0 };
  const scoreB = candidateB ? computeHPCScore(candidateB, facts) : { score: 0, sv: 0, ic: 0 };
  _audit('got:validate', { branchA: scoreA.score, branchB: scoreB.score });

  logger.info('hpc.branch_scores', {
    branchA: scoreA.score, svA: scoreA.sv, icA: scoreA.ic,
    branchB: scoreB.score, svB: scoreB.sv, icB: scoreB.ic,
  });

  if (rt) {
    rt.recordBranch(_activeRunId, {
      parentStateId: 'root', level: 2, label: 'composition_branch_A',
      score: { composite: scoreA.score, sv: scoreA.sv, ic: scoreA.ic },
      decision: candidateA && scoreA.score >= gotCfg.pruneThreshold * 0.7 ? 'retained' : 'pruned',
    });
    rt.recordBranch(_activeRunId, {
      parentStateId: 'root', level: 2, label: 'composition_branch_B',
      score: { composite: scoreB.score, sv: scoreB.sv, ic: scoreB.ic },
      decision: candidateB && scoreB.score >= gotCfg.pruneThreshold * 0.7 ? 'retained' : 'pruned',
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase: SELECT — prune below threshold, pick best survivor
  // ════════════════════════════════════════════════════════════════════════
  phases.enter(Phase.SELECT);

  const softTau = gotCfg.pruneThreshold * 0.7;
  const survivors = [];
  if (candidateA && scoreA.score >= softTau) survivors.push({ mmd: candidateA, score: scoreA, provider: compResultA.provider, label: 'A' });
  if (candidateB && scoreB.score >= softTau) survivors.push({ mmd: candidateB, score: scoreB, provider: compResultB.provider, label: 'B' });
  _audit('got:prune', { kept: survivors.length, total: 2, tau: softTau });

  if (survivors.length === 0) {
    logger.warn('hpc.stage3_all_pruned');
    return renderPrepare(source, profile, useMax);
  }

  // Select best survivor
  survivors.sort((a, b) => b.score.score - a.score.score);
  let mmdSource = survivors[0].mmd;
  let hpcScore = survivors[0].score;

  // ════════════════════════════════════════════════════════════════════════
  // Phase: MERGE — terminal merge of surviving branches
  // ════════════════════════════════════════════════════════════════════════
  phases.enter(Phase.MERGE, { survivorCount: survivors.length });

  if (survivors.length >= 2 && gotCfg.mergeEnabled) {
    _audit('got:merge_eval', { candidateCount: survivors.length });

    // Parallel shadow extraction — both are independent pure computations
    const [bestShadow, runnerShadow] = await Promise.all([
      Promise.resolve(extractShadow(survivors[0].mmd)),
      Promise.resolve(extractShadow(survivors[1].mmd)),
    ]);
    const bestEntities = new Set((bestShadow.entities || []).map(e => e.name.toLowerCase()));

    // Find compatible elements: entities in runner-up not already in best
    const compatibleEntities = (runnerShadow.entities || []).filter(e => !bestEntities.has(e.name.toLowerCase()));

    if (compatibleEntities.length > 0 && compatibleEntities.length <= 5) {
      // Lightweight merge: append compatible nodes as additional entries
      const entityLines = compatibleEntities.map(e => {
        const id = e.name.replace(/[^a-zA-Z0-9]/g, '');
        return `    ${id}["${e.name}"]`;
      }).join('\n');
      const mergedMmd = mmdSource.trim() + '\n' + entityLines;
      const mergedScore = computeHPCScore(mergedMmd, facts);

      if (mergedScore.score >= hpcScore.score) {
        _audit('got:merge_accept', { score: mergedScore.score, added: compatibleEntities.length });
        logger.info('hpc.merge_accepted', { oldScore: hpcScore.score, newScore: mergedScore.score, added: compatibleEntities.length });
        mmdSource = mergedMmd;
        hpcScore = mergedScore;
        stagesExecuted.push('merge_accepted');
      } else {
        _audit('got:merge_reject', { reason: 'score_decreased', oldScore: hpcScore.score, newScore: mergedScore.score });
        logger.info('hpc.merge_rejected', { reason: 'score_decreased' });
      }
    }
  }

  _audit('render:validate', { score: hpcScore.score, sv: hpcScore.sv, ic: hpcScore.ic, valid: hpcScore.sv > 0 });
  logger.info('hpc.stage3_initial_score', { score: hpcScore.score, sv: hpcScore.sv, ic: hpcScore.ic });

  let repairAttempt = 0;
  while (hpcScore.score < gotCfg.pruneThreshold && repairAttempt < gotCfg.maxRepairAttempts) {
    if (stateCount >= gotCfg.stateBudget) {
      logger.info('hpc.state_budget_reached', { stateCount, budget: gotCfg.stateBudget });
      break;
    }
    repairAttempt++;
    stateCount++;
    const invariantResult = validateInvariants(mmdSource, facts, plan);

    _audit('render:repair', { attempt: repairAttempt, stateCount, missingEntities: invariantResult.trace.missingEntities.length });
    logger.info('hpc.semantic_repair', {
      attempt: repairAttempt,
      missingEntities: invariantResult.trace.missingEntities.length,
      missingRelationships: invariantResult.trace.missingRelationships.length,
      proseFragments: invariantResult.trace.proseFragments.length,
    });

    const repairUserPrompt = buildSemanticRepairUserPrompt(mmdSource, invariantResult.trace, plan, facts);
    const repairCallStart = Date.now();
    const repairResult = await inferFn('semantic_repair', { userPrompt: repairUserPrompt });
    stagesExecuted.push(`semantic_repair_${repairAttempt}`);

    if (rt) {
      rt.addStage(_activeRunId, `semantic_repair_${repairAttempt}`);
      const repairContextEst = rmBridge.estimateContextSize('semantic_repair', repairUserPrompt);
      rt.recordAgentCall(_activeRunId, {
        stage: 'semantic_repair', model: repairResult.model, provider: repairResult.provider,
        promptText: repairUserPrompt, outputText: repairResult.output || '',
        latencyMs: repairResult.latencyMs || (Date.now() - repairCallStart),
        success: !!repairResult.output, outputType: 'text',
        actionTag: repairResult.actionTag || null,
        contextEst: repairContextEst,
      });
      if (repairResult.rateEvents) for (const re of repairResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
    }

    if (!repairResult.output) break;

    let repairedSource = repairResult.output;
    if (repairedSource.trim().startsWith('```')) {
      repairedSource = repairedSource.trim().replace(/^```(?:mermaid)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const repairedFirstLine = repairedSource.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
    if (!repairedFirstLine || !VALID_DIRECTIVE_RE.test(repairedFirstLine.trim())) break;

    const newScore = computeHPCScore(repairedSource, facts);

    // Only accept repair if score does not decrease
    if (newScore.score >= hpcScore.score) {
      mmdSource = repairedSource;
      hpcScore = newScore;
      logger.info('hpc.repair_accepted', { attempt: repairAttempt, newScore: newScore.score });
    } else {
      logger.info('hpc.repair_rejected', { attempt: repairAttempt, oldScore: hpcScore.score, newScore: newScore.score });
      break;
    }
  }

  // Final pruning check
  if (hpcScore.score < gotCfg.pruneThreshold * 0.7) {
    _audit('render:fallback', { reason: 'below_prune_threshold', score: hpcScore.score });
    logger.warn('hpc.below_prune_threshold', { score: hpcScore.score, threshold: gotCfg.pruneThreshold * 0.7 });
    const legacy = await renderPrepare(source, profile, useMax);
    legacy.stagesExecuted = [...stagesExecuted, ...legacy.stagesExecuted, 'legacy_fallback'];
    return legacy;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase: OUTPUT — compute structural signature, assemble protocol result
  // ════════════════════════════════════════════════════════════════════════
  phases.enter(Phase.OUTPUT);

  // Structural signature: first-class compiler artifact
  let signature = null;
  try { signature = structuralSig.extract(mmdSource); } catch { /* advisory */ }

  const phaseSummary = phases.summary();

  return {
    mmdSource,
    enhanced: true,
    provider: survivors[0]?.provider || compResultA.provider,
    stagesExecuted,
    facts,
    plan,
    hpcScore,
    stateCount,
    structuralSignature: signature,
    phaseSummary,
  };
}

// ---- Max Upgrade: architect-grade recomposition via strongest model ----------

/**
 * Strict .mmd contract enforcement: strip any non-Mermaid content from
 * model output and validate it's a pure Mermaid artifact.
 * @param {string} raw
 * @returns {{ mmd: string|null, violations: string[] }}
 */
function _enforceMmdContract(raw) {
  const violations = [];
  if (!raw || typeof raw !== 'string') {
    return { mmd: null, violations: ['empty output'] };
  }

  let cleaned = raw.trim();

  // Strip markdown fencing
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:mermaid|mmd)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    violations.push('stripped markdown fencing');
  }

  // Strip any leading prose lines before the directive
  const lines = cleaned.split('\n');
  let directiveIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%')) continue;
    if (VALID_DIRECTIVE_RE.test(line)) {
      directiveIdx = i;
      break;
    }
  }

  if (directiveIdx < 0) {
    return { mmd: null, violations: ['no valid Mermaid directive found'] };
  }

  if (directiveIdx > 0) {
    const stripped = lines.slice(0, directiveIdx).filter(l => l.trim() && !l.trim().startsWith('%%'));
    if (stripped.length > 0) {
      violations.push(`stripped ${stripped.length} leading prose lines`);
    }
    cleaned = lines.slice(directiveIdx).join('\n');
  } else {
    cleaned = lines.join('\n');
  }

  // Strip any trailing prose after the Mermaid body
  const trailingProseRe = /\n\n[A-Z][^\n]{20,}$/;
  if (trailingProseRe.test(cleaned)) {
    cleaned = cleaned.replace(trailingProseRe, '');
    violations.push('stripped trailing prose');
  }

  return { mmd: cleaned.trim(), violations };
}

/**
 * Max Upgrade pipeline: runs normal HPC-GoT to get a baseline, then
 * calls the strongest model with a dedicated architect-grade prompt
 * to recompose the diagram. Returns the better of baseline vs Max.
 *
 * @param {string} source - User's original text
 * @param {object} profile - InputProfile from input-analyzer
 * @returns {Promise<{mmdSource: string, enhanced: boolean, provider: string, stagesExecuted: string[], facts?: object, plan?: object, hpcScore?: object}>}
 */
async function renderMaxUpgrade(source, profile) {
  // Step 1: Run normal HPC-GoT to get a baseline
  const baseline = await renderHPCGoT(source, profile, false);
  const baselineStages = [...baseline.stagesExecuted];

  // If baseline completely failed (fell back to local), still try Max
  const facts = baseline.facts;
  const plan = baseline.plan;

  if (!facts || !facts.entities?.length) {
    // No facts extracted — can't do Max upgrade meaningfully.
    // Run inferMax on the raw HPC pipeline instead.
    logger.info('max.no_baseline_facts', { reason: 'running full HPC-GoT with Max model' });
    return renderHPCGoT(source, profile, true);
  }

  // Step 2: Call Max model with architect-grade composition prompt
  const rt = _rt();
  if (rt) rt.addStage(_activeRunId, 'max_composition');
  const maxUserPrompt = buildMaxCompositionUserPrompt(
    baseline.mmdSource, facts, plan, source,
  );
  const maxCallStart = Date.now();
  const maxResult = await provider.inferMax('max_composition', { userPrompt: maxUserPrompt });
  const stagesExecuted = [...baselineStages, 'max_composition'];

  if (rt) {
    const maxContextEst = rmBridge.estimateContextSize('max_composition', maxUserPrompt);
    rt.recordAgentCall(_activeRunId, {
      stage: 'max_composition', model: maxResult.model, provider: maxResult.provider,
      promptText: maxUserPrompt, outputText: maxResult.output || '',
      latencyMs: maxResult.latencyMs || (Date.now() - maxCallStart),
      success: !!maxResult.output, outputType: 'text',
      actionTag: maxResult.actionTag || null,
      contextEst: maxContextEst,
    });
    if (maxResult.rateEvents) for (const re of maxResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
  }

  if (!maxResult.output) {
    logger.warn('max.no_output', { provider: maxResult.provider });
    return { ...baseline, stagesExecuted };
  }

  // Step 3: Enforce strict .mmd contract
  const contract = _enforceMmdContract(maxResult.output);
  if (!contract.mmd) {
    logger.warn('max.contract_violation', { violations: contract.violations });
    return { ...baseline, stagesExecuted: [...stagesExecuted, 'max_contract_failed'] };
  }

  if (contract.violations.length > 0) {
    logger.info('max.contract_cleaned', { violations: contract.violations });
  }

  // Step 4: Score the Max result
  const maxScore = computeHPCScore(contract.mmd, facts);
  const baselineScore = baseline.hpcScore?.score || 0;

  logger.info('max.scored', {
    baselineScore,
    maxScore: maxScore.score,
    maxSv: maxScore.sv,
    maxIc: maxScore.ic,
    provider: maxResult.provider,
  });

  // Step 5: Accept Max if it doesn't regress
  // (Slightly lower threshold — Max output may have richer structure that
  // the simple coverage metric doesn't fully capture)
  if (maxScore.score >= baselineScore * 0.9 && maxScore.sv >= 0.5) {
    logger.info('max.accepted', {
      baselineScore,
      maxScore: maxScore.score,
      improvement: +(maxScore.score - baselineScore).toFixed(3),
    });
    return {
      mmdSource: contract.mmd,
      enhanced: true,
      provider: maxResult.provider,
      stagesExecuted,
      facts,
      plan,
      hpcScore: maxScore,
    };
  }

  // Max result regressed — fall back to baseline
  logger.info('max.rejected', {
    reason: 'Max score regressed below threshold',
    baselineScore,
    maxScore: maxScore.score,
  });
  return { ...baseline, stagesExecuted: [...stagesExecuted, 'max_rejected_fallback'] };
}

// ---- Decompose-and-render for complex inputs --------------------------------

function _extractMmdLabels(mmdSource) {
  const labels = new Set();
  // Match node labels: id["label"], id("label"), id(["label"]), id["label"], id{label}
  const labelPatterns = [
    /\w+\s*\["([^"]+)"\]/g,
    /\w+\s*\("([^"]+)"\)/g,
    /\w+\s*\(\["([^"]+)"\]\)/g,
    /\w+\s*\{"([^"]+)"\}/g,
    /\w+\s*\[([^\]"]+)\]/g,
    /\w+\s*\(([^)"]+)\)/g,
  ];
  for (const re of labelPatterns) {
    let m;
    while ((m = re.exec(mmdSource)) !== null) {
      const label = m[1].trim();
      if (label.length > 1 && label.length < 80) labels.add(label.toLowerCase());
    }
  }
  // Also extract subgraph titles: subgraph Title or subgraph id["Title"]
  const sgRe = /subgraph\s+(?:\w+\s*\["([^"]+)"\]|([^\n[]+))/g;
  let sgm;
  while ((sgm = sgRe.exec(mmdSource)) !== null) {
    const title = (sgm[1] || sgm[2] || '').trim();
    if (title.length > 1 && title.length < 80) labels.add(title.toLowerCase());
  }
  return labels;
}

function _fuzzyEntityMatch(entityName, labelSet) {
  const en = entityName.toLowerCase();
  if (labelSet.has(en)) return true;
  // Check if any label contains the entity name or vice versa (min 4 chars to avoid spurious matches)
  for (const label of labelSet) {
    if (en.length >= 4 && label.includes(en)) return true;
    if (label.length >= 4 && en.includes(label)) return true;
    // Word-boundary match: split entity and label into words, check overlap
    const eWords = en.split(/[\s_\-/]+/).filter(w => w.length >= 3);
    const lWords = label.split(/[\s_\-/]+/).filter(w => w.length >= 3);
    const overlap = eWords.filter(w => lWords.some(lw => lw.includes(w) || w.includes(lw)));
    if (eWords.length > 0 && overlap.length / eWords.length >= 0.5) return true;
  }
  return false;
}

function _scoreSubView(mmdSource, parentShadow) {
  const mmdMetrics = require('./mermaid-validator').validate(mmdSource);
  const nodeCount = mmdMetrics.stats?.nodeCount || 0;
  const edgeCount = mmdMetrics.stats?.edgeCount || 0;

  const compilability = mmdMetrics.valid ? 1.0 : 0.0;

  const labelSet = _extractMmdLabels(mmdSource);
  const parentEntityNames = (parentShadow?.entities || []).map(e => e.name);
  const coveredCount = parentEntityNames.filter(n => _fuzzyEntityMatch(n, labelSet)).length;
  const entityCoverage = parentEntityNames.length > 0
    ? Math.min(1.0, coveredCount / parentEntityNames.length)
    : 0.5;

  const edgeDensity = nodeCount > 1
    ? Math.min(1.0, edgeCount / (nodeCount - 1))
    : 0.0;

  const composite = +(0.4 * compilability + 0.3 * entityCoverage + 0.3 * edgeDensity).toFixed(3);

  return { compilability, entityCoverage, edgeDensity, composite, nodeCount, edgeCount };
}

const PROSE_LABEL_RE = /\[["']?([^"'\]]+)["']?\]/g;
const VERB_PHRASE_RE = /^(redirects?\s+to|goes?\s+to|sends?\s+to|connects?\s+to|routes?\s+to|flows?\s+to|returns?\s+|checks?\s+|validates?\s+|stores?\s+in|reads?\s+from|writes?\s+to)\b/i;

function _checkForProseFragments(mmdSource) {
  const fragments = [];
  let match;
  const re = new RegExp(PROSE_LABEL_RE.source, 'g');
  while ((match = re.exec(mmdSource)) !== null) {
    const label = match[1].trim();
    const words = label.split(/\s+/);
    if (words.length > 10) {
      fragments.push(label.slice(0, 40));
    } else if (VERB_PHRASE_RE.test(label) && words.length <= 4) {
      fragments.push(label);
    }
  }
  return { clean: fragments.length === 0, fragments };
}

function _extractLineNumber(errorStr) {
  if (!errorStr) return null;
  const m = errorStr.match(/(?:Parse error|Error) on line (\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

async function decomposeAndRender(source, profile, useMax = false) {
  const stagesExecuted = [];
  const fsp = require('node:fs/promises');
  const nodePath = require('node:path');
  const PROJECT_ROOT = nodePath.resolve(__dirname, '..', '..');
  const {
    buildDecomposeUserPrompt, buildRepairFromTraceUserPrompt,
    buildMergeCompositionUserPrompt,
  } = require('./axiom-prompts');
  const inferFn = useMax ? provider.inferMax : provider.infer;
  const rt = _rt();

  _audit('decompose:start', { useMax });
  if (rt) rt.addStage(_activeRunId, 'decompose');

  const decomposePrompt = buildDecomposeUserPrompt(source, profile);
  const decompCallStart = Date.now();
  const decomposeResult = await provider.infer('decompose', { userPrompt: decomposePrompt });
  stagesExecuted.push('decompose');

  if (rt) {
    const decompContextEst = rmBridge.estimateContextSize('decompose', decomposePrompt);
    rt.recordAgentCall(_activeRunId, {
      stage: 'decompose', model: decomposeResult.model, provider: decomposeResult.provider,
      promptText: decomposePrompt, outputText: decomposeResult.output || '',
      latencyMs: decomposeResult.latencyMs || (Date.now() - decompCallStart),
      success: !!decomposeResult.output, outputType: 'json',
      actionTag: decomposeResult.actionTag || null,
      contextEst: decompContextEst,
    });
    if (decomposeResult.rateEvents) for (const re of decomposeResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
  }

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

  async function _renderSubView(view, idx) {
    const viewDesc = view.viewDescription || view.description || '';
    if (!viewDesc) return null;

    const viewProfile = analyze(viewDesc, 'idea');
    const prep = await renderPrepare(viewDesc, viewProfile, useMax);

    const viewSlug = (view.viewName || `subview-${idx}`).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const outputDir = nodePath.join(PROJECT_ROOT, 'flows', '_tmp_subview_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const compileOut = await compileWithRetry(prep.mmdSource, outputDir, 'subview');

    if (!compileOut.result.ok) {
      const viewShadow = viewProfile.shadow;
      const errorStr = compileOut.result.error || 'compilation failed';
      const lineNumber = _extractLineNumber(errorStr);

      const tracePrompt = buildRepairFromTraceUserPrompt(
        prep.mmdSource, errorStr, viewShadow, viewDesc,
        { lineNumber, priorAttempts: compileOut.attempts, deterministicChanges: compileOut.repairChanges },
      );
      const repairResult = await provider.infer('repair_from_trace', { userPrompt: tracePrompt });

      if (repairResult.output) {
        const repairedCompile = await compileWithRetry(repairResult.output, outputDir, 'subview');
        if (repairedCompile.result.ok) {
          const repairedScore = _scoreSubView(repairedCompile.mmdSource, profile.shadow);
          return { mmdSource: repairedCompile.mmdSource, score: repairedScore.composite, scoreFactors: repairedScore, viewName: view.viewName, viewSlug, outputDir, compileResult: repairedCompile.result, stages: [`render_subview:${view.viewName || 'unnamed'}`, 'repair_from_trace'] };
        }
      }
      return { mmdSource: prep.mmdSource, score: 0.0, scoreFactors: null, viewName: view.viewName, viewSlug, outputDir, compileResult: compileOut.result, stages: [`render_subview:${view.viewName || 'unnamed'}`] };
    }

    const viewScore = _scoreSubView(compileOut.mmdSource, profile.shadow);
    return { mmdSource: compileOut.mmdSource, score: viewScore.composite, scoreFactors: viewScore, viewName: view.viewName, viewSlug, outputDir, compileResult: compileOut.result, stages: [`render_subview:${view.viewName || 'unnamed'}`] };
  }

  const viewTasks = subViews.slice(0, 6).map((v, i) => _renderSubView(v, i));
  const settled = await Promise.all(viewTasks);
  const results = settled.filter(Boolean);
  for (const r of results) stagesExecuted.push(...r.stages);

  if (results.length === 0) {
    logger.warn('decompose.no_results', { reason: 'all sub-views failed' });
    return renderPrepare(source, profile, useMax);
  }

  results.sort((a, b) => b.score - a.score);

  logger.info('decompose.subviews_complete', {
    count: results.length,
    scores: results.map(r => ({ name: r.viewName, score: r.score })),
  });

  const subviewMmds = [];
  const _writeOps = [];
  for (const r of results) {
    if (r.mmdSource) {
      subviewMmds.push({ viewName: r.viewName || r.viewSlug, mmdSource: r.mmdSource, score: r.score, outputDir: r.outputDir });
      _writeOps.push(fsp.writeFile(nodePath.join(r.outputDir, 'subview.mmd'), r.mmdSource, 'utf8').catch(() => {}));

      if (rt) {
        rt.addSubview(_activeRunId, {
          viewName: r.viewName || r.viewSlug,
          viewDescription: '',
          mmdSource: r.mmdSource,
          score: r.scoreFactors || null,
          compileResult: r.compileResult ? { ok: r.compileResult.ok, attempts: 1 } : null,
          retained: r.score > 0,
          mergeEligible: r.compileResult?.ok && r.score >= (getGotConfig().pruneThreshold * 0.7),
        });
      }
    }
  }
  if (_writeOps.length > 0) await Promise.all(_writeOps);

  // ---- MERGE STEP: combine all subview .mmd into one unified diagram ----
  if (subviewMmds.length >= 2) {
    _audit('decompose:merge_start', { subviewCount: subviewMmds.length });
    stagesExecuted.push('merge_composition');

    if (rt) rt.addStage(_activeRunId, 'merge_composition');
    const mergePrompt = buildMergeCompositionUserPrompt(subviewMmds, source);
    const mergeCallStart = Date.now();
    const mergeResult = await inferFn('merge_composition', { userPrompt: mergePrompt });

    let mergeCallId = null;
    if (rt) {
      const mergeContextEst = rmBridge.estimateContextSize('merge_composition', mergePrompt);
      mergeCallId = rt.recordAgentCall(_activeRunId, {
        stage: 'merge_composition', model: mergeResult.model, provider: mergeResult.provider,
        promptText: mergePrompt, outputText: mergeResult.output || '',
        latencyMs: mergeResult.latencyMs || (Date.now() - mergeCallStart),
        success: !!mergeResult.output, outputType: 'text',
        actionTag: mergeResult.actionTag || null,
        contextEst: mergeContextEst,
      });
      if (mergeResult.rateEvents) for (const re of mergeResult.rateEvents) rt.recordRateEvent(_activeRunId, re);
    }

    if (mergeResult.output) {
      const contract = _enforceMmdContract(mergeResult.output);
      if (contract.mmd) {
        const mergeScore = _scoreSubView(contract.mmd, profile.shadow);
        const bestSingleScore = results[0].score;

        logger.info('decompose.merge_scored', {
          mergeScore: mergeScore.composite,
          bestSingleScore,
          nodeCount: mergeScore.nodeCount,
          edgeCount: mergeScore.edgeCount,
          provider: mergeResult.provider,
        });

        // Accept merge if it covers at least as many entities as the best single subview
        // OR if it has more nodes (broader coverage of the full architecture)
        if (mergeScore.composite >= bestSingleScore * 0.85 || mergeScore.nodeCount > results[0].scoreFactors?.nodeCount) {
          _audit('decompose:merge_accepted', { score: mergeScore.composite, nodes: mergeScore.nodeCount });
          stagesExecuted.push('merge_accepted');

          if (rt) {
            rt.recordMerge(_activeRunId, {
              strategy: 'llm_synthesis',
              inputSubviewIds: subviewMmds.map((_, i) => `subview_${i}`),
              agentCallId: mergeCallId,
              preMergeBestScore: bestSingleScore,
              postMergeScore: mergeScore.composite,
              accepted: true,
            });
          }

          return {
            mmdSource: contract.mmd,
            enhanced: true,
            provider: mergeResult.provider,
            stagesExecuted,
            subviews: subviewMmds,
          };
        }

        if (rt) {
          rt.recordMerge(_activeRunId, {
            strategy: 'llm_synthesis',
            inputSubviewIds: subviewMmds.map((_, i) => `subview_${i}`),
            agentCallId: mergeCallId,
            preMergeBestScore: bestSingleScore,
            postMergeScore: mergeScore.composite,
            accepted: false,
            rejectionReason: 'score_below_threshold',
          });
        }

        _audit('decompose:merge_rejected', { reason: 'score_below_threshold', mergeScore: mergeScore.composite, bestSingleScore });
        logger.info('decompose.merge_rejected', { reason: 'score_below_threshold', mergeScore: mergeScore.composite, bestSingleScore });
      } else {
        logger.warn('decompose.merge_contract_failed', { violations: contract.violations });
      }
    } else {
      logger.warn('decompose.merge_no_output', { provider: mergeResult.provider });
    }
  }

  // Fallback: if merge fails or only one subview, return the best single one
  const best = results[0];
  logger.info('decompose.selected_single', {
    viewName: best.viewName,
    score: best.score,
    candidateCount: results.length,
  });

  return {
    mmdSource: best.mmdSource,
    enhanced: true,
    provider: decomposeResult.provider,
    stagesExecuted,
    subviews: subviewMmds,
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
  // ── VALIDATE: deterministic repair + L0 parse + classify ──
  const repairResult = deterministicRepair(mmdSource);
  if (repairResult.changes.length > 0) {
    mmdSource = repairResult.source;
    stagesExecuted.push('deterministic_repair');
    logger.info('deterministic.repair', { changes: repairResult.changes });
  }

  const diagramType = classify(mmdSource);
  const validation = validate(mmdSource);
  _audit('render:validate', { valid: validation.valid, diagramType, warnings: validation.warnings.length });

  const diagramSelection = (contentState === 'text' && originalSource)
    ? selectDiagramType(originalSource)
    : null;

  if (validation.warnings.length > 0) {
    logger.info('mmd.validation.warnings', { warnings: validation.warnings.map(w => w.message) });
  }
  if (!validation.valid) {
    logger.warn('mmd.validation.errors', { errors: validation.errors.map(e => e.message) });
  }

  // ── OUTPUT: structural signature + graph-theoretic validation ──
  let graphValidation = null;
  let signature = null;
  try {
    signature = structuralSig.extract(mmdSource);
    graphValidation = validateGraphProperties(mmdSource);
    if (graphValidation.issues.length > 0) {
      logger.info('compiler.output.graph', {
        score: graphValidation.score,
        issues: graphValidation.issues,
        complexity: signature.complexityClass,
        hash: signature.topologyHash,
      });
    }
  } catch { /* structural analysis is advisory */ }

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
    graphValidation,
    structuralSignature: signature,
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
  renderHPCGoT,
  renderMaxUpgrade,
  decomposeAndRender,
  compileWithRetry,
  detect,
  extractFencedMermaid,
  bestEffortExtract,
  RouterError,
  _setAuditEmitter,
  _setRunId,
};
