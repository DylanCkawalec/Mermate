'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tlaCompiler = require('../server/services/tla-compiler');
const { buildSpeculaBundle } = require('../server/services/specula-bundle');

const FACTS = {
  entities: [
    { name: 'API Gateway', type: 'gateway', responsibility: 'routes requests' },
    { name: 'Order Service', type: 'service', responsibility: 'processes orders' },
    { name: 'PostgreSQL', type: 'store', responsibility: 'persists data' },
  ],
  relationships: [
    { from: 'API Gateway', to: 'Order Service', verb: 'routes', edgeType: 'runtime' },
    { from: 'Order Service', to: 'PostgreSQL', verb: 'writes', edgeType: 'runtime' },
  ],
  boundaries: [
    { name: 'Edge', members: ['API Gateway'] },
    { name: 'Core', members: ['Order Service'] },
    { name: 'Data', members: ['PostgreSQL'] },
  ],
  failurePaths: [
    { trigger: 'PostgreSQL', condition: 'write fails', handler: 'Order Service', recovery: 'retry with backoff' },
  ],
};

describe('specula-bundle', () => {
  it('emits modeling, MC, trace, and instrumentation artifacts', () => {
    const base = tlaCompiler.factsToTlaModule(FACTS, { nodes: [], edges: [], subgraphs: [] }, 'OrderSpec');
    const cfgSource = tlaCompiler.factsToTlaCfg(base.invariants, 'OrderSpec');

    const bundle = buildSpeculaBundle({
      runId: 'run-123',
      diagramName: 'order-spec',
      moduleName: 'OrderSpec',
      facts: FACTS,
      plan: { nodes: [], edges: [], subgraphs: [] },
      variables: base.variables,
      actions: base.actions,
      invariants: base.invariants,
      markdownPath: '/flows/order-spec/architecture.md',
      tsxManifest: {
        plannedModules: [
          { path: 'src/features/core/order-service.ts', purpose: 'Implement Order Service' },
        ],
        interactions: [
          { from: 'API Gateway', to: 'Order Service', actionName: 'ApiGatewayRoutesOrderService' },
        ],
      },
      baseTlaSource: base.tlaSource,
      baseCfgSource: cfgSource,
      validation: {
        tlc: {
          checked: true,
          success: false,
          statesExplored: 8,
          violations: [
            { invariant: 'Safety_1_PostgreSQL', traceLength: 2 },
          ],
        },
      },
    });

    assert.ok(bundle.modelingBriefMarkdown.includes('# Modeling Brief'));
    assert.ok(bundle.mc.source.includes('MODULE OrderSpecMC'));
    assert.ok(bundle.trace.source.includes('MODULE OrderSpecTrace'));
    assert.ok(bundle.instrumentationMarkdown.includes('# Instrumentation Spec'));
    assert.ok(bundle.validationLoop.modelChecking.counterexamples.length === 1);
    assert.ok(bundle.files.some((file) => file.relativePath === 'specula/modeling-brief.md'));
    assert.ok(bundle.huntConfigs.length >= 1);
  });
});
