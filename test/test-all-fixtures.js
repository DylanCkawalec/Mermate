'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { compile } = require('../server/services/mermaid-compiler');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const FIXTURE_FILES = [
  'flowchart-simple.mmd',
  'sequence-diagram.mmd',
  'class-diagram.mmd',
  'state-diagram.mmd',
  'er-diagram.mmd',
  'gantt-chart.mmd',
  'pie-chart.mmd',
  'mindmap.mmd',
];

describe('all fixture compilation', () => {
  let tmpOut;

  before(async () => {
    tmpOut = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-allfx-'));
  });

  after(async () => {
    await fsp.rm(tmpOut, { recursive: true, force: true }).catch(() => {});
  });

  for (const fixture of FIXTURE_FILES) {
    const baseName = fixture.replace('.mmd', '');

    it(`compiles ${fixture} to valid SVG and PNG`, async () => {
      const source = await fsp.readFile(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const outDir = path.join(tmpOut, baseName);
      const result = await compile(source, outDir, baseName);

      assert.equal(result.ok, true, `Compile failed for ${fixture}: ${result.error}`);
      assert.equal(result.svg.valid, true, `SVG invalid for ${fixture}: ${result.svg?.reason}`);
      assert.equal(result.png.valid, true, `PNG invalid for ${fixture}: ${result.png?.reason}`);
      assert.ok(result.svg.bytes > 500, `SVG too small for ${fixture}: ${result.svg.bytes}`);
      assert.ok(result.png.bytes > 2048, `PNG too small for ${fixture}: ${result.png.bytes}`);
    });
  }
});
