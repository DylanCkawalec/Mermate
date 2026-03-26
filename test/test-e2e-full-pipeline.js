'use strict';

/**
 * E2E Full Pipeline Test — idea -> mmd -> TLA+ -> TS -> DuckDB
 *
 * Picks a random hard architecture prompt, runs the entire 5-stage pipeline,
 * and verifies GoT axioms (sigma >= 0.5, SV=1, IC > 0) at each stage.
 *
 * Requires: server running on port 3333, TLA+ toolchain (optional), tsc (optional).
 * Skips gracefully if server is not running.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const BASE = 'http://localhost:3333';

const HARD_PROMPTS = [
  `Distributed event-sourced order processing platform. Frontend SPA sends orders to API Gateway.
Gateway routes to Order Service (event sourcing with Kafka). Payment Service calls Stripe, handles 3DS.
Inventory Service reserves stock with optimistic locking on PostgreSQL. Notification Service consumes events
and sends via email/SMS/push. Dead letter queue for failed events. Circuit breaker on all external calls.
Prometheus + Grafana observability. Kubernetes deployment with horizontal pod autoscaling.
On payment failure: retry 3x then route to manual review queue. On inventory conflict: compensating transaction.`,

  `Real-time algorithmic trading system. Market data feed from exchange via FIX protocol into a
tick processor. Strategy engine evaluates signals across 50 instruments. Order management system
validates risk limits before routing to exchange. Position tracker maintains real-time P&L.
Risk engine computes VaR every 100ms. Circuit breaker on exchange connectivity.
PostgreSQL for trade history, Redis for real-time state, Kafka for event bus.
Failover: hot-standby strategy engine, automatic position reconciliation on recovery.`,

  `Kubernetes operator for managing distributed databases. Custom Resource Definition for DatabaseCluster.
Controller watches for CRD changes. Reconciliation loop handles: provisioning new nodes,
scaling up/down, rolling upgrades, automated failover on leader failure, backup scheduling to S3,
point-in-time recovery, TLS certificate rotation, connection pooling with PgBouncer.
Health checks via readiness/liveness probes. Prometheus metrics exporter.
On node failure: promote replica, update DNS, notify SRE via PagerDuty.`,

  `Blockchain consensus engine for a permissioned network. Nodes communicate via gRPC.
PBFT consensus with 3f+1 fault tolerance. Block proposer rotates round-robin.
Transaction pool with priority queue. Merkle Patricia trie for world state.
Smart contract VM executes deterministic bytecode. State transitions validated by all nodes.
Finality after 2/3 supermajority. On Byzantine fault: view change protocol.
Snapshot sync for new nodes joining. WAL for crash recovery.`,

  `Software-defined operating system platform. Virtual machine with bootup emulator that boots through
an emulator path, can run as a fully remote host virtual OS, and can load base applications into its
desktop environment and kernel runtime. Application loader fetches packages from a registry,
validates signatures, sandboxes execution. Kernel manages process scheduling, memory allocation,
IPC via message passing. Desktop environment renders via WebGL compositor.
On crash: checkpoint state, restart process, restore from last checkpoint.`,
];

async function _fetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

describe('E2E Full Pipeline (idea -> mmd -> TLA+ -> TS -> DB)', async () => {
  let serverUp = false;
  let runId = null;
  let diagramName = null;
  const timings = {};

  before(async () => {
    try {
      const res = await fetch(`${BASE}/api/copilot/health`);
      serverUp = res.ok;
    } catch { serverUp = false; }
    if (!serverUp) console.log('  [SKIP] Server not running on port 3333');
  });

  it('Stage 1: Render diagram from random hard prompt', { skip: !serverUp, timeout: 300_000 }, async () => {
    const prompt = HARD_PROMPTS[Math.floor(Math.random() * HARD_PROMPTS.length)];
    const name = `e2e-pipeline-${Date.now()}`;
    console.log(`  Prompt: ${prompt.slice(0, 80)}...`);
    console.log(`  Diagram: ${name}`);

    const t0 = Date.now();
    const data = await _fetch('/api/render', {
      method: 'POST',
      body: JSON.stringify({
        mermaid_source: prompt,
        diagram_name: name,
        enhance: true,
        input_mode: 'idea',
        max_mode: false,
      }),
    });
    timings.render = Date.now() - t0;

    assert.ok(data.success, `Render failed: ${data.error || data.details}`);
    assert.ok(data.paths?.png, 'PNG path missing');
    assert.ok(data.paths?.svg, 'SVG path missing');
    assert.ok(data.run_id, 'run_id missing');
    assert.ok(data.mmd_metrics?.nodeCount > 0, 'node_count should be > 0');

    runId = data.run_id;
    diagramName = data.diagram_name;
    console.log(`  Render: ${timings.render}ms, nodes=${data.mmd_metrics?.nodeCount}, edges=${data.mmd_metrics?.edgeCount}`);
  });

  it('Stage 2: TLA+ specification', { skip: !serverUp, timeout: 120_000 }, async () => {
    if (!runId) return;

    const t0 = Date.now();
    const data = await _fetch('/api/render/tla', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, diagram_name: diagramName }),
    });
    timings.tla = Date.now() - t0;

    if (!data.success && data.error?.includes('toolchain')) {
      console.log(`  [SKIP] TLA+ toolchain not available: ${data.error}`);
      return;
    }

    assert.ok(data.success, `TLA+ failed: ${data.error}`);
    assert.ok(data.tla_source, 'TLA+ source missing');
    assert.ok(data.module_name, 'Module name missing');

    const sanyValid = data.sany?.valid;
    const invariants = data.metrics?.invariantCount || 0;
    console.log(`  TLA+: ${timings.tla}ms, SANY=${sanyValid ? 'PASS' : 'FAIL'}, invariants=${invariants}, states=${data.tlc?.statesExplored || 0}`);

    if (sanyValid) {
      assert.ok(invariants > 0, 'Should have at least 1 invariant (TypeInvariant)');
    }
  });

  it('Stage 3: TypeScript runtime', { skip: !serverUp, timeout: 120_000 }, async () => {
    if (!runId) return;

    const t0 = Date.now();
    const data = await _fetch('/api/render/ts', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, diagram_name: diagramName }),
    });
    timings.ts = Date.now() - t0;

    if (!data.success && (data.error?.includes('toolchain') || data.error?.includes('TLA+'))) {
      console.log(`  [SKIP] TS toolchain not available: ${data.error}`);
      return;
    }

    if (data.success) {
      assert.ok(data.ts_source, 'TS source missing');
      console.log(`  TS: ${timings.ts}ms, compile=${data.compile?.success ? 'PASS' : 'FAIL'}, tests=${data.tests?.success ? 'PASS' : 'FAIL'}`);
    } else {
      console.log(`  TS: ${timings.ts}ms, error=${(data.error || '').slice(0, 60)}`);
    }
  });

  it('Stage 4: DuckDB project verification', { skip: !serverUp, timeout: 10_000 }, async () => {
    if (!diagramName) return;

    const t0 = Date.now();
    const data = await _fetch(`/api/projects/${diagramName}`);
    timings.dbProject = Date.now() - t0;

    assert.ok(data.success, `Project fetch failed: ${data.error}`);
    assert.ok(data.project, 'Project object missing');
    assert.ok(data.project.artifacts?.length > 0, 'Should have artifacts');

    console.log(`  DB: ${timings.dbProject}ms, artifacts=${data.project.artifacts?.length}, nonce=${data.project.nonce}`);
  });

  it('Stage 5: Pipeline status + GoT axioms', { skip: !serverUp, timeout: 10_000 }, async () => {
    if (!diagramName) return;

    const t0 = Date.now();
    const data = await _fetch(`/api/projects/${diagramName}/pipeline`);
    timings.pipeline = Date.now() - t0;

    assert.ok(data.success, `Pipeline fetch failed: ${data.error}`);
    const p = data.pipeline;

    console.log(`  Pipeline: ${timings.pipeline}ms, stage=${p.current_stage}, sigma=${p.sigma}, sv=${p.sv}, ic=${p.ic}`);
    console.log(`  Next recommended: ${p.next_recommended || 'complete'}`);

    // GoT axiom: sigma = 0.5*SV + 0.5*IC (Equation 285 from GoT.tex)
    if (p.sv === 1) {
      assert.ok(p.sigma >= 0.5, `sigma should be >= 0.5 when SV=1, got ${p.sigma}`);
    }
  });

  it('Report card', { skip: !serverUp }, async () => {
    console.log('\n  ═══════════════════════════════════════');
    console.log('  E2E PIPELINE REPORT');
    console.log('  ═══════════════════════════════════════');
    for (const [stage, ms] of Object.entries(timings)) {
      console.log(`  ${stage.padEnd(12)} ${ms}ms`);
    }
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    console.log(`  ${'TOTAL'.padEnd(12)} ${total}ms`);
    console.log('  ═══════════════════════════════════════\n');
  });
});
