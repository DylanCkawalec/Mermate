'use strict';

const express = require('express');
const path = require('node:path');
const logger = require('./utils/logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3333', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Static files: frontend
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// Static files: compiled diagram outputs
app.use('/flows', express.static(path.join(PROJECT_ROOT, 'flows')));

// Static files: archived sources (read-only serving)
app.use('/archs', express.static(path.join(PROJECT_ROOT, 'archs')));

// API routes
const renderRouter = require('./routes/render');
app.use('/api', renderRouter);

// Start server only when run directly (not imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
    console.log(`\n  Mermaid-GPT running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
