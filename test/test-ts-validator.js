'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const tsCompiler = require('../server/services/ts-compiler');
const tsValidator = require('../server/services/ts-validator');

const SAMPLE_CONTEXT = {
  runId: 'run-test-002',
  diagramName: 'billing-runtime',
  moduleName: 'BillingSpec',
  facts: {
    entities: [
      { name: 'Client', type: 'actor', responsibility: 'sends request' },
      { name: 'BillingGateway', type: 'gateway', responsibility: 'ingress' },
      { name: 'BillingService', type: 'service', responsibility: 'processes charge' },
    ],
    relationships: [
      { from: 'Client', to: 'BillingGateway', verb: 'requests', edgeType: 'runtime' },
      { from: 'BillingGateway', to: 'BillingService', verb: 'routes', edgeType: 'runtime' },
    ],
    boundaries: [],
    failurePaths: [
      { trigger: 'BillingService', condition: 'charge denied', handler: 'BillingGateway', recovery: 'return decline' },
    ],
  },
  plan: {
    nodes: [],
    edges: [],
    subgraphs: [],
  },
  structuralSignature: null,
  tla: {
    source: '---- MODULE BillingSpec ----\nVARIABLES billing\n====',
    cfg: 'SPECIFICATION Spec',
    metrics: null,
  },
};

describe('ts-validator', () => {
  it('checkCoverage passes for compiler output', () => {
    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const coverage = tsValidator.checkCoverage(compiled.tsSource, compiled.coverageSpec);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.entityCoverage, 1);
    assert.equal(coverage.actionCoverage, 1);
    assert.equal(coverage.invariantCoverage, 1);
  });

  it('checkCoverage detects missing required members', () => {
    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const broken = compiled.tsSource.replace('private assertTypeInvariant(): void', 'private assertTypeInvariantBroken(): void');
    const coverage = tsValidator.checkCoverage(broken, compiled.coverageSpec);
    assert.equal(coverage.ok, false);
    assert.ok(coverage.missing.requiredMethods.includes('assertTypeInvariant'));
  });

  it('fullValidation compiles and runs runtime harness', async (t) => {
    const available = await tsValidator.isAvailable();
    if (!available) t.skip('TypeScript toolchain unavailable');

    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermate-ts-validator-ok-'));

    try {
      const result = await tsValidator.fullValidation(
        compiled.tsSource,
        compiled.harnessSource,
        tmpDir,
        compiled.fileBase,
        compiled.coverageSpec,
      );

      assert.equal(result.success, true);
      assert.equal(result.compile.success, true);
      assert.equal(result.tests.success, true);
      assert.equal(result.coverage.ok, true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fullValidation returns structured compile trace on syntax errors', async (t) => {
    const available = await tsValidator.isAvailable();
    if (!available) t.skip('TypeScript toolchain unavailable');

    const compiled = tsCompiler.compileCompilationContext(SAMPLE_CONTEXT);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermate-ts-validator-fail-'));

    const brokenSource = compiled.tsSource.replace('export class', 'export class ???');

    try {
      const result = await tsValidator.fullValidation(
        brokenSource,
        compiled.harnessSource,
        tmpDir,
        compiled.fileBase,
        compiled.coverageSpec,
      );

      assert.equal(result.success, false);
      assert.equal(result.compile.success, false);
      assert.ok(Array.isArray(result.compile.errors));
      assert.ok(result.compile.errors.length > 0);
      assert.equal(result.compile.errors[0].type, 'ts_compile_error');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
