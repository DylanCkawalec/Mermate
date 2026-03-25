'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tsCompiler = require('../server/services/ts-compiler');

const SAMPLE_CONTEXT = {
  runId: 'run-test-001',
  diagramName: 'order-processing',
  moduleName: 'OrderSpec',
  facts: {
    entities: [
      { name: 'Gateway', type: 'gateway', responsibility: 'entry point' },
      { name: 'OrderService', type: 'service', responsibility: 'handles orders' },
      { name: 'OrderStore', type: 'store', responsibility: 'persists order state' },
    ],
    relationships: [
      { from: 'Gateway', to: 'OrderService', verb: 'routes', edgeType: 'runtime' },
      { from: 'OrderService', to: 'OrderStore', verb: 'writes', edgeType: 'runtime' },
    ],
    boundaries: [
      { name: 'App', members: ['Gateway', 'OrderService'] },
      { name: 'Storage', members: ['OrderStore'] },
    ],
    failurePaths: [
      { trigger: 'OrderService', condition: 'write fails', handler: 'Gateway', recovery: 'return error' },
    ],
  },
  plan: {
    nodes: [
      { id: 'Gateway', label: 'Gateway', shape: 'rectangle' },
      { id: 'OrderService', label: 'OrderService', shape: 'rectangle' },
      { id: 'OrderStore', label: 'OrderStore', shape: 'cylinder' },
    ],
    edges: [
      { from: 'Gateway', to: 'OrderService', label: 'routes' },
      { from: 'OrderService', to: 'OrderStore', label: 'writes' },
    ],
    subgraphs: [],
  },
  structuralSignature: {
    complexityClass: 'moderate',
    nodeCount: 3,
    edgeCount: 2,
  },
  tla: {
    source: '---- MODULE OrderSpec ----\nVARIABLES gateway, orderService\n====',
    cfg: 'SPECIFICATION Spec',
    metrics: { actionCount: 2, invariantCount: 1 },
  },
};

describe('ts-compiler', () => {
  it('builds deterministic TypeScriptRuntime artifacts', () => {
    const compiledA = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const compiledB = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);

    assert.equal(compiledA.className, 'OrderProcessingRuntime');
    assert.equal(compiledA.tsSource, compiledB.tsSource);
    assert.equal(compiledA.harnessSource, compiledB.harnessSource);
    assert.equal(compiledA.metrics.actionCount, 2);
    assert.equal(compiledA.metrics.invariantCount, 1);
  });

  it('generates runtime class with required methods and manifests', () => {
    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const source = compiled.tsSource;

    assert.ok(source.includes(`export class ${compiled.className}`));
    assert.ok(source.includes('dispatch(event: RuntimeEvent): void'));
    assert.ok(source.includes('getManifest(): {'));
    assert.ok(source.includes('assertTypeInvariant(): void'));
    assert.ok(source.includes('assertAllInvariants(_eventType: RuntimeEventType): void'));
  });

  it('generates harness with structured runtime-failure marker', () => {
    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const harness = compiled.harnessSource;

    assert.ok(harness.includes('runHarness(): void'));
    assert.ok(harness.includes('TS_RUNTIME_FAILURE::'));
    assert.ok(harness.includes('invariantChecks'));
  });

  it('emits coverage spec aligned to generated source', () => {
    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const coverage = compiled.coverageSpec;

    assert.ok(Array.isArray(coverage.entities));
    assert.ok(Array.isArray(coverage.actions));
    assert.ok(Array.isArray(coverage.invariants));
    assert.ok(coverage.requiredMethods.includes('dispatch'));
    assert.ok(coverage.requiredMethods.includes('getCoverageReport'));
  });
});
