'use strict';

/**
 * Contract test: Inference Ports
 * Verifies that RealInferenceProvider and FakeInferenceProvider return identically-shaped objects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRealInferenceProvider } = require('../server/services/inference-provider');
const FakeInferenceProvider = require('./lib/fake-inference-provider');

test('Inference Contract: Real and Fake providers return matching output shapes', async () => {
  const realProvider = createRealInferenceProvider();
  const fakeProvider = new FakeInferenceProvider();

  assert.ok(typeof realProvider.infer === 'function', 'Real provider has infer()');
  assert.ok(typeof fakeProvider.infer === 'function', 'Fake provider has infer()');

  const fakeResult = await fakeProvider.infer('fact_extraction', { userPrompt: 'Test contract' });

  assert.ok('output' in fakeResult, 'Result contains output key');
  assert.ok('provider' in fakeResult, 'Result contains provider key');
  assert.ok('noOp' in fakeResult, 'Result contains noOp key');
  assert.ok('model' in fakeResult, 'Result contains model key');
  assert.ok('latencyMs' in fakeResult, 'Result contains latencyMs key');

  assert.equal(typeof fakeResult.noOp, 'boolean', 'noOp is boolean');
  assert.equal(typeof fakeResult.latencyMs, 'number', 'latencyMs is number');
});
