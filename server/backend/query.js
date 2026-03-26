'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const embeddings = require('./embeddings');
const merkle = require('./merkle');
const logger = require('../utils/logger');

// ---- BigInt sanitization ----

function _s(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}
function _sa(rows) { return (rows || []).map(_s); }

// ---- Embedding LRU Cache (max 100 entries, 5-min TTL) ----

const _embCache = new Map();
const EMB_CACHE_MAX = 100;
const EMB_CACHE_TTL = 300_000;

function _embCacheKey(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function _cachedEmbed(text) {
  const key = _embCacheKey(text);
  const cached = _embCache.get(key);
  if (cached && Date.now() - cached.ts < EMB_CACHE_TTL) return cached.result;

  const result = await embeddings.embed(text);

  if (_embCache.size >= EMB_CACHE_MAX) {
    const oldest = _embCache.keys().next().value;
    _embCache.delete(oldest);
  }
  _embCache.set(key, { result, ts: Date.now() });
  return result;
}

// ---- Semantic Search ----

async function searchSimilar(queryText, opts = {}) {
  const { limit = 10, projectFilter, typeFilter } = opts;
  await db.init();

  const { vector } = await _cachedEmbed(queryText);
  const vecLiteral = `[${Array.from(vector).join(',')}]::FLOAT[1536]`;

  let sql = `
    SELECT e.embedding_id, e.project_id, e.content_type, e.content_preview, e.token_count,
           a.artifact_type, a.path, p.stage_reached, p.nonce, p.block_number, p.sigma,
           array_cosine_similarity(e.vector, ${vecLiteral}) AS score
    FROM embeddings e
    LEFT JOIN artifacts a ON e.artifact_id = a.artifact_id
    LEFT JOIN projects p ON e.project_id = p.project_id
    WHERE 1=1
  `;
  const params = [];
  let idx = 1;

  if (projectFilter) { sql += ` AND e.project_id = $${idx}`; params.push(projectFilter); idx++; }
  if (typeFilter) { sql += ` AND e.content_type = $${idx}`; params.push(typeFilter); idx++; }

  sql += ` ORDER BY score DESC LIMIT $${idx}`;
  params.push(limit);

  try {
    return _sa(await db.all(sql, ...params)).map(r => ({
      project: r.project_id, contentType: r.content_type, preview: r.content_preview,
      score: r.score, artifactType: r.artifact_type, path: r.path,
      stage: r.stage_reached, nonce: r.nonce, blockNumber: r.block_number, sigma: r.sigma,
    }));
  } catch (err) {
    logger.warn('query.search_error', { error: err.message });
    return [];
  }
}

// ---- Project Queries (JOIN-based, no correlated subqueries) ----

async function listProjects(opts = {}) {
  await db.init();
  const { limit = 50, offset = 0, sortBy = 'updated_at' } = opts;
  const validSorts = ['updated_at', 'created_at', 'block_number', 'nonce', 'project_id', 'sigma'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'updated_at';

  const rows = await db.all(`
    SELECT p.*,
      COALESCE(ac.cnt, 0) AS artifact_count,
      COALESCE(ec.cnt, 0) AS embedding_count,
      COALESCE(rc.cnt, 0) AS run_count
    FROM projects p
    LEFT JOIN (SELECT project_id, count(*) AS cnt FROM artifacts GROUP BY project_id) ac ON ac.project_id = p.project_id
    LEFT JOIN (SELECT project_id, count(*) AS cnt FROM embeddings GROUP BY project_id) ec ON ec.project_id = p.project_id
    LEFT JOIN (SELECT project_id, count(*) AS cnt FROM runs GROUP BY project_id) rc ON rc.project_id = p.project_id
    ORDER BY p.${sort} DESC
    LIMIT ? OFFSET ?
  `, limit, offset);

  return _sa(rows);
}

async function getProject(projectId) {
  await db.init();
  const project = _s(await db.get('SELECT * FROM projects WHERE project_id = ?', projectId));
  if (!project) return null;

  const [artifacts, merkleNodes, runHistory] = await Promise.all([
    db.all('SELECT * FROM artifacts WHERE project_id = ? ORDER BY artifact_type', projectId).then(_sa),
    db.all('SELECT * FROM merkle_nodes WHERE project_id = ? ORDER BY level DESC', projectId).then(_sa),
    db.all('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC', projectId).then(_sa),
  ]);

  return { ...project, artifacts, merkleNodes, runHistory };
}

async function getProjectHistory(projectId) {
  await db.init();
  const artifacts = _sa(await db.all(
    'SELECT artifact_id, artifact_type, path, block_number, nonce, created_at FROM artifacts WHERE project_id = ? ORDER BY block_number DESC, artifact_type',
    projectId,
  ));

  const byNonce = new Map();
  for (const a of artifacts) {
    const n = Number(a.nonce);
    if (!byNonce.has(n)) byNonce.set(n, []);
    byNonce.get(n).push(a);
  }

  return Array.from(byNonce.entries()).map(([nonce, arts]) => ({
    nonce, blockNumber: arts[0]?.block_number, artifacts: arts,
  }));
}

// ---- GoT Scoreboard ----

async function getGoTScoreboard(limit = 20) {
  await db.init();
  return _sa(await db.all(`
    SELECT project_id, sigma, sv, ic, quality_score, completeness_score,
           node_count, edge_count, subgraph_count, stage_reached,
           nonce, block_number, total_cost, wall_clock_ms
    FROM projects
    WHERE sigma > 0
    ORDER BY sigma DESC, node_count DESC
    LIMIT ?
  `, limit));
}

// ---- Pipeline Status ----

async function getProjectPipelineStatus(projectId) {
  await db.init();
  const project = _s(await db.get('SELECT * FROM projects WHERE project_id = ?', projectId));
  if (!project) return null;

  const stages = _sa(await db.all(
    `SELECT stage, sigma, sv, ic, quality_score, completeness_score,
            node_count, edge_count, tla_invariant_count, tla_states_explored,
            ts_compile_passed, ts_test_passed, wall_clock_ms, total_cost
     FROM runs WHERE project_id = ? ORDER BY created_at DESC`,
    projectId,
  ));

  const PIPELINE = ['idea', 'mmd', 'tla', 'ts'];
  const currentIdx = PIPELINE.indexOf(project.stage_reached);
  const nextStage = currentIdx < PIPELINE.length - 1 ? PIPELINE[currentIdx + 1] : null;

  const stageMap = {};
  for (const s of stages) {
    if (!stageMap[s.stage]) stageMap[s.stage] = s;
  }

  return {
    project_id: project.project_id,
    current_stage: project.stage_reached,
    next_recommended: nextStage,
    sigma: project.sigma,
    sv: project.sv,
    ic: project.ic,
    nonce: project.nonce,
    block_number: project.block_number,
    stages: stageMap,
    pipeline_complete: project.stage_reached === 'ts',
  };
}

// ---- Integrity ----

async function verifyIntegrity(projectId) {
  await db.init();
  const project = await db.get('SELECT root_hash FROM projects WHERE project_id = ?', projectId);
  if (!project) return { valid: false, error: 'project not found' };

  const artifacts = await db.all('SELECT artifact_id, artifact_type, content_hash FROM artifacts WHERE project_id = ?', projectId);
  const recomputed = merkle.computeRootHash(artifacts);

  return {
    valid: recomputed === project.root_hash,
    storedHash: project.root_hash,
    computedHash: recomputed,
    artifactCount: artifacts.length,
  };
}

async function getArtifact(artifactId) {
  await db.init();
  return _s(await db.get('SELECT * FROM artifacts WHERE artifact_id = ?', artifactId));
}

module.exports = {
  searchSimilar, listProjects, getProject, getProjectHistory,
  getGoTScoreboard, getProjectPipelineStatus,
  verifyIntegrity, getArtifact,
};
