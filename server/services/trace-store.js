'use strict';

/**
 * In-memory + file-backed trace store for MERMATE pipeline stage events.
 *
 * Every reportStage() call from opseeq-bridge appends here as well,
 * so traces are always available locally regardless of Opseeq connectivity.
 * On finalize, the trace is persisted alongside the run JSON.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');

// run_id -> StageEvent[]
const _traces = new Map();

const MAX_EVENTS_PER_RUN = 200;
const MAX_RUNS_IN_MEMORY = 500;

function append(runId, event) {
  if (!runId) return;
  let events = _traces.get(runId);
  if (!events) {
    if (_traces.size >= MAX_RUNS_IN_MEMORY) {
      const oldest = _traces.keys().next().value;
      _traces.delete(oldest);
    }
    events = [];
    _traces.set(runId, events);
  }
  if (events.length < MAX_EVENTS_PER_RUN) {
    events.push({ ...event, ts: event.ts || Date.now() });
  }
}

function get(runId) {
  return _traces.get(runId) || [];
}

function has(runId) {
  return _traces.has(runId);
}

/**
 * Persist the trace to disk alongside the run JSON, then optionally
 * evict from memory.
 */
async function persist(runId) {
  const events = _traces.get(runId);
  if (!events || events.length === 0) return;

  const tracePath = path.join(RUNS_DIR, `${runId}.trace.json`);
  try {
    const traceBody = process.env.MERMATE_RUN_JSON_PRETTY === '1'
      ? JSON.stringify(events, null, 2)
      : JSON.stringify(events);
    await fsp.writeFile(tracePath, traceBody, 'utf8');
    logger.debug('trace_store.persisted', { runId: runId.slice(0, 8), events: events.length, path: tracePath });
  } catch (err) {
    logger.warn('trace_store.persist_failed', { runId: runId.slice(0, 8), error: err.message });
  }
}

/**
 * Load a trace from disk if not in memory.
 */
async function load(runId) {
  if (_traces.has(runId)) return _traces.get(runId);

  const tracePath = path.join(RUNS_DIR, `${runId}.trace.json`);
  try {
    const raw = await fsp.readFile(tracePath, 'utf8');
    const events = JSON.parse(raw);
    _traces.set(runId, events);
    return events;
  } catch {
    return [];
  }
}

function clear(runId) {
  _traces.delete(runId);
}

function stats() {
  let totalEvents = 0;
  for (const events of _traces.values()) totalEvents += events.length;
  return { runs: _traces.size, totalEvents };
}

module.exports = { append, get, has, persist, load, clear, stats };
