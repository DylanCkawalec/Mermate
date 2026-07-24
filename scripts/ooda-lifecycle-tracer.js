'use strict';

/**
 * OODA Lifecycle Tracer — one end-to-end run through Mermate's five tabs.
 *
 * Runs a single canonical job: Simple Idea -> Markdown Spec -> Mermaid -> TLA+ -> TypeScript.
 * Records every inference call, toolchain outcome, and failure into a single trace file.
 *
 * Environment:
 *   MERMATE_BASE_URL      default http://localhost:3333
 *   MERMATE_ENHANCER_URL  default http://localhost:8100
 *   MERMATE_LOG_LEVEL     default warn
 *   MERMATE_LOG_FORMAT    default compact
 *
 * Usage:
 *   node scripts/ooda-lifecycle-tracer.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BASE = process.env.MERMATE_BASE_URL || 'http://localhost:3333';
const ENHANCER = process.env.MERMATE_ENHANCER_URL || 'http://localhost:8100';
const RUNS_DIR = path.resolve(__dirname, '..', 'runs');

process.env.MERMATE_LOG_LEVEL = process.env.MERMATE_LOG_LEVEL || 'warn';
process.env.MERMATE_LOG_FORMAT = process.env.MERMATE_LOG_FORMAT || 'compact';

const IDEA = process.env.CANONICAL_PROMPT || 'A real-time inventory management system for a chain of boutique retail stores with 5 locations, tracking stock levels across warehouses, sending alerts when items run low, and syncing with the POS system.';

const MMD_DIRECTIVE_RE = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|C4Context|C4Container|C4Dynamic|quadrantChart|sankey-beta|xychart-beta|block-beta|gitgraph)\b/i;

function isMermaid(text) {
  if (!text || !text.trim()) return false;
  const firstLine = text.split('\n').find(l => l.trim() && !l.trim().startsWith('%%'));
  return firstLine ? MMD_DIRECTIVE_RE.test(firstLine.trim()) : false;
}

function isTLA(text) {
  return /----\s*MODULE\s/i.test(text || '') && /====\s*$/.test((text || '').trim());
}

function isTS(text) {
  return /(interface|class|function|const|type)\s/i.test(text || '') && !isMermaid(text || '');
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port: 3333, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, data: raw, raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 3333, path }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, data: raw, raw }); }
      });
    }).on('error', reject);
  });
}

function postSSE(path, body, onEvent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port: 3333, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Accept': 'text/event-stream' },
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!frame.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(frame.slice(6));
            onEvent(evt);
          } catch { /* malformed SSE frame */ }
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function logProgress(tab, phase, stats) {
  const { calls = 0, infMs = 0, wallMs = 0 } = stats || {};
  console.log(`[tracer] tab=${tab.padEnd(6)} phase=${(phase || '').padEnd(12)} calls=${String(calls).padStart(2)} inf=${(infMs / 1000).toFixed(1)}s wall=${(wallMs / 1000).toFixed(1)}s`);
}

function fmtErr(err) {
  if (!err) return '';
  return err.message ? err.message : String(err);
}

async function healthChecks() {
  console.log('[tracer] Health checks');
  const results = {};
  try {
    const health = await get('/api/health');
    results.server = health.status === 200 ? 'ok' : `http_${health.status}`;
  } catch (e) { results.server = `err: ${fmtErr(e)}`; }

  try {
    const tla = await get('/api/render/tla/status');
    results.tla_toolchain = tla.status === 200 ? 'ok' : `http_${tla.status}`;
  } catch (e) { results.tla_toolchain = `err: ${fmtErr(e)}`; }

  try {
    const ts = await get('/api/render/ts/status');
    results.ts_toolchain = ts.status === 200 ? 'ok' : `http_${ts.status}`;
  } catch (e) { results.ts_toolchain = `err: ${fmtErr(e)}`; }

  try {
    const modes = await get('/api/agent/modes');
    results.agent_modes = modes.status === 200 && Array.isArray(modes.data?.modes) ? modes.data.modes.length : `http_${modes.status}`;
  } catch (e) { results.agent_modes = `err: ${fmtErr(e)}`; }

  try {
    const enhancerHealth = await new Promise((resolve, reject) => {
      http.get(ENHANCER + '/health', (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
      }).on('error', reject);
    });
    results.enhancer = enhancerHealth.status === 200 ? 'ok' : `http_${enhancerHealth.status}`;
  } catch (e) { results.enhancer = `err: ${fmtErr(e)}`; }

  console.log('  ' + Object.entries(results).map(([k, v]) => `${k}=${v}`).join(' '));
  return results;
}

async function runAgentPhase(tab, input, mode, currentStage, runId) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const events = [];
    let preview = null;
    let lastPhase = 'ingest';
    let calls = 0;

    postSSE('/api/agent/run', {
      prompt: input,
      mode,
      current_text: input,
      current_stage: currentStage,
      current_run_id: runId,
    }, (evt) => {
      events.push(evt);
      if (evt.type === 'agent_session') {
        console.log(`  [${tab}] session ${evt.session_id?.slice(0, 8) || ''}`);
      }
      if (evt.type === 'stage') {
        lastPhase = evt.stage;
        logProgress(tab, lastPhase, { calls, infMs: 0, wallMs: Date.now() - start });
      }
      if (evt.type === 'preview_ready') {
        preview = evt;
      }
      if (evt.type === 'telemetry' && typeof evt.totalTokensIn === 'number') {
        calls += 1;
      }
      if (evt.type === 'error') {
        console.log(`  [${tab}] ERROR: ${evt.message}`);
      }
    }).then(() => {
      const wallMs = Date.now() - start;
      resolve({ events, preview, phase: lastPhase, wallMs, calls });
    }).catch(reject);
  });
}

async function runRender(input, mode = 'md', runId) {
  console.log(`[tracer] Render ${mode} -> mermaid`);
  const start = Date.now();
  const res = await post('/api/render', {
    mermaid_source: input,
    input_mode: mode,
    enhance: true,
    diagram_name: 'tracer-inventory',
    run_id: runId,
  });
  const wallMs = Date.now() - start;
  return { ...res, wallMs };
}

async function runTLA(input, runId) {
  console.log('[tracer] Mermaid -> TLA+');
  const start = Date.now();
  const res = await post('/api/render/tla/check', {
    tla_source: input,
    module_name: 'TracerSpec',
    run_id: runId,
  });
  const wallMs = Date.now() - start;
  return { ...res, wallMs };
}

async function runTS(input, runId) {
  console.log('[tracer] TLA+ -> TypeScript');
  const start = Date.now();
  const res = await post('/api/render/ts', {
    ts_source: input,
    diagram_name: 'TracerSpec',
    run_id: runId,
  });
  const wallMs = Date.now() - start;
  return { ...res, wallMs };
}

async function fetchTrace(runId) {
  try {
    const res = await get(`/api/runs/${runId}/trace`);
    if (res.status === 200 && res.data?.success) return res.data.trace;
    const fallback = await get(`/api/runs/${runId}`);
    if (fallback.status === 200 && fallback.data?.success) return fallback.data.run;
  } catch (e) {
    console.log(`  [trace] fetch error: ${fmtErr(e)}`);
  }
  return null;
}

async function fetchEnhancerTelemetry() {
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(ENHANCER + '/telemetry/records?limit=50', (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, data: raw }); }
        });
      }).on('error', reject);
    });
    if (res.status === 200) return res.data?.records || [];
  } catch (e) { /* enhancer optional */ }
  return [];
}

function buildVerdict(trace, artifacts, failures) {
  const lines = ['# OODA Lifecycle Tracer Verdict\n'];
  lines.push(`- **run_id**: ${trace.run_id || 'unknown'}`);
  lines.push(`- **status**: ${trace.status || 'unknown'}`);
  lines.push(`- **wall_ms**: ${trace.totals?.wall_clock_ms || 0}`);
  lines.push(`- **inference_ms**: ${trace.totals?.total_inference_ms || 0}`);
  lines.push(`- **agent_calls**: ${trace.totals?.total_agent_calls || 0}`);
  lines.push(`- **cost_est**: ${trace.totals?.total_cost_est || 0}`);
  lines.push('');

  lines.push('## Per-Tab Outcomes');
  lines.push('| tab | present | ok | artifact_len |');
  lines.push('|-----|---------|----|-------------|');
  for (const tab of ['idea', 'md', 'mmd', 'tla', 'ts']) {
    const artifact = artifacts[tab] || '';
    const ok = tab === 'idea' ? true
      : tab === 'md' ? !!(artifact && artifact.length > 50)
      : tab === 'mmd' ? isMermaid(artifact)
      : tab === 'tla' ? isTLA(artifact)
      : isTS(artifact);
    lines.push(`| ${tab} | yes | ${ok ? 'ok' : 'FAIL'} | ${artifact.length} |`);
  }
  lines.push('');

  lines.push('## Provider Breakdown');
  const byProvider = {};
  for (const c of (trace.calls || [])) {
    const p = c.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { count: 0, ms: 0 };
    byProvider[p].count += 1;
    byProvider[p].ms += c.latency_ms || 0;
  }
  lines.push('| provider | calls | total_ms |');
  lines.push('|----------|-------|----------|');
  for (const [p, s] of Object.entries(byProvider)) {
    lines.push(`| ${p} | ${s.count} | ${s.ms} |`);
  }
  lines.push('');

  lines.push('## Failures');
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| stage | tab | error_class | message |');
    lines.push('|-------|-----|-------------|---------|');
    for (const f of failures) {
      lines.push(`| ${f.stage || ''} | ${f.tab || ''} | ${f.error_class || ''} | ${(f.message || '').slice(0, 80)} |`);
    }
  }
  lines.push('');

  lines.push('## sum_check');
  lines.push('```json');
  lines.push(JSON.stringify(trace.sum_check || {}, null, 2));
  lines.push('```');

  return lines.join('\n');
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  console.log('========================================');
  console.log('  OODA LIFECYCLE TRACER');
  console.log('========================================');

  const health = await healthChecks();

  const artifacts = {};
  const failures = [];
  let runId = null;

  // Phase 1: Simple Idea -> Markdown (via agent thinking)
  const agent = await runAgentPhase('idea', IDEA, 'thinking', 'idea');
  const preview = agent.preview || {};
  runId = preview.run_id || agent.events.find(e => e.type === 'agent_session')?.session_id || randomUUID();
  artifacts.idea = IDEA;
  artifacts.md = preview.md_source || preview.draft_text || '';
  artifacts.mmd = preview.mmd_source || '';
  if (!artifacts.md) failures.push({ stage: 'agent_run', tab: 'md', error_class: 'missing_artifact', message: 'md_source not emitted in preview_ready' });
  if (!artifacts.mmd) failures.push({ stage: 'agent_run', tab: 'mmd', error_class: 'missing_artifact', message: 'mmd_source not emitted in preview_ready' });

  // Phase 2: Markdown -> Mermaid (via render API if agent didn't yield valid mmd)
  let mmd = artifacts.mmd;
  if (!isMermaid(mmd)) {
    const render = await runRender(artifacts.md || IDEA, 'md', runId);
    if (render.status === 200 && render.data?.success) {
      mmd = render.data.compiled_source || render.data.mmd_source || '';
      artifacts.mmd = mmd;
    } else {
      failures.push({ stage: 'render', tab: 'mmd', error_class: 'render_failed', message: (render.data?.error || render.raw || '').slice(0, 120) });
    }
  }

  // Phase 3: Mermaid -> TLA+
  let tla = '';
  if (isMermaid(mmd)) {
    const tlaRes = await runTLA(mmd, runId);
    if (tlaRes.status === 200 && tlaRes.data?.success) {
      tla = tlaRes.data.tla_source || '';
      artifacts.tla = tla;
      if (!tlaRes.data.sany?.valid) {
        failures.push({ stage: 'tla', tab: 'tla', error_class: 'sany_failed', message: tlaRes.data.sany?.error || 'SANY validation failed' });
      }
    } else {
      failures.push({ stage: 'render/tla', tab: 'tla', error_class: 'render_failed', message: (tlaRes.data?.error || tlaRes.raw || '').slice(0, 120) });
    }
  } else {
    failures.push({ stage: 'render', tab: 'mmd', error_class: 'invalid_mermaid', message: 'mmd artifact is not valid Mermaid; skipping TLA+' });
  }

  // Phase 4: TLA+ -> TypeScript
  if (isTLA(tla)) {
    const tsRes = await runTS(tla, runId);
    if (tsRes.status === 200 && tsRes.data?.success) {
      artifacts.ts = tsRes.data.ts_source || tsRes.data.source || '';
    } else {
      failures.push({ stage: 'render/ts', tab: 'ts', error_class: 'render_failed', message: (tsRes.data?.error || tsRes.raw || '').slice(0, 120) });
    }
  } else {
    failures.push({ stage: 'tla', tab: 'tla', error_class: 'invalid_tla', message: 'TLA+ artifact missing MODULE/==== markers; skipping TS' });
  }

  // Collect trace from server
  const trace = await fetchTrace(runId) || { run_id: runId, status: 'partial', calls: [], totals: {}, sum_check: {} };

  // Merge local failures into trace failures
  const existingMessages = new Set((trace.failures || []).map(f => f.message));
  for (const f of failures) {
    if (!existingMessages.has(f.message)) trace.failures.push(f);
  }

  // Fetch enhancer telemetry if available
  trace.enhancer_telemetry = await fetchEnhancerTelemetry();

  // Write artifacts and trace
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tracePath = path.join(RUNS_DIR, `ooda-trace-${runId}.json`);
  const verdictPath = path.join(RUNS_DIR, `ooda-verdict-${runId}.md`);

  fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
  fs.writeFileSync(verdictPath, buildVerdict(trace, artifacts, failures));

  const totalMs = Date.now() - startedAt;
  console.log('');
  console.log('========================================');
  console.log('  TRACER COMPLETE');
  console.log('========================================');
  console.log(`  run_id:      ${runId}`);
  console.log(`  total_ms:    ${totalMs}`);
  console.log(`  trace:       ${tracePath}`);
  console.log(`  verdict:     ${verdictPath}`);
  console.log(`  failures:    ${(trace.failures || []).length}`);
  console.log('');
}

main().catch((err) => {
  console.error('[tracer] fatal:', err);
  process.exit(1);
});
