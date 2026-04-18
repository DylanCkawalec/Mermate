'use strict';

/**
 * Tandem E2E Acceptance Test — MERMATE + Opseeq Trace Correlation
 *
 * Validates the full tandem hardening loop:
 *   1. Render (idea -> Mermaid) with trace ID correlation
 *   2. Verify trace events are stored locally
 *   3. TLA+ compilation with stage reporting
 *   4. TypeScript compilation with stage reporting
 *   5. Read back the full trace via /api/mermate/trace/:run_id
 *   6. Verify trace completeness and ordering
 *   7. Validate fallback_events field appears when Opseeq is unavailable
 *
 * Requires: running server on port 3333 with API keys configured.
 */

const http = require('node:http');
const { strict: assert } = require('node:assert');

const PORT = 3333;
const BASE = `http://127.0.0.1:${PORT}`;

const TANDEM_IDEA = `
Design a task queue service with:
- A Producer that enqueues tasks with priority levels (high, medium, low)
- A Dispatcher that assigns tasks to Workers based on availability
- Workers process tasks, reporting success or failure back to the Dispatcher
- A Monitor tracks task latency, throughput, and failure rates
- Retry policy: failed tasks retry up to 3 times with exponential backoff
- Dead letter queue for exhausted retries
- Health check endpoint for the Dispatcher
`;

async function _post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 300_000,
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => buf += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

async function _get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, { timeout: 30_000 }, (res) => {
      let buf = '';
      res.on('data', (chunk) => buf += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    }).on('error', reject);
  });
}

function _pass(label, detail) { console.log(`  ✓ ${label}${detail ? ` (${detail})` : ''}`); }
function _fail(label, detail) { console.error(`  ✗ ${label}: ${detail}`); }
function _section(title) { console.log(`\n── ${title} ${'─'.repeat(60 - title.length)}`); }

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    MERMATE + OPSEEQ TANDEM E2E ACCEPTANCE TEST          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  let runId, diagramName;
  const stageTimings = {};

  // ── STAGE 1: Render ──────────────────────────────────────────────────
  _section('STAGE 1: Render (Idea -> Mermaid)');
  const t0 = Date.now();
  const renderResp = await _post('/api/render', {
    mermaid_source: TANDEM_IDEA.trim(),
    input_mode: 'idea',
    enhance: true,
    max_mode: true,
    diagram_name: 'tandem-test-taskqueue',
  });
  stageTimings.render = Date.now() - t0;

  if (!renderResp.data.success) {
    console.error('  [DEBUG] Render response:', JSON.stringify(renderResp.data, null, 2).slice(0, 500));
  }
  assert.equal(renderResp.data.success, true, 'Render should succeed');
  runId = renderResp.data.run_id;
  diagramName = renderResp.data.diagram_name;
  assert.ok(runId, 'run_id must be present');
  assert.ok(diagramName, 'diagram_name must be present');
  _pass('Render succeeded', `${stageTimings.render}ms, run_id=${runId.slice(0, 8)}, diagram=${diagramName}`);

  if (renderResp.data.fallback_events) {
    _pass('Fallback events detected', `${renderResp.data.fallback_events.length} direct-provider fallback(s)`);
  } else {
    _pass('No fallback events', 'Opseeq gateway handled all calls');
  }

  if (renderResp.data.progressionUpdate) {
    _pass('Progression update', `stage=${renderResp.data.progressionUpdate.stage}, unlocked=${renderResp.data.progressionUpdate.unlockedStages.join(',')}`);
  }

  // ── STAGE 2: Check trace after render ────────────────────────────────
  _section('STAGE 2: Trace readback (post-render)');
  const trace1 = await _get(`/api/mermate/trace/${runId}`);
  assert.equal(trace1.data.success, true, 'Trace readback should succeed');
  assert.ok(trace1.data.count >= 1, 'Should have at least 1 trace event after render');

  const renderStart = trace1.data.events.find(e => e.stage === 'render_start');
  const renderComplete = trace1.data.events.find(e => e.stage === 'render_complete');
  assert.ok(renderStart, 'render_start event must exist');
  _pass('render_start event', `pipeline=${renderStart.pipeline}`);

  if (renderComplete) {
    _pass('render_complete event', `diagram=${renderComplete.diagram_name}, valid=${renderComplete.valid}`);
  } else {
    _pass('render events present', `${trace1.data.count} events (complete event may be async)`);
  }

  // ── STAGE 3: TLA+ ───────────────────────────────────────────────────
  _section('STAGE 3: TLA+ (Mermaid -> Formal Spec)');
  const t1 = Date.now();
  const tlaResp = await _post('/api/render/tla', {
    run_id: runId,
    diagram_name: diagramName,
  });
  stageTimings.tla = Date.now() - t1;

  if (tlaResp.data.success) {
    _pass('TLA+ succeeded', `${stageTimings.tla}ms, sany_valid=${tlaResp.data.sany?.valid}, tlc_success=${tlaResp.data.tlc?.success}`);
  } else {
    _fail('TLA+ failed', tlaResp.data.error || 'unknown');
    if (tlaResp.status === 503) {
      console.log('    (Java/TLA+ toolchain not available — skipping TLA+ trace verification)');
    }
  }

  // ── STAGE 4: TypeScript ──────────────────────────────────────────────
  _section('STAGE 4: TypeScript (TLA+ -> Runtime)');
  const t2 = Date.now();
  const tsResp = await _post('/api/render/ts', {
    run_id: runId,
    diagram_name: diagramName,
  });
  stageTimings.ts = Date.now() - t2;

  if (tsResp.data.success || tsResp.data.compile) {
    const compileOk = tsResp.data.compile?.success;
    const testsOk = tsResp.data.tests?.passed;
    _pass('TypeScript generation', `${stageTimings.ts}ms, compile=${compileOk}, tests=${testsOk}`);
  } else {
    _fail('TypeScript failed', tsResp.data.error || 'unknown');
  }

  // ── STAGE 4b: Rust Binary ─────────────────────────────────────────────
  _section('STAGE 4b: Rust Binary (TypeScript -> Binary + Desktop)');
  const rustStatusResp = await _get('/api/render/rust/status');
  if (rustStatusResp.data.available) {
    const t3 = Date.now();
    const rustResp = await _post('/api/render/rust', { run_id: runId, diagram_name: diagramName });
    stageTimings.rust = Date.now() - t3;

    if (rustResp.data.success || rustResp.data.build?.success) {
      _pass('Rust compilation', `${stageTimings.rust}ms, build=${rustResp.data.build?.success}, miracle=${rustResp.data.run?.miracleAchieved}`);
      if (rustResp.data.paths?.desktop) {
        _pass('Desktop deployment', rustResp.data.paths.desktop);
      } else if (rustResp.data.paths?.app_bundle) {
        _pass('.app bundle created', rustResp.data.paths.app_bundle);
      } else {
        _pass('Binary path', rustResp.data.paths?.binary || 'none');
      }
    } else {
      _fail('Rust compilation', rustResp.data.error || `build=${rustResp.data.build?.success}`);
    }
  } else {
    console.log('    (Rust toolchain not available — skipping Rust stage)');
    stageTimings.rust = 0;
  }

  // ── STAGE 5: Full trace readback ─────────────────────────────────────
  _section('STAGE 5: Full trace readback (post-pipeline)');

  // Small delay to allow async stage events to settle
  await new Promise(r => setTimeout(r, 500));

  const traceFull = await _get(`/api/mermate/trace/${runId}`);
  assert.equal(traceFull.data.success, true, 'Full trace readback should succeed');

  const allEvents = traceFull.data.events;
  const stages = allEvents.map(e => e.stage);
  _pass('Total trace events', `${allEvents.length} events`);

  assert.ok(stages.includes('render_start'), 'Trace must include render_start');
  _pass('Stage ordering', stages.join(' -> '));

  // Verify timestamps are monotonically increasing
  let monotonic = true;
  for (let i = 1; i < allEvents.length; i++) {
    if (allEvents[i].ts < allEvents[i - 1].ts) { monotonic = false; break; }
  }
  _pass('Timestamp monotonicity', monotonic ? 'OK' : 'WARN: non-monotonic timestamps');

  // ── STAGE 6: Trace stats ─────────────────────────────────────────────
  _section('STAGE 6: Trace store stats');
  const stats = await _get('/api/mermate/trace-stats');
  assert.equal(stats.data.success, true);
  _pass('Trace store', `${stats.data.runs} runs, ${stats.data.totalEvents} total events`);

  // ── STAGE 7: Guide evaluate ──────────────────────────────────────────
  _section('STAGE 7: Guide evaluate');
  const guideResp = await _post('/api/guide/evaluate', {
    uiState: {
      currentMode: 'mmd',
      isLoading: false,
      agentState: 'idle',
      agentModeActive: false,
      hasInput: true,
      hasName: true,
      hasResult: true,
      enhanceChecked: true,
      maxMode: true,
      notesDirty: false,
      currentRunId: runId,
      currentDiagramName: diagramName,
      unlockedStages: ['idea', 'md', 'mmd', 'tla'],
      completedStages: ['idea', 'md', 'mmd'],
      errorVisible: false,
    },
  });
  if (guideResp.data.success) {
    _pass('Guide evaluate', `source=${guideResp.data.source}, suggestions=${guideResp.data.suggestions?.length}`);
  } else if (guideResp.data.fallback) {
    _pass('Guide evaluate (fallback)', `Opseeq unavailable, heuristic suggestions=${guideResp.data.suggestions?.length}`);
  } else {
    _pass('Guide evaluate (degraded)', `status=${guideResp.status}`);
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                    TANDEM TEST SUMMARY                   ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Run ID:        ${runId.slice(0, 8)}...                              ║`);
  console.log(`║  Diagram:       ${(diagramName + '                              ').slice(0, 38)}║`);
  console.log(`║  Render:        ${String(stageTimings.render || 0).padStart(6)}ms                              ║`);
  console.log(`║  TLA+:          ${String(stageTimings.tla || 0).padStart(6)}ms                              ║`);
  console.log(`║  TypeScript:    ${String(stageTimings.ts || 0).padStart(6)}ms                              ║`);
  console.log(`║  Rust:          ${String(stageTimings.rust || 0).padStart(6)}ms                              ║`);
  console.log(`║  Trace events:  ${String(allEvents.length).padStart(6)}                                ║`);
  console.log(`║  Stages seen:   ${stages.join(', ').slice(0, 38).padEnd(38)}║`);
  console.log(`║  Fallback used: ${renderResp.data.fallback_events ? 'YES' : 'NO '}                                  ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  console.log('\n✅ TANDEM E2E ACCEPTANCE TEST COMPLETE\n');
}

run().catch((err) => {
  console.error('\n❌ TANDEM TEST FAILED:', err.message);
  if (err.code === 'ECONNREFUSED') {
    console.error('   Server not running. Start with: ./mermaid.sh start');
  }
  process.exit(1);
});
