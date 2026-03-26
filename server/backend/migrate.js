#!/usr/bin/env node
'use strict';

/**
 * DuckDB Migration Script — initializes schema and ingests all existing runs.
 *
 * Usage: node server/backend/migrate.js
 * Or:    ./mermaid.sh db-init
 */

const schema = require('./schema');
const ingester = require('./ingester');
const db = require('./db');

async function main() {
  const start = Date.now();
  console.log('\n  DuckDB Migration — Mermate Backend\n');

  console.log('  [1/3] Initializing database and schema...');
  await db.init();
  await schema.createTables();
  console.log('  Schema created: projects, artifacts, merkle_nodes, embeddings');

  console.log('  [2/3] Ingesting existing runs...');
  const { projects, artifacts, embeddings } = await ingester.ingestAll();

  console.log(`  [3/3] Migration complete.`);
  console.log(`\n  Results:`);
  console.log(`    Projects:   ${projects}`);
  console.log(`    Artifacts:  ${artifacts}`);
  console.log(`    Embeddings: ${embeddings}`);
  console.log(`    Database:   ${db.DB_PATH}`);
  console.log(`    Elapsed:    ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  db.close();
}

main().catch(err => {
  console.error(`\n  Migration failed: ${err.message}\n`);
  process.exit(1);
});
