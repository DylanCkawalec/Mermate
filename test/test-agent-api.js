'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../server/index');

function requestJson(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

describe('agent routes', () => {
  let server;

  before(() => new Promise((resolve) => {
    server = app.listen(0, resolve);
  }));

  after(() => new Promise((resolve) => {
    server.close(resolve);
  }));

  it('returns the available agent modes', async () => {
    const res = await requestJson(server, 'GET', '/api/agent/modes');

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.modes));
    assert.deepEqual(
      res.body.modes.map((mode) => mode.id).sort(),
      ['code-review', 'optimize-mmd', 'thinking']
    );
  });

  it('rejects agent runs without a prompt', async () => {
    const res = await requestJson(server, 'POST', '/api/agent/run', { mode: 'thinking' });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'prompt is required');
  });

  it('rejects agent runs with an invalid mode', async () => {
    const res = await requestJson(server, 'POST', '/api/agent/run', {
      prompt: 'Describe the architecture',
      mode: 'unknown-mode',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'invalid agent mode');
  });

  it('rejects finalize requests without current_text', async () => {
    const res = await requestJson(server, 'POST', '/api/agent/finalize', {
      mode: 'thinking',
      user_notes: 'Focus on failure paths',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'current_text is required');
  });
});
