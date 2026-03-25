'use strict';

/**
 * Compiler Phases — the canonical phase model for MERMATE's architecture
 * compilation pipeline.
 *
 * MERMATE is a bounded architecture compiler. Its pipeline is:
 *
 *   PARSE → ANALYZE → VALIDATE → SELECT → MERGE → PERSIST → OUTPUT
 *
 * Every phase is:
 *   - Named and typed
 *   - Audit-tracked via the event stream
 *   - Recorded in the JSON lineage
 *   - Time-bounded by the GoT controller
 *
 * The structural signature is computed in ANALYZE, consumed in VALIDATE
 * and SELECT, recorded in PERSIST, and returned in OUTPUT. This makes it
 * a first-class compiler artifact, not a helper utility.
 */

const logger = require('../utils/logger');

// ---- Phase Enum ------------------------------------------------------------

const Phase = Object.freeze({
  PARSE:    'compile:parse',
  ANALYZE:  'compile:analyze',
  VALIDATE: 'compile:validate',
  SELECT:   'compile:select',
  MERGE:    'compile:merge',
  PERSIST:  'compile:persist',
  OUTPUT:   'compile:output',
});

const PHASE_ORDER = [
  Phase.PARSE,
  Phase.ANALYZE,
  Phase.VALIDATE,
  Phase.SELECT,
  Phase.MERGE,
  Phase.PERSIST,
  Phase.OUTPUT,
];

const PHASE_LABELS = Object.freeze({
  [Phase.PARSE]:    'Parse input and extract content state',
  [Phase.ANALYZE]:  'Extract facts, plan diagram, compute structural signature',
  [Phase.VALIDATE]: 'L0–L3 validation: parse, graph, flow, boundary',
  [Phase.SELECT]:   'Score branches, prune below threshold, select best',
  [Phase.MERGE]:    'Terminal merge of surviving branches',
  [Phase.PERSIST]:  'Finalize run lineage, archive artifacts',
  [Phase.OUTPUT]:   'Assemble protocol response with signature and lineage',
});

// ---- Phase Tracker ---------------------------------------------------------

/**
 * Lightweight phase tracker for a single compilation run.
 * Records phase transitions with timing for audit and narration.
 *
 * Usage:
 *   const run = createPhaseTracker(auditEmit);
 *   run.enter(Phase.PARSE);
 *   // ... do parse work ...
 *   run.enter(Phase.ANALYZE);
 *   // ... etc ...
 *   const summary = run.summary();
 */
function createPhaseTracker(auditEmit, runId) {
  const transitions = [];
  let currentPhase = null;
  let currentStart = null;

  function enter(phase, meta = {}) {
    const now = Date.now();

    // Close previous phase
    if (currentPhase) {
      transitions.push({
        phase: currentPhase,
        startMs: currentStart,
        endMs: now,
        durationMs: now - currentStart,
      });
    }

    currentPhase = phase;
    currentStart = now;

    if (auditEmit) {
      auditEmit('compiler:phase', {
        phase,
        label: PHASE_LABELS[phase] || phase,
        index: PHASE_ORDER.indexOf(phase),
        runId,
        ...meta,
      });
    }

    logger.info('compiler.phase', {
      phase,
      index: PHASE_ORDER.indexOf(phase),
      runId: runId?.slice(0, 8),
    });
  }

  function close() {
    if (currentPhase) {
      const now = Date.now();
      transitions.push({
        phase: currentPhase,
        startMs: currentStart,
        endMs: now,
        durationMs: now - currentStart,
      });
      currentPhase = null;
    }
  }

  function current() {
    return currentPhase;
  }

  function summary() {
    close();
    const total = transitions.reduce((s, t) => s + t.durationMs, 0);
    return {
      phases: transitions.map(t => ({
        phase: t.phase,
        durationMs: t.durationMs,
        pct: total > 0 ? +((t.durationMs / total) * 100).toFixed(1) : 0,
      })),
      totalMs: total,
      phaseCount: transitions.length,
    };
  }

  return { enter, close, current, summary };
}

module.exports = {
  Phase,
  PHASE_ORDER,
  PHASE_LABELS,
  createPhaseTracker,
};
