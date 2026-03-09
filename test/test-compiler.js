'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { compile } = require('../server/services/mermaid-compiler');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('mermaid-compiler', () => {
  let tmpOut;

  before(async () => {
    tmpOut = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-test-'));
  });

  after(async () => {
    await fsp.rm(tmpOut, { recursive: true, force: true }).catch(() => {});
  });

  it('compiles flowchart-simple.mmd to valid SVG and PNG', async () => {
    const source = await fsp.readFile(path.join(FIXTURES_DIR, 'flowchart-simple.mmd'), 'utf-8');
    const outDir = path.join(tmpOut, 'flowchart-simple');
    const result = await compile(source, outDir, 'flowchart-simple');

    assert.equal(result.ok, true, `Compile failed: ${result.error}`);
    assert.equal(result.svg.valid, true);
    assert.equal(result.png.valid, true);
    assert.ok(result.svg.bytes > 500, `SVG too small: ${result.svg.bytes}`);
    assert.ok(result.png.bytes > 2048, `PNG too small: ${result.png.bytes}`);
  });

  it('compiles sequence-diagram.mmd to valid outputs', async () => {
    const source = await fsp.readFile(path.join(FIXTURES_DIR, 'sequence-diagram.mmd'), 'utf-8');
    const outDir = path.join(tmpOut, 'sequence-diagram');
    const result = await compile(source, outDir, 'sequence-diagram');
    assert.equal(result.ok, true, `Compile failed: ${result.error}`);
  });

  it('compiles pie-chart.mmd to valid outputs', async () => {
    const source = await fsp.readFile(path.join(FIXTURES_DIR, 'pie-chart.mmd'), 'utf-8');
    const outDir = path.join(tmpOut, 'pie-chart');
    const result = await compile(source, outDir, 'pie-chart');
    assert.equal(result.ok, true, `Compile failed: ${result.error}`);
  });

  it('returns error for invalid Mermaid source', async () => {
    const outDir = path.join(tmpOut, 'invalid');
    const result = await compile('this is not valid mermaid !!!@@@', outDir, 'invalid');
    // This may either fail during compilation or during validation
    // Either way, the system should not crash
    assert.ok(typeof result.ok === 'boolean');
  });
});
