'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const rmBridge = require('../server/services/rate-master-bridge');
const catalog = require('../server/services/model-catalog');

describe('rate-master-bridge', () => {

  after(() => { rmBridge.destroy(); });

  // ---- Model Catalog tests (since bridge delegates to it) ----

  it('catalog.estimateTokens returns accurate estimates', () => {
    assert.equal(catalog.estimateTokens(''), 0);
    assert.equal(catalog.estimateTokens(null), 0);
    const est = catalog.estimateTokens('Hello world, generate a flowchart');
    assert.ok(est > 0, 'estimateTokens > 0');
  });

  it('catalog.estimateCost handles known and unknown models', () => {
    const cost1 = catalog.estimateCost('gpt-4o', 1000, 1000);
    assert.ok(cost1 > 0, 'known model has non-zero cost');
    const cost2 = catalog.estimateCost('gpt-oss:20b', 1000, 1000);
    assert.equal(cost2, 0, 'local model has zero cost');
    const cost3 = catalog.estimateCost('unknown-model', 1000, 1000);
    assert.ok(cost3 >= 0, 'unknown model falls back gracefully');
  });

  it('catalog.usesCompletionTokens classifies models correctly', () => {
    assert.equal(catalog.usesCompletionTokens('gpt-5.1'), true);
    assert.equal(catalog.usesCompletionTokens('gpt-4o'), false);
    assert.equal(catalog.usesCompletionTokens('o1'), true);
    assert.equal(catalog.usesCompletionTokens('o3-mini'), true);
    assert.equal(catalog.usesCompletionTokens('gpt-oss:20b'), false);
  });

  it('catalog.classifyTier returns valid tier names', () => {
    const ep1 = catalog.classifyTier('gpt-4o');
    assert.ok(Object.values(catalog.Tier).includes(ep1), `gpt-4o → ${ep1}`);

    assert.equal(catalog.classifyTier('gpt-4o-mini'), catalog.Tier.FAST);
    assert.equal(catalog.classifyTier('enhancer'), catalog.Tier.LOCAL);

    const ep5 = catalog.classifyTier('o1-preview');
    assert.equal(ep5, catalog.Tier.ORCHESTRATOR);
  });

  it('catalog.canonicalStage maps legacy names to verb:noun', () => {
    assert.equal(catalog.canonicalStage('fact_extraction'), 'extract:facts');
    assert.equal(catalog.canonicalStage('composition'), 'compose:branch');
    assert.equal(catalog.canonicalStage('max_composition'), 'compose:max');
    assert.equal(catalog.canonicalStage('unknown_stage'), 'unknown_stage');
  });

  it('catalog.stagePriority returns correct priority', () => {
    assert.equal(catalog.stagePriority('max_composition'), catalog.Priority.CRITICAL);
    assert.equal(catalog.stagePriority('merge_composition'), catalog.Priority.CRITICAL);
    assert.equal(catalog.stagePriority('composition'), catalog.Priority.HIGH);
    assert.equal(catalog.stagePriority('decompose'), catalog.Priority.NORMAL);
    assert.equal(catalog.stagePriority('copilot_suggest'), catalog.Priority.LOW);
    assert.equal(catalog.stagePriority('unknown_stage'), catalog.Priority.NORMAL);
  });

  // ---- Bridge tests ----

  it('estimateContextSize returns valid estimates', () => {
    const est = rmBridge.estimateContextSize('composition', 'Hello world, generate a flowchart');
    assert.ok(est.inputTokensEst > 0, 'inputTokensEst > 0');
    assert.ok(est.outputTokensEst > 0, 'outputTokensEst > 0');
    assert.ok(est.totalTokensEst === est.inputTokensEst + est.outputTokensEst);
    assert.ok(est.contextUtilization > 0 && est.contextUtilization < 1);
  });

  it('estimateContextSize uses stage profile for unknown input', () => {
    const est = rmBridge.estimateContextSize('max_composition');
    assert.equal(est.inputTokensEst, 8000);
    assert.equal(est.outputTokensEst, 12000);
  });

  it('buildActionTag creates valid structured tag', () => {
    const est = rmBridge.estimateContextSize('composition', 'test input');
    const tag = rmBridge.buildActionTag('composition', 'gpt-4o', 'openai-worker', 1, est);
    assert.ok(tag.tag.startsWith('[RM:'));
    assert.equal(tag.stage, 'compose:branch');
    assert.equal(tag.legacyStage, 'composition');
    assert.equal(tag.model, 'gpt-4o');
    assert.equal(tag.priority, 1);
    assert.equal(tag.priorityLabel, 'HIGH');
    assert.ok(tag.inputTokensEst > 0);
    assert.ok(tag.enqueuedAt > 0);
    assert.ok(tag.seq > 0);
  });

  it('getPriority delegates to catalog', () => {
    assert.equal(rmBridge.getPriority('max_composition'), catalog.Priority.CRITICAL);
    assert.equal(rmBridge.getPriority('copilot_suggest'), catalog.Priority.LOW);
  });

  it('getMetrics returns object or null', () => {
    const m = rmBridge.getMetrics();
    if (m) {
      assert.ok(typeof m.totalQueueDepth === 'number');
      assert.ok(typeof m.endpoints === 'object');
    }
  });

  it('execute routes a function through the queue', async () => {
    const { result, actionTag } = await rmBridge.execute(
      'composition', 'gpt-4o', 'test input',
      async () => 'mock output'
    );
    assert.equal(result, 'mock output');
    assert.ok(actionTag);
    assert.ok(actionTag.tag.startsWith('[RM:'));
    assert.equal(actionTag.stage, 'compose:branch');
    assert.ok(actionTag.executionMs >= 0);
  });

  it('getMetrics returns data after execute', () => {
    const m = rmBridge.getMetrics();
    assert.ok(m !== null, 'metrics should be available');
  });

  it('feedback does not throw', () => {
    assert.doesNotThrow(() => {
      rmBridge.feedback('gpt-4o', {
        remainingRequests: 50,
        statusCode: 200,
      });
    });
  });
});
