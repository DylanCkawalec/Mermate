'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const tmpDir = path.join(os.tmpdir(), 'mermate-rt-test-' + Date.now());
process.env.MERMATE_RUN_RETENTION_DAYS = '1';

const runTracker = require('../server/services/run-tracker');
const originalRunsDir = runTracker.RUNS_DIR;

describe('run-tracker', () => {
  before(async () => {
    await fsp.mkdir(tmpDir, { recursive: true });
    runTracker._setRunsDir(tmpDir);
  });

  after(async () => {
    runTracker._setRunsDir(originalRunsDir);
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    // Tear down rate-master bridge if it was initialized during finalize()
    try { require('../server/services/rate-master-bridge').destroy(); } catch { /* ok */ }
  });

  it('creates a run with valid skeleton JSON', async () => {
    const runId = await runTracker.create({
      mode: 'thinking',
      maxMode: true,
      enhance: true,
      userInput: 'test input',
      userDiagramName: 'test-diagram',
    });

    assert.ok(runId, 'runId should be returned');
    assert.match(runId, /^[0-9a-f-]{36}$/, 'runId should be UUID format');

    const manifest = runTracker.getManifest(runId);
    assert.ok(manifest, 'manifest should exist in memory');
    assert.equal(manifest.schema_version, '1.0.0');
    assert.equal(manifest.status, 'running');
    assert.equal(manifest.settings.mode, 'thinking');
    assert.equal(manifest.settings.max_mode, true);
    assert.equal(manifest.request.user_input, 'test input');
    assert.equal(manifest.request.user_diagram_name, 'test-diagram');

    // Verify JSON file on disk
    const onDisk = JSON.parse(await fsp.readFile(path.join(tmpDir, `${runId}.json`), 'utf8'));
    assert.equal(onDisk.run_id, runId);
    assert.equal(onDisk.status, 'running');
  });

  it('records agent calls with correct fields', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    const callId = runTracker.recordAgentCall(runId, {
      stage: 'fact_extraction',
      model: 'gpt-4o-mini',
      provider: 'premium',
      promptText: 'extract facts from this text',
      outputText: '{"entities": []}',
      latencyMs: 1500,
      success: true,
      outputType: 'json',
    });

    assert.ok(callId, 'callId should be returned');

    const m = runTracker.getManifest(runId);
    assert.equal(m.agent_calls.length, 1);

    const call = m.agent_calls[0];
    assert.equal(call.stage, 'fact_extraction');
    assert.equal(call.model, 'gpt-4o-mini');
    assert.equal(call.success, true);
    assert.ok(call.prompt_hash, 'prompt_hash should be computed');
    assert.ok(call.prompt_tokens_est > 0, 'prompt tokens should be estimated');
    assert.ok(call.output_tokens_est > 0, 'output tokens should be estimated');
    assert.ok(call.cost_est >= 0, 'cost should be estimated');
    assert.equal(call.seq, 0);
  });

  it('records branches with score and decision', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    const branchId = runTracker.recordBranch(runId, {
      parentStateId: 'root',
      level: 2,
      label: 'composition_branch_A',
      score: { composite: 0.85, sv: 0.8, ic: 0.9 },
      decision: 'retained',
    });

    assert.ok(branchId);
    const m = runTracker.getManifest(runId);
    assert.equal(m.branches.length, 1);
    assert.equal(m.branches[0].label, 'composition_branch_A');
    assert.equal(m.branches[0].decision, 'retained');
    assert.equal(m.controller.state_count, 1);
    assert.equal(m.controller.depth_reached, 2);
  });

  it('records subviews with artifacts', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    const svId = runTracker.addSubview(runId, {
      viewName: 'System Context',
      mmdSource: 'flowchart TB\n  A --> B',
      score: { compilability: 1.0, entityCoverage: 0.7, edgeDensity: 0.9, composite: 0.85 },
      compileResult: { ok: true, attempts: 1 },
      artifacts: { mmd: '/flows/test/subviews/sys/sys.mmd' },
      retained: true,
      mergeEligible: true,
    });

    assert.ok(svId);
    const m = runTracker.getManifest(runId);
    assert.equal(m.subviews.length, 1);
    assert.equal(m.subviews[0].view_name, 'System Context');
    assert.equal(m.subviews[0].retained, true);
  });

  it('records merge events', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    runTracker.recordMerge(runId, {
      strategy: 'llm_synthesis',
      inputSubviewIds: ['sv1', 'sv2'],
      preMergeBestScore: 0.85,
      postMergeScore: 0.92,
      accepted: true,
    });

    const m = runTracker.getManifest(runId);
    assert.ok(m.merge);
    assert.equal(m.merge.accepted, true);
    assert.equal(m.merge.pre_merge_best_score, 0.85);
    assert.equal(m.merge.post_merge_score, 0.92);
  });

  it('records rate events', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    runTracker.recordRateEvent(runId, {
      type: '429_rate_limit',
      httpStatus: 429,
      retryAfterMs: 5000,
      retryCount: 1,
      concurrencyWindow: 2,
      impactMs: 5200,
    });

    const m = runTracker.getManifest(runId);
    assert.equal(m.rate_events.length, 1);
    assert.equal(m.rate_events[0].type, '429_rate_limit');
    assert.equal(m.rate_events[0].retry_after_ms, 5000);
  });

  it('finalizes with completeness check and totals', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    runTracker.recordAgentCall(runId, {
      stage: 'render_prepare',
      model: 'gpt-4o',
      provider: 'premium',
      promptText: 'prompt',
      outputText: 'output',
      latencyMs: 2000,
      success: true,
    });

    runTracker.setFinalArtifact(runId, {
      diagramName: 'test',
      diagramType: 'flowchart',
      mmdSource: 'flowchart TB\n  A --> B',
      metrics: { nodeCount: 2, edgeCount: 1 },
      validation: { structurallyValid: true, svgValid: true, pngValid: true },
      artifacts: { png: '/flows/test/test.png' },
    });

    await runTracker.finalize(runId, 'completed');

    // manifest should be removed from active runs
    assert.equal(runTracker.getManifest(runId), null);

    // but persisted on disk
    const loaded = await runTracker.loadRun(runId);
    assert.ok(loaded);
    assert.equal(loaded.status, 'completed');
    assert.ok(loaded.completed_at);
    assert.ok(loaded.totals);
    assert.equal(loaded.totals.total_agent_calls, 1);
    assert.ok(loaded.totals.wall_clock_ms >= 0, 'wall_clock_ms should be non-negative');
    assert.equal(loaded.final_artifact.diagram_name, 'test');
    assert.ok(Array.isArray(loaded.warnings));
  });

  it('completeness check warns on missing completed_at', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    const m = runTracker.getManifest(runId);
    m.agent_calls.push({
      call_id: 'test-incomplete',
      seq: 0,
      stage: 'test',
      completed_at: null,
    });

    await runTracker.finalize(runId, 'completed');
    const loaded = await runTracker.loadRun(runId);
    assert.ok(loaded.warnings.length > 0, 'should have warnings for incomplete call');
    assert.ok(loaded.warnings.some(w => w.includes('missing completed_at')));
  });

  it('completeness check warns on missing final_artifact', async () => {
    const runId = await runTracker.create({ mode: 'direct' });
    await runTracker.finalize(runId, 'completed');
    const loaded = await runTracker.loadRun(runId);
    assert.ok(loaded.warnings.some(w => w.includes('final_artifact')));
  });

  it('atomic write survives partial content', async () => {
    const runId = await runTracker.create({ mode: 'direct' });

    // Record several calls to make the JSON non-trivial
    for (let i = 0; i < 5; i++) {
      runTracker.recordAgentCall(runId, {
        stage: `stage_${i}`, model: 'gpt-4o', provider: 'premium',
        promptText: 'p'.repeat(100), outputText: 'o'.repeat(100),
        latencyMs: 100, success: true,
      });
    }

    await runTracker.persist(runId);

    // Verify it's valid JSON on disk
    const raw = await fsp.readFile(path.join(tmpDir, `${runId}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.agent_calls.length, 5);

    // No .tmp file should remain
    const files = await fsp.readdir(tmpDir);
    assert.ok(!files.some(f => f.endsWith('.tmp')), 'no .tmp files should remain');
  });

  it('listRuns returns recent runs', async () => {
    const id1 = await runTracker.create({ mode: 'direct' });
    await runTracker.finalize(id1, 'completed');
    const id2 = await runTracker.create({ mode: 'direct' });
    await runTracker.finalize(id2, 'completed');

    const runs = await runTracker.listRuns();
    assert.ok(runs.length >= 2);
    assert.ok(runs.includes(id2));
  });
});
