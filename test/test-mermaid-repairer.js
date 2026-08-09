'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { repair } = require('../server/services/mermaid-repairer');

describe('mermaid-repairer', () => {

  it('adds missing directive when edges are present', () => {
    const r = repair('A --> B\nB --> C');
    assert.ok(r.source.startsWith('flowchart'));
    assert.ok(r.changes.some(c => /added missing directive/.test(c)));
  });

  it('renames reserved-word node IDs', () => {
    const r = repair('flowchart TD\n  end[Bad Node]\n  end --> B[OK]');
    assert.ok(!r.source.includes('  end['));
    assert.ok(r.source.includes('endNode'));
    assert.ok(r.changes.some(c => /reserved ID/.test(c)));
  });

  it('fixes spaces in node IDs with shape brackets', () => {
    const r = repair('flowchart TD\n  api gateway[API Gateway] --> db[(Database)]');
    assert.ok(r.source.includes('apiGateway['));
    assert.ok(r.changes.some(c => /space in node ID/.test(c)));
  });

  it('fixes spaces in edge-only references', () => {
    const r = repair('flowchart TD\n  api gateway --> db[(Database)]\n  db --> api gateway');
    assert.ok(!r.source.includes('api gateway'));
    assert.ok(r.source.includes('apiGateway'));
  });

  it('removes prose lines from mermaid source', () => {
    const r = repair('flowchart TD\n  A --> B\n  This is a prose sentence.\n  B --> C');
    assert.ok(!r.source.includes('This is a prose'));
    assert.ok(r.changes.some(c => /removed prose/.test(c)));
  });

  it('closes unbalanced brackets', () => {
    const r = repair('flowchart TD\n  A["unclosed label');
    assert.ok(r.source.includes(']'));
    assert.ok(r.changes.some(c => /unbalanced bracket/.test(c)));
  });

  it('keeps required quotes on labels containing reserved characters', () => {
    // Quotes are REQUIRED when the label holds brackets, parens, HTML, or
    // entities — stripping them breaks valid user-pasted diagrams
    // (regression: aria.mmd "Parse error on line 3").
    const valid = [
      'flowchart TB',
      '    TITLE["Spec ≜ Init ∧ □[Next]_vars&nbsp;·&nbsp;<br/>details"]:::title',
      '    SVC["Service (primary, hot-path)"] --> DB[("Store (SQL)")]',
    ].join('\n');
    const r = repair(valid);
    assert.ok(r.source.includes('TITLE["Spec'), 'bracket label must stay quoted');
    assert.ok(r.source.includes('SVC["Service (primary'), 'paren label must stay quoted');
    assert.ok(r.source.includes('[("Store (SQL)")]'), 'cylinder label must stay quoted');
    assert.ok(!r.changes.some(c => /stripped quotes/.test(c)));
  });

  it('still strips quotes from plain bracket labels', () => {
    const r = repair('flowchart TD\n    A[("plain text")] --> B["simple label"]');
    assert.ok(r.source.includes('A[(plain text)]'));
    assert.ok(r.changes.some(c => /stripped quotes/.test(c)));
  });

  it('preserves valid mermaid structure through repair', () => {
    const valid = 'flowchart TD\n    A["Start"] --> B["End"]';
    const r = repair(valid);
    assert.match(r.source, /-->/);
    assert.match(r.source, /A\[Start\]/);
    assert.match(r.source, /B\[End\]/);
    assert.doesNotMatch(r.source, /\]\]/);
    assert.ok(r.source.startsWith('flowchart'));
  });

  it('normalizes indentation on flat lines', () => {
    const r = repair('flowchart TD\nA --> B\nB --> C');
    const lines = r.source.split('\n');
    assert.ok(lines[1].startsWith('    '));
    assert.ok(lines[2].startsWith('    '));
  });

  it('handles empty input gracefully', () => {
    const r = repair('');
    assert.equal(r.source, '');
    assert.equal(r.changes.length, 0);
  });

  it('handles null input gracefully', () => {
    const r = repair(null);
    assert.equal(r.source, '');
    assert.equal(r.changes.length, 0);
  });
});
