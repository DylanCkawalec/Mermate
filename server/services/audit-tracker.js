'use strict';

/**
 * Audit Tracker — canonical hidden event stream for every MERMATE run.
 *
 * Separates three concerns cleanly:
 *   1. Raw execution log  → logger.info / debug (unchanged)
 *   2. Structured audit   → this module (new, complete)
 *   3. User-facing UX     → terminal-narrator reads from here
 *
 * Events are typed, timestamped, and stored in a per-run ring buffer.
 * Subscribers (e.g. terminal-narrator) are notified synchronously so
 * narration events can be emitted back to the SSE stream in real time.
 *
 * Event types follow the GoT.tex lifecycle:
 *
 *   agent:stage_enter        — pipeline stage transition
 *   agent:role_start         — named role begins inference
 *   agent:role_end           — named role inference complete
 *   agent:batch_start        — concurrent inference batch opening
 *   agent:batch_end          — concurrent inference batch closed
 *   agent:draft_update       — draft text evolved
 *   agent:note_decision      — user note path chosen
 *   agent:convergence        — system approaching final answer
 *   got:root_init            — GoT controller root state created
 *   got:branch_start         — branching at level L
 *   got:branch_end           — branch children generated
 *   got:validate             — validation scoring checkpoint
 *   got:prune                — prune pass at tau threshold
 *   got:merge_eval           — merge evaluation started
 *   got:merge_accept         — merge accepted (score non-decreasing)
 *   got:merge_reject         — merge rejected
 *   got:level_complete       — level transition complete
 *   render:prepare           — render pipeline starting
 *   render:hpc_stage1        — HPC fact extraction
 *   render:hpc_stage2        — HPC diagram plan
 *   render:hpc_stage3        — HPC composition
 *   render:validate          — structural validity check
 *   render:repair            — repair attempt started
 *   render:complete          — render succeeded
 *   render:failed            — render failed
 *   render:fallback          — falling back to local conversion
 *   sys:timeout              — timeout encountered
 *   sys:retry                — retry attempted
 *   sys:fallback             — degraded to lower provider
 *   sys:recovery             — recovered from error
 *   sys:error                — unrecoverable error
 */

const { randomUUID } = require('node:crypto');
const logger = require('../utils/logger');

const VERBOSE_AUDIT = process.env.MERMATE_VERBOSE_AUDIT === 'true';

const MAX_RUNS = 50;
const MAX_EVENTS_PER_RUN = 500;

const _runs = new Map();

// ---- Run management -------------------------------------------------------

function createRun(parentRunId, label) {
  if (_runs.size >= MAX_RUNS) {
    const oldest = _runs.keys().next().value;
    _runs.delete(oldest);
  }
  const id = randomUUID();
  _runs.set(id, {
    id,
    parentRunId: parentRunId || null,
    label: label || '',
    startedAt: Date.now(),
    events: [],
    subscribers: [],
    latestPhase: null,
    latestStage: null,
    activeRoles: new Set(),
    stateCount: 0,
    errorCount: 0,
  });
  return id;
}

function closeRun(auditRunId) {
  const run = _runs.get(auditRunId);
  if (run) {
    run.subscribers = [];
  }
}

// ---- Event emission -------------------------------------------------------

/**
 * Emit a typed event into the audit stream for a run.
 *
 * @param {string} auditRunId
 * @param {string} type  - e.g. 'agent:stage_enter'
 * @param {object} data  - type-specific payload
 * @returns {object} the frozen event record
 */
function emit(auditRunId, type, data = {}) {
  const run = _runs.get(auditRunId);
  if (!run) return null;

  const event = Object.freeze({
    id: randomUUID(),
    auditRunId,
    ts: Date.now(),
    elapsed: Date.now() - run.startedAt,
    type,
    ...data,
  });

  if (run.events.length >= MAX_EVENTS_PER_RUN) {
    run.events.shift();
  }
  run.events.push(event);

  // Update live state
  if (type === 'agent:stage_enter')  run.latestStage = data.stage;
  if (type === 'agent:role_start')   run.activeRoles.add(data.role);
  if (type === 'agent:role_end')     run.activeRoles.delete(data.role);
  if (type === 'got:root_init' || type === 'got:branch_end') run.stateCount++;
  if (type === 'sys:error')          run.errorCount++;

  // Log audit event (verbose, use info as debug is not in this logger)
  if (VERBOSE_AUDIT) {
    logger.info('audit.event', {
      runId: auditRunId.slice(0, 8),
      type,
      elapsed: event.elapsed,
      ...Object.fromEntries(
        Object.entries(data).slice(0, 4).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 80) : v])
      ),
    });
  }

  // Notify subscribers synchronously
  for (const cb of run.subscribers) {
    try { cb(event, run); } catch {}
  }

  return event;
}

// ---- Subscriptions --------------------------------------------------------

/**
 * Subscribe to events for a run. The callback receives (event, runSnapshot).
 * Returns an unsubscribe function.
 */
function subscribe(auditRunId, callback) {
  const run = _runs.get(auditRunId);
  if (!run) return () => {};
  run.subscribers.push(callback);
  return () => {
    run.subscribers = run.subscribers.filter(cb => cb !== callback);
  };
}

// ---- Queries --------------------------------------------------------------

function getRun(auditRunId) {
  return _runs.get(auditRunId) || null;
}

function getEvents(auditRunId, { types, since } = {}) {
  const run = _runs.get(auditRunId);
  if (!run) return [];
  let events = run.events;
  if (types) events = events.filter(e => types.includes(e.type));
  if (since) events = events.filter(e => e.ts > since);
  return events;
}

function getLatestState(auditRunId) {
  const run = _runs.get(auditRunId);
  if (!run) return null;
  return {
    id: run.id,
    label: run.label,
    startedAt: run.startedAt,
    elapsed: Date.now() - run.startedAt,
    latestStage: run.latestStage,
    activeRoles: [...run.activeRoles],
    stateCount: run.stateCount,
    errorCount: run.errorCount,
    eventCount: run.events.length,
    lastEventType: run.events[run.events.length - 1]?.type || null,
  };
}

/**
 * Return a compact audit summary suitable for debug replay.
 * Strips large text fields to keep size manageable.
 */
function getAuditSummary(auditRunId) {
  const run = _runs.get(auditRunId);
  if (!run) return null;
  return {
    id: run.id,
    parentRunId: run.parentRunId,
    label: run.label,
    startedAt: run.startedAt,
    durationMs: Date.now() - run.startedAt,
    eventCount: run.events.length,
    errorCount: run.errorCount,
    stateCount: run.stateCount,
    stages: [...new Set(run.events.filter(e => e.stage).map(e => e.stage))],
    roles: [...new Set(run.events.filter(e => e.role).map(e => e.role).filter(Boolean))],
    eventTypes: run.events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1; return acc;
    }, {}),
  };
}

module.exports = {
  createRun,
  closeRun,
  emit,
  subscribe,
  getRun,
  getEvents,
  getLatestState,
  getAuditSummary,
};
