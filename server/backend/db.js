'use strict';

const path = require('node:path');
const duckdb = require('duckdb');
const logger = require('../utils/logger');

const DB_PATH = path.resolve(__dirname, 'mermate.duckdb');

let _db = null;
let _conn = null;
let _ready = false;
let _initPromise = null;

function _run(sql, ...params) {
  return new Promise((resolve, reject) => {
    _conn.run(sql, ...params, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

function _all(sql, ...params) {
  return new Promise((resolve, reject) => {
    _conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
}

function _get(sql, ...params) {
  return new Promise((resolve, reject) => {
    _conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err); else resolve(rows?.[0] || null);
    });
  });
}

async function init() {
  if (_ready) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    _db = new duckdb.Database(DB_PATH);
    _conn = _db.connect();

    try {
      await _run("INSTALL 'vss'");
    } catch { /* already installed or unavailable */ }
    try {
      await _run("LOAD 'vss'");
    } catch { /* already loaded or unavailable */ }

    _ready = true;
    logger.info('duckdb.init', { path: DB_PATH });
  })();

  return _initPromise;
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
    _conn = null;
    _ready = false;
    _initPromise = null;
  }
}

module.exports = { init, close, run: _run, all: _all, get: _get, DB_PATH };
