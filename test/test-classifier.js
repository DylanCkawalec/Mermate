'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../server/services/mermaid-classifier');

describe('mermaid-classifier', () => {
  const cases = [
    ['flowchart LR\n  A --> B',           'flowchart'],
    ['flowchart TB\n  A --> B',           'flowchart'],
    ['graph TD\n  A --> B',               'flowchart'],
    ['sequenceDiagram\n  A->>B: msg',     'sequence'],
    ['classDiagram\n  class Foo',         'class'],
    ['stateDiagram-v2\n  [*] --> S',      'state'],
    ['erDiagram\n  A ||--o{ B : rel',     'er'],
    ['gantt\n  title T',                  'gantt'],
    ['pie title X\n  "A": 1',            'pie'],
    ['gitgraph\n  commit',               'gitgraph'],
    ['mindmap\n  root((R))',             'mindmap'],
    ['timeline\n  title T',              'timeline'],
    ['journey\n  title T',               'journey'],
    ['C4Context\n  Person(a,"A")',        'c4'],
    ['C4Container\n  System(a,"A")',      'c4'],
    ['C4Component\n  Component(a,"A")',   'c4'],
    ['C4Dynamic\n  Rel(a,b,"r")',         'c4'],
    ['quadrantChart\n  x-axis A',        'quadrant'],
    ['requirementDiagram\n  req r',      'requirement'],
    ['sankey-beta\n  A,B,1',             'sankey'],
    ['xychart-beta\n  title T',          'xychart'],
    ['block-beta\n  columns 1',          'block'],
  ];

  for (const [source, expected] of cases) {
    it(`classifies "${source.split('\n')[0]}" as "${expected}"`, () => {
      assert.equal(classify(source), expected);
    });
  }

  it('returns "unknown" for empty input', () => {
    assert.equal(classify(''), 'unknown');
    assert.equal(classify(null), 'unknown');
    assert.equal(classify(undefined), 'unknown');
  });

  it('returns "unknown" for unrecognized content', () => {
    assert.equal(classify('hello world\nfoo bar'), 'unknown');
  });

  it('skips %% comment lines', () => {
    assert.equal(classify('%% comment\nflowchart LR\n  A --> B'), 'flowchart');
  });

  it('skips classDef lines before directive', () => {
    const src = 'classDef default fill:#fff\nflowchart LR\n  A --> B';
    assert.equal(classify(src), 'flowchart');
  });
});
