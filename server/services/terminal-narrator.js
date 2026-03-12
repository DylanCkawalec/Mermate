'use strict';

/**
 * Terminal Narrator — downstream observer that converts the audit event
 * stream into a premium, gamified, audit-grade terminal UX.
 *
 * Separation of concerns (must never be violated):
 *   EXECUTION  →  audit-tracker.emit(...)    (upstream, no inference)
 *   NARRATION  →  terminal-narrator.watch()  (downstream, read-only)
 *   DISPLAY    →  SSE narration events        (terminal output only)
 *
 * The narrator is NEVER inside the decision loop. It watches, summarizes,
 * and emits 'narration' SSE events. It does not alter execution order,
 * model selection, controller state, or any timing.
 *
 * Narration strategy (in priority order):
 *   1. Event-specific static templates — always fast, always available
 *   2. gpt-oss-20b batch summaries   — async, compresses a batch of events
 *      into 1-2 line terminal messages. Falls back silently if unavailable.
 *
 * Terminal message design principles:
 *   - Short (≤60 chars preferred, ≤90 chars max)
 *   - Truthful: message reflects actual current event, not theater
 *   - Progressive: stage indicator + concise description
 *   - Premium: feels like a disciplined intelligence system
 *   - Non-repetitive: debounce + dedupe back-to-back identical messages
 */

const logger = require('../utils/logger');

// ---- Static narration templates ------------------------------------------

// Stage-level messages: what the terminal shows when a stage is entered
const STAGE_MESSAGES = {
  ingest:              '▸ Reading architecture input',
  planning:            '▸ Planning  —  analyzing structure and constraints',
  refining:            '▸ Refining  —  strengthening boundaries and flows',
  preview:             '▸ Validation render  —  building structural preview',
  incorporating_notes: '▸ Applying review notes',
  finalizing:          '▸ Final synthesis  —  converging on max-quality output',
  complete:            '✓ Workflow complete',
};

// Short role display names
function _shortRole(name) {
  if (!name || name === 'default') return 'Reasoning';
  return name.replace(/^Doctor_/, 'Dr.').replace(/_/g, ' ');
}

// Short domain display
function _shortDomain(domain) {
  if (!domain || domain === 'general') return '';
  return domain.replace(/_/g, ' ');
}

// Map event type → narration template fn
const EVENT_TEMPLATES = {
  'agent:stage_enter': (e) => STAGE_MESSAGES[e.stage] || `▸ ${e.stage}`,

  'agent:role_start': (e) => {
    const role = _shortRole(e.role);
    const dom  = _shortDomain(e.domain);
    const stg  = e.stage ? ` · ${e.stage}` : '';
    return `  ⤷ ${role}${dom ? ' / ' + dom : ''}${stg}`;
  },

  'agent:role_end': (e) => {
    const role = _shortRole(e.role);
    const latency = e.latencyMs ? ` (${(e.latencyMs / 1000).toFixed(1)}s)` : '';
    return e.success
      ? `  ✓ ${role} complete${latency}`
      : `  ↯ ${role} fell through to fallback${latency}`;
  },

  'agent:batch_start': (e) => {
    const n = e.roleCount || e.count || 2;
    return `  ⇌ ${n} expert channels opening  —  level ${e.level || '?'}`;
  },

  'agent:batch_end': (e) => {
    const survived = e.survived != null ? e.survived : '?';
    const total    = e.total    != null ? e.total    : '?';
    return `  ◈ Batch complete  —  ${survived}/${total} branches survive`;
  },

  'agent:draft_update': (e) => {
    const words = e.text ? Math.round(e.text.split(/\s+/).length) : 0;
    return `  ◆ Architecture updated  (${words} words)`;
  },

  'agent:note_decision': (e) =>
    e.hasNotes
      ? '  ✎ Review notes detected  —  incorporating into final synthesis'
      : '  → No review notes  —  proceeding to final render',

  'agent:convergence': (e) => {
    const pct = e.pct != null ? `${e.pct}%` : '';
    return `  ⬤ Converging${pct ? ' · ' + pct + ' confidence' : ''}`;
  },

  'got:root_init':   () => '  ◇ GoT controller initialized  (depth=3, budget=40)',
  'got:branch_start': (e) => `  ⇀ Branch  —  level ${e.level}, r=${e.branchCount || '?'}`,
  'got:branch_end':   (e) => `  ⇁ ${e.branchCount || '?'} children generated`,
  'got:validate':     (e) => {
    const s = e.score != null ? `σ=${e.score.toFixed(2)}` : '';
    return `  ∿ Validation checkpoint${s ? '  ' + s : ''}`;
  },
  'got:prune':        (e) => {
    const k = e.kept != null ? e.kept : '?';
    const t = e.total != null ? e.total : '?';
    return `  ✂ Pruned  —  ${k}/${t} branches above τ=${e.tau || 0.85}`;
  },
  'got:merge_eval':  () => '  ⊕ Evaluating merge across top branches',
  'got:merge_accept': (e) => {
    const score = e.score != null ? `  σ=${e.score.toFixed(2)}` : '';
    return `  ⊕ Merge accepted  —  architecture strengthened${score}`;
  },
  'got:merge_reject': () => '  ⊖ Merge rejected  —  dominant branch preserved',
  'got:level_complete': (e) => `  ─ Level ${e.level} complete  →  advancing`,

  'render:prepare':   () => '  ◈ Render pipeline initializing',
  'render:hpc_stage1': () => '  ∷ HPC Stage 1 of 3  —  extracting entities, relationships, and boundaries',
  'render:hpc_stage2': () => '  ∷ HPC Stage 2 of 3  —  building diagram plan with node and edge annotations',
  'render:hpc_stage3': (e) => {
    const b = e.branches ? `${e.branches} competing branches` : 'dual-branch';
    return `  ∷ HPC Stage 3 of 3  —  composing Mermaid structure (${b})`;
  },
  'render:validate':  (e) => {
    const v = e.valid ? '✓ Structure valid' : '↯ Validation failed';
    return `  ${v}`;
  },
  'render:repair':   (e) => `  ↺ Repairing structure  (attempt ${e.attempt || 1})`,
  'render:complete': (e) => {
    const nodes = e.nodeCount != null ? `${e.nodeCount} nodes` : '';
    const edges = e.edgeCount != null ? `${e.edgeCount} edges` : '';
    const parts = [nodes, edges].filter(Boolean).join(', ');
    return `  ✓ Render complete${parts ? '  —  ' + parts : ''}`;
  },
  'render:failed':   (e) => `  ✗ Render failed  —  ${(e.error || '').slice(0, 40)}`,
  'render:fallback': () => '  ↓ Falling back to local structural conversion',

  'sys:timeout':    (e) => `  ⌛ Timeout in ${e.stage || 'stage'}  —  retrying`,
  'sys:retry':      (e) => `  ↺ Retry  ${e.attempt || ''}  —  ${e.stage || ''}`,
  'sys:fallback':   (e) => `  ↓ ${e.from || 'provider'} unavailable  →  ${e.to || 'fallback'}`,
  'sys:recovery':   (e) => `  ✓ Recovered  —  ${e.stage || 'stage'} resumed`,
  'sys:error':      (e) => `  ✗ Error  —  ${(e.message || '').slice(0, 50)}`,

  'rm:action_tag':  (e) => {
    const tag = e.tag || `[${e.stage}]`;
    const ctx = e.ctxPct != null ? `${e.ctxPct}% ctx` : (e.contextUtilization != null ? `${e.contextUtilization}% ctx` : '');
    const tokens = e.inTok ? `~${e.inTok} tok` : (e.inputTokensEst ? `~${e.inputTokensEst} tok` : '');
    const parts = [tokens, ctx].filter(Boolean).join(', ');
    return `  ⚡ ${tag}  ${parts ? '(' + parts + ')' : ''}`;
  },
};

// Events that are internal plumbing — suppress from visible terminal
const SILENT_TYPES = new Set([
  'agent:batch_start', 'agent:batch_end',
  'got:root_init', 'got:branch_start', 'got:branch_end',
  'got:level_complete',
]);

// ---- OSS-20B async batch summarizer --------------------------------------

const OSS_BATCH_SIZE  = 6;   // compress this many events at once
const OSS_MIN_WAIT_MS = 1500; // summarize every 1.5s for tighter feedback loops

let _ossSummarizer = null; // lazily initialized

function _getOssSummarizer() {
  if (_ossSummarizer) return _ossSummarizer;
  try {
    const provider = require('./inference-provider');
    _ossSummarizer = provider;
    return _ossSummarizer;
  } catch {
    return null;
  }
}

async function _tryOssSummary(events) {
  const prov = _getOssSummarizer();
  if (!prov) return null;

  const compactEvents = events.map(e => {
    const tmpl = EVENT_TEMPLATES[e.type];
    const base = tmpl ? (typeof tmpl === 'function' ? tmpl(e) : tmpl) : e.type;
    return base.trim();
  }).filter(Boolean).join('\n');

  if (!compactEvents.trim()) return null;

  try {
    const result = await prov.infer('copilot_enhance', {
      systemPrompt: [
        'You are a terminal narrator for an AI architecture system.',
        'You receive a short list of system events. Your job: write exactly ONE line (max 70 chars)',
        'that truthfully summarizes the current system state in concise, intelligent terminal language.',
        'Do NOT add filler. Do NOT add markdown. Do NOT repeat "AI" or "system". Just the summary line.',
        'Examples of good outputs:',
        '  Planning — Dr. Alan Turing routing formal reasoning across 3 branches',
        '  Validation checkpoint passed — architecture converging',
        '  Refinement pass 2 — strengthening failure paths and boundary specificity',
      ].join('\n'),
      userPrompt: `Events:\n${compactEvents}\n\nSummarize in one terminal line:`,
    });
    if (result.output && !result.noOp) {
      return result.output.trim().slice(0, 90);
    }
  } catch {
    // OSS unavailable — silent fallback
  }
  return null;
}

// ---- Watch a run and emit narration events via callback ------------------

/**
 * Start watching an audit run. For each meaningful event, emit a
 * 'narration' SSE event via the provided sendEvent callback.
 *
 * Also attempts periodic gpt-oss-20b batch summarization (async,
 * non-blocking, strictly downstream).
 *
 * @param {string} auditRunId
 * @param {string} telemetryRunId  — used in narration metadata
 * @param {function} sendEvent     — (type, data) → void; SSE emitter
 * @param {object} auditTracker    — injected to avoid circular require
 * @returns {function} stop()       — call to unsubscribe
 */
function watchRun(auditRunId, telemetryRunId, sendEvent, auditTracker) {
  let lastNarration = null;
  let pendingBatch = [];
  let batchTimer = null;
  let lastOssAt = 0;
  let _ossInFlight = false;

  function _flushOssBatch() {
    batchTimer = null;
    if (_ossInFlight) return; // concurrency guard: one summarization at a time
    const batch = pendingBatch.splice(0);
    if (!batch.length) return;
    if (Date.now() - lastOssAt < OSS_MIN_WAIT_MS) return;
    lastOssAt = Date.now();
    _ossInFlight = true;
    _tryOssSummary(batch).then(summary => {
      if (summary && summary !== lastNarration) {
        lastNarration = summary;
        sendEvent('narration', {
          message: summary,
          source: 'oss',
          runId: telemetryRunId,
        });
      }
    }).catch(() => {}).finally(() => { _ossInFlight = false; });
  }

  const unsubscribe = auditTracker.subscribe(auditRunId, (event) => {
    const tmpl = EVENT_TEMPLATES[event.type];
    if (!tmpl) return;

    const message = typeof tmpl === 'function' ? tmpl(event) : tmpl;
    if (!message) return;

    // Always emit the static narration immediately (for real-time feedback)
    if (!SILENT_TYPES.has(event.type) && message !== lastNarration) {
      lastNarration = message;
      sendEvent('narration', {
        message,
        source: 'template',
        eventType: event.type,
        stage: event.stage || null,
        role: event.role || null,
        elapsed: event.elapsed,
        runId: telemetryRunId,
      });
    }

    // Queue event for gpt-oss batch summarization
    pendingBatch.push(event);
    if (pendingBatch.length >= OSS_BATCH_SIZE) {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      _flushOssBatch();
    } else if (!batchTimer) {
      batchTimer = setTimeout(_flushOssBatch, 2000);
    }
  });

  return function stop() {
    if (batchTimer) clearTimeout(batchTimer);
    unsubscribe();
  };
}

/**
 * Emit a single pre-composed narration without an audit event.
 * Used for finalize-phase messages that have no audit event backing.
 */
function narrate(sendEvent, message, meta = {}) {
  if (!message) return;
  sendEvent('narration', { message, source: 'direct', ...meta });
}

module.exports = { watchRun, narrate };
