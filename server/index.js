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
const agentLoader = require('./services/agent-loader');

// Eagerly load so any env parse errors surface at startup, not at first request
gotConfig.getConfig();
roleRegistry.getRoles();
agentLoader.loadAgents().catch(() => {});

// API routes
const renderRouter = require('./routes/render');
const agentRouter = require('./routes/agent');
const transcribeRouter = require('./routes/transcribe');
const tlaRouter = require('./routes/tla');
const tsRouter = require('./routes/ts');
const tsxRouter = require('./routes/tsx');
const searchRouter = require('./routes/search');
const openclawRouter = require('./routes/openclaw');
const bundleRouter = require('./routes/bundle');
const guideRouter = require('./routes/guide');
const artifactsRouter = require('./routes/artifacts');
const rustRouter = require('./routes/rust');
const traceRouter = require('./routes/trace');
const runsRouter = require('./routes/runs');
const speculaRouter = require('./routes/specula');
app.use('/api', renderRouter);
app.use('/api', agentRouter);
app.use('/api', transcribeRouter);
app.use('/api', tlaRouter);
app.use('/api', tsRouter);
app.use('/api', tsxRouter);
app.use('/api', searchRouter);
app.use('/api', openclawRouter);
app.use('/api', bundleRouter);
app.use('/api', guideRouter);
app.use('/api', artifactsRouter);
app.use('/api', rustRouter);
app.use('/api', traceRouter);
app.use('/api', runsRouter);
app.use('/api', speculaRouter);

// Run retention cleanup on startup (non-blocking)
const runTracker = require('./services/run-tracker');
const runExporter = require('./services/run-exporter');
runTracker.cleanup().catch(() => {});
runExporter.cleanup().catch(() => {});

// ---- Health endpoint (boot verification) -----------------------------------
// Returns comprehensive server health: provider availability, model config,
// and critical service status. Used by mermaid.sh to verify boot readiness.
app.get('/api/health', async (_req, res) => {
  try {
    const inferenceProvider = require('./services/inference-provider');
    const providers = await inferenceProvider.checkProviders();
    const maxAvailable = inferenceProvider.isMaxAvailable();
    const roles = roleRegistry.getRoles();
    const activeRoles = roles.filter(r => r.enabled).length;

    const health = {
      success: true,
      status: 'ok',
      // Payload-contract version: bump when the canonical envelope shape
      // (artifacts / progressionUpdate) changes incompatibly. The frontend
      // boot sequence reads this to detect contract mismatches.
      schema_version: 1,
      uptime: process.uptime(),
      port: PORT,
      models: {
        orchestrator: process.env.MERMATE_ORCHESTRATOR_MODEL || 'gpt-5.6-sol',
        worker: process.env.MERMATE_WORKER_MODEL || 'gpt-5.6-terra',
        fast: process.env.MERMATE_FAST_STRUCTURED_MODEL || 'gpt-5.6-luna',
      },
      providers: {
        premium: providers.premium,
        ollama: providers.ollama,
        enhancer: providers.enhancer,
        maxAvailable,
      },
      agents: {
        total: roles.length,
        active: activeRoles,
      },
      got: {
        enabled: gotConfig.getConfig()?.controllerEnabled || false,
        mode: gotConfig.getConfig()?.mode || 'unknown',
      },
    };

    const anyProvider = providers.premium || providers.ollama || providers.enhancer;
    health.status = anyProvider ? 'ok' : 'degraded';

    // Opseeq gateway health — AI features depend on this being ready
    try {
      const opseeq = require('./services/opseeq-bridge');
      const opseeqHealth = await opseeq.health();
      health.opseeq = {
        url: opseeq.getUrl(),
        healthy: opseeqHealth.healthy,
        warming: !opseeqHealth.healthy && _opseeqContainerStarted,
        version: opseeqHealth.version || null,
        providers: opseeqHealth.providers || null,
      };
      if (!opseeqHealth.healthy && !anyProvider) {
        health.status = 'degraded';
      }
    } catch {
      health.opseeq = { url: null, healthy: false, warming: false };
    }

    return res.status(200).json(health);
  } catch (err) {
    logger.error('health.error', { error: err.message });
    return res.status(503).json({
      success: false,
      status: 'error',
      error: err.message,
    });
  }
});

// Agent definitions endpoint
app.get('/api/agents', async (_req, res) => {
  const agents = agentLoader.getAllAgents();
  res.json({ success: true, count: agents.length, agents: agents.map(a => ({ name: a.agent, role: a.role, stage: a.stage, priority: a.priority, domain: a.domain })) });
});

// Rate-master metrics endpoint
const rmBridge = require('./services/rate-master-bridge');
app.get('/api/rate-master/metrics', (_req, res) => {
  const metrics = rmBridge.getMetrics();
  if (!metrics) return res.json({ success: true, available: false, message: 'rate-master not initialized' });
  return res.json({ success: true, available: true, metrics });
});

// ---- Opseeq gateway lifecycle (browser-window management) -----------------
// The frontend pings /api/opseeq/heartbeat while the tab is open.
// On first heartbeat, Mermate ensures the Opseeq Docker container is running.
// When no heartbeat arrives for >60s, Mermate stops the container.
const opseeqBridge = require('./services/opseeq-bridge');
const { execSync } = require('child_process');
let _opseeqLastHeartbeat = Date.now();
let _opseeqContainerStarted = false;
const _OPSEEQ_HEARTBEAT_TIMEOUT_MS = 60_000;
const _OPSEEQ_DOCKER_COMPOSE = process.env.OPSEEQ_DOCKER_COMPOSE
  || '../opseeq/docker-compose.yml';

function _opseeqExec(cmd) {
  try {
    return execSync(cmd, { timeout: 15000, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function _opseeqEnsureRunning() {
  if (_opseeqContainerStarted) return true;
  const status = _opseeqExec(`docker inspect -f '{{.State.Running}}' opseeq 2>/dev/null`);
  if (status === 'true') {
    _opseeqContainerStarted = true;
    return true;
  }
  const composeFile = path.resolve(__dirname, '..', _OPSEEQ_DOCKER_COMPOSE);
  _opseeqExec(`docker compose -f ${composeFile} up -d opseeq 2>/dev/null`);
  _opseeqContainerStarted = true;
  logger.info('opseeq.lifecycle.start', { composeFile });
  return true;
}

// Boot-time health gate: poll Opseeq until healthy or timeout.
// This ensures the first user request gets a ready gateway, not a cold-start.
async function _opseeqBootGate(maxWaitMs = 30_000, intervalMs = 2000) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const h = await opseeqBridge.health();
    if (h.healthy) {
      logger.info('opseeq.boot_gate.ready', { attempts: attempt, ms: Date.now() - (deadline - maxWaitMs) });
      return true;
    }
    logger.info('opseeq.boot_gate.poll', { attempt, error: h.error });
    await new Promise(r => setTimeout(r, intervalMs));
  }
  logger.warn('opseeq.boot_gate.timeout', { attempts: attempt, maxWaitMs });
  return false;
}

function _opseeqStopIfIdle() {
  const idleMs = Date.now() - _opseeqLastHeartbeat;
  if (idleMs < _OPSEEQ_HEARTBEAT_TIMEOUT_MS) return;
  if (!_opseeqContainerStarted) return;
  const composeFile = path.resolve(__dirname, '..', _OPSEEQ_DOCKER_COMPOSE);
  _opseeqExec(`docker compose -f ${composeFile} stop opseeq 2>/dev/null`);
  _opseeqContainerStarted = false;
  logger.info('opseeq.lifecycle.stop', { idleMs, reason: 'heartbeat_timeout' });
}

// Check every 15s for idle timeout
setInterval(_opseeqStopIfIdle, 15_000).unref?.();

app.post('/api/opseeq/heartbeat', (_req, res) => {
  _opseeqLastHeartbeat = Date.now();
  _opseeqEnsureRunning();
  res.json({ success: true, ts: _opseeqLastHeartbeat });
});

app.get('/api/opseeq/status', async (_req, res) => {
  const h = await opseeqBridge.health();
  res.json({
    success: true,
    healthy: h.healthy,
    url: opseeqBridge.getUrl(),
    containerStarted: _opseeqContainerStarted,
    lastHeartbeat: _opseeqLastHeartbeat,
    idleMs: Date.now() - _opseeqLastHeartbeat,
    ...h,
  });
});

app.post('/api/opseeq/start', (_req, res) => {
  _opseeqEnsureRunning();
  res.json({ success: true, message: 'Opseeq gateway start requested' });
});

app.post('/api/opseeq/stop', (_req, res) => {
  const composeFile = path.resolve(__dirname, '..', _OPSEEQ_DOCKER_COMPOSE);
  _opseeqExec(`docker compose -f ${composeFile} stop opseeq 2>/dev/null`);
  _opseeqContainerStarted = false;
  logger.info('opseeq.lifecycle.stop', { reason: 'manual' });
  res.json({ success: true, message: 'Opseeq gateway stopped' });
});

// Meta-cognition gateway endpoints + CRON
const metaBridge = require('./services/meta-gateway-bridge');
app.get('/api/meta/health', async (_req, res) => {
  const available = await metaBridge.isAvailable();
  res.json({ success: true, available });
});
app.post('/api/meta/refine', async (req, res) => {
  const { stage, msg, seed_prompt } = req.body || {};
  const result = await metaBridge.refinePrompt(stage || 'unknown', msg || '', seed_prompt || '');
  res.json({ success: true, ...result });
});
app.post('/api/meta/audit', async (req, res) => {
  const result = await metaBridge.auditRun(req.body?.run_id || '');
  res.json({ success: true, audit: result });
});
app.post('/api/meta/cron', async (_req, res) => {
  const result = await metaBridge.cronOptimize();
  res.json({ success: true, ...result });
});

// Start server only when run directly (not imported by tests)
if (require.main === module) {
  const server = http.createServer(app);

  server.once('listening', async () => {
    logger.info('server.started', { port: PORT });
    console.log(`\n  Mermaid-GPT running at http://localhost:${PORT}\n`);
    // TLA+ toolbox warm-up: cache Java version + jar presence now so the
    // first /api/render/tla request skips the probe entirely.
    try { require('./services/tla-validator').warmUp(); } catch { /* non-fatal */ }
    // Specula engine warm-up: pre-probe the pinned submodule and cache skill
    // prompts so boot-time discovery never blocks a render request.
    try { require('./services/specula-engine-bridge').warmUp(); } catch { /* non-fatal */ }
    // Opseeq gateway: ensure container is running, then poll until healthy.
    // This blocks boot briefly so the first user request gets a ready gateway.
    // If the container isn't running yet, the heartbeat will start it — but we
    // also proactively start it here for a warm boot.
    try {
      _opseeqEnsureRunning();
      const ready = await _opseeqBootGate(30_000, 2000);
      if (ready) {
        const h = await opseeqBridge.health();
        logger.info('opseeq.boot_ready', { url: opseeqBridge.getUrl(), version: h.version });
      } else {
        logger.warn('opseeq.boot_unhealthy', { url: opseeqBridge.getUrl(), reason: 'boot_gate_timeout' });
      }
    } catch { /* non-fatal — gateway may start later via heartbeat */ }
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

  // Meta-cognition CRON: audit runs + optimize prompts every 5 minutes
  const META_CRON_MS = parseInt(process.env.META_CRON_INTERVAL_MS || '300000', 10);
  let _metaCronTimer = null;
  if (process.env.META_GATEWAY_ENABLED !== 'false') {
    _metaCronTimer = setInterval(() => {
      metaBridge.cronOptimize().catch(() => {});
    }, META_CRON_MS);
    if (_metaCronTimer.unref) _metaCronTimer.unref();
  }

  const opseeqWsBridge = require('./services/opseeq-ws-bridge');
  const _shutdown = () => {
    if (_metaCronTimer) clearInterval(_metaCronTimer);
    try { rmBridge.destroy(); } catch {}
    try { opseeqWsBridge.close(); } catch {}
    // Note: Opseeq container lifecycle is managed by the browser heartbeat,
    // not by server shutdown. The idle timeout (60s after last heartbeat)
    // handles cleanup when the user actually closes the tab.
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', _shutdown);
  process.on('SIGINT', _shutdown);
}

module.exports = app;
