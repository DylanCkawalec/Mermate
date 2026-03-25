'use strict';

/**
 * Mermaid source validator implementing axiom section 13.
 * Runs structural, readability, and pre-compilation checks.
 */

const { DIRECTIVE_MAP } = require('./mermaid-classifier');

const RESERVED_IDS = new Set([
  'end', 'subgraph', 'graph', 'flowchart', 'style', 'class',
  'click', 'default', 'linkStyle', 'classDef', 'direction',
]);

/**
 * Validate Mermaid source against the axiom framework rules.
 * @param {string} source - Mermaid source code
 * @returns {{ valid: boolean, errors: object[], warnings: object[], stats: object }}
 */
function validate(source) {
  const errors = [];
  const warnings = [];

  if (!source || typeof source !== 'string' || !source.trim()) {
    errors.push({ check: 'empty_source', severity: 'error', message: 'Source is empty' });
    return { valid: false, errors, warnings, stats: {} };
  }

  const lines = source.split('\n');
  const stats = {};

  // --- Structural checks ---

  // Directive presence
  let hasDirective = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || line.startsWith('classDef ')) continue;
    for (const [regex] of DIRECTIVE_MAP) {
      if (regex.test(line)) { hasDirective = true; break; }
    }
    break;
  }
  if (!hasDirective) {
    errors.push({ check: 'directive_missing', severity: 'error', message: 'First non-comment line must be a valid Mermaid directive' });
  }

  // Bracket balance (within lines, for node definitions)
  let bracketIssues = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) continue;
    const opens = (line.match(/\[/g) || []).length;
    const closes = (line.match(/\]/g) || []).length;
    if (opens !== closes) {
      bracketIssues++;
      if (bracketIssues <= 3) {
        warnings.push({ check: 'bracket_balance', severity: 'warning', message: `Possible unbalanced brackets on line ${i + 1}`, line: i + 1 });
      }
    }
  }
  if (bracketIssues > 3) {
    errors.push({ check: 'bracket_balance', severity: 'error', message: `${bracketIssues} lines with unbalanced brackets` });
  }

  // Subgraph / end balance
  let subgraphCount = 0;
  let endCount = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('%%')) continue;
    if (/^subgraph\b/.test(line)) subgraphCount++;
    if (/^end\s*$/.test(line)) endCount++;
  }
  stats.subgraphCount = subgraphCount;
  if (subgraphCount !== endCount) {
    errors.push({ check: 'subgraph_balance', severity: 'error', message: `${subgraphCount} subgraph(s) but ${endCount} end(s)` });
  }

  // Node ID extraction and duplicate check
  const nodeIdRe = /\b([A-Za-z_]\w*)\s*[\[({]/g;
  const idCounts = {};
  const fullText = source;
  let match;
  while ((match = nodeIdRe.exec(fullText)) !== null) {
    const id = match[1];
    if (['subgraph', 'classDef', 'class', 'style', 'click', 'linkStyle', 'direction'].includes(id)) continue;
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  const nodeIds = Object.keys(idCounts);
  stats.nodeCount = nodeIds.length;

  // Duplicate IDs (defined more than once with a shape — could be legitimate redefinition)
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 2) {
      warnings.push({ check: 'duplicate_id', severity: 'warning', message: `Node ID "${id}" defined ${count} times` });
    }
  }

  // Reserved word IDs
  for (const id of nodeIds) {
    if (RESERVED_IDS.has(id.toLowerCase())) {
      errors.push({ check: 'reserved_id', severity: 'error', message: `"${id}" is a Mermaid reserved word and cannot be used as a node ID` });
    }
  }

  // Edge count
  const edgeCount = (fullText.match(/-->|==>|-.->|---/g) || []).length;
  stats.edgeCount = edgeCount;

  // --- Readability checks ---

  // Node count thresholds
  if (stats.nodeCount > 120) {
    errors.push({ check: 'node_count', severity: 'error', message: `${stats.nodeCount} nodes exceeds the 120-node hard limit` });
  } else if (stats.nodeCount > 80) {
    warnings.push({ check: 'node_count', severity: 'warning', message: `${stats.nodeCount} nodes exceeds the 80-node readability guideline` });
  }

  // Edge density
  if (stats.nodeCount > 0) {
    stats.edgeDensity = +(edgeCount / stats.nodeCount).toFixed(2);
    if (stats.edgeDensity > 2.5) {
      warnings.push({ check: 'edge_density', severity: 'warning', message: `Edge density ${stats.edgeDensity} exceeds 2.5:1 guideline` });
    }
  }

  // Nesting depth
  let maxNesting = 0;
  let currentNesting = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('%%')) continue;
    if (/^subgraph\b/.test(line)) {
      currentNesting++;
      if (currentNesting > maxNesting) maxNesting = currentNesting;
    }
    if (/^end\s*$/.test(line)) {
      currentNesting = Math.max(0, currentNesting - 1);
    }
  }
  stats.maxNesting = maxNesting;
  if (maxNesting > 3) {
    errors.push({ check: 'nesting_depth', severity: 'error', message: `Subgraph nesting depth ${maxNesting} exceeds 3-level limit` });
  }

  // Label length check (sample node labels)
  const labelRe = /\["([^"]+)"\]|\[([^\]]+)\]/g;
  let longLabels = 0;
  let labelMatch;
  while ((labelMatch = labelRe.exec(fullText)) !== null) {
    const label = labelMatch[1] || labelMatch[2];
    const labelLines = label.split('\\n');
    if (labelLines.length > 3) {
      longLabels++;
    }
  }
  if (longLabels > 0) {
    warnings.push({ check: 'label_length', severity: 'warning', message: `${longLabels} node(s) have labels exceeding 3 lines` });
  }

  stats.lineCount = lines.length;
  stats.charCount = source.length;

  const valid = errors.length === 0;
  return { valid, errors, warnings, stats };
}

/**
 * Quick structural check — just tests if the source will likely compile.
 * @param {string} source
 * @returns {boolean}
 */
function isLikelyValid(source) {
  const { errors } = validate(source);
  return errors.length === 0;
}

// ---- HPC-GoT Deterministic Invariant Validation --------------------------------

const { getConfig: getGotConfig } = require('./got-config');

const _gotCfg = () => getGotConfig();
const PROSE_WORD_LIMIT = () => _gotCfg().proseWordLimit;
const EDGE_LABEL_WORD_LIMIT = () => _gotCfg().edgeLabelWordLimit;

/**
 * Normalize a name for fuzzy matching: lowercase, strip non-alphanumeric, collapse whitespace.
 */
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract all node labels from Mermaid source as an array of { id, label } objects.
 */
function extractNodeLabels(source) {
  const nodes = [];
  // Match patterns: Id["label"], Id(["label"]), Id[("label")], Id{"label"}, Id{{"label"}}, Id("label")
  const patterns = [
    /\b([A-Za-z_]\w*)\s*\["([^"]+)"\]/g,              // rectangle
    /\b([A-Za-z_]\w*)\s*\(\["([^"]+)"\]\)/g,           // stadium
    /\b([A-Za-z_]\w*)\s*\[\("([^"]+)"\)\]/g,           // cylinder
    /\b([A-Za-z_]\w*)\s*\{"([^"]+)"\}/g,               // diamond
    /\b([A-Za-z_]\w*)\s*\{\{"([^"]+)"\}\}/g,           // hexagon
    /\b([A-Za-z_]\w*)\s*\("([^"]+)"\)/g,               // rounded
    /\b([A-Za-z_]\w*)\s*\[([^\]]+)\]/g,                // bare bracket
  ];
  const seen = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const id = m[1];
      if (['subgraph', 'classDef', 'class', 'style', 'click', 'linkStyle', 'direction'].includes(id)) continue;
      if (!seen.has(id)) {
        seen.add(id);
        nodes.push({ id, label: m[2] });
      }
    }
  }
  return nodes;
}

/**
 * Extract all edge labels from Mermaid source.
 */
function extractEdgeLabels(source) {
  const labels = [];
  // |"label"|, |label|
  const re = /\|"?([^"\|]+)"?\|/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    labels.push(m[1].trim());
  }
  return labels;
}

/**
 * Validate Mermaid source against typed architecture facts.
 * Returns a structured failure trace describing every invariant violation.
 *
 * @param {string} mmdSource - Generated Mermaid source
 * @param {object} facts - Stage 1 output (entities, relationships, boundaries, failurePaths)
 * @param {object} [plan] - Optional Stage 2 plan for cross-reference
 * @returns {{ passed: boolean, trace: object, coverage: object }}
 */
function validateInvariants(mmdSource, facts, plan) {
  const trace = {
    compileError: null,
    missingEntities: [],
    missingRelationships: [],
    proseFragments: [],
    longLabels: [],
    reservedIds: [],
    invariantFailures: [],
  };

  if (!mmdSource || !facts) {
    trace.invariantFailures.push('Missing mmdSource or facts');
    return { passed: false, trace, coverage: { entityCoverage: 0, relationCoverage: 0 } };
  }

  // Structural validity first
  const structural = validate(mmdSource);
  if (!structural.valid) {
    trace.invariantFailures.push(...structural.errors.map(e => `${e.check}: ${e.message}`));
  }

  const sourceLower = mmdSource.toLowerCase();
  const sourceNorm = normalizeName(mmdSource);
  const nodeLabels = extractNodeLabels(mmdSource);
  const nodeLabelNorms = nodeLabels.map(n => ({ ...n, norm: normalizeName(n.label) }));
  const nodeIdNorms = nodeLabels.map(n => normalizeName(n.id));

  // --- Entity coverage ---
  const entities = facts.entities || [];
  let entitiesCovered = 0;
  for (const entity of entities) {
    const nameNorm = normalizeName(entity.name);
    const found = nodeLabelNorms.some(n => n.norm.includes(nameNorm) || nameNorm.includes(n.norm))
      || nodeIdNorms.some(id => id.includes(nameNorm) || nameNorm.includes(id));
    if (found) {
      entitiesCovered++;
    } else {
      trace.missingEntities.push(entity.name);
    }
  }
  const entityCoverage = entities.length > 0 ? entitiesCovered / entities.length : 1;

  // --- Relationship coverage ---
  const relationships = facts.relationships || [];
  let relationsCovered = 0;
  for (const rel of relationships) {
    const fromNorm = normalizeName(rel.from);
    const toNorm = normalizeName(rel.to);
    // Check if both endpoints appear in the source
    const fromFound = sourceNorm.includes(fromNorm);
    const toFound = sourceNorm.includes(toNorm);
    if (fromFound && toFound) {
      relationsCovered++;
    } else {
      trace.missingRelationships.push({ from: rel.from, to: rel.to, verb: rel.verb });
    }
  }
  const relationCoverage = relationships.length > 0 ? relationsCovered / relationships.length : 1;

  // --- Prose fragment detection ---
  for (const node of nodeLabels) {
    const lines = node.label.split('\\n');
    for (const line of lines) {
      const wordCount = line.trim().split(/\s+/).length;
      if (wordCount > PROSE_WORD_LIMIT() * 2) {
        trace.proseFragments.push(`Node ${node.id}: "${line.substring(0, 60)}..."`);
      }
    }
  }

  // --- Edge label length ---
  const edgeLabels = extractEdgeLabels(mmdSource);
  for (const label of edgeLabels) {
    const wordCount = label.split(/\s+/).length;
    if (wordCount > EDGE_LABEL_WORD_LIMIT()) {
      trace.longLabels.push(`"${label.substring(0, 40)}" (${wordCount} words)`);
    }
  }

  // --- Reserved word IDs ---
  for (const node of nodeLabels) {
    if (RESERVED_IDS.has(node.id.toLowerCase())) {
      trace.reservedIds.push(node.id);
    }
  }

  // --- Coverage thresholds ---
  if (entityCoverage < 0.8) {
    trace.invariantFailures.push(`Entity coverage ${(entityCoverage * 100).toFixed(0)}% below 80% threshold`);
  }
  if (relationCoverage < 0.6) {
    trace.invariantFailures.push(`Relationship coverage ${(relationCoverage * 100).toFixed(0)}% below 60% threshold`);
  }

  const hasTraceIssues =
    trace.missingEntities.length > 0 ||
    trace.missingRelationships.length > 0 ||
    trace.proseFragments.length > 0 ||
    trace.longLabels.length > 0 ||
    trace.reservedIds.length > 0 ||
    trace.invariantFailures.length > 0;

  return {
    passed: !hasTraceIssues,
    trace,
    coverage: {
      entityCoverage: +entityCoverage.toFixed(3),
      relationCoverage: +relationCoverage.toFixed(3),
      entitiesTotal: entities.length,
      entitiesCovered,
      relationsTotal: relationships.length,
      relationsCovered,
    },
  };
}

/**
 * Compute the HPC canonical score: σ = 0.5 * SV + 0.5 * IC
 * where SV = structural validity (0 or 1), IC = invariant coverage (0..1).
 *
 * @param {string} mmdSource
 * @param {object} facts
 * @returns {{ score: number, sv: number, ic: number, details: object }}
 */
function computeHPCScore(mmdSource, facts) {
  const structural = validate(mmdSource);
  const sv = structural.valid ? 1.0 : 0.0;

  const invariants = validateInvariants(mmdSource, facts);
  const ec = invariants.coverage.entityCoverage;
  const rc = invariants.coverage.relationCoverage;
  // IC = average of entity coverage and relationship coverage
  const ic = (ec + rc) / 2;

  const cfg = getGotConfig();
  const score = +(cfg.scoreStructuralWeight * sv + cfg.scoreInvariantWeight * ic).toFixed(3);

  return {
    score,
    sv,
    ic: +ic.toFixed(3),
    details: {
      structuralErrors: structural.errors.length,
      structuralWarnings: structural.warnings.length,
      entityCoverage: ec,
      relationCoverage: rc,
      missingEntities: invariants.trace.missingEntities,
      missingRelationships: invariants.trace.missingRelationships,
      proseFragments: invariants.trace.proseFragments.length,
      longLabels: invariants.trace.longLabels.length,
      reservedIds: invariants.trace.reservedIds,
    },
  };
}

// ---- Graph-Theoretic Structural Validation (L1–L3) -------------------------

const structuralSig = require('./structural-signature');

/**
 * Deep structural validation using graph-theoretic properties.
 * Complements L0 parse validation with L1 (graph), L2 (flow), L3 (boundary).
 *
 * @param {string} mmdSource
 * @returns {{ properties: object, issues: string[], score: number }}
 */
function validateGraphProperties(mmdSource) {
  const sig = structuralSig.extract(mmdSource);
  const issues = [];

  // L1: Graph validity
  if (!sig.isFullyConnected && sig.connectedComponents > 1) {
    issues.push(`L1:disconnected — ${sig.connectedComponents} disconnected components`);
  }
  if (sig.orphanedNodes > 0) {
    issues.push(`L1:orphaned — ${sig.orphanedNodes} nodes with no edges`);
  }

  // L2: Flow validity
  if (sig.unreachableNodes > 0) {
    issues.push(`L2:unreachable — ${sig.unreachableNodes} nodes unreachable from any entry point`);
  }
  if (sig.entryPoints === 0 && sig.nodeCount > 1) {
    issues.push(`L2:no_entry — no clear entry points (all nodes have incoming edges)`);
  }
  if (sig.terminalNodes === 0 && sig.nodeCount > 1 && !sig.hasCycles) {
    issues.push(`L2:no_terminal — no terminal nodes (all nodes have outgoing edges but no cycles)`);
  }

  // L3: Boundary & failure path validity
  if (sig.boundaryCrossings > 0 && sig.boundarySymmetry < 0.3) {
    issues.push(`L3:asymmetric_boundaries — boundary symmetry ${(sig.boundarySymmetry * 100).toFixed(0)}% (many one-way cross-boundary flows)`);
  }
  if (sig.nodeCount >= 10 && !sig.hasExplicitFailurePaths) {
    issues.push(`L3:no_failure_paths — no explicit error/failure/retry nodes in a ${sig.nodeCount}-node architecture`);
  }
  if (sig.crossCuttingCount >= 3) {
    issues.push(`L3:cross_cutting — ${sig.crossCuttingCount} cross-cutting hubs detected (may need pattern extraction)`);
  }

  // Score: 1.0 = clean, degrade by 0.1 per issue category
  const score = Math.max(0, +(1.0 - issues.length * 0.1).toFixed(2));

  return { properties: sig, issues, score };
}

module.exports = { validate, isLikelyValid, validateInvariants, computeHPCScore, validateGraphProperties };
