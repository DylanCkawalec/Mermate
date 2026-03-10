'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { dateStamp } = require('../utils/naming');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');

/**
 * Archive the original Mermaid input as a dated .md file and the source as a .mmd file.
 * @param {string} mermaidSource  Raw Mermaid text
 * @param {string} diagramName    Slugified diagram name
 * @param {string} diagramType    Classified diagram type
 * @returns {Promise<{mdPath: string, mmdPath: string}>}
 */
async function archive(mermaidSource, diagramName, diagramType) {
  await fsp.mkdir(ARCHS_DIR, { recursive: true });

  const date = dateStamp();
  const mdFileName = `${date}-${diagramName}.md`;
  const mmdFileName = `${diagramName}.mmd`;

  const mdPath = path.join(ARCHS_DIR, mdFileName);
  const mmdPath = path.join(ARCHS_DIR, mmdFileName);

  const mdContent = [
    `# ${diagramName}`,
    '',
    `- **Date**: ${date}`,
    `- **Type**: ${diagramType}`,
    '',
    '## Source',
    '',
    '```mermaid',
    mermaidSource,
    '```',
    '',
  ].join('\n');

  await fsp.writeFile(mdPath, mdContent, 'utf-8');
  await fsp.writeFile(mmdPath, mermaidSource, 'utf-8');

  logger.info('diagram.archived', { diagramName, mdPath: mdFileName, mmdPath: mmdFileName });

  return {
    mdPath: `/archs/${mdFileName}`,
    mmdPath: `/archs/${mmdFileName}`,
  };
}

/**
 * Archive the final compiled Mermaid source that was actually rendered.
 * This preserves an accurate record of what the system produced, separate
 * from the original user input (which may be natural language or markdown).
 *
 * @param {string} compiledMmd - The Mermaid source that was compiled to SVG/PNG
 * @param {string} diagramName - Slugified diagram name
 * @param {object} renderMeta  - Metadata about the render (provider, attempts, etc.)
 */
async function archiveCompiled(compiledMmd, diagramName, renderMeta = {}) {
  if (!compiledMmd || !diagramName) return null;
  await fsp.mkdir(ARCHS_DIR, { recursive: true });

  const compiledFileName = `${diagramName}.compiled.mmd`;
  const compiledPath = path.join(ARCHS_DIR, compiledFileName);

  const header = [
    `%% Compiled Mermaid source for: ${diagramName}`,
    `%% Generated: ${new Date().toISOString()}`,
    renderMeta.provider ? `%% Provider: ${renderMeta.provider}` : null,
    renderMeta.attempts ? `%% Compile attempts: ${renderMeta.attempts}` : null,
    renderMeta.maxMode ? `%% Max mode: true` : null,
  ].filter(Boolean).join('\n');

  const content = header + '\n\n' + compiledMmd;
  await fsp.writeFile(compiledPath, content, 'utf-8');

  return `/archs/${compiledFileName}`;
}

module.exports = { archive, archiveCompiled };
