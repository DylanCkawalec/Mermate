'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compileTsxArchitectureScaffold } = require('../server/services/tsx-compiler');

describe('tsx-compiler', () => {
  it('builds a deterministic TSX scaffold manifest and sources', () => {
    const compiled = compileTsxArchitectureScaffold({
      diagramName: 'inventory-platform',
      title: 'Inventory Platform',
      summary: 'Inventory service reserves stock and notifies downstream systems.',
      markdownPath: '/flows/inventory-platform/architecture.md',
      facts: {
        entities: [
          { name: 'Inventory Service', type: 'service', responsibility: 'reserves stock' },
          { name: 'Redis Cache', type: 'cache', responsibility: 'caches inventory reads' },
          { name: 'Kafka', type: 'broker', responsibility: 'delivers events' },
        ],
        relationships: [
          { from: 'Inventory Service', to: 'Redis Cache', verb: 'hydrates cache', edgeType: 'runtime' },
          { from: 'Inventory Service', to: 'Kafka', verb: 'publishes event', edgeType: 'async' },
        ],
        boundaries: [
          { name: 'Core', members: ['Inventory Service'] },
          { name: 'Infra', members: ['Redis Cache', 'Kafka'] },
        ],
        failurePaths: [
          { trigger: 'Kafka', condition: 'broker unavailable', handler: 'Inventory Service', recovery: 'buffer locally' },
        ],
      },
      plan: {
        subgraphs: [],
      },
    });

    assert.equal(compiled.metrics.componentCount, 3);
    assert.equal(compiled.metrics.boundaryCount, 2);
    assert.ok(compiled.appSource.includes('TSX Architecture Scaffold'));
    assert.ok(compiled.specSource.includes('export const architectureShell'));
    assert.ok(compiled.styleSource.includes('.architecture-shell'));
    assert.ok(compiled.manifest.polyglotTargets.some((target) => target.language === 'python'));
    assert.ok(Object.keys(compiled.files).includes('src/App.tsx'));
  });
});
