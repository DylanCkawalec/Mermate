'use strict';

/**
 * FakeInferenceProvider — Deterministic Record/Replay provider for pipeline testing.
 *
 * Modes:
 *   - Replay (default): Returns pre-recorded responses from test/fixtures/regression-fixtures.json
 *   - Record (MERMATE_RECORD=1 or MERMATE_RECORD_FIXTURES=1): Calls real provider and saves fixture
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIXTURE_PATH = path.join(__dirname, '../fixtures/regression-fixtures.json');

function computeFixtureKey(stage, userPrompt = '') {
  const normPrompt = typeof userPrompt === 'string'
    ? userPrompt.slice(0, 500)
    : JSON.stringify(userPrompt || '').slice(0, 500);
  return crypto.createHash('sha256').update(`${stage}::${normPrompt}`).digest('hex');
}

class FakeInferenceProvider {
  constructor(options = {}) {
    this.fixturePath = options.fixturePath || FIXTURE_PATH;
    this.recordMode = !!(
      process.env.MERMATE_RECORD === '1' ||
      process.env.MERMATE_RECORD_FIXTURES === '1' ||
      options.record
    );
    this.fixtures = this._loadFixtures();
    this.realProvider = options.realProvider || null;
  }

  _loadFixtures() {
    try {
      if (fs.existsSync(this.fixturePath)) {
        const raw = fs.readFileSync(this.fixturePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[FakeInferenceProvider] Failed to load fixtures from ${this.fixturePath}:`, err.message);
    }
    return {};
  }

  _saveFixtures() {
    try {
      const dir = path.dirname(this.fixturePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.fixturePath, JSON.stringify(this.fixtures, null, 2), 'utf8');
    } catch (err) {
      console.error(`[FakeInferenceProvider] Failed to save fixtures:`, err.message);
    }
  }

  setFixture(stage, userPrompt, output, metadata = {}) {
    const key = computeFixtureKey(stage, userPrompt);
    this.fixtures[key] = {
      stage,
      key,
      userPromptSnippet: typeof userPrompt === 'string' ? userPrompt.slice(0, 100) : '',
      output,
      model: metadata.model || 'fake-model',
      provider: metadata.provider || 'fake-provider',
      latencyMs: metadata.latencyMs || 0,
    };
    if (this.recordMode) {
      this._saveFixtures();
    }
  }

  async infer(stage, context = {}) {
    const userPrompt = context.userPrompt || '';
    const key = computeFixtureKey(stage, userPrompt);

    if (this.fixtures[key]) {
      const fix = this.fixtures[key];
      return {
        output: typeof fix.output === 'object' ? JSON.stringify(fix.output) : fix.output,
        provider: fix.provider || 'fake-provider',
        noOp: false,
        latencyMs: 0,
        model: fix.model || 'fake-model',
      };
    }

    // Check scenario-based lookup
    if (this.fixtures.scenarios) {
      for (const [scenName, scen] of Object.entries(this.fixtures.scenarios)) {
        if (scen && scen[stage]) {
          const val = scen[stage];
          const outputStr = typeof val === 'object' ? JSON.stringify(val) : val;
          return {
            output: outputStr,
            provider: 'fake-provider',
            noOp: false,
            latencyMs: 0,
            model: 'fake-model',
          };
        }
      }
    }

    if (this.recordMode && this.realProvider) {
      const result = await this.realProvider.infer(stage, context);
      if (result && result.output) {
        this.setFixture(stage, userPrompt, result.output, {
          model: result.model,
          provider: result.provider,
          latencyMs: result.latencyMs,
        });
      }
      return result;
    }

    // Fallback: check stage-based generic match or construct synthetic valid output
    const stageMatch = Object.values(this.fixtures).find(f => f && f.stage === stage);
    if (stageMatch) {
      return {
        output: typeof stageMatch.output === 'object' ? JSON.stringify(stageMatch.output) : stageMatch.output,
        provider: 'fake-provider-fallback',
        noOp: false,
        latencyMs: 0,
        model: stageMatch.model || 'fake-model',
      };
    }

    return {
      output: null,
      provider: 'fake-none',
      noOp: true,
      latencyMs: 0,
      model: 'none',
    };
  }

  async inferMax(stage, context = {}) {
    return this.infer(stage, context);
  }

  async inferWithRole(stage, context = {}, roleName) {
    return this.infer(stage, context);
  }

  isMaxAvailable() {
    return true;
  }

  async checkProviders() {
    return { premium: true, ollama: false, enhancer: false };
  }

  /**
   * Monkey-patches the real inference provider in place.
   */
  patchModule(targetModule) {
    const realModule = targetModule || require('../../server/services/inference-provider');
    this.realProvider = { ...realModule };

    realModule.infer = (stage, context) => this.infer(stage, context);
    realModule.inferMax = (stage, context) => this.inferMax(stage, context);
    realModule.inferWithRole = (stage, context, roleName) => this.inferWithRole(stage, context, roleName);
    realModule.isMaxAvailable = () => this.isMaxAvailable();
    realModule.checkProviders = () => this.checkProviders();

    return realModule;
  }
}

module.exports = FakeInferenceProvider;
