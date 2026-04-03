'use strict';

const { Router } = require('express');

const router = Router();

function _normalizeOpenclawBase() {
  const raw = (process.env.OPENCLAW_URL || process.env.OPSEEQ_URL || 'http://localhost:9090').replace(/\/+$/, '');
  // Management endpoints live at the service root, not under /v1.
  return raw.endsWith('/v1') ? raw.slice(0, -3) : raw;
}

const OPENCLAW_URL = _normalizeOpenclawBase();

async function _proxyJson(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${OPENCLAW_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({
    error: `${path} returned ${response.status} without JSON`,
  }));

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function _respond(res, path, options) {
  try {
    const result = await _proxyJson(path, options);
    const payload =
      result.payload && typeof result.payload === 'object'
        ? { baseUrl: OPENCLAW_URL, ...result.payload }
        : { baseUrl: OPENCLAW_URL, data: result.payload };
    res.status(result.status).json(payload);
  } catch (error) {
    res.status(502).json({
      success: false,
      baseUrl: OPENCLAW_URL,
      error: 'openclaw_proxy_unreachable',
      details: error.message,
    });
  }
}

router.get('/openclaw/status', async (_req, res) => {
  await _respond(res, '/api/status');
});

router.get('/openclaw/connectivity', async (_req, res) => {
  await _respond(res, '/api/connectivity');
});

router.post('/openclaw/connectivity/probe', async (req, res) => {
  await _respond(res, '/api/connectivity/probe', {
    method: 'POST',
    body: req.body || {},
  });
});

router.post('/openclaw/chat', async (req, res) => {
  await _respond(res, '/api/chat', {
    method: 'POST',
    body: req.body || {},
  });
});

router.get('/openclaw/architect/status', async (_req, res) => {
  await _respond(res, '/api/architect/status');
});

router.post('/openclaw/architect/pipeline', async (req, res) => {
  await _respond(res, '/api/architect/pipeline', {
    method: 'POST',
    body: req.body || {},
  });
});

router.post('/openclaw/builder/scaffold', async (req, res) => {
  await _respond(res, '/api/builder/scaffold', {
    method: 'POST',
    body: req.body || {},
  });
});

module.exports = router;
