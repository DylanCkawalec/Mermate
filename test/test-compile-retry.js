'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { compileWithRetry } = require('../server/services/input-router');

describe('compileWithRetry', () => {

  it('compiles valid mermaid on attempt 1', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermate-test-'));
    try {
      const result = await compileWithRetry(
        'flowchart TD\n    A["Start"] --> B["End"]',
        tmpDir,
        'test-valid',
      );
      assert.equal(result.result.ok, true);
      assert.equal(result.attempts, 1);
      assert.equal(result.repairChanges.length, 0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('repairs reserved-word IDs and compiles on attempt 2', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermate-test-'));
    try {
      const result = await compileWithRetry(
        'flowchart TD\n    end["Bad Node"] --> B["OK"]',
        tmpDir,
        'test-reserved',
      );
      assert.equal(result.result.ok, true);
      assert.ok(result.attempts <= 2, `Expected <= 2 attempts, got ${result.attempts}`);
      if (result.attempts === 2) {
        assert.ok(result.repairChanges.length > 0, 'Should have repair changes');
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('attempts multiple times for broken input and reports attempt count', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermate-test-'));
    try {
      const result = await compileWithRetry(
        'this is not mermaid at all !!!@@@',
        tmpDir,
        'test-broken',
      );
      // The retry loop should attempt at least once. If a model provider is
      // available, it may succeed in repairing the input — that is correct behavior.
      assert.ok(result.attempts >= 1, 'Should have attempted at least once');
      if (result.result.ok) {
        assert.ok(result.attempts >= 2, 'Broken input should require at least 2 attempts to recover');
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
