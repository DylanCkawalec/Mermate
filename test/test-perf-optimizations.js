'use strict';

if (!process.env.MERMATE_INFER_TIMEOUT) process.env.MERMATE_INFER_TIMEOUT = '5000';
if (!process.env.MERMATE_MAX_INFER_TIMEOUT) process.env.MERMATE_MAX_INFER_TIMEOUT = '5000';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

describe('buildPrompt caching', () => {
  const { buildPrompt } = require('../server/services/axiom-prompts');

  it('returns the same object reference for repeated calls with same stage', () => {
    const a = buildPrompt('render_prepare');
    const b = buildPrompt('render_prepare');
    assert.equal(a, b, 'cached result must be the same reference');
    assert.ok(a.system.length > 100, 'prompt must have content');
  });

  it('returns different objects for different stages', () => {
    const a = buildPrompt('render_prepare');
    const b = buildPrompt('fact_extraction');
    assert.notEqual(a, b);
    assert.notEqual(a.system, b.system);
  });

  it('cached prompt includes the correct structure', () => {
    const p = buildPrompt('composition');
    assert.equal(typeof p.system, 'string');
    assert.equal(typeof p.outputFormat, 'string');
    assert.equal(typeof p.temperature, 'number');
  });
});

describe('classifyTier caching', () => {
  const catalog = require('../server/services/model-catalog');

  it('returns consistent tier for the same model across calls', () => {
    const a = catalog.classifyTier('gpt-4o-mini');
    const b = catalog.classifyTier('gpt-4o-mini');
    assert.equal(a, b);
    assert.equal(a, catalog.Tier.FAST);
  });

  it('returns correct tiers for known model families', () => {
    assert.equal(catalog.classifyTier('gpt-4o-mini'), catalog.Tier.FAST);
    assert.equal(catalog.classifyTier('enhancer'), catalog.Tier.LOCAL);
    const orchTier = catalog.classifyTier('o1-preview');
    assert.equal(orchTier, catalog.Tier.ORCHESTRATOR);
  });
});

describe('lazy health check behavior', () => {
  const { checkProviders } = require('../server/services/inference-provider');

  after(() => {
    try { require('../server/services/rate-master-bridge').destroy(); } catch { /* ok */ }
  });

  it('checkProviders still returns all three provider statuses', async () => {
    const status = await checkProviders();
    assert.equal(typeof status.premium, 'boolean');
    assert.equal(typeof status.ollama, 'boolean');
    assert.equal(typeof status.enhancer, 'boolean');
  });

  it('infer returns within timeout even when local providers are lazy-skipped', async () => {
    const { infer } = require('../server/services/inference-provider');
    const start = Date.now();
    const result = await infer('fact_extraction', {
      userPrompt: 'test lazy health check bypass',
    });
    const elapsed = Date.now() - start;
    assert.ok(typeof result.provider === 'string');
    assert.ok(elapsed < 10000, `inference should complete within 10s, took ${elapsed}ms`);
  });
});
