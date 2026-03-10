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
    this._animating = false;
  }

  get running() { return this._running; }

  // ---- Phase 1: Run through planning, refinement, preview ----

  async run(mode) {
    if (this._running) return;
    this._running = true;
    this._mode = mode;

    const prompt = this.input.value.trim();
    if (!prompt) {
      this.onError('Please enter a prompt for the agent.');
      this._running = false;
      return;
    }

    this.panel.hidden = false;
    this.panelMode.textContent = mode;
    this.panelLog.innerHTML = '';
    this.notesWrap.hidden = true;
    this._addLog('Starting agent...', 'active');
    this.onStateChange('running');

    this._abortController = new AbortController();

    try {
      await this._streamSSE('/api/agent/run', {
        prompt, mode, current_text: prompt,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        this._addLog(`Error: ${err.message}`, 'done');
        this.onError(err.message);
      }
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
    this._running = false;
    this.notesWrap.hidden = true;
    this.onStateChange('idle');
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
      case 'stage':
        this._markPreviousLogDone();
        this._addLog(event.message, 'active');
        break;

      case 'analysis':
        this._addLog(`Analysis: maturity=${event.maturity}, quality=${event.quality}, entities=${event.entities}`, 'done');
        break;

      case 'draft_update':
        await this._animateDraftUpdate(event.original || this.input.value, event.text);
        this._draftText = event.text;
        this._addLog(event.reason || 'Draft updated', 'done');
        break;

      case 'preview_render':
        if (event.success) {
          this._addLog(`Preview: ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.edgeCount || '?'} edges`, 'done');
          this.onPreviewRender(event);
        } else {
          this._addLog(`Preview failed: ${event.error || 'unknown'}`, 'done');
        }
        break;

      case 'preview_ready':
        this._markPreviousLogDone();
        this._addLog('Preview ready — add notes or finalize', 'done');
        this._draftText = event.draft_text || this.input.value;
        this._showNotesUI();
        this.onStateChange('awaiting_notes');
        break;

      case 'final_render':
        if (event.success) {
          this._addLog(`Max render: ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.subgraphCount || 0} subgraphs`, 'done');
          this.onRenderResult(event);
        } else {
          this._addLog(`Final render failed: ${event.error || 'unknown'}`, 'done');
        }
        break;

      case 'done':
        this._markPreviousLogDone();
        this._addLog('Agent complete', 'done');
        this._running = false;
        this.onComplete(event.final_text);
        this.onStateChange('idle');
        break;

      case 'error':
        this._addLog(`Error: ${event.message}`, 'done');
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
    const d = document.createElement('div');
    d.textContent = text;
    entry.innerHTML = `<span class="agent-log-dot"></span><span>${d.innerHTML}</span>`;
    this.panelLog.appendChild(entry);
    this.panelLog.scrollTop = this.panelLog.scrollHeight;
  }

  _markPreviousLogDone() {
    this.panelLog.querySelectorAll('.agent-log-entry.active').forEach(e => {
      e.classList.remove('active');
      e.classList.add('done');
    });
  }
};
