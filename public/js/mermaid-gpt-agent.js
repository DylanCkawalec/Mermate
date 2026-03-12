/**
 * MermaidAgent — Frontend orchestrator for Agent mode.
 *
 * Two-phase flow:
 *   Phase 1 (run):      planning -> refinement -> preview render -> pause for notes
 *   Phase 2 (finalize): user notes -> optional refinement -> final Max render
 *
 * Includes semantic draft-typing animation for text updates.
 */
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

    this._abortController = null;
    this._running = false;
    this._mode = null;
    this._draftText = '';
    this._originalText = '';  // snapshot before agent starts
    this._previewDiagramName = null;
    this._animating = false;
    this._thinkingEffect = null;
    this._thinkingEffectDot = null;
    this._thinkingEffectToken = 0;
    this._thinkingEffectLoader = null;
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

  /** Stop and restore the textarea to the user's original text. */
  stopAndRestore() {
    this.stop();
    if (this._originalText) {
      this.input.value = this._originalText;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.panel.hidden = true;
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
      // ---- Primary display path: narration events from terminal-narrator ----
      // These are the high-quality, compressed terminal messages. They replace
      // the noisy raw stage/thinking dump as the primary visible output.
      case 'narration':
        this._addNarrationLog(event.message, event.source, event.eventType);
        break;

      // ---- Stage events: used for state tracking only when no narration ----
      // Still shown if narration is not active (e.g., first event before
      // the narrator has wired up), but suppressed once narration is flowing.
      case 'stage':
        if (!this._narratorActive) {
          this._markPreviousLogDone();
          this._addLog(event.message, 'active');
        }
        if (event.stage === 'ingest' || event.stage === 'planning') {
          this._narratorActive = false; // reset at run start
        }
        break;

      // ---- Thinking events: shown as expert badges in the audit expand ----
      case 'thinking':
        this._narratorActive = true; // narrator is now flowing
        this._addThinkingLog(event.role, event.summary, event.domain);
        break;

      // ---- Heartbeat / telemetry / audit: hidden from visible terminal ----
      case 'heartbeat':
      case 'telemetry':
      case 'audit_summary':
        break;

      // ---- Analysis: append to expandable audit detail only ----
      case 'analysis':
        this._auditDetail = this._auditDetail || [];
        this._auditDetail.push(`quality=${event.quality} · completeness=${event.completeness} · maturity=${event.maturity}`);
        break;

      case 'draft_update':
        await this._animateDraftUpdate(event.original || this.input.value, event.text);
        this._draftText = event.text;
        // If narrator isn't active yet, show a fallback log entry
        if (!this._narratorActive) {
          this._addLog(event.reason || 'Architecture updated', 'done');
        }
        break;

      case 'preview_render':
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
        this._addNarrationLog('◈ Preview ready  —  add notes or finalize', 'system', 'preview_ready');
        this._draftText = event.draft_text || this.input.value;
        this._previewDiagramName = event.diagram_name || null;
        this._showNotesUI();
        this.onStateChange('awaiting_notes');
        break;

      case 'final_render':
        if (event.success) {
          this._addNarrationLog(
            `✓ Final render complete  —  ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.subgraphCount || 0} subgraphs`,
            'system', 'render:complete',
          );
          this.onRenderResult(event);
        } else {
          this._addNarrationLog(`✗ Render failed  —  ${(event.error || 'unknown').slice(0, 45)}`, 'system', 'render:failed');
          this.onError(event.error || 'Render failed — try a simpler description or check your model connection');
        }
        break;

      case 'done':
        this._markPreviousLogDone();
        this._addNarrationLog('✓ Agent workflow complete', 'system', 'done');
        this._running = false;
        this._narratorActive = false;
        this.onComplete(event.final_text);
        this.onStateChange('idle');
        break;

      case 'error':
        this._markPreviousLogDone();
        this._addNarrationLog(`✗ ${event.message}`, 'system', 'sys:error');
        this.onError(event.message);
        break;
    }
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

    // Build a classification for each word in the new text
    const oldSet = new Set(oldWords.map(w => w.toLowerCase()));
    const classified = newWords.map(w => ({
      word: w,
      preserved: oldSet.has(w.toLowerCase()),
    }));

    // Create animation overlay
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

    // Animate words appearing
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

      // Reveal batch
      await this._frame();
      const spans = overlay.querySelectorAll('span');
      for (let j = Math.max(0, i); j < Math.min(spans.length, i + BATCH); j++) {
        spans[j].style.opacity = '1';
      }
      if (DELAY > 0) await this._sleep(DELAY);
    }

    // Settle: transition all to black
    await this._sleep(120);
    overlay.querySelectorAll('span').forEach(s => {
      s.style.color = 'var(--text)';
      s.style.fontWeight = 'normal';
    });

    await this._sleep(250);

    // Swap: set the real textarea and remove overlay
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
    const entry = document.createElement('div');
    entry.className = 'agent-log-entry' + (state ? ' ' + state : '');
    const dot = document.createElement('span');
    dot.className = 'agent-log-dot';

    const label = document.createElement('span');
    label.className = 'agent-log-text';
    label.textContent = text;

    entry.append(dot, label);
    this.panelLog.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;

    if (state === 'active') {
      void this._attachThinkingEffect(dot);
    }
  }

  /**
   * Add a narration log entry — the primary visible terminal output.
   * Narration entries are the distilled, premium terminal messages from
   * the terminal-narrator service or the system itself.
   *
   * source: 'template' | 'oss' | 'system'
   * eventType: the audit event type that triggered this narration
   */
  _addNarrationLog(message, source = 'system', eventType = '') {
    if (!message) return;

    // Collapse any active thinking entries
    this.panelLog.querySelectorAll('.agent-log-entry.thinking').forEach(e => {
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

    // Source badge for OSS-summarized messages
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
    this.panelLog.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;
  }

  _addThinkingLog(role, summary, domain) {
    this.panelLog.querySelectorAll('.agent-log-entry.thinking').forEach(e => {
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
    this.panelLog.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;
  }

  _markPreviousLogDone() {
    this._teardownThinkingEffect();
    this.panelLog.querySelectorAll('.agent-log-entry.active').forEach(e => {
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
