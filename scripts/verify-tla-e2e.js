'use strict';

/**
 * TLA+ end-to-end verification script.
 *
 * Usage:
 *   node scripts/verify-tla-e2e.js [BASE_URL]
 *
 * Environment:
 *   RUN_ID          - reuse an existing run instead of creating a new one
 *   BASE_URL        - defaults to http://localhost:3333
 *   MERMATE_DIAGRAM - complex architecture description for /api/render (optional)
 *
 * The script exercises the full TLA+ pipeline:
 *   1. GET  /api/render/tla/status  (probes toolchain + provider chain)
 *   2. POST /api/render              (creates a complex architecture run)
 *   3. POST /api/render/tla          (generates + verifies the TLA+ spec)
 *   4. POST /api/render/tla/check    (round-trips an edited spec through SANY)
 *   5. GET  /api/render/tla/errors/:run_id (reads persisted verification stamp)
 *
 * Assertions:
 *   - sany.valid === true
 *   - tlc.checked === true
 *   - verification.generator.model present
 *   - verification.toolbox.javaVersion present
 *   - wall-clock end-to-end TLA < 180s
 */

const http = require('node:http');
const https = require('node:https');

const BASE_URL = process.argv[2] || process.env.BASE_URL || 'http://localhost:3333';
const RUN_ID = process.env.RUN_ID || null;
const MERMATE_DIAGRAM = process.env.MERMATE_DIAGRAM || null;

const WALL_CLOCK_BUDGET_MS = 180_000;

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function parseUrl(url) {
  const u = new URL(url);
  const transport = u.protocol === 'https:' ? https : http;
  return { u, transport };
}

async function request(method, urlPath, body) {
  const { u, transport } = parseUrl(`${BASE_URL}${urlPath}`);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : null;
            resolve({ status: res.statusCode, data: parsed });
          } catch (err) {
            reject(new Error(`Invalid JSON from ${urlPath}: ${err.message}\n${data.slice(0, 500)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getStatus() {
  const res = await request('GET', '/api/render/tla/status');
  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`TLA status unavailable: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function createRun() {
  if (RUN_ID) {
    log(`Using existing run ${RUN_ID}`);
    return RUN_ID;
  }

  const description = MERMATE_DIAGRAM || `Design a distributed task queue with 12+ entities and 3+ failure paths.

Entities:
- ApiGateway, TaskQueue, WorkerPool, WorkerNode, Scheduler, RetryPolicy, DeadLetterQueue,
  MetricsCollector, RateLimiter, BlobStore, CacheLayer, AuditLogger.

Boundaries:
- PublicZone: ApiGateway, RateLimiter
- ControlPlane: Scheduler, RetryPolicy, MetricsCollector, AuditLogger
- DataPlane: TaskQueue, WorkerPool, WorkerNode, DeadLetterQueue, BlobStore, CacheLayer

Relationships:
- ApiGateway -> TaskQueue (enqueue, sync)
- Scheduler -> WorkerPool (dispatch, sync)
- WorkerPool -> WorkerNode (assign, sync)
- WorkerNode -> BlobStore (persist result, async)
- WorkerNode -> CacheLayer (cache state, async)
- WorkerNode -> DeadLetterQueue (fail permanently, sync)
- RetryPolicy -> TaskQueue (requeue, sync)
- RateLimiter -> ApiGateway (throttle, sync)
- MetricsCollector -> WorkerPool (collect, async)
- AuditLogger -> ApiGateway (log, async)

Failure paths:
- WorkerNode crash mid-task: condition "worker dies after accept but before ack", handler Scheduler, recovery requeue with retry count.
- BlobStore timeout: condition "write stalls >5s", handler WorkerNode, recovery mark degraded and retry once.
- CacheLayer corruption: condition "cache returns stale checksum", handler WorkerNode, recovery invalidate and reload from BlobStore.
- DeadLetter overflow: condition "DLQ size exceeds 1000", handler MetricsCollector, recovery alert and pause ingestion.

Produce a Mermaid architecture diagram.`;

  log('Creating complex architecture run via /api/render ...');
  const start = Date.now();
  const res = await request('POST', '/api/render', {
    mermaid_source: description,
    diagram_name: `tla-e2e-${Date.now()}`,
    input_mode: 'idea',
  });

  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`Render failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }

  const runId = res.data.run_id;
  if (!runId) {
    throw new Error('Render response did not include run_id');
  }

  log(`Run created: ${runId} (${Date.now() - start}ms)`);
  return runId;
}

async function pollRun(runId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await request('GET', `/api/runs/${runId}.json`);
    if (res.status === 200 && res.data?.stage) {
      if (['mmd_complete', 'tla_ready', 'tla_complete', 'ts_complete'].includes(res.data.stage)) {
        return res.data;
      }
    }
    await sleep(2000);
  }
  throw new Error('Timed out waiting for /api/render to produce artifacts');
}

async function runTla(runId) {
  log(`Triggering /api/render/tla for ${runId} ...`);
  const start = Date.now();
  const res = await request('POST', '/api/render/tla', { run_id: runId });
  const elapsed = Date.now() - start;
  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`TLA render failed: HTTP ${res.status} ${JSON.stringify(res.data)} (after ${elapsed}ms)`);
  }
  return { ...res.data, elapsed };
}

async function checkSpec(moduleName, source) {
  const res = await request('POST', '/api/render/tla/check', {
    tla_source: source,
    module_name: moduleName,
  });
  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`TLA check round-trip failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function getErrors(runId) {
  const res = await request('GET', `/api/render/tla/errors/${runId}`);
  if (res.status !== 200) {
    throw new Error(`TLA errors read-back failed: HTTP ${res.status}`);
  }
  return res.data;
}

async function main() {
  const startAll = Date.now();
  log(`TLA+ E2E against ${BASE_URL}`);

  const status = await getStatus();
  log('TLA status:', {
    available: status.available,
    javaVersion: status.javaVersion,
    tlcTimeoutMs: status.tlcTimeoutMs,
    speculaEngineAvailable: status.specula?.engine?.available,
    providerChain: status.specula?.llm?.chain,
  });

  if (!status.available) {
    throw new Error('TLA+ toolchain not available; aborting E2E.');
  }

  const runId = await createRun();
  if (!RUN_ID) {
    await pollRun(runId);
  }

  const tlaResult = await runTla(runId);
  const verification = tlaResult.verification;

  log('TLA result:', {
    module_name: tlaResult.module_name,
    sany_valid: tlaResult.sany?.valid,
    tlc_checked: tlaResult.tlc?.checked,
    states_explored: tlaResult.tlc?.statesExplored,
    wall_clock_ms: tlaResult.elapsed,
    provider: verification?.generator?.provider,
    model: verification?.generator?.model,
  });

  // Assertions
  if (!tlaResult.sany?.valid) {
    fail('SANY validation did not pass');
  }
  if (!tlaResult.tlc?.checked) {
    fail('TLC model check was not run');
  }
  if (!verification?.generator?.model) {
    fail('verification.generator.model is missing');
  }
  if (!verification?.toolbox?.javaVersion) {
    fail('verification.toolbox.javaVersion is missing');
  }
  if (tlaResult.elapsed > WALL_CLOCK_BUDGET_MS) {
    fail(`TLA wall-clock ${tlaResult.elapsed}ms exceeded budget ${WALL_CLOCK_BUDGET_MS}ms`);
  }

  // Round-trip check: edit the spec slightly (append a comment) and re-check with SANY.
  const editedSource = `${tlaResult.tla_source}\n\\* E2E round-trip comment\n`;
  const checkResult = await checkSpec(tlaResult.module_name, editedSource);
  if (!checkResult.sany?.valid) {
    fail('Edited spec round-trip SANY check failed');
  }
  log('Edited spec round-trip SANY check passed');

  // Read-back the persisted verification stamp.
  const errorsData = await getErrors(runId);
  if (!errorsData.verification?.toolbox?.javaVersion) {
    fail('Persisted verification stamp missing in /render/tla/errors read-back');
  }
  log('Persisted verification stamp round-trips correctly');

  const totalMs = Date.now() - startAll;
  log(`\nTLA+ E2E passed in ${totalMs}ms (TLA stage: ${tlaResult.elapsed}ms)`);
}

main().catch((err) => {
  fail(err.message);
  console.error(err.stack);
  process.exit(1);
});
