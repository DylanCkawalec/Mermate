'use strict';

/**
 * Lightweight structured JSON logger for Mermaid-GPT.
 * Writes to stdout. Levels: info, warn, error.
 */

function _emit(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const _debugEnabled = process.env.DEBUG === '1' || process.env.LOG_LEVEL === 'debug';

const logger = {
  debug(event, data) { if (_debugEnabled) _emit('debug', event, data); },
  info(event, data)  { _emit('info', event, data); },
  warn(event, data)  { _emit('warn', event, data); },
  error(event, data) { _emit('error', event, data); },
};

module.exports = logger;
