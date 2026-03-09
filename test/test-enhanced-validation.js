'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateSvg, validatePng } = require('../server/services/mermaid-compiler');

describe('enhanced SVG validation', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-enh-svg-'));
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects SVG with only style/marker definitions and no rendered content', async () => {
    const svgPath = path.join(tmpDir, 'markers-only.svg');
    // Valid viewBox, large enough, but no nodes/root/edgePaths groups
    const content = `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
      <style>.node { fill: blue; } .edge { stroke: black; } .label { font-size: 14px; }</style>
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" orient="auto"/></defs>
      <g id="container"><g id="empty-group"></g></g>
    </svg>`;
    await fsp.writeFile(svgPath, content.repeat(5)); // ensure > 500 bytes
    const result = await validateSvg(svgPath);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('insufficient rendered content'));
  });

  it('accepts SVG with nodes group', async () => {
    const svgPath = path.join(tmpDir, 'with-nodes.svg');
    const content = `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
      <style>.node { fill: blue; }</style>
      <g class="root"><g class="clusters"/><g class="edgePaths"><path d="M10 10 L100 100"/></g>
      <g class="nodes"><rect x="10" y="10" width="100" height="50"/></g></g>
    </svg>`;
    await fsp.writeFile(svgPath, content.repeat(3));
    const result = await validateSvg(svgPath);
    assert.equal(result.valid, true);
  });
});

describe('enhanced PNG validation', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-enh-png-'));
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects PNG without IDAT chunk', async () => {
    const pngPath = path.join(tmpDir, 'no-idat.png');
    // Valid PNG header + IHDR chunk but no IDAT
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Fake IHDR chunk (13 bytes data)
    const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13);
    const ihdrType = Buffer.from('IHDR');
    const ihdrData = Buffer.alloc(13); // width, height, bit depth, etc.
    const padding = Buffer.alloc(3000, 0x00); // pad to > 2048 bytes, no IDAT
    await fsp.writeFile(pngPath, Buffer.concat([header, ihdrLen, ihdrType, ihdrData, padding]));
    const result = await validatePng(pngPath);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('IDAT'));
  });

  it('rejects PNG with very low byte variance (blank-white)', async () => {
    const pngPath = path.join(tmpDir, 'blank-white.png');
    // Valid PNG header + IDAT signature embedded, but all-0xFF data (simulating blank white)
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const idatSig = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54, 0xFF]);
    const body = Buffer.alloc(3000, 0xFF); // all 0xFF — single distinct value + a few header bytes
    await fsp.writeFile(pngPath, Buffer.concat([header, idatSig, body]));
    const result = await validatePng(pngPath);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('variance'));
  });
});
