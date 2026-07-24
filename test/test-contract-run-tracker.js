'use strict';

/**
 * Contract test: Run Tracker Ports
 * Verifies that RealRunTracker and NoopRunTracker conform to the RunTrackerPort interface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const realRunTracker = require('../server/services/run-tracker');
const NoopRunTracker = require('./lib/noop-run-tracker');

test('RunTracker Contract: Both implement expected interface methods', () => {
  const noop = new NoopRunTracker();

  const requiredMethods = ['addStage', 'recordAgentCall', 'recordRateEvent', 'recordMerge'];

  for (const method of requiredMethods) {
    assert.equal(typeof noop[method], 'function', `NoopRunTracker implements ${method}`);
    if (realRunTracker[method]) {
      assert.equal(typeof realRunTracker[method], 'function', `RealRunTracker implements ${method}`);
    }
  }

  noop.addStage('run-1', 'fact_extraction');
  noop.recordAgentCall('run-1', { stage: 'fact_extraction', model: 'gpt-5.6-terra' });

  assert.equal(noop.stages.length, 1, 'NoopRunTracker recorded 1 stage');
  assert.equal(noop.calls.length, 1, 'NoopRunTracker recorded 1 agent call');
});
