'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAvailable, enhance } = require('../server/services/gpt-enhancer-bridge');

describe('gpt-enhancer-bridge', () => {
  // These tests run without the enhancer service running on port 8100,
  // so they verify the graceful degradation / passthrough behavior.

  it('isAvailable returns false when enhancer is not running', async () => {
    const available = await isAvailable();
    assert.equal(available, false);
  });

  it('enhance returns passthrough when enhancer is not running', async () => {
    const source = 'flowchart LR\n  A --> B';
    const result = await enhance(source);
    assert.equal(result.source, source);
    assert.equal(result.enhanced, false);
    assert.equal(result.meta.transformation, 'passthrough');
    assert.ok(result.meta.reason); // should contain the connection error reason
  });

  it('enhance preserves original source exactly on passthrough', async () => {
    const source = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi';
    const result = await enhance(source, 'sequence');
    assert.equal(result.source, source);
    assert.equal(result.enhanced, false);
  });
});
