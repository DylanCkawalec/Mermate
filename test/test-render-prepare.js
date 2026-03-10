'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderPrepare } = require('../server/services/input-router');
const { analyze } = require('../server/services/input-analyzer');
const { buildRenderPrepareUserPrompt, buildModelRepairUserPrompt } = require('../server/services/axiom-prompts');
const { selectDiagramType } = require('../server/services/diagram-selector');

describe('renderPrepare', () => {

  it('produces valid Mermaid from plain text via local fallback', async () => {
    const source = 'A user logs in via the browser, the API gateway validates JWT, then routes to the user service which reads from PostgreSQL.';
    const profile = analyze(source, 'idea');
    const result = await renderPrepare(source, profile);

    assert.ok(result.mmdSource, 'Should produce mmd output');
    const firstLine = result.mmdSource.split('\n')[0].trim();
    assert.ok(/^(flowchart|graph|sequenceDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey)/i.test(firstLine),
      `First line should be a valid directive, got: ${firstLine}`);
    assert.ok(result.stagesExecuted.length > 0);
  });

  it('includes structured context in user prompt', () => {
    const source = 'Auth service validates JWT from API gateway. Reads user profile from PostgreSQL. On failure return 401.';
    const profile = analyze(source, 'idea');
    const prompt = buildRenderPrepareUserPrompt(source, profile);

    assert.ok(prompt.includes('[USER INPUT]'));
    assert.ok(prompt.includes('[ENTITIES]') || prompt.includes('[RELATIONSHIPS]') || prompt.includes('[GAPS]'));
  });

  it('builds model repair user prompt with error context', () => {
    const source = 'flowchart TD\n    end["Bad"] --> B';
    const error = 'Parse error on line 2: got "end"';
    const prompt = buildModelRepairUserPrompt(source, error);

    assert.ok(prompt.includes('[FAILED MERMAID SOURCE]'));
    assert.ok(prompt.includes('[COMPILE ERROR]'));
    assert.ok(prompt.includes('end'));
    assert.ok(prompt.includes('Parse error'));
  });
});

describe('diagram-selector fixes', () => {

  it('classifies multi-service distributed system as flowchart, not sequence', () => {
    const r = selectDiagramType(
      'Web and mobile clients hit CloudFront and an API gateway. Auth service issues JWT. Cart service uses Redis. Order service writes to PostgreSQL and emits events to Kafka. Payment service calls Stripe.',
    );
    assert.equal(r.type, 'flowchart');
    assert.ok(r.reason.includes('distributed') || r.reason.includes('architecture'));
  });

  it('still classifies pure state machine text as state diagram', () => {
    const r = selectDiagramType(
      'State machine for deployment: Pending -> Building -> Testing -> Failed. If tests fail go to Failed.',
    );
    assert.equal(r.type, 'state');
  });

  it('still classifies simple actor interaction as sequence when no heavy architecture signals', () => {
    const r = selectDiagramType(
      'Client sends request to server. Server responds with data. Client acknowledges.',
    );
    assert.equal(r.type, 'sequence');
  });
});
