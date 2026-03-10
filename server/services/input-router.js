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
const { validateInvariants, computeHPCScore } = require('./mermaid-validator');
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
        mmd += `        ${node.id}${_nodeShape(node.name)}\n`;
      }
      mmd += `    end\n`;
    }
  } else {
    for (const [, node] of nodeMap) {
      mmd += `    ${node.id}${_nodeShape(node.name)}\n`;
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

// ---- HPC-GoT Bounded Render Pipeline ----------------------------------------

const HPC_PRUNE_THRESHOLD = 0.85;
const HPC_MAX_REPAIR_ATTEMPTS = 2;

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
async function renderHPCGoT(source, profile, useMax = false) {
  const stagesExecuted = [];
  const inferFn = useMax ? provider.inferMax : provider.infer;

  // ---- Stage 1: Typed Architecture Fact Extraction ---
  const factUserPrompt = buildFactExtractionUserPrompt(source, profile);
  const factResult = await inferFn('fact_extraction', { userPrompt: factUserPrompt });
  stagesExecuted.push('fact_extraction');

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

  logger.info('hpc.stage1_complete', {
    entities: facts.entities.length,
    relationships: (facts.relationships || []).length,
    boundaries: (facts.boundaries || []).length,
    failurePaths: (facts.failurePaths || []).length,
    provider: factResult.provider,
  });

  // ---- Stage 2: Diagram Plan ---
  const planUserPrompt = buildDiagramPlanUserPrompt(facts, profile);
  const planResult = await inferFn('diagram_plan', { userPrompt: planUserPrompt });
  stagesExecuted.push('diagram_plan');

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

  // ---- Stage 3: Mermaid Composition ---
  const compUserPrompt = buildCompositionUserPrompt(plan, facts);
  const compResult = await inferFn('composition', { userPrompt: compUserPrompt });
  stagesExecuted.push('composition');

  let mmdSource = compResult.output || '';

  // Strip markdown fencing if present
  if (mmdSource.trim().startsWith('```')) {
    mmdSource = mmdSource.trim().replace(/^```(?:mermaid)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Validate first line is a valid directive
  const firstLine = mmdSource.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
  if (!firstLine || !VALID_DIRECTIVE_RE.test(firstLine.trim())) {
    logger.warn('hpc.stage3_invalid_directive', { firstLine: firstLine?.slice(0, 80) });
    return renderPrepare(source, profile, useMax);
  }

  // ---- Invariant Validation + Bounded Repair ---
  let hpcScore = computeHPCScore(mmdSource, facts);
  logger.info('hpc.stage3_initial_score', { score: hpcScore.score, sv: hpcScore.sv, ic: hpcScore.ic });

  let repairAttempt = 0;
  while (hpcScore.score < HPC_PRUNE_THRESHOLD && repairAttempt < HPC_MAX_REPAIR_ATTEMPTS) {
    repairAttempt++;
    const invariantResult = validateInvariants(mmdSource, facts, plan);

    logger.info('hpc.semantic_repair', {
      attempt: repairAttempt,
      missingEntities: invariantResult.trace.missingEntities.length,
      missingRelationships: invariantResult.trace.missingRelationships.length,
      proseFragments: invariantResult.trace.proseFragments.length,
    });

    const repairUserPrompt = buildSemanticRepairUserPrompt(mmdSource, invariantResult.trace, plan, facts);
    const repairResult = await inferFn('semantic_repair', { userPrompt: repairUserPrompt });
    stagesExecuted.push(`semantic_repair_${repairAttempt}`);

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
  if (hpcScore.score < HPC_PRUNE_THRESHOLD * 0.7) {
    logger.warn('hpc.below_prune_threshold', { score: hpcScore.score, threshold: HPC_PRUNE_THRESHOLD * 0.7 });
    // Score is very low — fall back to legacy path
    const legacy = await renderPrepare(source, profile, useMax);
    legacy.stagesExecuted = [...stagesExecuted, ...legacy.stagesExecuted, 'legacy_fallback'];
    return legacy;
  }

  return {
    mmdSource,
    enhanced: true,
    provider: compResult.provider,
    stagesExecuted,
    facts,
    plan,
    hpcScore,
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
  const maxUserPrompt = buildMaxCompositionUserPrompt(
    baseline.mmdSource, facts, plan, source,
  );
  const maxResult = await provider.inferMax('max_composition', { userPrompt: maxUserPrompt });
  const stagesExecuted = [...baselineStages, 'max_composition'];

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

function _scoreSubView(mmdSource, parentShadow) {
  const mmdMetrics = require('./mermaid-validator').validate(mmdSource);
  const nodeCount = mmdMetrics.stats?.nodeCount || 0;
  const edgeCount = mmdMetrics.stats?.edgeCount || 0;

  const compilability = mmdMetrics.valid ? 1.0 : 0.0;

  const mmdLower = mmdSource.toLowerCase();
  const parentEntityNames = (parentShadow?.entities || []).map(e => e.name.toLowerCase());
  const coveredCount = parentEntityNames.filter(n => mmdLower.includes(n)).length;
  const entityCoverage = parentEntityNames.length > 0
    ? Math.min(1.0, coveredCount / parentEntityNames.length)
    : 0.5;

  const edgeDensity = nodeCount > 1
    ? Math.min(1.0, edgeCount / (nodeCount - 1))
    : 0.0;

  const composite = +(0.4 * compilability + 0.3 * entityCoverage + 0.3 * edgeDensity).toFixed(3);

  return { compilability, entityCoverage, edgeDensity, composite, nodeCount, edgeCount };
}

function _extractLineNumber(errorStr) {
  if (!errorStr) return null;
  const m = errorStr.match(/(?:Parse error|Error) on line (\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

async function decomposeAndRender(source, profile, useMax = false) {
  const stagesExecuted = [];
  const { buildDecomposeUserPrompt, buildRepairFromTraceUserPrompt } = require('./axiom-prompts');

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
      const viewShadow = viewProfile.shadow;
      const errorStr = compileOut.result.error || 'compilation failed';
      const lineNumber = _extractLineNumber(errorStr);

      const tracePrompt = buildRepairFromTraceUserPrompt(
        prep.mmdSource,
        errorStr,
        viewShadow,
        viewDesc,
        { lineNumber, priorAttempts: compileOut.attempts, deterministicChanges: compileOut.repairChanges },
      );
      const repairResult = await provider.infer('repair_from_trace', { userPrompt: tracePrompt });
      stagesExecuted.push('repair_from_trace');

      if (repairResult.output) {
        const repairedCompile = await compileWithRetry(repairResult.output, outputDir, 'subview');
        if (repairedCompile.result.ok) {
          const repairedScore = _scoreSubView(repairedCompile.mmdSource, profile.shadow);
          results.push({ mmdSource: repairedCompile.mmdSource, score: repairedScore.composite, scoreFactors: repairedScore, viewName: view.viewName, compileResult: repairedCompile.result });
          continue;
        }
      }
      results.push({ mmdSource: prep.mmdSource, score: 0.0, scoreFactors: null, viewName: view.viewName, compileResult: compileOut.result });
    } else {
      const viewScore = _scoreSubView(compileOut.mmdSource, profile.shadow);
      results.push({ mmdSource: compileOut.mmdSource, score: viewScore.composite, scoreFactors: viewScore, viewName: view.viewName, compileResult: compileOut.result });
    }
  }

  if (results.length === 0) {
    logger.warn('decompose.no_results', { reason: 'all sub-views failed' });
    return renderPrepare(source, profile, useMax);
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  logger.info('decompose.selected', {
    viewName: best.viewName,
    score: best.score,
    factors: best.scoreFactors,
    candidateCount: results.length,
  });

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
  renderHPCGoT,
  renderMaxUpgrade,
  decomposeAndRender,
  compileWithRetry,
  detect,
  extractFencedMermaid,
  bestEffortExtract,
  RouterError,
};
