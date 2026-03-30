'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// We import the Express app directly and create our own server
// to avoid port conflicts with a running instance.
const app = require('../server/index');

function postJson(server, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method: 'POST',
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
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('POST /api/render', () => {
  let server;

  before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
  });

  after(() => {
    try { require('../server/services/rate-master-bridge').destroy(); } catch { /* ok */ }
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('renders a simple flowchart and returns valid response', async () => {
    const res = await postJson(server, '/api/render', {
      mermaid_source: 'flowchart LR\n  A[Hello] --> B[World]',
      diagram_name: 'test-hello-world',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.diagram_type, 'flowchart');
    assert.equal(res.body.diagram_name, 'test-hello-world');
    assert.ok(res.body.paths.png);
    assert.ok(res.body.paths.svg);
    assert.ok(res.body.validation.svg_valid);
    assert.ok(res.body.validation.png_valid);

    // Verify files actually exist on disk
    const pngPath = path.join(PROJECT_ROOT, res.body.paths.png.slice(1));
    const svgPath = path.join(PROJECT_ROOT, res.body.paths.svg.slice(1));
    const pngStat = await fsp.stat(pngPath);
    const svgStat = await fsp.stat(svgPath);
    assert.ok(pngStat.size > 2048);
    assert.ok(svgStat.size > 500);

    // Verify progressionUpdate payload for 5-tab orchestrator
    if (res.body.run_id) {
      assert.ok(res.body.progressionUpdate, 'progressionUpdate must be present when run_id exists');
      assert.equal(res.body.progressionUpdate.stage, 'mmd');
      assert.ok(Array.isArray(res.body.progressionUpdate.unlockedStages));
      assert.ok(res.body.progressionUpdate.unlockedStages.includes('tsx'), 'TSX must be unlocked after Mermaid render');
      assert.ok(res.body.progressionUpdate.unlockedStages.includes('tla'), 'TLA+ must be unlocked after Mermaid render');
      assert.equal(typeof res.body.progressionUpdate.confidence, 'number');
      assert.ok(res.body.progressionUpdate.confidence > 0 && res.body.progressionUpdate.confidence <= 1);
    }
    assert.ok(res.body.paths.architecture_md);
  });

  it('returns 400 for missing mermaid_source', async () => {
    const res = await postJson(server, '/api/render', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'missing_source');
  });
});
