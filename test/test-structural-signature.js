'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sig = require('../server/services/structural-signature');

const SIMPLE_FLOW = `flowchart TD
  A["User"] --> B["API Gateway"]
  B --> C["Auth Service"]
  B --> D["Data Service"]
  C --> E["Database"]
  D --> E
`;

const COMPLEX_FLOW = `flowchart TD
  subgraph Frontend
    U["User"] --> LB["Load Balancer"]
  end
  subgraph Backend
    LB --> API["API Server"]
    API --> Auth["Auth"]
    API --> Cache["Redis"]
    API --> Worker["Worker"]
  end
  subgraph Storage
    Worker --> DB["Postgres"]
    Worker --> S3["Object Store"]
  end
  Auth --> DB
  Cache --> DB
`;

const CYCLIC_FLOW = `flowchart TD
  A --> B
  B --> C
  C --> A
  C --> D
`;

const DISCONNECTED_FLOW = `flowchart TD
  A --> B
  B --> C
  D --> E
`;

const CROSS_CUTTING = `flowchart TD
  subgraph SvcA
    A1 --> Log
  end
  subgraph SvcB
    B1 --> Log
  end
  subgraph SvcC
    C1 --> Log
  end
  subgraph SvcD
    D1 --> Log
  end
`;

describe('structural-signature', () => {

  describe('parseGraph', () => {
    it('extracts nodes and edges from simple flow', () => {
      const g = sig.parseGraph(SIMPLE_FLOW);
      assert.ok(g.nodes.size >= 4, `expected >=4 nodes, got ${g.nodes.size}`);
      assert.ok(g.edges.length >= 4, `expected >=4 edges, got ${g.edges.length}`);
    });

    it('tracks subgraph membership', () => {
      const g = sig.parseGraph(COMPLEX_FLOW);
      assert.ok(g.subgraphs.length >= 3, 'expected 3 subgraphs');
      assert.ok(Object.keys(g.nodeToSubgraph).length > 0, 'should track node-to-subgraph');
    });

    it('handles empty input', () => {
      const g = sig.parseGraph('');
      assert.equal(g.nodes.size, 0);
      assert.equal(g.edges.length, 0);
    });
  });

  describe('extract', () => {
    it('produces a complete signature for simple flow', () => {
      const s = sig.extract(SIMPLE_FLOW);
      assert.ok(s.topologyHash, 'should have topology hash');
      assert.ok(s.nodeCount >= 4, `nodeCount=${s.nodeCount}`);
      assert.ok(s.edgeCount >= 4, `edgeCount=${s.edgeCount}`);
      assert.ok(['trivial', 'simple'].includes(s.complexityClass), `class=${s.complexityClass}`);
      assert.equal(s.hasCycles, false);
      assert.equal(s.isFullyConnected, true);
    });

    it('detects cycles', () => {
      const s = sig.extract(CYCLIC_FLOW);
      assert.equal(s.hasCycles, true);
    });

    it('detects disconnected components', () => {
      const s = sig.extract(DISCONNECTED_FLOW);
      assert.equal(s.isFullyConnected, false);
      assert.ok(s.connectedComponents >= 2);
    });

    it('computes boundary crossings', () => {
      const s = sig.extract(COMPLEX_FLOW);
      assert.ok(s.boundaryCrossings > 0, 'should have boundary crossings');
      assert.ok(s.boundaryRatio > 0, 'should have boundary ratio');
    });

    it('detects cross-cutting patterns', () => {
      const s = sig.extract(CROSS_CUTTING);
      assert.ok(s.crossCuttingCount >= 1, `expected cross-cutting patterns, got ${s.crossCuttingCount}`);
      assert.ok(s.crossCuttingPatterns.length > 0);
      const logPattern = s.crossCuttingPatterns.find(p => p.node === 'Log');
      assert.ok(logPattern, 'should detect Log as cross-cutting hub');
      assert.ok(logPattern.fanInSubgraphs >= 3);
    });

    it('classifies complexity consistently', () => {
      const s1 = sig.extract(SIMPLE_FLOW);
      const s2 = sig.extract(COMPLEX_FLOW);
      const s3 = sig.extract(CYCLIC_FLOW);
      assert.ok(['trivial', 'simple'].includes(s1.complexityClass), `simple flow: ${s1.complexityClass}`);
      assert.ok(['trivial', 'simple', 'moderate'].includes(s2.complexityClass), `complex flow: ${s2.complexityClass}`);
      assert.equal(s3.complexityClass, 'trivial', 'cyclic 4-node is trivial');
    });

    it('computes flow completeness', () => {
      const s = sig.extract(SIMPLE_FLOW);
      assert.ok(s.sourceNodes >= 1, 'should have entry points');
      assert.ok(s.sinkNodes >= 1, 'should have terminal nodes');
      assert.ok(s.orphanedNodes <= 1, `orphans should be minimal, got ${s.orphanedNodes}`);
    });

    it('topology hash is deterministic', () => {
      const s1 = sig.extract(SIMPLE_FLOW);
      const s2 = sig.extract(SIMPLE_FLOW);
      assert.equal(s1.topologyHash, s2.topologyHash, 'same input = same hash');
    });

    it('topology hash differs for different structures', () => {
      const s1 = sig.extract(SIMPLE_FLOW);
      const s2 = sig.extract(CYCLIC_FLOW);
      assert.notEqual(s1.topologyHash, s2.topologyHash, 'different structures = different hash');
    });
  });

  describe('graph property validation', () => {
    it('validates graph properties through mermaid-validator', () => {
      const { validateGraphProperties } = require('../server/services/mermaid-validator');
      const result = validateGraphProperties(SIMPLE_FLOW);
      assert.ok(result.properties, 'should return properties');
      assert.ok(typeof result.score === 'number');
      assert.ok(result.properties.topologyHash);
    });

    it('detects issues in disconnected graph', () => {
      const { validateGraphProperties } = require('../server/services/mermaid-validator');
      const result = validateGraphProperties(DISCONNECTED_FLOW);
      assert.ok(result.issues.length > 0, 'should find issues');
      assert.ok(result.issues.some(i => i.includes('L1:disconnected')));
      assert.ok(result.score < 1.0);
    });
  });
});
