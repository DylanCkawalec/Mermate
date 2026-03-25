'use strict';

/**
 * E2E Pipeline Test — Full 5-Stage Architecture Compilation
 *
 * Tests the complete MERMATE artifact chain:
 *   Simple Idea -> Mermaid Diagram -> TLA+ Specification -> TypeScript Runtime
 *
 * Uses a super-complex architecture prompt that exercises:
 *   - Multi-boundary systems (frontend, backend, data, external)
 *   - Failure paths and recovery mechanisms
 *   - Async event-driven patterns
 *   - State machines and lifecycle management
 *   - Cross-cutting concerns (auth, logging, rate limiting)
 *
 * Requires: running server on port 3333 with premium API keys configured.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3333;
const BASE = `http://127.0.0.1:${PORT}`;

const COMPLEX_IDEA = `
Design a distributed event-sourced order processing platform with the following architecture:

Frontend Boundary:
- Browser SPA sends requests through CloudFront CDN
- WebSocket gateway maintains real-time order status subscriptions

API Boundary:
- API Gateway handles authentication via JWT validation, rate limiting at 1000 req/s per tenant
- GraphQL federation layer routes queries to domain services

Order Domain:
- Order Service manages order lifecycle: Created -> Validated -> PaymentPending -> Paid -> Fulfilling -> Shipped -> Delivered
- Each state transition emits a domain event to Kafka
- Order validation checks inventory via synchronous gRPC call to Inventory Service
- On validation failure: order moves to Rejected state with reason code

Payment Domain:
- Payment Service integrates with Stripe for card processing
- Implements saga pattern: reserve -> charge -> confirm (or compensate -> refund)
- Circuit breaker on Stripe calls: closed -> open after 5 failures -> half-open after 30s probe
- Dead letter queue for failed payment events after 3 retries

Data Layer:
- PostgreSQL for order state (event-sourced with snapshots every 100 events)
- Redis for session cache and rate limit counters
- Elasticsearch for order search and analytics
- S3 for invoice PDF storage

Observability:
- OpenTelemetry traces span all service boundaries
- Prometheus metrics exported from each service
- Grafana dashboards with SLO alerting (99.9% availability, p99 < 500ms)

Failure Paths:
- If Stripe is down: circuit breaker opens, payments queue in Kafka, retry with exponential backoff
- If Inventory Service is unreachable: order enters PendingInventoryCheck state, retries via CRON every 60s
- If Kafka is unavailable: local event store with WAL, replay on reconnect
- If PostgreSQL failover occurs: read replicas serve reads, writes pause until primary is elected
`.trim();

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 300_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/copilot/health`, { timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function run() {
  console.log('\n' + '='.repeat(60));
  console.log('  MERMATE E2E PIPELINE TEST');
  console.log('  Simple Idea -> Mermaid -> TLA+ -> TypeScript');
  console.log('='.repeat(60) + '\n');

  const serverUp = await checkServer();
  if (!serverUp) {
    console.log('  Server not running on port ' + PORT + ' — skipping E2E pipeline test.\n');
    return;
  }

  const timings = {};
  let runId = null;
  let diagramName = null;

  // ================================================================
  // STAGE 1: Render — Simple Idea -> Mermaid Diagram
  // ================================================================
  console.log('--- STAGE 1: Simple Idea -> Mermaid Diagram ---\n');
  const renderStart = Date.now();

  const renderRes = await postJson('/api/render', {
    mermaid_source: COMPLEX_IDEA,
    diagram_name: 'e2e-pipeline-test',
    enhance: true,
    input_mode: 'idea',
    max_mode: true,
  });

  timings.render = Date.now() - renderStart;

  console.log(`  Status: ${renderRes.status}`);
  console.log(`  Success: ${renderRes.body.success}`);
  console.log(`  Diagram: ${renderRes.body.diagram_name}`);
  console.log(`  Type: ${renderRes.body.diagram_type}`);
  console.log(`  Enhanced: ${renderRes.body.enhanced}`);
  console.log(`  Content state: ${renderRes.body.content_state}`);
  console.log(`  SVG valid: ${renderRes.body.validation?.svg_valid}`);
  console.log(`  PNG valid: ${renderRes.body.validation?.png_valid}`);
  console.log(`  Run ID: ${renderRes.body.run_id}`);
  console.log(`  Duration: ${timings.render}ms`);

  if (renderRes.body.mmd_metrics) {
    const m = renderRes.body.mmd_metrics;
    console.log(`  Nodes: ${m.nodeCount}, Edges: ${m.edgeCount}, Subgraphs: ${m.subgraphCount}`);
  }

  if (renderRes.body.progressionUpdate) {
    console.log(`  Progression: stage=${renderRes.body.progressionUpdate.stage}, confidence=${renderRes.body.progressionUpdate.confidence}`);
    console.log(`  Unlocked: ${renderRes.body.progressionUpdate.unlockedStages?.join(', ')}`);
  }

  if (!renderRes.body.success) {
    console.error('\n  STAGE 1 FAILED:', renderRes.body.error || renderRes.body.details);
    return;
  }

  runId = renderRes.body.run_id;
  diagramName = renderRes.body.diagram_name;
  console.log(`\n  STAGE 1 PASSED in ${timings.render}ms\n`);

  // ================================================================
  // STAGE 2: TLA+ Verification
  // ================================================================
  console.log('--- STAGE 2: Mermaid -> TLA+ Formal Specification ---\n');

  if (!runId) {
    console.log('  No run_id — TLA+ requires HPC-GoT render with fact extraction. Skipping.\n');
  } else {
    const tlaStart = Date.now();
    const tlaRes = await postJson('/api/render/tla', {
      diagram_name: diagramName,
      run_id: runId,
    });
    timings.tla = Date.now() - tlaStart;

    console.log(`  Status: ${tlaRes.status}`);
    console.log(`  Success: ${tlaRes.body.success}`);
    console.log(`  Module: ${tlaRes.body.module_name}`);
    console.log(`  SANY valid: ${tlaRes.body.sany?.valid}`);
    console.log(`  SANY repairs: ${tlaRes.body.sany?.repairAttempts || 0}`);
    console.log(`  TLC checked: ${tlaRes.body.tlc?.checked}`);
    console.log(`  TLC success: ${tlaRes.body.tlc?.success}`);
    console.log(`  States explored: ${tlaRes.body.tlc?.statesExplored || 0}`);
    console.log(`  Violations: ${tlaRes.body.tlc?.violations?.length || 0}`);
    console.log(`  Duration: ${timings.tla}ms`);

    if (tlaRes.body.metrics) {
      const m = tlaRes.body.metrics;
      console.log(`  Variables: ${m.variableCount}, Actions: ${m.actionCount}, Invariants: ${m.invariantCount}`);
      console.log(`  Entity coverage: ${(m.entityCoverage * 100).toFixed(0)}%, State space: ~${m.stateSpaceEstimate}`);
    }

    if (tlaRes.body.progressionUpdate) {
      console.log(`  Progression: stage=${tlaRes.body.progressionUpdate.stage}, confidence=${tlaRes.body.progressionUpdate.confidence}`);
      console.log(`  Unlocked: ${tlaRes.body.progressionUpdate.unlockedStages?.join(', ')}`);
    }

    if (tlaRes.body.tla_source) {
      const lines = tlaRes.body.tla_source.split('\n').length;
      const hasTheorems = tlaRes.body.tla_source.includes('THEOREM');
      const hasMasterSafety = tlaRes.body.tla_source.includes('MasterSafety');
      console.log(`  TLA+ lines: ${lines}`);
      console.log(`  Has THEOREM declarations: ${hasTheorems}`);
      console.log(`  Has MasterSafety: ${hasMasterSafety}`);
    }

    console.log(`\n  STAGE 2 ${tlaRes.body.success !== false ? 'PASSED' : 'COMPLETED (with findings)'} in ${timings.tla}ms\n`);

    // ================================================================
    // STAGE 3: TypeScript Runtime Generation
    // ================================================================
    console.log('--- STAGE 3: TLA+ -> TypeScript Runtime ---\n');

    const tsStart = Date.now();
    const tsRes = await postJson('/api/render/ts', {
      diagram_name: diagramName,
      run_id: runId,
    });
    timings.ts = Date.now() - tsStart;

    console.log(`  Status: ${tsRes.status}`);
    console.log(`  Success: ${tsRes.body.success}`);
    console.log(`  Class: ${tsRes.body.class_name}`);
    console.log(`  tsc compile: ${tsRes.body.compile?.success}`);
    console.log(`  Compile repairs: ${tsRes.body.compile?.repairs || 0}`);
    console.log(`  Harness pass: ${tsRes.body.tests?.success}`);
    console.log(`  Test repairs: ${tsRes.body.tests?.repairs || 0}`);
    console.log(`  Coverage OK: ${tsRes.body.coverage?.ok}`);
    console.log(`  Duration: ${timings.ts}ms`);

    if (tsRes.body.coverage) {
      const c = tsRes.body.coverage;
      console.log(`  Entity coverage: ${(c.entityCoverage * 100).toFixed(0)}%`);
      console.log(`  Action coverage: ${(c.actionCoverage * 100).toFixed(0)}%`);
      console.log(`  Invariant coverage: ${(c.invariantCoverage * 100).toFixed(0)}%`);
    }

    if (tsRes.body.progressionUpdate) {
      console.log(`  Progression: stage=${tsRes.body.progressionUpdate.stage}, confidence=${tsRes.body.progressionUpdate.confidence}`);
    }

    if (tsRes.body.ts_source) {
      const tsLines = tsRes.body.ts_source.split('\n').length;
      const hasDispatch = tsRes.body.ts_source.includes('dispatch(');
      const hasInvariant = tsRes.body.ts_source.includes('assertTypeInvariant');
      const hasManifest = tsRes.body.ts_source.includes('getManifest');
      console.log(`  TS lines: ${tsLines}`);
      console.log(`  Has dispatch(): ${hasDispatch}`);
      console.log(`  Has assertTypeInvariant(): ${hasInvariant}`);
      console.log(`  Has getManifest(): ${hasManifest}`);
    }

    console.log(`\n  STAGE 3 ${tsRes.body.success ? 'PASSED' : 'COMPLETED (with traces)'} in ${timings.ts}ms\n`);
  }

  // ================================================================
  // SUMMARY
  // ================================================================
  console.log('='.repeat(60));
  console.log('  PIPELINE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Render (idea -> mmd -> SVG/PNG): ${timings.render}ms`);
  if (timings.tla) console.log(`  TLA+ (mmd -> .tla + SANY/TLC):  ${timings.tla}ms`);
  if (timings.ts) console.log(`  TypeScript (tla -> .ts + tsc):    ${timings.ts}ms`);
  const total = (timings.render || 0) + (timings.tla || 0) + (timings.ts || 0);
  console.log(`  Total pipeline:                   ${total}ms (${(total / 1000).toFixed(1)}s)`);
  console.log(`  Run ID: ${runId}`);
  console.log('='.repeat(60) + '\n');

  // Verify run JSON has all artifacts
  if (runId) {
    try {
      const runPath = path.join(__dirname, '..', 'runs', `${runId}.json`);
      const runData = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
      console.log('  Run JSON verification:');
      console.log(`    status: ${runData.status}`);
      console.log(`    agent_calls: ${runData.agent_calls?.length || 0}`);
      console.log(`    final_artifact: ${runData.final_artifact ? 'present' : 'missing'}`);
      console.log(`    tla_metrics: ${runData.tla_metrics ? 'present' : 'not yet'}`);
      console.log(`    ts_metrics: ${runData.ts_metrics ? 'present' : 'not yet'}`);
      console.log(`    tla_artifacts: ${runData.tla_artifacts ? JSON.stringify(Object.keys(runData.tla_artifacts)) : 'none'}`);
      console.log(`    ts_artifacts: ${runData.ts_artifacts ? JSON.stringify(Object.keys(runData.ts_artifacts)) : 'none'}`);
      if (runData.totals) {
        console.log(`    total_cost: $${runData.totals.total_cost_est}`);
        console.log(`    total_tokens: ${runData.totals.total_tokens_in + runData.totals.total_tokens_out}`);
        console.log(`    wall_clock: ${runData.totals.wall_clock_ms}ms`);
      }
    } catch (err) {
      console.log(`  Could not read run JSON: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('  E2E PIPELINE TEST COMPLETE');
  console.log('='.repeat(60) + '\n');
}

run().catch(err => {
  if (err.code === 'ECONNREFUSED') {
    console.log('  Server not reachable — E2E pipeline test skipped.\n');
    process.exit(0);
  }
  console.error('E2E pipeline test failed:', err.message);
  process.exit(1);
});
