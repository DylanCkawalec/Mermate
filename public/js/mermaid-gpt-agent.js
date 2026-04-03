/**
 * MermaidAgent — Frontend orchestrator for Agent mode.
 *
 * Two-phase flow:
 *   Phase 1 (run):      planning -> refinement -> preview render -> pause for notes
 *   Phase 2 (finalize): user notes -> optional refinement -> final Max render
 *
 * Includes:
 *   - Collapsible phase accordion (sub-steps fold under phase headers)
 *   - Gamified metrics bar with rolling-number animation
 *   - Semantic draft-typing animation for text updates
 */

const PHASE_LABELS = {
  ingest:              'Reading your idea',
  planning:            'Exploring architectures',
  refining:            'Refining structure',
  preview:             'Building preview',
  incorporating_notes: 'Applying your notes',
  finalizing:          'Final render',
  tla_build:           'Generating TLA+ specification',
  ts_build:            'Compiling TypeScript runtime',
  complete:            'Complete',
};

const METRIC_DEFS = [
  { key: 'level',    label: 'Level',    format: 'int',      unit: '/ 3' },
  { key: 'sigma',    label: 'Score',    format: 'float',    unit: '' },
  { key: 'branches', label: 'Branches', format: 'int',      unit: '' },
  { key: 'tokens',   label: 'Tokens',   format: 'int',      unit: '' },
  { key: 'cost',     label: 'Cost',     format: 'currency', unit: '' },
  { key: 'elapsed',  label: 'Time',     format: 'time',     unit: '' },
];

window.MermaidAgent = class MermaidAgent {
  constructor(opts) {
    this.input = opts.input;
    this.panel = opts.panel;
    this.panelLog = opts.panelLog;
    this.panelMode = opts.panelMode;
    this.notesWrap = opts.notesWrap;
    this.notesInput = opts.notesInput;
    this.btnFinalize = opts.btnFinalize;
    this.onPreviewRender = opts.onPreviewRender || (() => {});
    this.onRenderResult = opts.onRenderResult || (() => {});
    this.onComplete = opts.onComplete || (() => {});
    this.onError = opts.onError || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.onContinue = opts.onContinue || (() => {});

    this._abortController = null;
    this._running = false;
    this._mode = null;
    this._draftText = '';
    this._originalText = '';
    this._previewDiagramName = null;
    this._animating = false;
    this._thinkingEffect = null;
    this._thinkingEffectDot = null;
    this._thinkingEffectToken = 0;
    this._thinkingEffectLoader = null;

    this._currentPhaseGroup = null;
    this._currentPhaseBody = null;
    this._currentPhaseName = null;
    this._phaseStepCount = 0;
    this._phaseStartTime = 0;
    this._metricsBar = null;
    this._metricEls = {};
    this._metricValues = {};
    this._scroller = typeof NumberScroller !== 'undefined' ? new NumberScroller() : null;
  }

  get running() { return this._running; }

  // ---- Phase 1: Run through planning, refinement, preview ----

  async run(mode, diagramName) {
    if (this._running) return;
    this._running = true;
    this._mode = mode;
    this._userDiagramName = diagramName || null;

    const prompt = this.input.value.trim();
    if (!prompt) {
      this.onError('Please enter a prompt for the agent.');
      this._running = false;
      return;
    }

    this._originalText = prompt;

    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }

    this.panel.hidden = false;
    this.panelMode.textContent = mode;
    this.panelLog.innerHTML = '';
    this.notesWrap.hidden = true;
    this._draftText = '';
    this._previewDiagramName = null;
    this._currentPhaseGroup = null;
    this._currentPhaseBody = null;
    this._currentPhaseName = null;

    this._buildMetricsBar();
    this._openPhase('ingest');
    this._addLog('Starting agent...', 'active');
    this.onStateChange('running');

    this._abortController = new AbortController();

    try {
      await this._streamSSE('/api/agent/run', {
        prompt, mode, current_text: prompt,
        diagram_name: this._userDiagramName || undefined,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        this._addLog(`Error: ${err.message}`, 'done');
        this.onError(err.message);
      }
    } finally {
      this._running = false;
    }
  }

  // ---- Phase 2: Finalize with optional notes ----

  async finalize() {
    if (!this._draftText) return;

    const notes = this.notesInput?.value?.trim() || '';
    this.notesWrap.hidden = true;
    this._openPhase('finalizing');
    this._addLog(notes ? 'Applying notes and running Max render...' : 'Running final Max render...', 'active');
    this.onStateChange('finalizing');

    this._abortController = new AbortController();

    try {
      await this._streamSSE('/api/agent/finalize', {
        current_text: this._draftText,
        mode: this._mode,
        user_notes: notes,
        diagram_name: this._userDiagramName || this._previewDiagramName,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        this._addLog(`Error: ${err.message}`, 'done');
        this.onError(err.message);
      }
    } finally {
      this._running = false;
      this._abortController = null;
      this.onStateChange('idle');
    }
  }

  stop() {
    if (this._abortController) this._abortController.abort();
    this._teardownThinkingEffect();
    this._running = false;
    this.notesWrap.hidden = true;
    this.onStateChange('idle');
  }

  stopAndRestore() {
    this.stop();
    if (this._originalText) {
      this.input.value = this._originalText;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.panel.hidden = true;
  }

  // ---- Metrics bar ----

  _buildMetricsBar() {
    if (this._metricsBar) this._metricsBar.remove();

    const bar = document.createElement('div');
    bar.className = 'agent-metrics-bar';
    this._metricEls = {};
    this._metricValues = {};

    for (const def of METRIC_DEFS) {
      const cell = document.createElement('div');
      cell.className = 'metric-cell';
      cell.dataset.metric = def.key;

      const label = document.createElement('span');
      label.className = 'metric-label';
      label.textContent = def.label;

      const value = document.createElement('span');
      value.className = 'metric-value';
      value.textContent = def.format === 'currency' ? '$0.00'
        : def.format === 'float' ? '0.00'
        : def.format === 'time' ? '0.0s'
        : '0';

      cell.append(label, value);
      if (def.unit) {
        const unit = document.createElement('span');
        unit.className = 'metric-unit';
        unit.textContent = def.unit;
        cell.appendChild(unit);
      }

      bar.appendChild(cell);
      this._metricEls[def.key] = value;
      this._metricValues[def.key] = 0;
    }

    this.panelLog.parentNode.insertBefore(bar, this.panelLog);
    this._metricsBar = bar;
  }

  _updateMetric(key, newValue) {
    const el = this._metricEls[key];
    if (!el) return;
    const def = METRIC_DEFS.find(d => d.key === key);
    if (!def) return;

    const oldValue = this._metricValues[key] || 0;
    this._metricValues[key] = newValue;

    if (oldValue === newValue) return;

    const direction = newValue > oldValue ? 'rising' : 'falling';
    el.classList.add(direction);
    setTimeout(() => el.classList.remove(direction), 600);

    if (this._scroller) {
      this._scroller.animate(el, oldValue, newValue, def.format);
    } else {
      el.textContent = this._formatMetric(newValue, def.format);
    }
  }

  _formatMetric(value, format) {
    switch (format) {
      case 'float': return value.toFixed(2);
      case 'currency': return '$' + value.toFixed(2);
      case 'time': return value.toFixed(1) + 's';
      case 'int':
      default: return Math.round(value).toLocaleString();
    }
  }

  // ---- Phase accordion ----

  _openPhase(phaseName) {
    if (this._currentPhaseGroup) {
      this._closeCurrentPhase();
    }

    this._currentPhaseName = phaseName;
    this._phaseStepCount = 0;
    this._phaseStartTime = Date.now();

    const group = document.createElement('div');
    group.className = 'phase-group phase-active';
    group.dataset.phase = phaseName;

    const header = document.createElement('div');
    header.className = 'phase-header';

    const dot = document.createElement('span');
    dot.className = 'phase-dot';

    const label = document.createElement('span');
    label.className = 'phase-label';
    label.textContent = PHASE_LABELS[phaseName] || phaseName;

    const badge = document.createElement('span');
    badge.className = 'phase-badge';
    badge.textContent = '';

    const time = document.createElement('span');
    time.className = 'phase-time';
    time.textContent = '';

    const chevron = document.createElement('span');
    chevron.className = 'phase-chevron';
    chevron.textContent = '\u25BC';

    header.append(dot, label, badge, time, chevron);
    header.addEventListener('click', () => {
      group.classList.toggle('collapsed');
    });

    const body = document.createElement('div');
    body.className = 'phase-body';

    group.append(header, body);
    this.panelLog.appendChild(group);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;

    this._currentPhaseGroup = group;
    this._currentPhaseBody = body;
  }

  _closeCurrentPhase(status = 'done') {
    if (!this._currentPhaseGroup) return;

    const elapsed = ((Date.now() - this._phaseStartTime) / 1000).toFixed(1);
    const badge = this._currentPhaseGroup.querySelector('.phase-badge');
    const time = this._currentPhaseGroup.querySelector('.phase-time');

    if (badge) badge.textContent = this._phaseStepCount > 0 ? `${this._phaseStepCount} steps` : '';
    if (time) time.textContent = `${elapsed}s`;

    this._currentPhaseGroup.classList.remove('phase-active');
    this._currentPhaseGroup.classList.add(status === 'error' ? 'phase-error' : 'phase-done');
    this._currentPhaseGroup.classList.add('collapsed');
  }

  _getLogTarget() {
    return this._currentPhaseBody || this.panelLog;
  }

  // ---- SSE streaming ----

  async _streamSSE(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this._abortController.signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Request failed: ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { await this._handleEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }

  // ---- Event handling ----

  async _handleEvent(event) {
    switch (event.type) {
      case 'narration':
        this._phaseStepCount++;
        this._addNarrationLog(event.message, event.source, event.eventType);
        if (event.elapsed) {
          this._updateMetric('elapsed', event.elapsed / 1000);
        }
        break;

      case 'stage':
        if (event.stage && event.stage !== this._currentPhaseName) {
          this._openPhase(event.stage);
        }
        if (!this._narratorActive) {
          this._markPreviousLogDone();
          this._addLog(event.message, 'active');
        }
        if (event.stage === 'ingest' || event.stage === 'planning') {
          this._narratorActive = false;
        }
        break;

      case 'thinking':
        this._narratorActive = true;
        this._phaseStepCount++;
        this._addThinkingLog(event.role, event.summary, event.domain);
        break;

      case 'phase_metric':
        this._applyPhaseMetric(event);
        break;

      case 'heartbeat':
        break;

      case 'telemetry':
        this._applyTelemetry(event);
        break;

      case 'audit_summary':
        break;

      case 'analysis':
        this._auditDetail = this._auditDetail || [];
        this._auditDetail.push(`quality=${event.quality} · completeness=${event.completeness} · maturity=${event.maturity}`);
        if (typeof event.quality === 'number') {
          this._updateMetric('sigma', event.quality);
        }
        break;

      case 'draft_update':
        await this._animateDraftUpdate(event.original || this.input.value, event.text);
        this._draftText = event.text;
        if (!this._narratorActive) {
          this._addLog(event.reason || 'Architecture updated', 'done');
        }
        break;

      case 'preview_render':
        this._phaseStepCount++;
        if (event.success) {
          if (!this._narratorActive) {
            this._addLog(`Preview: ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.edgeCount || '?'} edges`, 'done');
          }
          this.onPreviewRender(event);
        } else {
          this._addNarrationLog('Preview compile issue — you can still finalize', 'system', 'render:failed');
        }
        break;

      case 'preview_ready':
        this._markPreviousLogDone();
        this._closeCurrentPhase();
        this._addNarrationLog('Preview ready  —  add notes or finalize', 'system', 'preview_ready');
        this._draftText = event.draft_text || this.input.value;
        this._previewDiagramName = event.diagram_name || null;
        this._showNotesUI();
        this.onStateChange('awaiting_notes');
        break;

      case 'final_render':
        this._phaseStepCount++;
        if (event.success) {
          this._addNarrationLog(
            `Final render complete  —  ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.subgraphCount || 0} subgraphs`,
            'system', 'render:complete',
          );
          this.onRenderResult(event);
          if (this._mode !== 'full-build') {
            this._showContinuationCTA('tla', 'Diagram complete', 'Continue to TLA+ Specification', { autoChain: true, delayMs: 3000 });
          }
        } else {
          this._addNarrationLog(`Render failed  —  ${(event.error || 'unknown').slice(0, 45)}`, 'system', 'render:failed');
          this.onError(event.error || 'Render failed — try a simpler description or check your model connection');
        }
        break;

      case 'pipeline_stage':
        this._markPreviousLogDone();
        if (event.stage === 'tla') {
          const tlaOk = event.success && event.sany_valid;
          this._addNarrationLog(
            tlaOk ? `TLA+ spec verified — SANY passed, ${event.violations || 0} violations` : `TLA+ stage ${event.success ? 'completed' : 'failed'}`,
            'system', tlaOk ? 'tla:pass' : 'tla:fail',
          );
        } else if (event.stage === 'ts') {
          this._addNarrationLog(
            event.success ? `TypeScript compiled — tsc ${event.compile_ok ? 'pass' : 'fail'}, tests ${event.tests_ok ? 'pass' : 'fail'}` : `TypeScript stage failed`,
            'system', event.success ? 'ts:pass' : 'ts:fail',
          );
        }
        break;

      case 'bundle_ready':
        this._markPreviousLogDone();
        this._closeCurrentPhase();
        this._addNarrationLog(
          `Full build complete — stages: ${(event.stages_completed || []).join(' → ')}`,
          'system', 'bundle:ready',
        );
        if (this.onBundleReady) this.onBundleReady(event);
        break;

      case 'done':
        this._markPreviousLogDone();
        this._closeCurrentPhase();
        this._addNarrationLog('Agent workflow complete', 'system', 'done');
        this._running = false;
        this._narratorActive = false;
        this.onComplete(event.final_text);
        this.onStateChange('idle');
        break;

      case 'error':
        this._markPreviousLogDone();
        this._closeCurrentPhase('error');
        this._addNarrationLog(`${event.message}`, 'system', 'sys:error');
        this.onError(event.message);
        break;
    }
  }

  // ---- Metrics from server events ----

  _applyPhaseMetric(m) {
    if (m.level != null)            this._updateMetric('level', m.level);
    if (m.sigma != null)            this._updateMetric('sigma', m.sigma);
    if (m.branches_active != null)  this._updateMetric('branches', m.branches_active);
    if (m.tokens_in != null || m.tokens_out != null) {
      this._updateMetric('tokens', (m.tokens_in || 0) + (m.tokens_out || 0));
    }
    if (m.cost != null)             this._updateMetric('cost', m.cost);
    if (m.elapsed_ms != null)       this._updateMetric('elapsed', m.elapsed_ms / 1000);
  }

  _applyTelemetry(t) {
    if (t.totalTokensIn != null || t.totalTokensOut != null) {
      this._updateMetric('tokens', (t.totalTokensIn || 0) + (t.totalTokensOut || 0));
    }
    if (t.totalCost != null) this._updateMetric('cost', t.totalCost);
    if (t.wallClockMs != null) this._updateMetric('elapsed', t.wallClockMs / 1000);
  }

  // ---- Continuation CTA ----

  _showContinuationCTA(nextStage, label, buttonText, { autoChain = false, delayMs = 3000 } = {}) {
    this._removeContinuationCTA();
    if (this._autoChainTimer) { clearTimeout(this._autoChainTimer); this._autoChainTimer = null; }

    const wrap = document.createElement('div');
    wrap.className = 'agent-continuation';
    wrap.dataset.continuationStage = nextStage;

    const span = document.createElement('span');
    span.className = 'continuation-label';
    span.textContent = label;

    const btn = document.createElement('button');
    btn.className = 'btn btn-continuation';
    btn.dataset.nextStage = nextStage;
    btn.textContent = buttonText;

    const fireContinue = () => {
      if (this._autoChainTimer) { clearTimeout(this._autoChainTimer); this._autoChainTimer = null; }
      this._removeContinuationCTA();
      this.onContinue(nextStage);
    };

    btn.addEventListener('click', fireContinue);
    wrap.append(span, btn);
    this.panelLog.parentNode.insertBefore(wrap, this.notesWrap);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;

    if (autoChain) {
      const countdown = document.createElement('span');
      countdown.className = 'continuation-countdown';
      let remaining = Math.ceil(delayMs / 1000);
      countdown.textContent = ` (auto in ${remaining}s)`;
      btn.appendChild(countdown);

      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) { fireContinue(); return; }
        countdown.textContent = ` (auto in ${remaining}s)`;
        this._autoChainTimer = setTimeout(tick, 1000);
      };
      this._autoChainTimer = setTimeout(tick, 1000);
    }
  }

  showTsContinuation({ autoChain = false } = {}) {
    this._showContinuationCTA('ts', 'TLA+ verified', 'Continue to TypeScript Runtime', { autoChain });
  }

  _removeContinuationCTA() {
    if (this._autoChainTimer) { clearTimeout(this._autoChainTimer); this._autoChainTimer = null; }
    this.panel.querySelectorAll('.agent-continuation').forEach(el => el.remove());
  }

  // ---- Pre-Max notes UI ----

  _showNotesUI() {
    this.notesWrap.hidden = false;
    if (this.notesInput) {
      this.notesInput.value = '';
      this.notesInput.focus();
    }
  }

  // ---- Semantic draft animation ----

  async _animateDraftUpdate(oldText, newText) {
    if (this._animating || !newText) return;
    this._animating = true;

    const textarea = this.input;
    const oldWords = this._tokenize(oldText || '');
    const newWords = this._tokenize(newText);

    const oldSet = new Set(oldWords.map(w => w.toLowerCase()));
    const classified = newWords.map(w => ({
      word: w,
      preserved: oldSet.has(w.toLowerCase()),
    }));

    const wrap = textarea.closest('.copilot-wrap') || textarea.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'agent-typing-overlay';
    overlay.style.cssText = `
      position:absolute; inset:0; padding:14px;
      font-family:var(--font-mono); font-size:0.82rem; line-height:1.6;
      white-space:pre-wrap; word-wrap:break-word; overflow:hidden;
      z-index:5; pointer-events:none; border-radius:var(--radius);
      background:var(--surface);
    `;
    wrap.style.position = 'relative';
    textarea.style.opacity = '0';
    wrap.appendChild(overlay);

    const BATCH = 8;
    const DELAY = 12;
    const colors = ['#e8820c', '#4f46e5', '#db2777'];

    for (let i = 0; i < classified.length; i += BATCH) {
      const batch = classified.slice(i, i + BATCH);
      for (const item of batch) {
        const span = document.createElement('span');
        span.textContent = item.word + ' ';
        if (item.preserved) {
          const color = colors[Math.abs(this._simpleHash(item.word)) % colors.length];
          span.style.cssText = `color:${color}; font-weight:600; opacity:0; transition:opacity 0.15s, color 0.4s;`;
        } else {
          span.style.cssText = 'color:#9ca3af; opacity:0; transition:opacity 0.12s, color 0.5s;';
        }
        overlay.appendChild(span);
      }

      await this._frame();
      const spans = overlay.querySelectorAll('span');
      for (let j = Math.max(0, i); j < Math.min(spans.length, i + BATCH); j++) {
        spans[j].style.opacity = '1';
      }
      if (DELAY > 0) await this._sleep(DELAY);
    }

    await this._sleep(120);
    overlay.querySelectorAll('span').forEach(s => {
      s.style.color = 'var(--text)';
      s.style.fontWeight = 'normal';
    });

    await this._sleep(250);

    textarea.value = newText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.style.opacity = '1';
    overlay.style.transition = 'opacity 0.15s';
    overlay.style.opacity = '0';
    await this._sleep(160);
    overlay.remove();

    this._animating = false;
  }

  _tokenize(text) {
    return text.split(/(\s+)/).filter(t => t.trim());
  }

  _simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
  }

  _frame() { return new Promise(r => requestAnimationFrame(r)); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Log helpers ----

  _addLog(text, state = '') {
    const target = this._getLogTarget();
    const entry = document.createElement('div');
    entry.className = 'agent-log-entry' + (state ? ' ' + state : '');
    const dot = document.createElement('span');
    dot.className = 'agent-log-dot';

    const label = document.createElement('span');
    label.className = 'agent-log-text';
    label.textContent = text;

    entry.append(dot, label);
    target.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;

    if (state === 'active') {
      void this._attachThinkingEffect(dot);
    }
  }

  _addNarrationLog(message, source = 'system', eventType = '') {
    if (!message) return;

    const target = this._getLogTarget();

    target.querySelectorAll('.agent-log-entry.thinking').forEach(e => {
      e.classList.remove('thinking');
      e.classList.add('done');
    });
    this._markPreviousLogDone();

    const entry = document.createElement('div');
    const isComplete = message.startsWith('✓') || eventType === 'done' || eventType === 'render:complete';
    const isError    = message.startsWith('✗') || eventType === 'sys:error' || eventType === 'render:failed';
    const isWait     = eventType === 'preview_ready';

    entry.className = [
      'agent-log-entry',
      isComplete ? 'narration-complete' : isError ? 'narration-error' : isWait ? 'narration-wait' : 'narration',
    ].join(' ');

    const dot = document.createElement('span');
    dot.className = 'agent-log-dot';

    const sourceBadge = source === 'oss' ? (() => {
      const b = document.createElement('span');
      b.className = 'narration-source-badge';
      b.textContent = 'oss';
      return b;
    })() : null;

    const text = document.createElement('span');
    text.className = 'agent-log-text narration-text';
    text.textContent = message;

    entry.append(dot, ...(sourceBadge ? [sourceBadge] : []), text);
    target.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;
  }

  _addThinkingLog(role, summary, domain) {
    const target = this._getLogTarget();

    target.querySelectorAll('.agent-log-entry.thinking').forEach(e => {
      e.classList.remove('thinking');
      e.classList.add('done');
    });

    const entry = document.createElement('div');
    entry.className = 'agent-log-entry thinking';

    const dot = document.createElement('span');
    dot.className = 'agent-log-dot';

    const badge = document.createElement('span');
    badge.className = 'agent-role-badge';
    const displayName = (role || 'default')
      .replace(/^Doctor_/, 'Dr. ')
      .replace(/_/g, ' ');
    badge.textContent = displayName;

    const text = document.createElement('span');
    text.className = 'agent-log-text';
    text.textContent = summary || '';

    entry.append(dot, badge, text);
    target.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;
  }

  _markPreviousLogDone() {
    this._teardownThinkingEffect();
    const target = this._getLogTarget();
    target.querySelectorAll('.agent-log-entry.active').forEach(e => {
      e.classList.remove('active');
      e.classList.add('done');
    });
  }

  async _attachThinkingEffect(dot) {
    if (!dot) return;

    this._teardownThinkingEffect(false);
    const token = ++this._thinkingEffectToken;
    this._thinkingEffectDot = dot;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      dot.classList.add('is-thinking-fallback');
      return;
    }

    try {
      this._thinkingEffectLoader ||= import('/js/thinking-effect.js');
      const { AgentThinkingEffect } = await this._thinkingEffectLoader;

      if (token !== this._thinkingEffectToken || !dot.isConnected) return;

      const host = document.createElement('span');
      host.className = 'agent-log-dot-visual';
      dot.appendChild(host);
      this._thinkingEffect = new AgentThinkingEffect(host, { size: 25 });
      this._thinkingEffectDot = dot;
    } catch {
      if (token !== this._thinkingEffectToken || !dot.isConnected) return;
      dot.classList.add('is-thinking-fallback');
    }
  }

  _teardownThinkingEffect(invalidateToken = true) {
    if (invalidateToken) {
      this._thinkingEffectToken += 1;
    }

    if (this._thinkingEffect) {
      this._thinkingEffect.dispose();
      this._thinkingEffect = null;
    }

    if (this._thinkingEffectDot) {
      this._thinkingEffectDot.classList.remove('is-thinking-fallback');
      this._thinkingEffectDot.querySelector('.agent-log-dot-visual')?.remove();
      this._thinkingEffectDot = null;
    }
  }
};
