'use strict';

/**
 * Deterministic Mermaid diagram type classifier.
 * Inspects the first non-comment, non-whitespace directive.
 */

const DIRECTIVE_MAP = [
  [/^flowchart\b/i,           'flowchart'],
  [/^graph\b/i,               'flowchart'],
  [/^sequenceDiagram\b/,      'sequence'],
  [/^classDiagram\b/,         'class'],
  [/^stateDiagram\b/,         'state'],
  [/^erDiagram\b/,            'er'],
  [/^gantt\b/,                'gantt'],
  [/^pie\b/,                  'pie'],
  [/^gitgraph\b/,             'gitgraph'],
  [/^mindmap\b/,              'mindmap'],
  [/^timeline\b/,             'timeline'],
  [/^journey\b/,              'journey'],
  [/^C4Context\b/,            'c4'],
  [/^C4Container\b/,          'c4'],
  [/^C4Component\b/,          'c4'],
  [/^C4Dynamic\b/,            'c4'],
  [/^quadrantChart\b/,        'quadrant'],
  [/^requirementDiagram\b/,   'requirement'],
  [/^sankey-beta\b/,          'sankey'],
  [/^xychart-beta\b/,         'xychart'],
  [/^block-beta\b/,           'block'],
];

/**
 * Classify a Mermaid source string into its diagram type.
 * @param {string} source - Raw Mermaid text
 * @returns {string} Diagram type identifier (e.g. 'flowchart', 'sequence', 'unknown')
 */
function classify(source) {
  if (!source || typeof source !== 'string') return 'unknown';

  const lines = source.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    // Skip empty lines, comments, directives (%%{...}), and classDef lines
    if (!line) continue;
    if (line.startsWith('%%')) continue;
    if (line.startsWith('classDef ')) continue;

    for (const [regex, type] of DIRECTIVE_MAP) {
      if (regex.test(line)) return type;
    }

    // If we reached a non-comment, non-empty line that didn't match, it's unknown
    return 'unknown';
  }

  return 'unknown';
}

module.exports = { classify, DIRECTIVE_MAP };
