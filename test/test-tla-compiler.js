'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tla = require('../server/services/tla-compiler');

const SAMPLE_FACTS = {
  entities: [
    { name: 'API Gateway', type: 'gateway', responsibility: 'routes requests' },
    { name: 'Auth Service', type: 'service', responsibility: 'authenticates users' },
    { name: 'Database', type: 'store', responsibility: 'persists data' },
    { name: 'User', type: 'actor', responsibility: 'initiates requests' },
    { name: 'Cache', type: 'cache', responsibility: 'speeds reads' },
  ],
  relationships: [
    { from: 'User', to: 'API Gateway', verb: 'sends request', edgeType: 'runtime' },
    { from: 'API Gateway', to: 'Auth Service', verb: 'authenticates', edgeType: 'runtime' },
    { from: 'Auth Service', to: 'Database', verb: 'reads credentials', edgeType: 'runtime' },
    { from: 'API Gateway', to: 'Cache', verb: 'checks cache', edgeType: 'runtime' },
  ],
  boundaries: [
    { name: 'Backend', members: ['API Gateway', 'Auth Service', 'Cache'] },
    { name: 'Storage', members: ['Database'] },
  ],
  failurePaths: [
    { trigger: 'Auth Service', condition: 'invalid token', handler: 'API Gateway', recovery: 'return 401' },
    { trigger: 'Database', condition: 'connection lost', handler: 'Auth Service', recovery: 'retry with backoff' },
  ],
};

const SAMPLE_PLAN = {
  directive: 'flowchart TD',
  nodes: [
    { id: 'User', label: 'User', shape: 'stadium', entityRef: 'User' },
    { id: 'APIGw', label: 'API Gateway', shape: 'rectangle', entityRef: 'API Gateway' },
  ],
  edges: [
    { from: 'User', to: 'APIGw', label: 'request', style: 'solid', relationRef: 'sends request' },
  ],
};

describe('tla-compiler', () => {

  describe('_sanitizeId', () => {
    it('removes special characters', () => {
      assert.equal(tla._sanitizeId('API Gateway'), 'API_Gateway');
      assert.equal(tla._sanitizeId('Auth Service'), 'Auth_Service');
    });

    it('handles leading digits', () => {
      assert.equal(tla._sanitizeId('3DPrinter'), 'v3DPrinter');
    });

    it('handles empty string', () => {
      assert.equal(tla._sanitizeId(''), '');
    });
  });

  describe('mapEntityToVariable', () => {
    it('maps a service to stateful variable', () => {
      const v = tla.mapEntityToVariable({ name: 'Auth Service', type: 'service', responsibility: 'auth' });
      assert.equal(v.id, 'Auth_Service');
      assert.equal(v.isStateful, true);
      assert.equal(v.isConstant, false);
      assert.ok(v.states.length >= 3);
      assert.ok(v.stateSet.includes('"idle"'));
    });

    it('maps a decision to non-stateful', () => {
      const v = tla.mapEntityToVariable({ name: 'RouteDecision', type: 'decision', responsibility: 'routes' });
      assert.equal(v.isStateful, false);
      assert.equal(v.isConstant, true);
    });
  });

  describe('factsToTlaModule', () => {
    it('generates a valid TLA+ module structure', () => {
      const { tlaSource, variables, actions, invariants } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      assert.ok(tlaSource.includes('---- MODULE TestSpec ----'));
      assert.ok(tlaSource.includes('===='));
      assert.ok(tlaSource.includes('VARIABLES'));
      assert.ok(tlaSource.includes('Init =='));
      assert.ok(tlaSource.includes('Next =='));
      assert.ok(tlaSource.includes('Spec =='));
      assert.ok(tlaSource.includes('TypeInvariant =='));
      assert.equal(variables.length, 5); // gateway, service, store, actor, cache
    });

    it('maps all stateful entities to variables', () => {
      const { variables } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      const varNames = variables.map(v => v.name);
      assert.ok(varNames.includes('API Gateway'));
      assert.ok(varNames.includes('Auth Service'));
      assert.ok(varNames.includes('Database'));
      assert.ok(varNames.includes('User'));
    });

    it('maps relationships to actions', () => {
      const { actions } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      assert.equal(actions.length, 4);
      assert.ok(actions.some(a => a.actionName.includes('authenticates')));
    });

    it('maps failure paths to invariants', () => {
      const { invariants, tlaSource } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      assert.equal(invariants.length, 2);
      assert.ok(tlaSource.includes('Safety_1_'));
      assert.ok(tlaSource.includes('Safety_2_'));
    });

    it('includes UNCHANGED clauses', () => {
      const { tlaSource } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      assert.ok(tlaSource.includes('UNCHANGED'));
    });

    it('handles empty facts gracefully', () => {
      const { tlaSource, variables, actions, invariants } = tla.factsToTlaModule(
        { entities: [], relationships: [], boundaries: [], failurePaths: [] },
        null,
        'EmptySpec'
      );
      assert.ok(tlaSource.includes('---- MODULE EmptySpec ----'));
      assert.equal(variables.length, 0);
      assert.equal(actions.length, 0);
      assert.equal(invariants.length, 0);
    });
  });

  describe('factsToTlaCfg', () => {
    it('generates config with SPECIFICATION and INVARIANT', () => {
      const { invariants } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      const cfg = tla.factsToTlaCfg(invariants, 'TestSpec');
      assert.ok(cfg.includes('SPECIFICATION Spec'));
      assert.ok(cfg.includes('INVARIANT TypeInvariant'));
      assert.ok(cfg.includes('INVARIANT Safety_1_'));
      assert.ok(cfg.includes('CHECK_DEADLOCK FALSE'));
    });
  });

  describe('computeTlaMetrics', () => {
    it('computes correct metrics', () => {
      const { variables, actions, invariants } = tla.factsToTlaModule(SAMPLE_FACTS, SAMPLE_PLAN, 'TestSpec');
      const metrics = tla.computeTlaMetrics(variables, actions, invariants, SAMPLE_FACTS);
      assert.ok(metrics.variableCount > 0);
      assert.ok(metrics.actionCount > 0);
      assert.ok(metrics.invariantCount > 0);
      assert.ok(metrics.entityCoverage > 0);
      assert.ok(metrics.invariantCoverage > 0);
      assert.ok(metrics.stateSpaceEstimate > 0);
    });
  });
});
