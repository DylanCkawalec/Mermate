'use strict';

// Load .env file if present (lightweight, no dotenv dependency)
// Two-pass: first load raw values, then resolve {VAR} references
const _fs = require('node:fs');
const _envPath = require('node:path').resolve(__dirname, '..', '.env');
try {
  for (const line of _fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  // Second pass: resolve {VAR} references in all env values
  for (const [key, val] of Object.entries(process.env)) {
    if (val && val.includes('{') && val.includes('}')) {
      const resolved = val.replace(/\{(\w+)\}/g, (_, ref) => process.env[ref] || `{${ref}}`);
      if (resolved !== val) process.env[key] = resolved;
    }
  }
} catch { /* .env is optional */ }

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const logger = require('./utils/logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3333', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Static files: frontend (no-cache for JS/CSS so code changes take effect immediately)
app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Static files: compiled diagram outputs
app.use('/flows', express.static(path.join(PROJECT_ROOT, 'flows')));

// Static files: archived sources (read-only serving)
app.use('/archs', express.static(path.join(PROJECT_ROOT, 'archs')));

// Static files: run JSON lineage (read-only)
app.use('/runs', express.static(path.join(PROJECT_ROOT, 'runs'), {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/json');
  },
}));

// Frontend vendor modules
app.use('/vendor/three', express.static(path.join(PROJECT_ROOT, 'node_modules', 'three')));

// Initialize foundation layer (read-only metadata + controller config)
const gotConfig = require('./services/got-config');
const roleRegistry = require('./services/role-registry');

// Eagerly load so any env parse errors surface at startup, not at first request
gotConfig.getConfig();
roleRegistry.getRoles();

// API routes
const renderRouter = require('./routes/render');
const agentRouter = require('./routes/agent');
const transcribeRouter = require('./routes/transcribe');
app.use('/api', renderRouter);
app.use('/api', agentRouter);
app.use('/api', transcribeRouter);

// Run retention cleanup on startup (non-blocking)
const runTracker = require('./services/run-tracker');
runTracker.cleanup().catch(() => {});

// Rate-master metrics endpoint
const rmBridge = require('./services/rate-master-bridge');
app.get('/api/rate-master/metrics', (_req, res) => {
  const metrics = rmBridge.getMetrics();
  if (!metrics) return res.json({ success: true, available: false, message: 'rate-master not initialized' });
  return res.json({ success: true, available: true, metrics });
});

// Start server only when run directly (not imported by tests)
if (require.main === module) {
  const server = http.createServer(app);

  server.once('listening', () => {
    logger.info('server.started', { port: PORT });
    console.log(`\n  Mermaid-GPT running at http://localhost:${PORT}\n`);
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('server.port_in_use', { port: PORT });
      console.error(`\n  Error: port ${PORT} is already in use.\n  Run: kill $(lsof -ti :${PORT}) && ./mermaid.sh start\n`);
    } else {
      logger.error('server.error', { error: err.message });
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  server.listen(PORT);

  process.on('SIGTERM', () => { rmBridge.destroy(); server.close(() => process.exit(0)); });
  process.on('SIGINT',  () => { rmBridge.destroy(); server.close(() => process.exit(0)); });
}

module.exports = app;
