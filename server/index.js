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
  const server = app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
    console.log(`\n  Mermaid-GPT running at http://localhost:${PORT}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('server.port_in_use', { port: PORT });
      console.error(`\n  Error: port ${PORT} is already in use.\n  Run: kill $(lsof -ti :${PORT}) && ./mermaid.sh start\n`);
    } else {
      logger.error('server.error', { error: err.message });
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
}

module.exports = app;
