'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');

function resolveArtifactPath(urlPath) {
  if (!urlPath || typeof urlPath !== 'string') return null;
  return path.join(PROJECT_ROOT, urlPath.replace(/^\/+/, ''));
}

async function readTextArtifact(urlPath) {
  const resolvedPath = resolveArtifactPath(urlPath);
  if (!resolvedPath) return '';
  return fsp.readFile(resolvedPath, 'utf8');
}

async function loadRunData(runId) {
  const runPath = path.join(RUNS_DIR, `${runId}.json`);
  const raw = await fsp.readFile(runPath, 'utf8');
  return {
    runPath,
    runData: JSON.parse(raw),
  };
}

function persistRunData(runPath, runData) {
  return fsp.writeFile(runPath, JSON.stringify(runData, null, 2), 'utf8');
}

function extractFactsAndPlan(runData) {
  let facts = null;
  let plan = null;

  for (const call of (runData.agent_calls || [])) {
    if (call.stage === 'fact_extraction' && call.success) {
      try { facts = JSON.parse(call.output_text); } catch { /* ignore parse miss */ }
    }
    if (call.stage === 'diagram_plan' && call.success) {
      try { plan = JSON.parse(call.output_text); } catch { /* ignore parse miss */ }
    }
  }

  return { facts, plan };
}

function getOriginalInput(runData) {
  return runData?.request?.user_input
    || runData?.user_request?.input
    || '';
}

function resolveDiagramName(runData, fallback = 'architecture') {
  return runData?.final_artifact?.diagram_name
    || runData?.user_request?.diagram_name
    || runData?.request?.user_diagram_name
    || fallback;
}

async function loadCompiledMmd(runData, diagramName) {
  const compiledUrl = runData?.final_artifact?.artifacts?.compiled_mmd
    || runData?.final_artifact?.artifacts?.mmd
    || `/flows/${diagramName}/${diagramName}.mmd`;

  let raw = await readTextArtifact(compiledUrl);
  if (!raw) return '';
  if (raw.startsWith('%%')) {
    raw = raw.split('\n').filter((line) => !line.startsWith('%%')).join('\n').trim();
  }
  return raw.trim();
}

async function loadCanonicalMarkdown(runData, diagramName) {
  const canonicalUrl = runData?.markdown_artifacts?.canonical
    || runData?.final_artifact?.artifacts?.architecture_md
    || `/flows/${diagramName}/architecture.md`;

  try {
    return await readTextArtifact(canonicalUrl);
  } catch {
    return '';
  }
}

module.exports = {
  PROJECT_ROOT,
  RUNS_DIR,
  FLOWS_DIR,
  resolveArtifactPath,
  readTextArtifact,
  loadRunData,
  persistRunData,
  extractFactsAndPlan,
  getOriginalInput,
  resolveDiagramName,
  loadCompiledMmd,
  loadCanonicalMarkdown,
};
