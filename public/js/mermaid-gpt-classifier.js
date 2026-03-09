/**
 * Client-side Mermaid diagram type classifier + content-state detector.
 * Used for preview badges — authoritative classification is server-side.
 */
window.MermaidClassifier = {
  _map: [
    [/^flowchart\b/i, 'flowchart'], [/^graph\b/i, 'flowchart'],
    [/^sequenceDiagram\b/, 'sequence'], [/^classDiagram\b/, 'class'],
    [/^stateDiagram\b/, 'state'], [/^erDiagram\b/, 'er'],
    [/^gantt\b/, 'gantt'], [/^pie\b/, 'pie'],
    [/^gitgraph\b/, 'gitgraph'], [/^mindmap\b/, 'mindmap'],
    [/^timeline\b/, 'timeline'], [/^journey\b/, 'journey'],
    [/^C4Context\b/, 'c4'], [/^C4Container\b/, 'c4'],
    [/^quadrantChart\b/, 'quadrant'], [/^sankey-beta\b/, 'sankey'],
    [/^xychart-beta\b/, 'xychart'], [/^block-beta\b/, 'block'],
  ],

  classify(source) {
    if (!source) return '';
    const lines = source.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('%%') || line.startsWith('classDef ')) continue;
      for (const [re, type] of this._map) {
        if (re.test(line)) return type;
      }
      return '';
    }
    return '';
  },

  /**
   * Detect content state: text, md, mmd, hybrid.
   * Lightweight client-side preview; server is authoritative.
   */
  detectState(source) {
    if (!source || !source.trim()) return '';
    const s = source.trim();

    if (this.classify(s)) return 'mmd';

    if (/^#{1,6}\s/m.test(s) || /```mermaid/.test(s)) return 'md';

    const bullets = s.split('\n').filter(l => /^\s*[-*]\s|^\s*\d+\.\s/.test(l)).length;
    if (bullets >= 3) return 'md';

    const edges = (s.match(/-->|==>|---|-.->|-->/g) || []).length;
    const nodes = (s.match(/\w+\[|\w+\(|\w+\{/g) || []).length;
    if (edges >= 2 || nodes >= 2) return 'hybrid';

    return 'text';
  },
};
