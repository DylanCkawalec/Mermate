#!/usr/bin/env node
'use strict';

/**
 * DuckDB Query Engine Benchmark
 *
 * Measures latency for all query paths and prints a report.
 * Run: node test/benchmark-query.js
 */

const db = require('../server/backend/db');
const schema = require('../server/backend/schema');
const query = require('../server/backend/query');
const ingester = require('../server/backend/ingester');

async function bench(label, fn, iterations = 5) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { label, avg: avg.toFixed(2), min: min.toFixed(2), max: max.toFixed(2), iterations };
}

async function main() {
  console.log('\n  DuckDB Query Engine Benchmark\n');

  await db.init();
  await schema.createTables();

  const projects = await query.listProjects({ limit: 1 });
  const testProject = projects[0]?.project_id || 'test-hello-world';
  console.log(`  Test project: ${testProject}\n`);

  const results = [];

  results.push(await bench('listProjects()', () => query.listProjects({ limit: 50 })));

  results.push(await bench('getProject()', () => query.getProject(testProject)));

  results.push(await bench('getProjectHistory()', () => query.getProjectHistory(testProject)));

  results.push(await bench('getGoTScoreboard()', () => query.getGoTScoreboard(20)));

  results.push(await bench('getPipelineStatus()', () => query.getProjectPipelineStatus(testProject)));

  results.push(await bench('verifyIntegrity()', () => query.verifyIntegrity(testProject)));

  // Find a run to benchmark ingestion
  const fsp = require('node:fs/promises');
  const runFiles = (await fsp.readdir('runs').catch(() => [])).filter(f => f.endsWith('.json'));
  if (runFiles.length > 0) {
    const testRunId = runFiles[runFiles.length - 1].replace('.json', '');
    results.push(await bench('ingestRun()', () => ingester.ingestRun(testRunId), 3));
  }

  // Print report
  console.log('  ┌──────────────────────┬──────────┬──────────┬──────────┬──────┐');
  console.log('  │ Query                │ Avg (ms) │ Min (ms) │ Max (ms) │ Runs │');
  console.log('  ├──────────────────────┼──────────┼──────────┼──────────┼──────┤');
  for (const r of results) {
    const l = r.label.padEnd(20);
    const a = r.avg.padStart(8);
    const mn = r.min.padStart(8);
    const mx = r.max.padStart(8);
    const n = String(r.iterations).padStart(4);
    console.log(`  │ ${l} │ ${a} │ ${mn} │ ${mx} │ ${n} │`);
  }
  console.log('  └──────────────────────┴──────────┴──────────┴──────────┴──────┘\n');

  db.close();
}

main().catch(err => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
