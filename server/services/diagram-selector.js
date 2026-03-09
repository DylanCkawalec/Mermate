'use strict';

/**
 * Deterministic diagram type selector implementing axiom section 7.
 * Evaluates semantic signals from user input to choose the best Mermaid diagram type.
 */

const SEQUENCE_RE = /\b(sends?\s+to|calls?|requests?|responds?|ask|reply|message|notify|acknowledge|flow\s+between|authorization\s+code)\b/i;
const ACTOR_INTERACTION_RE = /\b(user|client|server|browser|api|service|authorization)\b.*\b(sends?|calls?|requests?|talks?\s+to|responds?|flow)\b.*\b(user|client|server|browser|api|service|resource)\b/i;
const STATE_RE = /\b(state|transition|lifecycle|mode|status|becomes?|transitions?\s+to|changes?\s+to|pending|running|succeeded|failed|active|inactive|idle|terminated)\b/i;
const CLASS_RE = /\b(class|interface|extends|implements|inherits?|abstract|polymorphi)/i;
const ER_RE = /\b(one-to-many|many-to-many|one-to-one|cardinality|entity|relationship|foreign\s+key|primary\s+key|has\s+many|belongs\s+to)\b/i;
const GANTT_RE = /\b(schedule|phase|milestone|deadline|start\s+date|end\s+date|duration|gantt|sprint|from\s+\w+\s+to\s+\w+)\b/i;
const JOURNEY_RE = /\b(user\s+journey|experience|satisfaction|happy|unhappy|frustrated|delight|touchpoint)\b/i;
const MINDMAP_RE = /\b(brainstorm|mind\s*map|topic|category|categories|ideas?\s+about|break\s*down|overview\s+of)\b/i;
const TIMELINE_RE = /\b(chronolog|historical|milestone|era|epoch|year\s+\d{4}|century|decade)\b/i;
const PIE_RE = /\b(percent|proportion|distribution|share|pie\s+chart|breakdown\s+by)\b/i;
const PIPELINE_RE = /\b(pipeline|workflow|process|step\s+\d|stage\s+\d|etl|ci\/?cd|ingest|transform|load)\b/i;
const ARCH_RE = /\b(architect|infrastructure|layer|service|microservice|gateway|load\s+balancer|database|cache|queue|deploy|kubernetes|docker|aws|gcp|azure)\b/i;

const EXPLICIT_TYPE_RE = /\b(sequence\s+diagram|state\s+diagram|class\s+diagram|er\s+diagram|gantt|pie\s+chart|mind\s*map|timeline|journey|flowchart)\b/i;

/**
 * Select the best Mermaid diagram type from natural-language input.
 * Implements the priority-ordered decision tree from axiom section 7.
 *
 * @param {string} text - User's natural-language input
 * @returns {{ type: string, directive: string, confidence: string, reason: string }}
 */
function selectDiagramType(text) {
  if (!text || typeof text !== 'string') {
    return result('flowchart', 'flowchart TB', 'low', 'empty input, default fallback');
  }

  const s = text.toLowerCase();

  // Priority 1: user explicitly names a type
  const explicit = EXPLICIT_TYPE_RE.exec(text);
  if (explicit) {
    const named = explicit[1].toLowerCase().replace(/\s+/g, '');
    if (named.includes('sequence')) return result('sequence', 'sequenceDiagram', 'high', 'user requested sequence diagram');
    if (named.includes('state')) return result('state', 'stateDiagram-v2', 'high', 'user requested state diagram');
    if (named.includes('class')) return result('class', 'classDiagram', 'high', 'user requested class diagram');
    if (named.includes('erdiagram') || named.includes('er')) return result('er', 'erDiagram', 'high', 'user requested ER diagram');
    if (named.includes('gantt')) return result('gantt', 'gantt', 'high', 'user requested gantt chart');
    if (named.includes('pie')) return result('pie', 'pie', 'high', 'user requested pie chart');
    if (named.includes('mindmap') || named.includes('mind')) return result('mindmap', 'mindmap', 'high', 'user requested mind map');
    if (named.includes('timeline')) return result('timeline', 'timeline', 'high', 'user requested timeline');
    if (named.includes('journey')) return result('journey', 'journey', 'high', 'user requested journey');
    if (named.includes('flowchart')) return result('flowchart', 'flowchart TB', 'high', 'user requested flowchart');
  }

  // Priority 2: ordered interactions between actors
  if (ACTOR_INTERACTION_RE.test(text) || countMatches(s, SEQUENCE_RE) >= 2) {
    return result('sequence', 'sequenceDiagram', 'medium', 'detected actor interactions / request-response pattern');
  }

  // Priority 3: state transitions / lifecycle
  if (countMatches(s, STATE_RE) >= 2) {
    return result('state', 'stateDiagram-v2', 'medium', 'detected state/transition/lifecycle language');
  }

  // Priority 4: class hierarchy
  if (CLASS_RE.test(text)) {
    return result('class', 'classDiagram', 'medium', 'detected class/interface/inheritance language');
  }

  // Priority 5: entity relationships with cardinality
  if (ER_RE.test(text)) {
    return result('er', 'erDiagram', 'medium', 'detected entity-relationship / cardinality language');
  }

  // Priority 6: scheduled phases
  if (countMatches(s, GANTT_RE) >= 2) {
    return result('gantt', 'gantt', 'medium', 'detected scheduling / phase / milestone language');
  }

  // Priority 7: user journey
  if (JOURNEY_RE.test(text)) {
    return result('journey', 'journey', 'medium', 'detected user journey / experience language');
  }

  // Priority 8: mind map / brainstorm
  if (MINDMAP_RE.test(text)) {
    return result('mindmap', 'mindmap', 'medium', 'detected brainstorm / topic / category language');
  }

  // Priority 9: timeline / history
  if (TIMELINE_RE.test(text)) {
    return result('timeline', 'timeline', 'medium', 'detected chronological / historical language');
  }

  // Priority 10: proportional distribution
  if (PIE_RE.test(text)) {
    return result('pie', 'pie', 'medium', 'detected percentage / distribution language');
  }

  // Priority 11: pipeline / workflow
  if (countMatches(s, PIPELINE_RE) >= 2) {
    return result('flowchart', 'flowchart LR', 'medium', 'detected pipeline / workflow / process language');
  }

  // Priority 12: architecture / infrastructure
  if (countMatches(s, ARCH_RE) >= 3) {
    return result('flowchart', 'flowchart TB', 'medium', 'detected architecture / infrastructure language');
  }

  // Priority 13: default
  return result('flowchart', 'flowchart TB', 'low', 'default fallback');
}

function result(type, directive, confidence, reason) {
  return { type, directive, confidence, reason };
}

function countMatches(text, regex) {
  const global = new RegExp(regex.source, 'gi');
  return (text.match(global) || []).length;
}

module.exports = { selectDiagramType };
