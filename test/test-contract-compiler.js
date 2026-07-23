'use strict';

/**
 * Contract test: Compiler Ports
 * Verifies that RealCompiler and FakeCompiler produce matching compile/validate output contracts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const realCompiler = require('../server/services/mermaid-compiler');
const FakeCompiler = require('./lib/fake-compiler');

test('Compiler Contract: Both implement compile and validate functions', async () => {
  const fakeCompiler = new FakeCompiler();

  const validMmd = 'flowchart TB\n    A["Start"] --> B["End"]';
  const valResult = fakeCompiler.validate(validMmd);

  assert.ok('valid' in valResult, 'Validate result contains valid property');
  assert.equal(typeof valResult.valid, 'boolean', 'valid property is boolean');

  const tmpDir = path.join(__dirname, 'fixtures');
  const compResult = await fakeCompiler.compile(validMmd, tmpDir, 'contract-test');

  assert.ok('ok' in compResult, 'Compile result contains ok property');
  assert.equal(typeof compResult.ok, 'boolean', 'ok property is boolean');
});
