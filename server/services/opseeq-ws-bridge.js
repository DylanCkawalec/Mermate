'use strict';

/**
 * Opseeq WebSocket bridge — low-latency stage reporting.
 *
 * Maintains a single persistent WebSocket connection from Mermate to
 * Opseeq's `/api/mermate/ws` endpoint. When the connection is healthy,
 * `reportStage` (in opseeq-bridge.js) prefers WS over HTTP so stage events
 * reuse one connection instead of paying a TCP/TLS handshake per event.
 *
 * Design rules:
 *   - Fire-and-forget: failures NEVER block the pipeline.
 *   - Graceful degradation: if `globalThis.WebSocket` is missing (Node 18,
 *     or `--no-experimental-websocket` flag), the bridge stays disabled
 *     and reportStage falls through to the HTTP path.
 *   - Reconnect with capped exponential backoff (1s → 2s → 5s → 15s → 30s).
 *   - Heartbeat: ping every 15s, drop the connection if no pong arrives
 *     within the next 15s, since a hung socket reports no error on its own.
 *   - Auth: send a `hello` frame with `OPSEEQ_WS_TOKEN` once the socket is
 *     open. The server may reject; we treat that as "WS unavailable" and
 *     stop trying for OPSEEQ_WS_REJECT_BACKOFF_MS (default 5 minutes).
 *
 * Public API:
 *   - sendStage(runId, event) → boolean (true if dispatched over WS)
 *   - status() → { enabled, connected, lastError, queueDepth }
 *   - close() — graceful shutdown (called from server SIGTERM handler).
 */

const logger = require('../utils/logger');

const OPSEEQ_HTTP_URL = (process.env.OPSEEQ_URL || 'http://localhost:9090')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');

// Derive default WS URL from HTTP URL unless explicitly overridden.
function _deriveDefaultWsUrl(httpUrl) {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/api/mermate/ws';
    return u.toString();
  } catch {
    return null;
  }
}

const OPSEEQ_WS_URL = process.env.OPSEEQ_WS_URL || _deriveDefaultWsUrl(OPSEEQ_HTTP_URL);
const OPSEEQ_WS_TOKEN = process.env.OPSEEQ_WS_TOKEN || '';
const WS_ENABLED = (process.env.OPSEEQ_WS_ENABLED || '').toLowerCase() === 'true'
  && typeof globalThis.WebSocket === 'function'
  && !!OPSEEQ_WS_URL;

const HEARTBEAT_MS = parseInt(process.env.OPSEEQ_WS_HEARTBEAT_MS || '15000', 10);
const HEARTBEAT_TIMEOUT_MS = parseInt(process.env.OPSEEQ_WS_HEARTBEAT_TIMEOUT_MS || '15000', 10);
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const REJECT_BACKOFF_MS = parseInt(process.env.OPSEEQ_WS_REJECT_BACKOFF_MS || '300000', 10);
const QUEUE_LIMIT = parseInt(process.env.OPSEEQ_WS_QUEUE_LIMIT || '500', 10);

let _ws = null;
let _connected = false;
let _connecting = false;
let _backoffIdx = 0;
let _reconnectTimer = null;
let _heartbeatTimer = null;
let _heartbeatTimeoutTimer = null;
let _rejectUntil = 0;
let _lastError = null;
const _queue = []; // pending messages while disconnected

function _isRejected() {
  return Date.now() < _rejectUntil;
}

function _enqueue(payload) {
  if (_queue.length >= QUEUE_LIMIT) {
    // Drop the oldest event to keep the queue bounded. Backpressure here
    // means Opseeq is unreachable AND the pipeline is producing events
    // faster than the HTTP fallback can flush — extremely rare.
    _queue.shift();
  }
  _queue.push(payload);
}

function _flushQueue() {
  if (!_connected || !_ws) return;
  while (_queue.length) {
    const next = _queue.shift();
    try {
      _ws.send(JSON.stringify(next));
    } catch (err) {
      _lastError = err.message;
      _enqueue(next); // put it back at the front
      _queue.unshift(next);
      break;
    }
  }
}

function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_heartbeatTimeoutTimer) { clearTimeout(_heartbeatTimeoutTimer); _heartbeatTimeoutTimer = null; }
}

function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (!_ws || _ws.readyState !== 1 /* OPEN */) return;
    try {
      _ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      // If no pong arrives within the timeout, force a reconnect.
      if (_heartbeatTimeoutTimer) clearTimeout(_heartbeatTimeoutTimer);
      _heartbeatTimeoutTimer = setTimeout(() => {
        logger.warn('opseeq_ws.heartbeat_timeout', { url: OPSEEQ_WS_URL });
        _forceReconnect();
      }, HEARTBEAT_TIMEOUT_MS);
    } catch (err) {
      _lastError = err.message;
    }
  }, HEARTBEAT_MS);
}

function _forceReconnect() {
  try { _ws?.close(); } catch {}
  _ws = null;
  _connected = false;
  _scheduleReconnect();
}

function _scheduleReconnect() {
  if (_reconnectTimer || _connecting) return;
  if (_isRejected()) {
    logger.debug('opseeq_ws.reject_backoff_active', { remainingMs: _rejectUntil - Date.now() });
    return;
  }
  const delay = RECONNECT_BACKOFF_MS[Math.min(_backoffIdx, RECONNECT_BACKOFF_MS.length - 1)];
  _backoffIdx += 1;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _connect();
  }, delay);
}

function _connect() {
  if (!WS_ENABLED || _connecting || _connected) return;
  if (_isRejected()) return;
  _connecting = true;

  let ws;
  try {
    ws = new globalThis.WebSocket(OPSEEQ_WS_URL);
  } catch (err) {
    _connecting = false;
    _lastError = err.message;
    logger.warn('opseeq_ws.construct_failed', { error: err.message });
    _scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    _connecting = false;
    _connected = true;
    _backoffIdx = 0;
    _lastError = null;

    // Auth handshake — Opseeq may close the socket if it dislikes the token.
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        client: 'mermate',
        token: OPSEEQ_WS_TOKEN || null,
        version: 1,
      }));
    } catch (err) {
      _lastError = err.message;
    }

    _startHeartbeat();
    _flushQueue();
    logger.info('opseeq_ws.connected', { url: OPSEEQ_WS_URL });
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg?.type === 'pong') {
      if (_heartbeatTimeoutTimer) {
        clearTimeout(_heartbeatTimeoutTimer);
        _heartbeatTimeoutTimer = null;
      }
    } else if (msg?.type === 'auth_rejected') {
      _rejectUntil = Date.now() + REJECT_BACKOFF_MS;
      _lastError = `auth rejected: ${msg.reason || 'unknown'}`;
      logger.warn('opseeq_ws.auth_rejected', { reason: msg.reason, backoffMs: REJECT_BACKOFF_MS });
      try { ws.close(); } catch {}
    }
  });

  ws.addEventListener('close', (event) => {
    _connected = false;
    _connecting = false;
    _stopHeartbeat();
    _ws = null;
    logger.debug('opseeq_ws.closed', { code: event?.code, reason: event?.reason || '' });
    _scheduleReconnect();
  });

  ws.addEventListener('error', (event) => {
    _lastError = event?.message || 'ws error';
    logger.debug('opseeq_ws.error', { error: _lastError });
    // Don't schedule here — close handler will fire next.
  });

  _ws = ws;
}

/**
 * Attempt to send a stage event over WS. Returns true if dispatched
 * (or queued for flush on next reconnect), false if the WS bridge is
 * disabled and the caller should use the HTTP fallback.
 *
 * Even when disconnected, we queue up to QUEUE_LIMIT events so a brief
 * reconnect window doesn't lose stage data — the HTTP bridge already
 * persists events to disk via trace-store, so duplication is safe.
 */
function sendStage(runId, event) {
  if (!WS_ENABLED) return false;
  if (_isRejected()) return false;

  const payload = { type: 'stage', run_id: runId, ...event };

  if (_connected && _ws && _ws.readyState === 1 /* OPEN */) {
    try {
      _ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      _lastError = err.message;
      _enqueue(payload);
      _forceReconnect();
      return true; // we've taken responsibility for the event
    }
  }

  _enqueue(payload);
  if (!_connecting && !_reconnectTimer) _connect();
  return true;
}

function status() {
  return {
    enabled: WS_ENABLED,
    connected: _connected,
    connecting: _connecting,
    rejected: _isRejected(),
    rejectUntil: _rejectUntil || null,
    lastError: _lastError,
    queueDepth: _queue.length,
    url: OPSEEQ_WS_URL || null,
  };
}

function close() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _stopHeartbeat();
  try { _ws?.close(); } catch {}
  _ws = null;
  _connected = false;
  _connecting = false;
}

// Kick off the first connection attempt at module load if enabled.
if (WS_ENABLED) {
  // Small delay so we don't race the HTTP server boot.
  setTimeout(_connect, 250);
} else {
  // Surface the reason once at startup so operators know whether to expect
  // low-latency telemetry. This is intentionally a single info-level log,
  // not a warning, because HTTP fallback is still functional.
  logger.info('opseeq_ws.disabled', {
    enabledFlag: process.env.OPSEEQ_WS_ENABLED || 'unset',
    websocket_global: typeof globalThis.WebSocket,
    url: OPSEEQ_WS_URL || null,
  });
}

module.exports = { sendStage, status, close };
