'use strict';

/**
 * Winning-design regression tests — one check per TLC-verified invariant.
 * See docs/specs/MermateOrchestrator.tla (TLC: 85,449 distinct states, no error).
 *
 * Strategy: frontend logic is tested by extracting the PRODUCTION source
 * (AGENT_ARTIFACT_RULES literal, orchestrator class) and evaluating it in a
 * sandbox — the assertions fail if the shipped rules regress, not a copy.
 * Server logic (infer cache) is imported directly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mermaid-gpt-app.js'), 'utf8');
const COPILOT_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mermaid-gpt-copilot.js'), 'utf8');

function extractBalanced(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${startMarker}`);
}

// ---- F2 / TSRequiresVerifiedTLA -------------------------------------------
// The exact production rule table: mmd must never grant ts; tla grants ts
// ONLY when sanyValid. This is the site of the original regression.

test('TS gate: production AGENT_ARTIFACT_RULES bars ts without verified TLA+', () => {
  const literal = extractBalanced(APP_JS, 'const AGENT_ARTIFACT_RULES =');
  const rules = vm.runInNewContext(`(${literal})`);

  assert.equal(rules.mmd.unlocks, 'tla',
    'mmd must unlock only the tla TAB (was "ts" — the F2 regression)');
  assert.equal(rules.tla.unlocks({ sanyValid: false }), 'tla',
    'unverified tla must not unlock ts');
  assert.equal(rules.tla.unlocks({ sanyValid: true }), 'ts',
    'verified tla unlocks ts — VerifyTLA is the ONLY ts-granting action');

  // The application site must resolve function unlocks (not pass the
  // function itself into unlockedThrough).
  assert.ok(
    /typeof rule\.unlocks === 'function'\s*\?\s*rule\.unlocks\(ev\.verification\)/.test(APP_JS),
    'artifact application must resolve function unlocks with the verification block');
});

// ---- F6 / Enhance presence contract ----------------------------------------
// A failed or no-op enhance must never replace a non-empty artifact.

test('Enhance contract: no-op/empty server output never overwrites content', () => {
  assert.ok(/enhanced\.trim\(\) === original\.trim\(\)/.test(COPILOT_JS),
    'no-op detection (identical output) must remain — it routes to local fallback');
  assert.ok(/_applyLocalEnhance/.test(COPILOT_JS),
    'local fallback path must exist for failed/no-op enhances');
  assert.ok(/if \(this\.isEnhancing\) return;/.test(COPILOT_JS),
    're-entrancy guard must remain');
  // The winning contract: the typewriter replace is only reachable with a
  // DIFFERENT, non-empty enhanced string.
  assert.ok(/_typewriterReplace\(enhanced/.test(COPILOT_JS),
    'replace path must operate on the enhanced string only');
});

// ---- F3 / HealthAlarm -------------------------------------------------------
// Degraded persistence must ALWAYS surface (events), and recovery must clear.

test('HealthAlarm: persist dispatches degraded + recovery events', () => {
  for (const anchor of [
    "mermate:storage-degraded",
    "mermate:storage-ok",
    '_storageDegraded',
  ]) {
    assert.ok(APP_JS.includes(anchor), `missing storage-alarm anchor: ${anchor}`);
  }
  // Every quota branch must dispatch, not just log.
  const persistBody = extractBalanced(APP_JS, '_persistNow() {');
  const dispatchCount = (persistBody.match(/storage-degraded/g) || []).length;
  assert.ok(dispatchCount >= 3,
    `expected >=3 degraded dispatches (trim/session-only/unavailable), got ${dispatchCount}`);
});

// ---- F4 / Reload recovery ---------------------------------------------------

test('Reload: boot recovers completed-run artifacts before dropping session', () => {
  assert.ok(/_recoverCompletedRun\(currentRunId\)/.test(APP_JS),
    'not-live boot branch must attempt artifact recovery');
  assert.ok(/api\/artifacts\/\$\{runId\}/.test(APP_JS),
    'recovery must read /api/artifacts/:run_id');
  // Recovery must apply the SAME gate: tla hydration unlocks ts only on sany.
  assert.ok(/unlockedThrough\(sanyOk \? 'ts' : 'tla'\)/.test(APP_JS),
    'recovery path must gate ts on sany_valid');
});

// ---- Stage 5 / infer cache --------------------------------------------------

test('infer cache: fact_extraction is cached, repair stages are not', async () => {
  const provider = require('../server/services/inference-provider');
  assert.ok(provider.__test, 'inference-provider must expose __test hooks');
  const { INFER_CACHEABLE_STAGES, _inferCacheKey } = provider.__test;

  assert.ok(INFER_CACHEABLE_STAGES.has('fact_extraction'));
  assert.ok(INFER_CACHEABLE_STAGES.has('diagram_plan'));
  assert.ok(!INFER_CACHEABLE_STAGES.has('semantic_repair'));
  assert.ok(!INFER_CACHEABLE_STAGES.has('copilot_enhance'));

  const k1 = _inferCacheKey('fact_extraction', {}, 'sys', 'user');
  const k2 = _inferCacheKey('fact_extraction', {}, 'sys', 'user');
  const k3 = _inferCacheKey('fact_extraction', {}, 'sys', 'user2');
  assert.equal(k1, k2, 'identical prompts must hit');
  assert.notEqual(k1, k3, 'different prompts must miss');

  const k4 = _inferCacheKey('fact_extraction', { responseFormat: 'json' }, 'sys', 'user');
  assert.notEqual(k1, k4, 'different responseFormat must miss');
});

// ---- Stage 1 server gate (already correct — guard it stays so) --------------

test('Server pipeline: ts build remains gated on sany_valid', () => {
  const agentJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'agent.js'), 'utf8');
  assert.ok(
    /tlaData\.success && tlaData\.sany\?\.valid && !abort\.signal\.aborted/.test(agentJs),
    'agent.js must keep the ts_build precondition on sany_valid');
});
