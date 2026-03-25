'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MMDC_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'mmdc');
const PUPPETEER_CONFIG = path.join(PROJECT_ROOT, 'puppeteer-config.json');
const COMPILE_TIMEOUT_MS = 120_000;

const SVG_WIDTH = 4096;
const SVG_HEIGHT = 2160;
const PNG_WIDTH = 3840;
const PNG_HEIGHT = 2160;
const PNG_SCALE = 4;

/**
 * Run mmdc to compile a .mmd source file into the given output format.
 * @param {string} inputPath  Absolute path to a .mmd file
 * @param {string} outputPath Absolute path to the output file (.svg or .png)
 * @param {object} [opts]
 * @param {number} [opts.scale] PNG scale factor (default: PNG_SCALE)
 * @param {number} [opts.width] Viewport width
 * @param {number} [opts.height] Viewport height
 * @returns {Promise<{ok: boolean, stderr?: string}>}
 */
function runMmdc(inputPath, outputPath, opts = {}) {
  return new Promise((resolve) => {
    const isPng = outputPath.endsWith('.png');
    const width = opts.width || (isPng ? PNG_WIDTH : SVG_WIDTH);
    const height = opts.height || (isPng ? PNG_HEIGHT : SVG_HEIGHT);
    const scale = opts.scale || (isPng ? PNG_SCALE : 1);

    const args = [
      '--input', inputPath,
      '--output', outputPath,
      '--puppeteerConfigFile', PUPPETEER_CONFIG,
      '--width', String(width),
      '--height', String(height),
      '--quiet',
    ];

    if (isPng) {
      args.push('--scale', String(scale));
    }

    execFile(MMDC_BIN, args, {
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stderr: stderr || err.message });
      } else {
        resolve({ ok: true, stderr });
      }
    });
  });
}

/**
 * Validate an SVG file is not broken.
 * @param {string} svgPath
 * @returns {Promise<{valid: boolean, reason?: string, bytes: number}>}
 */
async function validateSvg(svgPath) {
  try {
    const stat = await fsp.stat(svgPath);
    if (stat.size < 500) {
      return { valid: false, reason: 'SVG file too small (< 500 bytes)', bytes: stat.size };
    }
    const content = await fsp.readFile(svgPath, 'utf-8');
    if (content.includes('-Infinity') || content.includes('NaN')) {
      return { valid: false, reason: 'SVG contains -Infinity or NaN in viewBox', bytes: stat.size };
    }
    // Check viewBox has positive dimensions
    const vbMatch = content.match(/viewBox="([^"]+)"/);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/\s+/).map(Number);
      if (parts.length >= 4 && (parts[2] <= 0 || parts[3] <= 0)) {
        return { valid: false, reason: `SVG viewBox has non-positive dimensions: ${vbMatch[1]}`, bytes: stat.size };
      }
    }
    // Content check: ensure rendered SVG primitives exist (not just defs/styles)
    // Different diagram types (flowchart, sequence, gantt, pie, etc.) use
    // different group classes, so we check for actual drawing primitives.
    const primitiveCount =
      (content.match(/<(rect|path|circle|line|polygon|ellipse|text)[ >/]/g) || []).length;
    if (primitiveCount < 3) {
      return { valid: false, reason: `SVG has insufficient rendered content (${primitiveCount} primitives found, need >= 3)`, bytes: stat.size };
    }
    return { valid: true, bytes: stat.size };
  } catch (e) {
    return { valid: false, reason: e.message, bytes: 0 };
  }
}

/**
 * Validate a PNG file is not blank.
 * @param {string} pngPath
 * @returns {Promise<{valid: boolean, reason?: string, bytes: number}>}
 */
async function validatePng(pngPath) {
  try {
    const stat = await fsp.stat(pngPath);
    if (stat.size < 2048) {
      return { valid: false, reason: `PNG file too small (${stat.size} bytes, blank PNGs are ~1.2KB)`, bytes: stat.size };
    }
    // Check PNG magic bytes
    const buf = Buffer.alloc(4);
    const fh = await fsp.open(pngPath, 'r');
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      return { valid: false, reason: 'File does not have PNG magic bytes', bytes: stat.size };
    }
    // IDAT chunk check: ensure image data exists (not just headers)
    const fullBuf = await fsp.readFile(pngPath);
    const idatSig = Buffer.from([0x49, 0x44, 0x41, 0x54]); // 'IDAT'
    if (!fullBuf.includes(idatSig)) {
      return { valid: false, reason: 'PNG has no IDAT chunk (no image data)', bytes: stat.size };
    }
    // Byte variance check: sample 1KB starting at offset 100 to detect blank-white PNGs
    if (stat.size > 1124) {
      const sample = fullBuf.subarray(100, 1124);
      const uniqueBytes = new Set(sample);
      if (uniqueBytes.size < 8) {
        return { valid: false, reason: `PNG byte variance too low (${uniqueBytes.size} distinct values in 1KB sample — likely blank)`, bytes: stat.size };
      }
    }
    return { valid: true, bytes: stat.size };
  } catch (e) {
    return { valid: false, reason: e.message, bytes: 0 };
  }
}

/**
 * Compile Mermaid source into SVG and PNG.
 * @param {string} mermaidSource  Raw Mermaid text
 * @param {string} outputDir      Absolute path to the output directory
 * @param {string} baseName       Base name (no extension)
 * @returns {Promise<{ok: boolean, svg?: object, png?: object, error?: string}>}
 */
async function compile(mermaidSource, outputDir, baseName) {
  // Ensure output directory exists
  await fsp.mkdir(outputDir, { recursive: true });

  // Write source to a temp .mmd file
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mermaid-gpt-'));
  const tmpMmd = path.join(tmpDir, `${baseName}.mmd`);
  await fsp.writeFile(tmpMmd, mermaidSource, 'utf-8');

  const svgPath = path.join(outputDir, `${baseName}.svg`);
  const pngPath = path.join(outputDir, `${baseName}.png`);

  const start = Date.now();

  // Compile SVG and PNG in parallel — they read the same .mmd and write to different paths
  const [svgResult, pngResult] = await Promise.all([
    runMmdc(tmpMmd, svgPath, { width: SVG_WIDTH, height: SVG_HEIGHT }),
    runMmdc(tmpMmd, pngPath, { scale: PNG_SCALE, width: PNG_WIDTH, height: PNG_HEIGHT }),
  ]);

  if (!svgResult.ok) {
    logger.error('diagram.compiled', { baseName, format: 'svg', error: svgResult.stderr });
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: svgResult.stderr };
  }
  if (!pngResult.ok) {
    logger.error('diagram.compiled', { baseName, format: 'png', error: pngResult.stderr });
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: pngResult.stderr };
  }

  // Post-process SVG: ensure width="100%" for infinite scalability
  try {
    let svgContent = await fsp.readFile(svgPath, 'utf-8');
    svgContent = svgContent
      .replace(/width="\d+(\.\d+)?px"/, 'width="100%"')
      .replace(/height="\d+(\.\d+)?%?"/, '')
      .replace(/style="max-width:\s*[\d.]+px;/, 'style="max-width: none;');
    await fsp.writeFile(svgPath, svgContent, 'utf-8');
  } catch { /* non-fatal */ }

  const durationMs = Date.now() - start;

  // Validate outputs in parallel
  const [svgValidation, pngValidation] = await Promise.all([
    validateSvg(svgPath),
    validatePng(pngPath),
  ]);

  logger.info('diagram.compiled', {
    baseName,
    duration_ms: durationMs,
    svg_valid: svgValidation.valid,
    png_valid: pngValidation.valid,
    svg_bytes: svgValidation.bytes,
    png_bytes: pngValidation.bytes,
  });

  // Cleanup temp
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  if (!svgValidation.valid) {
    return { ok: false, error: `SVG validation failed: ${svgValidation.reason}`, svg: svgValidation, png: pngValidation };
  }
  if (!pngValidation.valid) {
    return { ok: false, error: `PNG validation failed: ${pngValidation.reason}`, svg: svgValidation, png: pngValidation };
  }

  return {
    ok: true,
    svg: svgValidation,
    png: pngValidation,
    duration_ms: durationMs,
  };
}

module.exports = { compile, validateSvg, validatePng, runMmdc };
