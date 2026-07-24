'use strict';

/**
 * Performance Regression Tests for Mermate Pipeline
 * Verifies latency budgets and memory stability using offline fakes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FakeInferenceProvider = require('./lib/fake-inference-provider');
const fakeProvider = new FakeInferenceProvider();
fakeProvider.patchModule();

const inputRouter = require('../server/services/input-router');

test('Performance Budget: renderHPCGoT completes in < 500ms (offline fake)', async () => {
  const start = Date.now();
  const source = 'User sends request to WebApp, which queries Database.';
  await inputRouter.renderHPCGoT(source, null, null, false);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `renderHPCGoT latency ${elapsed}ms < 500ms budget`);
});

test('Performance Budget: decomposeAndRender completes in < 15000ms (offline fake + subview compile)', async () => {
  const start = Date.now();
  const source = 'Large e-commerce platform with Ingress Gateway, Order Processing, and Persistence.';
  await inputRouter.decomposeAndRender(source, null, null, false);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 15000, `decomposeAndRender latency ${elapsed}ms < 15000ms budget`);
});

test('Performance Budget: compileWithRetry completes in < 8000ms on valid input', async () => {
  const validMmd = 'flowchart TB\n    A["Start"] --> B["End"]';
  const tmpDir = path.join(__dirname, 'fixtures');

  const start = Date.now();
  await inputRouter.compileWithRetry(validMmd, tmpDir, 'perf-valid');
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 8000, `compileWithRetry latency ${elapsed}ms < 8000ms budget`);
});

test('Memory Stability: 20 consecutive pipeline iterations do not cause uncontrolled heap growth', async () => {
  if (global.gc) global.gc();
  const initialMemory = process.memoryUsage().heapUsed;

  const source = 'User sends request to WebApp, which queries Database.';
  for (let i = 0; i < 20; i++) {
    await inputRouter.renderHPCGoT(source, null, null, false);
  }

  if (global.gc) global.gc();
  const finalMemory = process.memoryUsage().heapUsed;
  const growthMB = (finalMemory - initialMemory) / (1024 * 1024);

  assert.ok(growthMB < 50, `Heap growth ${growthMB.toFixed(2)}MB < 50MB budget`);
});
