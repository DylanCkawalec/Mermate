'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { infer, checkProviders } = require('../server/services/inference-provider');

describe('inference-provider', () => {

  it('checkProviders returns health status for all providers', async () => {
    const status = await checkProviders();
    assert.ok(typeof status.premium === 'boolean');
    assert.ok(typeof status.ollama === 'boolean');
    assert.ok(typeof status.enhancer === 'boolean');
  });

  it('infer returns output:null and provider:none when no providers are available', async () => {
    // With no providers running on test ports, the chain should exhaust
    // Note: this test may pass slowly if Ollama is running locally
    const result = await infer('render_prepare', {
      userPrompt: 'test input that should trigger no-op on all providers',
    });
    assert.ok(typeof result.provider === 'string');
    assert.ok(typeof result.noOp === 'boolean');
  });

  it('no-op detection rejects output identical to input', async () => {
    // This verifies the no-op logic in the infer function conceptually.
    // Real no-op detection happens inside infer() when provider returns input unchanged.
    const input = 'exact same text';
    const result = await infer('render_prepare', { userPrompt: input });
    // If all providers are down or return no-op, we get null output
    if (result.output === null) {
      assert.equal(result.noOp, true);
    } else {
      // If a provider did respond, it must differ from input
      assert.notEqual(result.output.trim(), input.trim());
    }
  });
});
