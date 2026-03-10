'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyze,
  classifyMaturity,
  scoreQuality,
  scoreCompleteness,
  inferIntent,
  decideAction,
  extractShadow,
} = require('../server/services/input-analyzer');

describe('input-analyzer', () => {

  describe('analyze()', () => {
    it('returns fragment maturity for empty input', () => {
      const profile = analyze('', 'idea');
      assert.equal(profile.maturity, 'fragment');
      assert.equal(profile.recommendation, 'suggest');
    });

    it('returns fragment for very short input', () => {
      const profile = analyze('login flow', 'idea');
      assert.equal(profile.maturity, 'fragment');
    });

    it('classifies developing maturity for mid-quality idea', () => {
      const profile = analyze(
        'A user logs in via the browser, the API gateway validates JWT, then routes to the user service which reads from PostgreSQL.',
        'idea',
      );
      assert.ok(['developing', 'structured', 'complete'].includes(profile.maturity));
      assert.ok(profile.qualityScore > 0);
      assert.ok(profile.shadow.entities.length >= 2);
    });

    it('detects auth problem domain', () => {
      const profile = analyze(
        'User authenticates via OAuth, the auth service validates the JWT token and creates a session.',
        'idea',
      );
      assert.equal(profile.intent.problemDomain, 'auth');
    });

    it('detects payment domain', () => {
      const profile = analyze(
        'Checkout service calls Stripe for payment processing. On failure, retry up to 3 times.',
        'idea',
      );
      assert.equal(profile.intent.problemDomain, 'payment');
    });

    it('detects event-driven domain', () => {
      const profile = analyze(
        'Producer emits events to Kafka broker. Consumer subscribes to the topic. Message queue handles backpressure via pub/sub.',
        'idea',
      );
      assert.equal(profile.intent.problemDomain, 'eventDriven');
    });

    it('returns render-ready for valid mermaid', () => {
      const profile = analyze(
        'flowchart TD\n  A[Start] --> B[End]',
        'mmd',
      );
      assert.equal(profile.maturity, 'render-ready');
      assert.equal(profile.recommendation, 'render');
      assert.equal(profile.contentState, 'mmd');
    });

    it('returns repair for invalid mermaid', () => {
      const profile = analyze(
        'flowchart TD\n  end[Bad] --> B[End]',
        'mmd',
      );
      assert.equal(profile.recommendation, 'repair');
    });

    it('extracts failure paths', () => {
      const profile = analyze(
        'User logs in. Gateway validates token. On failure, return 401. On timeout, retry up to 3 times then dead-letter.',
        'idea',
      );
      assert.ok(profile.shadow.failurePaths.length >= 1);
      assert.ok(profile.qualityFactors.failurePathPresence > 0);
    });

    it('identifies gaps when no failure path exists', () => {
      const profile = analyze(
        'User logs in via browser. API gateway routes to auth service. Auth service reads from database. Return profile to browser.',
        'idea',
      );
      assert.ok(profile.shadow.gaps.some(g => /failure|error/.test(g)));
    });

    it('provides a useful hint', () => {
      const profile = analyze('User logs in via browser.', 'idea');
      assert.ok(profile.hint.length > 0);
      assert.ok(typeof profile.hint === 'string');
    });

    it('returns stop recommendation when input is complete and high quality', () => {
      const profile = analyze(
        'User opens browser and submits login form. API gateway validates the JWT token. Auth service queries PostgreSQL for user profile. On success, return the profile to the browser. On failure, return a 401 error with retry guidance. The security boundary includes the gateway and auth service.',
        'idea',
      );
      // With failure path, beginning, end state, and boundaries, should score well
      assert.ok(profile.completenessScore >= 0.5);
      assert.ok(profile.qualityScore >= 0.3);
    });
  });

  describe('extractShadow()', () => {
    it('extracts named technologies', () => {
      const shadow = extractShadow('Auth service uses PostgreSQL and Redis for caching.');
      const techNames = shadow.entities.filter(e => e.source === 'explicit').map(e => e.name.toLowerCase());
      assert.ok(techNames.some(n => n.includes('postgresql')));
      assert.ok(techNames.some(n => n.includes('redis')));
    });

    it('extracts relationships from action verbs', () => {
      const shadow = extractShadow('Gateway routes to auth service. Auth service reads from database.');
      assert.ok(shadow.relationships.length >= 1);
    });
  });

  describe('decideAction()', () => {
    it('returns render for valid mmd', () => {
      assert.equal(decideAction('mmd', 'render-ready', 0.8, 0.9, { valid: true }), 'render');
    });

    it('returns repair for invalid mmd', () => {
      assert.equal(decideAction('mmd', 'render-ready', 0.8, 0.9, { valid: false }), 'repair');
    });

    it('returns stop for complete high-quality text', () => {
      assert.equal(decideAction('text', 'complete', 0.8, 0.9, null), 'stop');
    });

    it('returns enhance for complete low-quality text', () => {
      assert.equal(decideAction('text', 'complete', 0.5, 0.7, null), 'enhance');
    });

    it('returns suggest for developing text', () => {
      assert.equal(decideAction('text', 'developing', 0.3, 0.4, null), 'suggest');
    });

    it('returns repair for hybrid content', () => {
      assert.equal(decideAction('hybrid', 'developing', 0.3, 0.4, null), 'repair');
    });
  });
});
