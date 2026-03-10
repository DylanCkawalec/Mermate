'use strict';

/**
 * Deterministic Mermaid source repairer.
 *
 * Fixes common structural defects without needing a model:
 *  - Reserved-word node IDs
 *  - Spaces in node IDs
 *  - Missing directive
 *  - Non-Mermaid prose lines
 *  - Unbalanced brackets
 *  - Duplicate node definitions
 *  - Indentation normalization
 *
 * Returns { source, changes } where `changes` is an array of
 * human-readable descriptions of what was fixed.
 */

const { DIRECTIVE_MAP } = require('./mermaid-classifier');

const RESERVED_IDS = new Set([
  'end', 'subgraph', 'graph', 'flowchart', 'style', 'class',
  'click', 'default', 'linkStyle', 'classDef', 'direction',
]);

const EDGE_RE = /-->|==>|-.->|---/;
const NODE_DEF_RE = /^(\s*)(\w[\w\s]*?)(\[|\(|{)/;
const MERMAID_LINE_RE = /-->|==>|---|-.->|\w+\[|\w+\(|\w+\{|subgraph\s|classDef\s|class\s|style\s|linkStyle\s|%%/;

/**
 * Repair a Mermaid source string.
 * @param {string} source
 * @returns {{ source: string, changes: string[] }}
 */
function repair(source) {
  if (!source || typeof source !== 'string') {
    return { source: source || '', changes: [] };
  }

  const changes = [];
  let lines = source.split('\n');

  // ---- 1. Detect and fix missing directive --------------------------------

  let hasDirective = false;
  let directiveLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%') || line.startsWith('classDef ')) continue;
    for (const [regex] of DIRECTIVE_MAP) {
      if (regex.test(line)) { hasDirective = true; directiveLineIndex = i; break; }
    }
    break;
  }

  if (!hasDirective) {
    const hasEdges = lines.some(l => EDGE_RE.test(l));
    const directive = hasEdges ? 'flowchart TD' : 'flowchart LR';
    lines.unshift(directive);
    directiveLineIndex = 0;
    changes.push(`added missing directive: ${directive}`);
  }

  // ---- 2. Remove non-Mermaid prose lines ----------------------------------

  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Always keep directive line, empty lines, and comments
    if (i === directiveLineIndex || !trimmed || trimmed.startsWith('%%')) {
      cleaned.push(line);
      continue;
    }

    // Keep lines that look like Mermaid syntax
    if (MERMAID_LINE_RE.test(trimmed) || /^(end|subgraph)\b/.test(trimmed) || /^\w+\s*-->/.test(trimmed)) {
      cleaned.push(line);
      continue;
    }

    // Keep lines that are continuations of node/edge definitions
    if (/^\s+/.test(line) && /\w/.test(trimmed) && !/[.?!]$/.test(trimmed)) {
      cleaned.push(line);
      continue;
    }

    // Remove prose lines
    if (/[.?!]$/.test(trimmed) && !trimmed.includes('-->') && !trimmed.includes('==>')) {
      changes.push(`removed prose line: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '...' : ''}"`);
      continue;
    }

    // Keep anything ambiguous
    cleaned.push(line);
  }
  lines = cleaned;

  // ---- 3. Fix reserved-word node IDs --------------------------------------

  const reservedReplacements = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) continue;

    for (const reserved of RESERVED_IDS) {
      // Match reserved word used as node ID (before a shape bracket)
      const idPattern = new RegExp(`\\b(${reserved})(\\s*[\\[({])`, 'gi');
      if (idPattern.test(line)) {
        const replacement = reserved + 'Node';
        if (!reservedReplacements.has(reserved)) {
          reservedReplacements.set(reserved, replacement);
          changes.push(`renamed reserved ID "${reserved}" to "${replacement}"`);
        }
        // Replace as node ID only (before shape brackets), not as keyword
        const replaceRe = new RegExp(`\\b${reserved}\\b(?=\\s*[\\[({])`, 'gi');
        lines[i] = lines[i].replace(replaceRe, replacement);
        // Also replace in edge references
        const edgeRefRe = new RegExp(`\\b${reserved}\\b(?=\\s*(?:-->|==>|-.->|---)|(?:-->|==>|-.->|---)\\s*${reserved}\\b)`, 'gi');
        lines[i] = lines[i].replace(edgeRefRe, replacement);
      }
    }
  }

  // Fix all edge references to renamed IDs across all lines
  for (const [original, replacement] of reservedReplacements) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('%%')) continue;
      // Replace standalone references in edges (not inside brackets)
      const standAloneRe = new RegExp(`(?<=-->\\s*|==>\\s*|-.->\\s*|---\\s*)\\b${original}\\b(?!\\s*[\\[({])`, 'gi');
      lines[i] = lines[i].replace(standAloneRe, replacement);
      const beforeEdgeRe = new RegExp(`\\b${original}\\b(?=\\s*(?:-->|==>|-.->|---))`, 'gi');
      lines[i] = lines[i].replace(beforeEdgeRe, replacement);
    }
  }

  // ---- 4. Fix spaces in node IDs ------------------------------------------

  // First pass: fix node definitions with shape brackets
  const spaceIdReplacements = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%') || /^(subgraph|classDef|class|style|linkStyle|direction)\b/.test(line.trim())) continue;

    const spaceIdMatch = line.match(/^(\s*)([\w]+(?:\s+[\w]+)+)\s*(\[|\(|{)/);
    if (spaceIdMatch) {
      const indent = spaceIdMatch[1];
      const rawId = spaceIdMatch[2];
      const bracket = spaceIdMatch[3];
      if (!rawId.includes('-->') && !rawId.includes('==>')) {
        const camelId = rawId.split(/\s+/)
          .map((w, idx) => idx === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join('');
        const rest = line.slice(spaceIdMatch[0].length);
        lines[i] = `${indent}${camelId}${bracket}${rest}`;
        spaceIdReplacements.set(rawId, camelId);
        changes.push(`fixed space in node ID: "${rawId}" → "${camelId}"`);
      }
    }
  }

  // Second pass: fix multi-word IDs in edge lines (e.g., "api gateway --> db")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%') || /^(subgraph|classDef|class|style|linkStyle|direction)\b/.test(line.trim())) continue;

    // Detect edge lines: lines containing --> ==> -.-> ---
    if (!EDGE_RE.test(line)) continue;

    // Split on edge operators, fix multi-word tokens, rejoin
    const parts = line.split(/(-->|==>|-.->|---|\|[^|]*\|)/);
    let changed = false;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p].trim();
      // Skip edge operators and labels
      if (/^(-->|==>|-.->|---)$/.test(part) || /^\|/.test(part) || !part) continue;
      // Check if this part has spaces and looks like a multi-word ID
      if (/^\w+(\s+\w+)+$/.test(part) && !part.includes('[') && !part.includes('(') && !part.includes('{')) {
        const camelId = part.split(/\s+/)
          .map((w, idx) => idx === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join('');
        if (!spaceIdReplacements.has(part)) {
          spaceIdReplacements.set(part, camelId);
          changes.push(`fixed space in edge ref: "${part}" → "${camelId}"`);
        }
        parts[p] = parts[p].replace(part, spaceIdReplacements.get(part) || camelId);
        changed = true;
      }
    }
    if (changed) lines[i] = parts.join('');
  }

  // Third pass: apply all space-ID replacements across remaining lines
  for (const [original, replacement] of spaceIdReplacements) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('%%')) continue;
      if (lines[i].includes(original)) {
        lines[i] = lines[i].split(original).join(replacement);
      }
    }
  }

  // ---- 5. Fix unbalanced brackets -----------------------------------------

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) continue;

    const opens = (line.match(/\[/g) || []).length;
    const closes = (line.match(/\]/g) || []).length;
    if (opens > closes) {
      lines[i] = line + ']'.repeat(opens - closes);
      changes.push(`closed ${opens - closes} unbalanced bracket(s) on line ${i + 1}`);
    }
  }

  // ---- 6. Normalize indentation -------------------------------------------

  let needsIndentFix = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('%%')) continue;
    if (/^(subgraph|end)\b/.test(line.trim())) continue;
    if (!/^\s/.test(line) && !line.trim().startsWith('%%')) {
      needsIndentFix = true;
      break;
    }
  }

  if (needsIndentFix) {
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('%%')) continue;
      if (/^(subgraph|end)\b/.test(trimmed)) continue;
      if (!/^\s/.test(lines[i])) {
        lines[i] = '    ' + trimmed;
      }
    }
    changes.push('normalized indentation');
  }

  return {
    source: lines.join('\n'),
    changes,
  };
}

module.exports = { repair };
