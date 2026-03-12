#!/usr/bin/env node
'use strict';

/**
 * analyze-runs.js — Aggregate statistics across all MERMATE run JSON files.
 *
 * Usage:  node scripts/analyze-runs.js [runs-dir]
 * Default: reads from ./runs/
 *
 * Reports:
 *   - Run count by status and pipeline
 *   - Mean/P50/P95 wall-clock time per pipeline
 *   - Mean/P50/P95 tokens per run
 *   - Merge acceptance rate
 *   - Rate-limit frequency and mean impact
 *   - Score distribution for final artifacts
 *   - Model usage breakdown
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const RUNS_DIR = process.argv[2] || path.resolve(__dirname, '..', 'runs');

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(arr) {
  if (arr.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    count: arr.length,
    mean: +(sum / arr.length).toFixed(2),
    p50: +percentile(arr, 50).toFixed(2),
    p95: +percentile(arr, 95).toFixed(2),
    min: +Math.min(...arr).toFixed(2),
    max: +Math.max(...arr).toFixed(2),
  };
}

async function main() {
  let files;
  try {
    files = (await fsp.readdir(RUNS_DIR)).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  } catch {
    console.error(`No runs directory found at: ${RUNS_DIR}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log('No run files found.');
    process.exit(0);
  }

  const runs = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(RUNS_DIR, f), 'utf8');
      runs.push(JSON.parse(raw));
    } catch { /* skip corrupt files */ }
  }

  console.log(`\n  MERMATE Run Analysis — ${runs.length} runs from ${RUNS_DIR}\n`);

  // 1. Status breakdown
  const byStatus = {};
  for (const r of runs) {
    byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
  }
  console.log('  Status breakdown:');
  for (const [s, c] of Object.entries(byStatus)) console.log(`    ${s}: ${c}`);

  // 2. Pipeline breakdown
  const byPipeline = {};
  for (const r of runs) {
    const p = r.controller?.pipeline || 'unknown';
    byPipeline[p] = (byPipeline[p] || 0) + 1;
  }
  console.log('\n  Pipeline breakdown:');
  for (const [p, c] of Object.entries(byPipeline)) console.log(`    ${p}: ${c}`);

  // 3. Wall clock time per pipeline
  console.log('\n  Wall-clock time (ms) per pipeline:');
  const pipelineGroups = {};
  for (const r of runs) {
    if (!r.totals?.wall_clock_ms) continue;
    const p = r.controller?.pipeline || 'unknown';
    if (!pipelineGroups[p]) pipelineGroups[p] = [];
    pipelineGroups[p].push(r.totals.wall_clock_ms);
  }
  for (const [p, arr] of Object.entries(pipelineGroups)) {
    const s = stats(arr);
    console.log(`    ${p}: mean=${s.mean}, p50=${s.p50}, p95=${s.p95}, min=${s.min}, max=${s.max} (n=${s.count})`);
  }

  // 4. Token usage
  const tokensIn = runs.filter(r => r.totals).map(r => r.totals.total_tokens_in || 0);
  const tokensOut = runs.filter(r => r.totals).map(r => r.totals.total_tokens_out || 0);
  console.log(`\n  Token usage (across ${tokensIn.length} runs):`);
  console.log(`    Tokens in:  ${JSON.stringify(stats(tokensIn))}`);
  console.log(`    Tokens out: ${JSON.stringify(stats(tokensOut))}`);

  // 5. Cost
  const costs = runs.filter(r => r.totals?.total_cost_est).map(r => r.totals.total_cost_est);
  if (costs.length > 0) {
    const costStats = stats(costs);
    const totalCost = costs.reduce((s, v) => s + v, 0);
    console.log(`\n  Cost: total=$${totalCost.toFixed(4)}, ${JSON.stringify(costStats)}`);
  }

  // 6. Merge stats
  const mergeAttempted = runs.filter(r => r.merge);
  const mergeAccepted = mergeAttempted.filter(r => r.merge.accepted);
  console.log(`\n  Merge: ${mergeAttempted.length} attempted, ${mergeAccepted.length} accepted (${mergeAttempted.length > 0 ? (mergeAccepted.length / mergeAttempted.length * 100).toFixed(0) : 0}%)`);

  // 7. Rate events
  const allRateEvents = runs.flatMap(r => r.rate_events || []);
  console.log(`\n  Rate events: ${allRateEvents.length} total across ${runs.filter(r => (r.rate_events || []).length > 0).length} runs`);
  if (allRateEvents.length > 0) {
    const byType = {};
    for (const re of allRateEvents) {
      byType[re.type || 'unknown'] = (byType[re.type || 'unknown'] || 0) + 1;
    }
    for (const [t, c] of Object.entries(byType)) console.log(`    ${t}: ${c}`);
    const impacts = allRateEvents.map(re => re.impact_ms || 0).filter(v => v > 0);
    if (impacts.length > 0) console.log(`    Impact: ${JSON.stringify(stats(impacts))}`);
  }

  // 8. Model usage
  const modelUsage = {};
  for (const r of runs) {
    for (const call of (r.agent_calls || [])) {
      const m = call.model || 'unknown';
      modelUsage[m] = (modelUsage[m] || 0) + 1;
    }
  }
  console.log('\n  Model usage:');
  for (const [m, c] of Object.entries(modelUsage).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${m}: ${c} calls`);
  }

  // 9. Warnings
  const totalWarnings = runs.reduce((s, r) => s + (r.warnings || []).length, 0);
  console.log(`\n  Warnings: ${totalWarnings} total across ${runs.filter(r => (r.warnings || []).length > 0).length} runs`);

  // 10. Agent calls per run
  const callCounts = runs.map(r => (r.agent_calls || []).length);
  console.log(`\n  Agent calls per run: ${JSON.stringify(stats(callCounts))}`);

  console.log('\n  Done.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
