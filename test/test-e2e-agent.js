'use strict';

/**
 * End-to-End MERMATE Agent Verification
 *
 * Simulates the exact user journey:
 *   1. Type simple-idea.prompt into Simple Idea mode
 *   2. Select Agent > Thinking
 *   3. Enable Max mode
 *   4. Click Run Agent
 *   5. Wait for preview_ready
 *   6. Click "Render as is" (finalize without notes)
 *   7. Wait for done
 *
 * Captures every SSE event, telemetry record, and state transition.
 * Produces a structured audit report.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.resolve(__dirname, '..', 'simple-idea.prompt');
const PORT = 3333;
const BASE = `http://127.0.0.1:${PORT}`;

function postSSE(urlPath, body) {
  return new Promise((resolve, reject) => {
    const events = [];
    const startMs = Date.now();

    const req = http.request(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 900_000,
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            event._receivedAt = Date.now();
            event._elapsedMs = Date.now() - startMs;
            events.push(event);

            const label = event.type === 'thinking'
              ? `  ${event.role} — ${event.summary}`
              : event.type === 'stage'
                ? `  >> ${event.message}`
                : event.type === 'analysis'
                  ? `  [quality=${event.quality}, entities=${event.entities}]`
                  : event.type === 'draft_update'
                    ? `  draft updated (${event.reason?.slice(0, 50)})`
                    : event.type === 'telemetry'
                      ? `  [calls=${event.totalCalls}, cost=$${event.totalCost}, latency=${event.totalLatencyMs}ms]`
                      : '';

            console.log(`[${(event._elapsedMs / 1000).toFixed(1)}s] ${event.type}${label}`);
          } catch {}
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('\n========================================');
  console.log('  MERMATE E2E INTELLIGENCE VERIFICATION');
  console.log('========================================\n');

  // Load the prompt
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf-8').trim();
  console.log(`Prompt loaded: ${prompt.length} chars, ${prompt.split(/\s+/).length} words\n`);

  // ---- Phase 1: Agent Run (planning + refinement + preview) ----
  console.log('--- PHASE 1: Agent Run (Thinking mode) ---\n');
  const runStartMs = Date.now();

  const runEvents = await postSSE('/api/agent/run', {
    prompt,
    mode: 'thinking',
    current_text: prompt,
  });

  const runDurationMs = Date.now() - runStartMs;
  console.log(`\nPhase 1 complete: ${runEvents.length} events in ${(runDurationMs / 1000).toFixed(1)}s\n`);

  // Extract draft text from preview_ready
  const previewReady = runEvents.find(e => e.type === 'preview_ready');
  const draftText = previewReady?.draft_text || prompt;
  const diagramName = previewReady?.diagram_name;

  // ---- Phase 2: Finalize (Max render without notes) ----
  console.log('--- PHASE 2: Finalize (Max render, no notes) ---\n');
  const finalizeStartMs = Date.now();

  const finalizeEvents = await postSSE('/api/agent/finalize', {
    current_text: draftText,
    mode: 'thinking',
    user_notes: '',
    diagram_name: diagramName,
  });

  const finalizeDurationMs = Date.now() - finalizeStartMs;
  console.log(`\nPhase 2 complete: ${finalizeEvents.length} events in ${(finalizeDurationMs / 1000).toFixed(1)}s\n`);

  // ---- AUDIT REPORT ----
  const allEvents = [...runEvents, ...finalizeEvents];

  console.log('\n========================================');
  console.log('  AUDIT REPORT');
  console.log('========================================\n');

  // 1. Event Summary
  const eventCounts = {};
  for (const e of allEvents) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  }
  console.log('Event counts:', JSON.stringify(eventCounts, null, 2));

  // 2. Thinking Events (role usage)
  const thinkingEvents = allEvents.filter(e => e.type === 'thinking');
  console.log(`\nThinking events: ${thinkingEvents.length}`);
  for (const t of thinkingEvents) {
    console.log(`  [${t.stage}] ${t.role} (${t.domain}) — ${t.summary}`);
  }

  // 3. Analysis Events
  const analysisEvents = allEvents.filter(e => e.type === 'analysis');
  for (const a of analysisEvents) {
    console.log(`\nAnalysis: maturity=${a.maturity}, quality=${a.quality}, completeness=${a.completeness}, entities=${a.entities}, relationships=${a.relationships}`);
    if (a.gaps?.length) console.log(`  Gaps: ${a.gaps.join('; ')}`);
  }

  // 4. Draft Evolution
  const draftUpdates = allEvents.filter(e => e.type === 'draft_update');
  console.log(`\nDraft updates: ${draftUpdates.length}`);
  for (const d of draftUpdates) {
    const textLen = d.text?.length || 0;
    console.log(`  ${d.reason} (${textLen} chars)`);
  }

  // 5. Preview Render
  const previewRender = allEvents.find(e => e.type === 'preview_render');
  if (previewRender) {
    console.log(`\nPreview render: success=${previewRender.success}`);
    if (previewRender.metrics) {
      console.log(`  Nodes: ${previewRender.metrics.nodeCount}, Edges: ${previewRender.metrics.edgeCount}, Subgraphs: ${previewRender.metrics.subgraphCount || 0}`);
    }
    if (previewRender.error) console.log(`  Error: ${previewRender.error}`);
  }

  // 6. Final Render
  const finalRender = allEvents.find(e => e.type === 'final_render');
  if (finalRender) {
    console.log(`\nFinal render: success=${finalRender.success}`);
    if (finalRender.metrics) {
      console.log(`  Nodes: ${finalRender.metrics?.nodeCount}, Edges: ${finalRender.metrics?.edgeCount}, Subgraphs: ${finalRender.metrics?.subgraphCount || 0}`);
    }
    if (finalRender.error) console.log(`  Error: ${finalRender.error}`);
  }

  // 7. Telemetry
  const telemetryEvent = allEvents.find(e => e.type === 'telemetry');
  if (telemetryEvent) {
    console.log(`\nTelemetry summary:`);
    console.log(`  Run ID: ${telemetryEvent.runId}`);
    console.log(`  Total calls: ${telemetryEvent.totalCalls}`);
    console.log(`  Total tokens in: ${telemetryEvent.totalTokensIn}`);
    console.log(`  Total tokens out: ${telemetryEvent.totalTokensOut}`);
    console.log(`  Total cost: $${telemetryEvent.totalCost}`);
    console.log(`  Total latency: ${telemetryEvent.totalLatencyMs}ms`);
    console.log(`  Wall clock: ${telemetryEvent.wallClockMs}ms`);
    console.log(`  Roles used: ${JSON.stringify(telemetryEvent.roles)}`);
    console.log(`  Providers used: ${JSON.stringify(telemetryEvent.providers)}`);
    console.log(`  Stages: ${JSON.stringify(telemetryEvent.stages)}`);
  }

  // 8. Errors
  const errors = allEvents.filter(e => e.type === 'error');
  if (errors.length) {
    console.log(`\nErrors: ${errors.length}`);
    for (const err of errors) console.log(`  ${err.message}`);
  }

  // 9. Done + Run JSON Lineage Verification
  const doneEvent = allEvents.find(e => e.type === 'done');
  if (doneEvent) {
    console.log(`\nFinal text length: ${doneEvent.final_text?.length || 0} chars`);
    if (doneEvent.run_id) {
      console.log(`Run ID: ${doneEvent.run_id}`);
    }
  }

  // 9b. Verify runs/{id}.json lineage
  console.log('\n--- Run JSON Lineage Verification ---');
  const runId = doneEvent?.run_id || previewReady?.run_id;
  if (runId) {
    try {
      const runJsonPath = path.resolve(__dirname, '..', 'runs', `${runId}.json`);
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf-8'));
      console.log(`Run JSON found: ${runJsonPath}`);
      console.log(`  schema_version: ${runJson.schema_version}`);
      console.log(`  status: ${runJson.status}`);
      console.log(`  pipeline: ${runJson.controller?.pipeline || 'n/a'}`);
      console.log(`  agent_calls: ${runJson.agent_calls?.length || 0}`);
      console.log(`  branches: ${runJson.branches?.length || 0}`);
      console.log(`  subviews: ${runJson.subviews?.length || 0}`);
      console.log(`  merge: ${runJson.merge ? (runJson.merge.accepted ? 'accepted' : 'rejected') : 'none'}`);
      console.log(`  rate_events: ${runJson.rate_events?.length || 0}`);
      console.log(`  warnings: ${runJson.warnings?.length || 0}`);
      if (runJson.totals) {
        console.log(`  totals.wall_clock_ms: ${runJson.totals.wall_clock_ms}`);
        console.log(`  totals.total_agent_calls: ${runJson.totals.total_agent_calls}`);
        console.log(`  totals.total_tokens_in: ${runJson.totals.total_tokens_in}`);
        console.log(`  totals.total_cost_est: $${runJson.totals.total_cost_est}`);
      }
      if (runJson.final_artifact) {
        console.log(`  final_artifact.diagram_name: ${runJson.final_artifact.diagram_name}`);
        console.log(`  final_artifact.diagram_type: ${runJson.final_artifact.diagram_type}`);
        console.log(`  final_artifact.mmd_char_count: ${runJson.final_artifact.mmd_char_count}`);
        console.log(`  final_artifact.metrics: nodes=${runJson.final_artifact.metrics?.node_count}, edges=${runJson.final_artifact.metrics?.edge_count}`);
      }

      // Structural assertions
      const assertions = [];
      if (runJson.schema_version !== '1.0.0') assertions.push('FAIL: schema_version !== 1.0.0');
      if (!['completed', 'failed'].includes(runJson.status)) assertions.push(`FAIL: unexpected status: ${runJson.status}`);
      if (!runJson.agent_calls || runJson.agent_calls.length === 0) assertions.push('WARN: no agent_calls recorded');
      if (runJson.agent_calls) {
        for (const call of runJson.agent_calls) {
          if (!call.completed_at) assertions.push(`WARN: agent_call ${call.call_id?.slice(0, 8)} missing completed_at`);
        }
      }
      if (!runJson.totals) assertions.push('FAIL: missing totals');
      if (assertions.length > 0) {
        console.log('\n  Lineage assertions:');
        for (const a of assertions) console.log(`    ${a}`);
      } else {
        console.log('  All lineage assertions passed');
      }
    } catch (err) {
      console.log(`  Could not read run JSON: ${err.message}`);
    }
  } else {
    console.log('  No run_id found in SSE events — lineage check skipped');
    // Also check if any child run JSON was created from the render calls
    try {
      const runsDir = path.resolve(__dirname, '..', 'runs');
      const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
      console.log(`  Found ${files.length} run JSON files in runs/`);
      if (files.length > 0) {
        const newest = files.sort().pop();
        console.log(`  Newest: ${newest}`);
        const sample = JSON.parse(fs.readFileSync(path.join(runsDir, newest), 'utf-8'));
        console.log(`  Sample: status=${sample.status}, calls=${sample.agent_calls?.length || 0}, pipeline=${sample.controller?.pipeline || 'n/a'}`);
      }
    } catch { /* runs dir may not exist */ }
  }

  // 10. GoT Controller Verification
  console.log('\n--- GoT Controller Verification ---');
  console.log(`Thinking events (role-based calls): ${thinkingEvents.length}`);
  console.log(`Draft evolved: ${draftUpdates.length > 0 ? 'YES' : 'NO'}`);
  console.log(`Preview attempted: ${previewRender ? 'YES' : 'NO'}`);
  console.log(`Final render attempted: ${finalRender ? 'YES' : 'NO'}`);
  console.log(`Total wall clock: ${((runDurationMs + finalizeDurationMs) / 1000).toFixed(1)}s`);

  // 11. Intelligence Assessment
  console.log('\n--- Intelligence Assessment ---');
  const originalWords = prompt.split(/\s+/).length;
  const finalWords = (doneEvent?.final_text || draftText || '').split(/\s+/).length;
  console.log(`Original: ${originalWords} words`);
  console.log(`Final draft: ${finalWords} words`);
  console.log(`Expansion: ${(finalWords / originalWords * 100).toFixed(0)}%`);

  if (analysisEvents.length > 0) {
    const a = analysisEvents[0];
    console.log(`Quality score: ${a.quality}`);
    console.log(`Completeness: ${a.completeness}`);
    console.log(`Maturity: ${a.maturity}`);
    console.log(`Entities detected: ${a.entities}`);
    console.log(`Relationships detected: ${a.relationships}`);
  }

  console.log('\n========================================');
  console.log('  VERIFICATION COMPLETE');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('E2E test failed:', err.message);
  process.exit(1);
});
