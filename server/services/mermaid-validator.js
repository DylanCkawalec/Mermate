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

module.exports = { validate, isLikelyValid };
