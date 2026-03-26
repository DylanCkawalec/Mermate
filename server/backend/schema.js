'use strict';

const db = require('./db');

const DDL = [
  `CREATE SEQUENCE IF NOT EXISTS block_seq START 1`,

  `CREATE TABLE IF NOT EXISTS projects (
    project_id        TEXT PRIMARY KEY,
    root_hash         TEXT,
    nonce             INTEGER DEFAULT 0,
    block_number      INTEGER DEFAULT 0,
    created_at        TIMESTAMP DEFAULT current_timestamp,
    updated_at        TIMESTAMP DEFAULT current_timestamp,
    latest_run_id     TEXT,
    stage_reached     TEXT DEFAULT 'idea',
    status            TEXT DEFAULT 'active',
    sigma             FLOAT DEFAULT 0,
    sv                INTEGER DEFAULT 0,
    ic                FLOAT DEFAULT 0,
    quality_score     FLOAT DEFAULT 0,
    completeness_score FLOAT DEFAULT 0,
    node_count        INTEGER DEFAULT 0,
    edge_count        INTEGER DEFAULT 0,
    subgraph_count    INTEGER DEFAULT 0,
    total_cost        FLOAT DEFAULT 0,
    wall_clock_ms     INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id   TEXT PRIMARY KEY,
    project_id    TEXT,
    artifact_type TEXT,
    path          TEXT,
    content_hash  TEXT,
    size_bytes    INTEGER DEFAULT 0,
    block_number  INTEGER DEFAULT 0,
    nonce         INTEGER DEFAULT 0,
    created_at    TIMESTAMP DEFAULT current_timestamp,
    metadata      JSON
  )`,

  `CREATE TABLE IF NOT EXISTS merkle_nodes (
    node_hash    TEXT PRIMARY KEY,
    project_id   TEXT,
    parent_hash  TEXT,
    level        INTEGER DEFAULT 0,
    children     TEXT[],
    block_number INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS embeddings (
    embedding_id  TEXT PRIMARY KEY,
    artifact_id   TEXT,
    project_id    TEXT,
    content_type  TEXT,
    content_preview TEXT,
    vector        FLOAT[1536],
    token_count   INTEGER DEFAULT 0,
    created_at    TIMESTAMP DEFAULT current_timestamp
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    run_id              TEXT PRIMARY KEY,
    project_id          TEXT,
    sigma               FLOAT DEFAULT 0,
    sv                  INTEGER DEFAULT 0,
    ic                  FLOAT DEFAULT 0,
    quality_score       FLOAT DEFAULT 0,
    completeness_score  FLOAT DEFAULT 0,
    node_count          INTEGER DEFAULT 0,
    edge_count          INTEGER DEFAULT 0,
    subgraph_count      INTEGER DEFAULT 0,
    total_cost          FLOAT DEFAULT 0,
    wall_clock_ms       INTEGER DEFAULT 0,
    total_tokens_in     INTEGER DEFAULT 0,
    total_tokens_out    INTEGER DEFAULT 0,
    agent_calls         INTEGER DEFAULT 0,
    stage               TEXT DEFAULT 'idea',
    tla_invariant_count INTEGER DEFAULT 0,
    tla_states_explored INTEGER DEFAULT 0,
    ts_compile_passed   BOOLEAN DEFAULT false,
    ts_test_passed      BOOLEAN DEFAULT false,
    created_at          TIMESTAMP DEFAULT current_timestamp
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts (artifact_type)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_project_block ON artifacts (project_id, block_number)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_project_nonce ON artifacts (project_id, nonce)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings (content_type)`,
  `CREATE INDEX IF NOT EXISTS idx_merkle_project ON merkle_nodes (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_merkle_project_level ON merkle_nodes (project_id, level)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects (stage_reached)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_sigma ON projects (sigma)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_sigma ON runs (sigma)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_stage ON runs (stage)`,
];

async function createTables() {
  await db.init();
  for (const sql of DDL) {
    await db.run(sql);
  }

  for (const sql of INDEXES) {
    try { await db.run(sql); } catch { /* may already exist */ }
  }

  try {
    await db.run(`CREATE INDEX emb_vss ON embeddings USING HNSW (vector) WITH (metric = 'cosine')`);
  } catch { /* VSS index may already exist or vss extension unavailable */ }
}

async function nextBlockNumber() {
  const row = await db.get(`SELECT nextval('block_seq') AS bn`);
  return Number(row?.bn || 1);
}

module.exports = { createTables, nextBlockNumber };
