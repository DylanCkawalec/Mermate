'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const db = require('./db');
const schema = require('./schema');
const merkle = require('./merkle');
const embeddings = require('./embeddings');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');

function _uuid() { return crypto.randomUUID(); }

async function _fileHash(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return { hash: merkle.hashContent(buf), size: buf.length };
  } catch { return null; }
}

async function _readTextSafe(filePath) {
  try { return await fsp.readFile(filePath, 'utf8'); } catch { return null; }
}

const ARTIFACT_EXTENSIONS = {
  '.harness.ts': 'harness',
  '.compiled.mmd': 'compiled_mmd',
  '.mmd': 'mmd',
  '.md': 'md',
  '.png': 'png',
  '.svg': 'svg',
  '.tla': 'tla',
  '.cfg': 'cfg',
  '.ts': 'ts',
};

function _classifyFile(fileName) {
  for (const [ext, type] of Object.entries(ARTIFACT_EXTENSIONS)) {
    if (fileName.endsWith(ext)) return type;
  }
  return null;
}

// ---- GoT Signal Extraction (canonical: sigma = 0.5*SV + 0.5*IC) ----

function _extractGoTSignals(runData) {
  const sv = runData.final_artifact?.validation?.structurally_valid ? 1 : 0;

  let ic = 1.0;
  if (runData.tla_metrics) {
    ic = runData.tla_metrics.invariantCoverage ?? 1.0;
  }

  const sigma = 0.5 * sv + 0.5 * ic;

  const profile = runData.request?.profile;
  const metrics = runData.final_artifact?.metrics;
  const totals = runData.totals;
  const tla = runData.tla_metrics;
  const ts = runData.ts_metrics;

  return {
    sigma,
    sv,
    ic,
    quality_score: profile?.quality_score ?? 0,
    completeness_score: profile?.completeness_score ?? 0,
    node_count: metrics?.node_count ?? 0,
    edge_count: metrics?.edge_count ?? 0,
    subgraph_count: metrics?.subgraph_count ?? 0,
    total_cost: totals?.total_cost_est ?? 0,
    wall_clock_ms: totals?.wall_clock_ms ?? 0,
    total_tokens_in: totals?.total_tokens_in ?? 0,
    total_tokens_out: totals?.total_tokens_out ?? 0,
    agent_calls: totals?.total_agent_calls ?? 0,
    tla_invariant_count: tla?.invariantCount ?? 0,
    tla_states_explored: tla?.tlcStatesExplored ?? 0,
    ts_compile_passed: ts?.compilePassed ?? false,
    ts_test_passed: ts?.testPassed ?? false,
  };
}

function _stageFromRun(runData) {
  if (runData.ts_artifacts) return 'ts';
  if (runData.tla_artifacts) return 'tla';
  if (runData.final_artifact) return 'mmd';
  return 'idea';
}

// ---- Parallel artifact discovery ----

async function _discoverArtifacts(projectId) {
  const flowDir = path.join(FLOWS_DIR, projectId);
  const artifacts = [];

  try {
    const files = await fsp.readdir(flowDir);
    const results = await Promise.all(files.map(async (f) => {
      const type = _classifyFile(f);
      if (!type) return null;
      const fullPath = path.join(flowDir, f);
      const stat = await fsp.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) return null;
      const info = await _fileHash(fullPath);
      if (!info) return null;
      return {
        artifact_id: info.hash, project_id: projectId, artifact_type: type,
        path: `flows/${projectId}/${f}`, content_hash: info.hash, size_bytes: info.size,
      };
    }));
    artifacts.push(...results.filter(Boolean));

    const tsDir = path.join(flowDir, 'ts-runtime');
    try {
      const tsFiles = await fsp.readdir(tsDir);
      const tsResults = await Promise.all(tsFiles.map(async (f) => {
        const type = _classifyFile(f);
        if (!type) return null;
        const fullPath = path.join(tsDir, f);
        const info = await _fileHash(fullPath);
        if (!info) return null;
        return {
          artifact_id: info.hash, project_id: projectId, artifact_type: type,
          path: `flows/${projectId}/ts-runtime/${f}`, content_hash: info.hash, size_bytes: info.size,
        };
      }));
      artifacts.push(...tsResults.filter(Boolean));
    } catch { /* no ts-runtime dir */ }
  } catch { /* flow dir may not exist */ }

  return artifacts;
}

// ---- Parallel embedding generation ----

async function _generateEmbeddings(projectId, runData, artifacts) {
  const texts = [];
  const types = [];

  const userInput = runData.request?.user_input;
  if (userInput) { texts.push(userInput); types.push('description'); }

  const factsCall = (runData.agent_calls || []).find(c => c.stage === 'fact_extraction' && c.success);
  if (factsCall?.output_text) { texts.push(factsCall.output_text.slice(0, 20000)); types.push('facts'); }

  const planCall = (runData.agent_calls || []).find(c => c.stage === 'diagram_plan' && c.success);
  if (planCall?.output_text) { texts.push(planCall.output_text.slice(0, 20000)); types.push('plan'); }

  const textArtifacts = artifacts.filter(a => ['mmd', 'compiled_mmd', 'tla', 'ts'].includes(a.artifact_type));
  const textContents = await Promise.all(textArtifacts.map(a => _readTextSafe(path.join(PROJECT_ROOT, a.path))));

  for (let i = 0; i < textArtifacts.length; i++) {
    const content = textContents[i];
    if (content && content.length > 20) {
      texts.push(content.slice(0, 20000));
      types.push(textArtifacts[i].artifact_type === 'tla' ? 'tla_source'
        : textArtifacts[i].artifact_type === 'ts' ? 'ts_source' : 'mmd_source');
    }
  }

  if (texts.length === 0) return [];

  const results = await embeddings.embedBatch(texts);
  return texts.map((t, i) => ({
    embedding_id: _uuid(),
    artifact_id: artifacts[0]?.artifact_id || _uuid(),
    project_id: projectId,
    content_type: types[i],
    content_preview: t.slice(0, 500),
    vector: results[i].vector,
    token_count: results[i].tokenCount,
  }));
}

// ---- Main ingestion ----

async function ingestRun(runId) {
  await db.init();

  const runPath = path.join(RUNS_DIR, `${runId}.json`);
  let runData;
  try {
    runData = JSON.parse(await fsp.readFile(runPath, 'utf8'));
  } catch (err) {
    logger.warn('ingester.run_not_found', { runId, error: err.message });
    return;
  }

  const projectId = runData.final_artifact?.diagram_name
    || runData.user_request?.diagram_name
    || runData.request?.user_diagram_name;

  if (!projectId) {
    logger.warn('ingester.no_project_id', { runId });
    return;
  }

  const blockNumber = await schema.nextBlockNumber();
  const stage = _stageFromRun(runData);
  const got = _extractGoTSignals(runData);

  const existing = await db.get('SELECT nonce FROM projects WHERE project_id = ?', projectId);
  const nonce = existing ? Number(existing.nonce) + 1 : 0;

  if (existing) {
    await db.run(
      `UPDATE projects SET nonce=?, block_number=?, updated_at=current_timestamp,
       latest_run_id=?, stage_reached=?, sigma=?, sv=?, ic=?,
       quality_score=?, completeness_score=?, node_count=?, edge_count=?,
       subgraph_count=?, total_cost=?, wall_clock_ms=?
       WHERE project_id=?`,
      nonce, blockNumber, runId, stage,
      got.sigma, got.sv, got.ic, got.quality_score, got.completeness_score,
      got.node_count, got.edge_count, got.subgraph_count, got.total_cost, got.wall_clock_ms,
      projectId,
    );
  } else {
    await db.run(
      `INSERT INTO projects (project_id, nonce, block_number, latest_run_id, stage_reached,
       sigma, sv, ic, quality_score, completeness_score, node_count, edge_count,
       subgraph_count, total_cost, wall_clock_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId, nonce, blockNumber, runId, stage,
      got.sigma, got.sv, got.ic, got.quality_score, got.completeness_score,
      got.node_count, got.edge_count, got.subgraph_count, got.total_cost, got.wall_clock_ms,
    );
  }

  // Insert into runs table
  await db.run(
    `INSERT OR REPLACE INTO runs (run_id, project_id, sigma, sv, ic,
     quality_score, completeness_score, node_count, edge_count, subgraph_count,
     total_cost, wall_clock_ms, total_tokens_in, total_tokens_out, agent_calls,
     stage, tla_invariant_count, tla_states_explored, ts_compile_passed, ts_test_passed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    runId, projectId, got.sigma, got.sv, got.ic,
    got.quality_score, got.completeness_score, got.node_count, got.edge_count, got.subgraph_count,
    got.total_cost, got.wall_clock_ms, got.total_tokens_in, got.total_tokens_out, got.agent_calls,
    stage, got.tla_invariant_count, got.tla_states_explored, got.ts_compile_passed, got.ts_test_passed,
  );

  // Discover artifacts (parallel I/O)
  const runJson = JSON.stringify(runData);
  const runArtifact = {
    artifact_id: merkle.hashContent(Buffer.from(runJson)),
    project_id: projectId, artifact_type: 'run_json',
    path: `runs/${runId}.json`, content_hash: merkle.hashContent(Buffer.from(runJson)),
    size_bytes: runJson.length,
  };

  const fileArtifacts = await _discoverArtifacts(projectId);
  const allArtifacts = [runArtifact, ...fileArtifacts];

  // Batch insert artifacts
  for (const a of allArtifacts) {
    try {
      await db.run(
        `INSERT OR REPLACE INTO artifacts (artifact_id, project_id, artifact_type, path, content_hash, size_bytes, block_number, nonce, metadata)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        a.artifact_id, a.project_id, a.artifact_type, a.path, a.content_hash,
        a.size_bytes, blockNumber, nonce, JSON.stringify(got),
      );
    } catch (err) {
      logger.warn('ingester.artifact_insert', { path: a.path, error: err.message });
    }
  }

  // Merkle tree
  const { root, nodes } = merkle.buildProjectTree(allArtifacts);
  for (const node of nodes) {
    try {
      const childrenList = `[${node.children.map(c => `'${c}'`).join(', ')}]`;
      await db.run(
        `INSERT OR REPLACE INTO merkle_nodes (node_hash, project_id, parent_hash, level, children, block_number)
         VALUES (?, ?, ?, ?, ${childrenList}::TEXT[], ?)`,
        node.nodeHash, projectId, node.parentHash, node.level, blockNumber,
      );
    } catch (err) {
      logger.warn('ingester.merkle_insert', { hash: node.nodeHash, error: err.message });
    }
  }

  await db.run('UPDATE projects SET root_hash = ? WHERE project_id = ?', root, projectId);

  // Embeddings (parallel text reads already done)
  try {
    const embRows = await _generateEmbeddings(projectId, runData, fileArtifacts);
    for (const row of embRows) {
      const vecLiteral = `[${Array.from(row.vector).join(',')}]`;
      await db.run(
        `INSERT OR REPLACE INTO embeddings (embedding_id, artifact_id, project_id, content_type, content_preview, vector, token_count)
         VALUES (?, ?, ?, ?, ?, ${vecLiteral}::FLOAT[1536], ?)`,
        row.embedding_id, row.artifact_id, row.project_id, row.content_type,
        row.content_preview, row.token_count,
      );
    }
    logger.info('ingester.done', { projectId, emb: embRows.length });
  } catch (err) {
    logger.warn('ingester.embeddings_failed', { projectId, error: err.message });
  }

  logger.info('ingester.run_ingested', {
    runId: runId.slice(0, 8), projectId, block: Number(blockNumber), nonce: Number(nonce),
    arts: allArtifacts.length, stage, sigma: got.sigma, sv: got.sv, ic: got.ic,
  });
}

async function ingestAll() {
  await db.init();
  await schema.createTables();

  let files;
  try {
    files = (await fsp.readdir(RUNS_DIR)).filter(f => f.endsWith('.json')).sort();
  } catch {
    logger.warn('ingester.runs_dir_not_found');
    return { projects: 0, artifacts: 0, embeddings: 0, runs: 0 };
  }

  for (const f of files) {
    try { await ingestRun(f.replace('.json', '')); }
    catch (err) { logger.warn('ingester.run_failed', { runId: f, error: err.message }); }
  }

  const pCount = Number((await db.get('SELECT count(*) AS c FROM projects'))?.c || 0);
  const aCount = Number((await db.get('SELECT count(*) AS c FROM artifacts'))?.c || 0);
  const eCount = Number((await db.get('SELECT count(*) AS c FROM embeddings'))?.c || 0);
  const rCount = Number((await db.get('SELECT count(*) AS c FROM runs'))?.c || 0);

  logger.info('ingester.all_done', { files: files.length, projects: pCount, artifacts: aCount, embeddings: eCount, runs: rCount });
  return { projects: pCount, artifacts: aCount, embeddings: eCount, runs: rCount };
}

module.exports = { ingestRun, ingestAll };
