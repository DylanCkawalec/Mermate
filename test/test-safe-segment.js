'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { safeSegment, slugify } = require('../server/utils/naming');

describe('safeSegment (path traversal guard)', () => {
  it('accepts normal run ids and diagram names', () => {
    assert.equal(safeSegment('e2e-synthetic-test'), 'e2e-synthetic-test');
    assert.equal(safeSegment('run_123.v2'), 'run_123.v2');
  });

  it('rejects traversal and separators', () => {
    assert.equal(safeSegment('..'), null);
    assert.equal(safeSegment('.'), null);
    assert.equal(safeSegment('../etc/passwd'), null);
    assert.equal(safeSegment('a/b'), null);
    assert.equal(safeSegment('a\\b'), null);
    assert.equal(safeSegment(''), null);
    assert.equal(safeSegment(null), null);
    assert.equal(safeSegment(undefined), null);
  });

  it('slugify strips path characters from diagram names', () => {
    assert.equal(slugify('../../evil'), 'evil');
    assert.ok(!slugify('a/b/../c').includes('/'));
  });
});
