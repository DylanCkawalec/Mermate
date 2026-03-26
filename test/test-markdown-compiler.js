'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compileMarkdownArtifact } = require('../server/services/markdown-compiler');

describe('markdown-compiler', () => {
  it('builds a canonical markdown artifact from extracted facts', () => {
    const compiled = compileMarkdownArtifact({
      diagramName: 'order-platform',
      inputMode: 'idea',
      diagramType: 'flowchart',
      originalSource: 'Order service validates payment and writes to PostgreSQL.',
      facts: {
        entities: [
          { name: 'Order Service', type: 'service', responsibility: 'validates orders' },
          { name: 'Payment Gateway', type: 'gateway', responsibility: 'routes charges' },
          { name: 'PostgreSQL', type: 'store', responsibility: 'persists orders' },
        ],
        relationships: [
          { from: 'Order Service', to: 'Payment Gateway', verb: 'submits charge', edgeType: 'runtime' },
          { from: 'Order Service', to: 'PostgreSQL', verb: 'writes order', edgeType: 'runtime' },
        ],
        boundaries: [
          { name: 'Core', members: ['Order Service', 'Payment Gateway'] },
          { name: 'Data', members: ['PostgreSQL'] },
        ],
        failurePaths: [
          { trigger: 'Payment Gateway', condition: 'charge rejected', handler: 'Order Service', recovery: 'mark order failed' },
        ],
      },
      plan: {
        subgraphs: [
          { id: 'Core', label: 'Core', members: ['Order Service', 'Payment Gateway'] },
        ],
      },
      mmdSource: 'flowchart TD\n  OrderService --> PaymentGateway\n  OrderService --> PostgreSQL',
    });

    assert.ok(compiled.markdownSource.includes('# Order Platform'));
    assert.ok(compiled.markdownSource.includes('## Components'));
    assert.ok(compiled.markdownSource.includes('Order Service'));
    assert.ok(compiled.markdownSource.includes('## Failure Paths'));
    assert.ok(compiled.markdownSource.includes('```mermaid'));
    assert.equal(compiled.manifest.entityCount, 3);
    assert.equal(compiled.manifest.boundaryCount, 2);
  });
});
