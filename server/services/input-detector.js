'use strict';

const { DIRECTIVE_MAP } = require('./mermaid-classifier');

const EDGE_RE = /-->|==>|---|-.->|-->/g;
const NODE_BRACKET_RE = /\w+\[|\w+\(|\w+\{/g;
const MD_HEADING_RE = /^#{1,6}\s/m;
const FENCED_MERMAID_RE = /```mermaid/;
const BULLET_RE = /^\s*[-*]\s|^\s*\d+\.\s/;
const STRUCTURAL_KW_RE = /\b(subgraph|classDef|end)\b/g;
const PROSE_END_RE = /[.?!]$/;

const CONTENT_STATES = {
  TEXT: 'text',
  MD: 'md',
  MMD: 'mmd',
  HYBRID: 'hybrid',
};

/**
 * Gather quantitative signals from raw input.
 * @param {string} source
 * @returns {object}
 */
function extractSignals(source) {
  const lines = source.split('\n');
  const totalLines = lines.length;

  let mmdDirectiveMatch = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('%%') || line.startsWith('classDef ')) continue;
    for (const [regex] of DIRECTIVE_MAP) {
      if (regex.test(line)) { mmdDirectiveMatch = true; break; }
    }
    break;
  }

  const fullText = source;
  const edgeCount = (fullText.match(EDGE_RE) || []).length;
  const nodeCount = (fullText.match(NODE_BRACKET_RE) || []).length;
  const hasMarkdownHeading = MD_HEADING_RE.test(fullText);
  const hasFencedMermaid = FENCED_MERMAID_RE.test(fullText);
  const bulletCount = lines.filter(l => BULLET_RE.test(l)).length;
  const structuralKeywords = (fullText.match(STRUCTURAL_KW_RE) || []).length;

  let proseLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (PROSE_END_RE.test(line) && !line.startsWith('%%') && !line.includes('-->')) {
      proseLines++;
    }
  }
  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;
  const proseRatio = nonEmptyLines > 0 ? proseLines / nonEmptyLines : 0;

  return {
    totalLines,
    mmdDirectiveMatch,
    edgeCount,
    nodeCount,
    hasMarkdownHeading,
    hasFencedMermaid,
    bulletCount,
    structuralKeywords,
    proseLines,
    proseRatio,
    charCount: source.length,
  };
}

/**
 * Detect the content state of user input.
 * Precedence: mmd > md > hybrid > text
 *
 * @param {string} source - Raw user input (already trimmed)
 * @returns {{ state: string, signals: object }}
 */
function detect(source) {
  if (!source || typeof source !== 'string') {
    return { state: CONTENT_STATES.TEXT, signals: {} };
  }

  const signals = extractSignals(source);

  // 1. mmd — first non-comment line matches a known directive
  if (signals.mmdDirectiveMatch) {
    return { state: CONTENT_STATES.MMD, signals };
  }

  // 2. md — has markdown heading, fenced mermaid block, or 3+ bullet lines
  if (signals.hasMarkdownHeading || signals.hasFencedMermaid || signals.bulletCount >= 3) {
    return { state: CONTENT_STATES.MD, signals };
  }

  // 3. hybrid — has Mermaid structural signals but no valid directive
  const mermaidSignalCount =
    (signals.edgeCount >= 2 ? 1 : 0) +
    (signals.nodeCount >= 2 ? 1 : 0) +
    (signals.structuralKeywords >= 1 ? 1 : 0);
  if (mermaidSignalCount >= 1) {
    return { state: CONTENT_STATES.HYBRID, signals };
  }

  // 4. text — everything else
  return { state: CONTENT_STATES.TEXT, signals };
}

module.exports = { detect, extractSignals, CONTENT_STATES };
