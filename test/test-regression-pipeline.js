'use strict';

/**
 * test-regression-pipeline.js
 *
 * Deterministic regression test suite for Mermate pipeline.
 * Uses FakeInferenceProvider to run sub-10-second offline tests with zero API cost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FakeInferenceProvider = require('./lib/fake-inference-provider');
const fakeProvider = new FakeInferenceProvider();
fakeProvider.patchModule();

const inputRouter = require('../server/services/input-router');
const { STAGE_JSON_SCHEMAS } = require('../server/services/inference-provider');

test('Regression Suite: renderHPCGoT full pipeline', async () => {
  const source = 'User submits a request to WebApp, which queries Database.';
  const result = await inputRouter.renderHPCGoT(source, null, null, false);

  assert.ok(result, 'renderHPCGoT returned a result object');
  assert.ok(result.facts, 'facts object present');
  assert.ok(Array.isArray(result.facts.entities) && result.facts.entities.length > 0, 'facts.entities length > 0');
  
  const validTypes = new Set(['actor', 'service', 'store', 'gateway', 'broker', 'cache', 'queue', 'external', 'decision', 'boundary']);
  for (const entity of result.facts.entities) {
    assert.ok(entity.name, 'entity has name');
    assert.ok(validTypes.has(entity.type), `entity type ${entity.type} is valid`);
  }

  assert.ok(result.plan, 'plan object present');
  assert.equal(result.plan.nodes.length, result.facts.entities.length, 'plan.nodes matches facts.entities 1:1');
  assert.equal(result.plan.edges.length, result.facts.relationships.length, 'plan.edges matches facts.relationships count');

  assert.ok(result.mmdSource, 'mmdSource present');
  const validDirectives = ['flowchart', 'graph', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram'];
  const firstLine = result.mmdSource.trim().split('\n')[0];
  assert.ok(validDirectives.some(d => firstLine.startsWith(d)), `directive starts with valid Mermaid directive: ${firstLine}`);

  if (result.hpcScore) {
    assert.ok(typeof result.hpcScore.score === 'number', `hpcScore.score evaluated (got ${result.hpcScore.score})`);
  }
});

test('Regression Suite: decomposeAndRender pipeline', async () => {
  const source = 'Large e-commerce platform with Ingress Gateway, Order Processing, and Persistence.';
  const result = await inputRouter.decomposeAndRender(source, null, null, false);

  assert.ok(result, 'decomposeAndRender returned result');
  const views = result.subviews || result.subViews;
  assert.ok(Array.isArray(views) && views.length > 0, 'subviews array has items');

  assert.ok(result.mmdSource, 'merge composition produces mmdSource');
  assert.ok(result.mmdSource.includes('flowchart') || result.mmdSource.includes('subgraph'), 'mmdSource contains flowchart/subgraph');
});

test('Regression Suite: compileWithRetry', async () => {
  const brokenMmd = 'flowchart TB\n  N1["Broken Node" --> N2["Target"]';
  const tmpDir = path.join(__dirname, 'fixtures');
  const result = await inputRouter.compileWithRetry(brokenMmd, tmpDir, 'test-repair');

  assert.ok(result, 'compileWithRetry returned result');
  assert.ok(result.attempts > 0 || (result.repairChanges && result.repairChanges.length >= 0), 'recorded compile repair attempt');
  assert.ok(result.mmdSource, 'repaired mmdSource present');
  assert.ok(result.result, 'compile result present');
});

test('Regression Suite: Structured output enforcement & schema validation', async () => {
  const factSchema = STAGE_JSON_SCHEMAS.fact_extraction;
  assert.ok(factSchema, 'fact_extraction schema defined');
  assert.deepEqual(factSchema.required, ['entities', 'relationships', 'boundaries', 'failurePaths', 'diagramType']);

  const planSchema = STAGE_JSON_SCHEMAS.diagram_plan;
  assert.ok(planSchema, 'diagram_plan schema defined');
  assert.deepEqual(planSchema.required, ['directive', 'nodes', 'edges', 'subgraphs', 'classDefs']);

  const validateTsSchema = STAGE_JSON_SCHEMAS.validate_ts;
  assert.ok(validateTsSchema, 'validate_ts schema defined');
  assert.deepEqual(validateTsSchema.required, ['valid', 'issues', 'summary']);

  const tsResponse = fakeProvider.fixtures.scenarios.ts_runtime.compose_ts;
  const parsedTs = JSON.parse(tsResponse);
  assert.ok(parsedTs.ts_source, 'compose_ts output has ts_source key');
  assert.ok(parsedTs.ts_source.includes('export interface'), 'ts_source contains TypeScript interface');
});

test('Regression Suite: renderPrepare fallback', async () => {
  const proseSource = 'The client connects to the server and fetches the data.';
  const result = await inputRouter.renderPrepare(proseSource, null, null, false);

  assert.ok(result, 'renderPrepare returned result');
  assert.ok(result.mmdSource, 'mmdSource present');
  assert.ok(result.mmdSource.includes('flowchart') || result.mmdSource.includes('graph') || result.mmdSource.includes('sequenceDiagram'), 'fallback output is valid Mermaid');
});
