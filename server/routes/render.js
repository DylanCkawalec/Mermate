'use strict';

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { compile } = require('../services/mermaid-compiler');
const { archive } = require('../services/mermaid-archiver');
const { route, RouterError } = require('../services/input-router');
const { deriveDiagramName } = require('../utils/naming');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');

const router = Router();

/**
 * POST /api/render
 * Body: { mermaid_source: string, diagram_name?: string, enhance?: boolean }
 *
 * Accepts plain text, markdown, mermaid source, or hybrid content.
 * The input-router detects the content type and selects the correct pipeline.
 */
router.post('/render', async (req, res) => {
  const { mermaid_source, diagram_name, enhance } = req.body || {};

  if (!mermaid_source || typeof mermaid_source !== 'string' || !mermaid_source.trim()) {
    return res.status(400).json({
      success: false,
      error: 'missing_source',
      details: 'mermaid_source is required and must be a non-empty string',
    });
  }

  const source = mermaid_source.trim();

  if (source.length > 100_000) {
    return res.status(400).json({
      success: false,
      error: 'input_too_large',
      details: 'Input exceeds 100,000 characters',
    });
  }

  try {
    const classifiedAt = new Date().toISOString();

    // 1. Route through intelligent pipeline (detect -> enhance -> produce .mmd)
    let routeResult;
    try {
      routeResult = await route(source, { enhance: !!enhance });
    } catch (err) {
      if (err instanceof RouterError) {
        return res.status(422).json({
          success: false,
          error: err.code,
          details: err.message,
        });
      }
      throw err;
    }

    const {
      mmdSource,
      diagramType,
      contentState,
      enhanced: wasEnhanced,
      enhanceMeta,
      stagesExecuted,
      totalEnhanceMs,
      validation: preCompileValidation,
      diagramSelection,
    } = routeResult;

    logger.info('input.routed', {
      content_state: contentState,
      diagram_type: diagramType,
      enhanced: wasEnhanced,
      stages: stagesExecuted,
      enhance_ms: totalEnhanceMs,
    });

    // 2. Derive name
    const diagramName = deriveDiagramName(mmdSource, diagram_name);

    // 3. Archive original source
    const archivePaths = await archive(source, diagramName, diagramType);

    // 4. Compile the .mmd output (SVG + PNG)
    const outputDir = path.join(FLOWS_DIR, diagramName);
    const compileResult = await compile(mmdSource, outputDir, diagramName);

    if (!compileResult.ok) {
      return res.status(422).json({
        success: false,
        error: 'compilation_failed',
        details: compileResult.error,
        diagram_type: diagramType,
        content_state: contentState,
        enhance_meta: wasEnhanced ? {
          transformation: enhanceMeta?.transformation,
          content_state: contentState,
          stages_executed: stagesExecuted,
          total_enhance_ms: totalEnhanceMs,
        } : null,
      });
    }

    // 5. Respond
    const compiledAt = new Date().toISOString();
    return res.json({
      success: true,
      diagram_name: diagramName,
      diagram_type: diagramType,
      classified_at: classifiedAt,
      compiled_at: compiledAt,
      enhanced: wasEnhanced,
      enhance_meta: wasEnhanced ? {
        transformation: enhanceMeta?.transformation,
        content_state: contentState,
        maturity: enhanceMeta?.maturity || null,
        stages_executed: stagesExecuted,
        total_enhance_ms: totalEnhanceMs,
        warnings: enhanceMeta?.warnings || [],
      } : null,
      content_state: contentState,
      paths: {
        png: `/flows/${diagramName}/${diagramName}.png`,
        svg: `/flows/${diagramName}/${diagramName}.svg`,
        mmd: archivePaths.mmdPath,
        md: archivePaths.mdPath,
      },
      validation: {
        svg_valid: compileResult.svg.valid,
        png_valid: compileResult.png.valid,
        svg_bytes: compileResult.svg.bytes,
        png_bytes: compileResult.png.bytes,
      },
      axiom_analysis: {
        pre_compile: {
          valid: preCompileValidation?.valid ?? true,
          errors: (preCompileValidation?.errors || []).length,
          warnings: (preCompileValidation?.warnings || []).length,
          stats: preCompileValidation?.stats || {},
        },
        diagram_selection: diagramSelection || null,
      },
    });
  } catch (err) {
    logger.error('render.error', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      details: err.message,
    });
  }
});

/**
 * GET /api/diagrams
 * Returns list of previously rendered diagrams from flows/.
 */
router.get('/diagrams', async (_req, res) => {
  try {
    await fsp.mkdir(FLOWS_DIR, { recursive: true });
    const entries = await fsp.readdir(FLOWS_DIR, { withFileTypes: true });
    const diagrams = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const dirPath = path.join(FLOWS_DIR, name);
      const files = await fsp.readdir(dirPath);
      const hasPng = files.some(f => f.endsWith('.png'));
      const hasSvg = files.some(f => f.endsWith('.svg'));
      if (hasPng || hasSvg) {
        const stat = await fsp.stat(dirPath);
        diagrams.push({
          name,
          has_png: hasPng,
          has_svg: hasSvg,
          paths: {
            png: hasPng ? `/flows/${name}/${name}.png` : null,
            svg: hasSvg ? `/flows/${name}/${name}.svg` : null,
          },
          created_at: stat.birthtime.toISOString(),
        });
      }
    }

    diagrams.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return res.json({ success: true, diagrams });
  } catch (err) {
    logger.error('diagrams.list.error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/diagrams/:name
 * Remove a diagram's compiled outputs and archived source.
 */
router.delete('/diagrams/:name', async (req, res) => {
  const name = req.params.name;
  if (!name || /[\/\\]/.test(name)) {
    return res.status(400).json({ success: false, error: 'invalid_name' });
  }

  try {
    const flowDir = path.join(FLOWS_DIR, name);
    await fsp.rm(flowDir, { recursive: true, force: true }).catch(() => {});

    const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');
    const mmdPath = path.join(ARCHS_DIR, `${name}.mmd`);
    await fsp.rm(mmdPath, { force: true }).catch(() => {});

    const mdFiles = await fsp.readdir(ARCHS_DIR).catch(() => []);
    for (const f of mdFiles) {
      if (f.endsWith(`-${name}.md`)) {
        await fsp.rm(path.join(ARCHS_DIR, f), { force: true }).catch(() => {});
      }
    }

    logger.info('diagram.deleted', { name });
    return res.json({ success: true });
  } catch (err) {
    logger.error('diagram.delete.error', { name, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
