'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateSvg, validatePng } = require('../server/services/mermaid-compiler');

describe('image validation', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-imgval-'));
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('SVG validation', () => {
    it('rejects SVG with -Infinity in viewBox', async () => {
      const svgPath = path.join(tmpDir, 'bad.svg');
      const content = '<svg viewBox="0 0 -Infinity -Infinity"><g class="nodes"></g></svg>';
      await fsp.writeFile(svgPath, content.repeat(10)); // pad to > 500 bytes
      const result = await validateSvg(svgPath);
      assert.equal(result.valid, false);
      assert.ok(result.reason.includes('-Infinity'));
    });

    it('rejects SVG smaller than 500 bytes', async () => {
      const svgPath = path.join(tmpDir, 'tiny.svg');
      await fsp.writeFile(svgPath, '<svg></svg>');
      const result = await validateSvg(svgPath);
      assert.equal(result.valid, false);
    });

    it('accepts a valid SVG', async () => {
      const svgPath = path.join(tmpDir, 'good.svg');
      const content = `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="600" fill="white"/>
        <g class="nodes"><rect x="10" y="10" width="100" height="50"/></g>
      </svg>`;
      await fsp.writeFile(svgPath, content.repeat(5)); // ensure > 500 bytes
      const result = await validateSvg(svgPath);
      assert.equal(result.valid, true);
    });
  });

  describe('PNG validation', () => {
    it('rejects PNG smaller than 2048 bytes', async () => {
      const pngPath = path.join(tmpDir, 'tiny.png');
      // Write valid PNG header but tiny file
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fsp.writeFile(pngPath, buf);
      const result = await validatePng(pngPath);
      assert.equal(result.valid, false);
    });

    it('rejects non-PNG file', async () => {
      const fakePath = path.join(tmpDir, 'fake.png');
      await fsp.writeFile(fakePath, Buffer.alloc(3000, 0x42)); // 3KB of 'B'
      const result = await validatePng(fakePath);
      assert.equal(result.valid, false);
      assert.ok(result.reason.includes('magic bytes'));
    });
  });
});
