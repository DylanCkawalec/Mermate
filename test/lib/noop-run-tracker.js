'use strict';

/**
 * NoopRunTracker — In-memory fake run tracker for testing.
 * Records calls in memory without external side effects or DB mutations.
 */

class NoopRunTracker {
  constructor() {
    this.stages = [];
    this.calls = [];
    this.rateEvents = [];
    this.merges = [];
  }

  addStage(runId, stage) {
    this.stages.push({ runId, stage, ts: Date.now() });
  }

  recordAgentCall(runId, call) {
    this.calls.push({ runId, ...call, ts: Date.now() });
  }

  recordRateEvent(runId, event) {
    this.rateEvents.push({ runId, ...event, ts: Date.now() });
  }

  recordMerge(runId, mergeInfo) {
    this.merges.push({ runId, ...mergeInfo, ts: Date.now() });
  }

  clear() {
    this.stages.length = 0;
    this.calls.length = 0;
    this.rateEvents.length = 0;
    this.merges.length = 0;
  }
}

module.exports = NoopRunTracker;
