/**
 * MermaidCopilot — Ghost-text suggestion and active enhancement for Simple Idea mode.
 *
 * Spec: archs/copilot-simple-idea-spec.md
 * Exposed as window.MermaidCopilot. Instantiated/destroyed by mermaid-gpt-app.js.
 */
window.MermaidCopilot = class MermaidCopilot {
  constructor(inputEl, options) {
    this.input = inputEl;
    this.enhancerUrl = options.enhancerUrl || '';
    this.onAccept = options.onAccept || (() => {});

    // Config
    this.IDLE_DELAY_MS      = Math.max(1200, options.idleDelay || 1800);
    this.MIN_SUGGEST_GAP    = 5000;   // AI suggestions
    this.LOCAL_SUGGEST_GAP  = 2000;   // Local suggestions
    this.SUGGEST_TIMEOUT    = 4000;
    this.ENHANCE_TIMEOUT    = 12000;
    this.COOLDOWN_CHARS     = 3;
    this.HEALTH_INTERVAL    = 30000;
    this.MAX_SUGGESTION_LEN = 120;

    // Timers
    this._idleTimer = null;
    this._healthTimer = null;

    // Flags
    this.isSuggesting = false;
    this.isEnhancing = false;
    this.ghostVisible = false;

    // Rate limiting
    this.lastSuggestAt = 0;

    // Cooldown
    this.charsSinceCooldown = 0;
    this.inCooldown = false;

    // Stale check
    this._suggestTextHash = '';

    // Ghost content
    this.currentGhost = '';

    // Health cache
    this._enhancerHealthy = false;
    this._lastHealthCheck = 0;

    // AbortControllers
    this._suggestAC = null;
    this._enhanceAC = null;

    // DOM refs (set in init)
    this.ghostLayer = null;
    this.mirrorSpan = null;
    this.ghostSpan = null;
    this.thinkingEl = null;
    this.wrapEl = null;

    // Bound handlers
    this._onInput = this._onInput.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onBlur = this._onBlur.bind(this);

    this._init();
  }

  // ---- Initialization -------------------------------------------------------

  _init() {
    this.wrapEl = this.input.closest('.copilot-wrap');
    this.ghostLayer = this.wrapEl ? this.wrapEl.querySelector('.copilot-ghost-layer') : null;
    this.mirrorSpan = this.ghostLayer ? this.ghostLayer.querySelector('.copilot-mirror-text') : null;
    this.ghostSpan = this.ghostLayer ? this.ghostLayer.querySelector('.copilot-ghost-text') : null;
    this.thinkingEl = document.getElementById('copilot-thinking');

    this.input.addEventListener('input', this._onInput);
    this.input.addEventListener('keydown', this._onKeyDown);
    this.input.addEventListener('blur', this._onBlur);

    this._checkHealth();
    this._healthTimer = setInterval(() => this._checkHealth(), this.HEALTH_INTERVAL);
  }

  // ---- Teardown -------------------------------------------------------------

  destroy() {
    clearTimeout(this._idleTimer);
    clearInterval(this._healthTimer);
    if (this._suggestAC) this._suggestAC.abort();
    if (this._enhanceAC) this._enhanceAC.abort();
    this.input.removeEventListener('input', this._onInput);
    this.input.removeEventListener('keydown', this._onKeyDown);
    this.input.removeEventListener('blur', this._onBlur);
    this._dismissGhost();
    this._hideThinking();
    this._idleTimer = null;
    this._healthTimer = null;
  }

  // ---- Health check ---------------------------------------------------------

  async _checkHealth() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.enhancerUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      this._enhancerHealthy = res.ok;
    } catch {
      this._enhancerHealthy = false;
    }
    this._lastHealthCheck = Date.now();
  }

  _isHealthy() {
    if (Date.now() - this._lastHealthCheck > this.HEALTH_INTERVAL) return false;
    return this._enhancerHealthy;
  }

  // ---- Event handlers -------------------------------------------------------

  _onInput() {
    this._dismissGhost();
    clearTimeout(this._idleTimer);

    if (this.inCooldown) {
      this.charsSinceCooldown++;
      if (this.charsSinceCooldown >= this.COOLDOWN_CHARS) {
        this.inCooldown = false;
        this.charsSinceCooldown = 0;
      }
    }

    // Abort any in-flight suggestion since user is typing
    if (this._suggestAC) {
      this._suggestAC.abort();
      this._suggestAC = null;
      this.isSuggesting = false;
    }

    this._idleTimer = setTimeout(() => this._onIdle(), this.IDLE_DELAY_MS);
  }

  _onKeyDown(e) {
    // Tab or Enter (no modifier): accept ghost text if visible
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey))
        && this.ghostVisible) {
      e.preventDefault();
      this._acceptGhost();
      return;
    }

    // Escape: dismiss ghost text
    if (e.key === 'Escape' && this.ghostVisible) {
      e.preventDefault();
      this._dismissGhost();
      this._enterCooldown();
      clearTimeout(this._idleTimer);
      return;
    }

    // Ctrl/Cmd+Return is handled by the app (triggers render). Do NOT intercept it here.

    // Any other printable key while ghost visible: dismiss ghost
    if (this.ghostVisible && e.key.length === 1) {
      this._dismissGhost();
      this._enterCooldown();
    }
  }

  _onBlur() {
    clearTimeout(this._idleTimer);
    this._dismissGhost();
  }

  // ---- Idle detection -------------------------------------------------------

  _onIdle() {
    const text = this.input.value;

    if (this._isHealthy()) {
      // ---- AI suggestion path ----
      if (!this._canSuggestAI()) return;
      if (Date.now() - this.lastSuggestAt < this.MIN_SUGGEST_GAP) return;

      const hash = this._hash(text);
      this._suggestTextHash = hash;
      this.isSuggesting = true;

      this._suggestAC = new AbortController();
      const timeoutId = setTimeout(() => this._suggestAC && this._suggestAC.abort(), this.SUGGEST_TIMEOUT);

      this._callSuggest(text, this._suggestAC.signal)
        .then(data => {
          clearTimeout(timeoutId);
          this.isSuggesting = false;
          this.lastSuggestAt = Date.now();
          this._suggestAC = null;

          if (!data) return;
          if (this._hash(this.input.value) !== this._suggestTextHash) return;
          if (data.confidence === 'low') return;

          const suggestion = (data.suggestion || '').slice(0, this.MAX_SUGGESTION_LEN);
          if (!suggestion.trim()) return;
          this._showGhost(suggestion);
        })
        .catch(() => {
          clearTimeout(timeoutId);
          this.isSuggesting = false;
          this._suggestAC = null;
        });
    } else {
      // ---- Local suggestion path (no enhancer needed) ----
      if (!this._canSuggestLocal()) return;
      if (Date.now() - this.lastSuggestAt < this.LOCAL_SUGGEST_GAP) return;

      const suggestion = this._localSuggest(text);
      if (suggestion) {
        this.lastSuggestAt = Date.now();
        this._showGhost(suggestion);
      }
    }
  }

  _canSuggestAI() {
    const text = this.input.value;
    if (text.length < 10) return false;
    if (this.ghostVisible) return false;
    if (this.isSuggesting) return false;
    if (this.isEnhancing) return false;
    if (this.inCooldown) return false;
    if (this.input.readOnly) return false;
    if (document.activeElement !== this.input) return false;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        const l = lines[i].trim();
        if (/[.?!]$/.test(l) && l.length > 60) return false;
        break;
      }
    }
    return true;
  }

  _canSuggestLocal() {
    const text = this.input.value;
    if (text.length < 5) return false;
    if (this.ghostVisible) return false;
    if (this.isSuggesting) return false;
    if (this.isEnhancing) return false;
    if (this.inCooldown) return false;
    if (this.input.readOnly) return false;
    if (document.activeElement !== this.input) return false;
    // Don't suggest if the text is already Mermaid source
    if (/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey)\b/i.test(text.trim())) return false;
    return true;
  }

  // ---- Local (offline) suggestions ------------------------------------------

  _getLastActiveLine(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) return lines[i].trim();
    }
    return '';
  }

  _localSuggest(text) {
    const last = this._getLastActiveLine(text);
    if (!last || last.length < 3) return null;

    // Don't suggest if last line already has an arrow or looks like mermaid syntax
    if (/-->|->|==>|subgraph|classDef|%%/.test(last)) return null;

    const lc = last.toLowerCase();

    // Pattern-based contextual hints
    if (/\buser\b|\bclient\b|\bbrowser\b/.test(lc))
      return ' → API Gateway → Service → Database';
    if (/\bapi\s*gateway\b|\bgateway\b/.test(lc))
      return ' → Auth Service → Backend Service';
    if (/\bauth\b|\blogin\b|\bsso\b/.test(lc))
      return ' → validate token → grant access';
    if (/\bpayment\b|\bcheckout\b/.test(lc))
      return ' → Payment Service → Stripe → Bank';
    if (/\bkafka\b|\bqueue\b|\bevent\s*bus\b/.test(lc))
      return ' → Consumer A\n[broker] → Consumer B';
    if (/\bservice\b|\bserver\b|\bbackend\b/.test(lc))
      return ' → Database';
    if (/\bdeployment\b|\bdeploy\b|\bci\b|\bcd\b/.test(lc))
      return ' → build → test → staging → production';
    if (/\bstate\b|\blifecycle\b|\btransition\b/.test(lc))
      return ': Pending → Running → Succeeded / Failed';

    // Generic: hint that an arrow can connect the next idea
    if (/\w+$/.test(last) && last.split(/\s+/).length >= 2)
      return ' → [connects to]';

    return null;
  }

  // ---- Ghost text -----------------------------------------------------------

  _showGhost(suggestion) {
    if (!this.ghostLayer || !this.mirrorSpan || !this.ghostSpan) return;

    this.currentGhost = suggestion;
    this.ghostVisible = true;

    // Mirror the textarea content so ghost text appears at correct position
    this.mirrorSpan.textContent = this.input.value;
    this.ghostSpan.textContent = suggestion;
    this.ghostLayer.style.display = '';

    // Sync scroll position
    this.ghostLayer.scrollTop = this.input.scrollTop;
  }

  _dismissGhost() {
    if (!this.ghostVisible) return;
    this.ghostVisible = false;
    this.currentGhost = '';
    if (this.ghostSpan) this.ghostSpan.textContent = '';
    if (this.mirrorSpan) this.mirrorSpan.textContent = '';
    if (this.ghostLayer) this.ghostLayer.style.display = 'none';
  }

  _acceptGhost() {
    if (!this.ghostVisible || !this.currentGhost) return;
    const ghost = this.currentGhost;
    this._dismissGhost();

    // Append ghost text + newline to textarea value
    this.input.value = this.input.value + ghost + '\n';
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);

    this._enterCooldown();
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._onIdle(), this.IDLE_DELAY_MS);

    this.onAccept();
  }

  _enterCooldown() {
    this.inCooldown = true;
    this.charsSinceCooldown = 0;
  }

  // ---- Active enhancement ---------------------------------------------------

  async enhance() {
    if (this.isEnhancing) return;
    this._dismissGhost();
    clearTimeout(this._idleTimer);

    const text = this.input.value.trim();
    if (text.length < 10) return;

    const selStart = this.input.selectionStart;
    const selEnd = this.input.selectionEnd;
    const hasSelection = selStart !== selEnd;

    this.isEnhancing = true;
    this._enhanceAC = new AbortController();

    let payload;
    if (hasSelection) {
      const selectedText = this.input.value.slice(selStart, selEnd);
      payload = {
        stage: 'copilot_enhance',
        content_state: 'text',
        mode: 'idea',
        enhance_mode: 'selection',
        full_text: this.input.value.slice(0, 2000),
        selected_text: selectedText,
        preceding_context: this.input.value.slice(Math.max(0, selStart - 500), selStart),
        following_context: this.input.value.slice(selEnd, selEnd + 200),
      };
      this._showThinking('selection', selEnd);
    } else {
      payload = {
        stage: 'copilot_enhance',
        content_state: 'text',
        mode: 'idea',
        enhance_mode: 'full',
        full_text: this.input.value.slice(0, 2000),
        selected_text: null,
        preceding_context: '',
        following_context: '',
      };
      this._showThinking('full');
    }

    const timeoutId = setTimeout(() => this._enhanceAC && this._enhanceAC.abort(), this.ENHANCE_TIMEOUT);

    try {
      const res = await fetch(`${this.enhancerUrl}/mermaid/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this._enhanceAC.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) { this._finishEnhance(); return; }

      const data = await res.json();
      const enhanced = data.enhanced_source || data.suggestion || '';
      if (!enhanced) { this._finishEnhance(); return; }

      if (hasSelection) {
        const before = this.input.value.slice(0, selStart);
        const after = this.input.value.slice(selEnd);
        this.input.value = before + enhanced + after;
        const newEnd = selStart + enhanced.length;
        this.input.setSelectionRange(newEnd, newEnd);
      } else {
        this.input.value = enhanced;
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      }

      this.onAccept();
    } catch {
      // Silently discard — timeout, abort, or network error
    } finally {
      clearTimeout(timeoutId);
      this._finishEnhance();
    }
  }

  _finishEnhance() {
    this.isEnhancing = false;
    this._enhanceAC = null;
    this._hideThinking();
    this._enterCooldown();
  }

  // ---- Thinking indicator ---------------------------------------------------

  _showThinking(mode, selectionEnd) {
    if (!this.thinkingEl || !this.wrapEl) return;
    if (mode === 'full') {
      this.thinkingEl.style.bottom = '10px';
      this.thinkingEl.style.right = '10px';
      this.thinkingEl.style.top = '';
      this.thinkingEl.style.left = '';
    } else {
      const pos = this._getCaretXY(selectionEnd || this.input.selectionEnd);
      this.thinkingEl.style.top = (pos.top - 4) + 'px';
      this.thinkingEl.style.left = (pos.left + 8) + 'px';
      this.thinkingEl.style.bottom = '';
      this.thinkingEl.style.right = '';
    }
    this.thinkingEl.hidden = false;
  }

  _hideThinking() {
    if (this.thinkingEl) this.thinkingEl.hidden = true;
  }

  /**
   * Approximate caret pixel coordinates within the textarea.
   * Uses a hidden mirror div technique.
   */
  _getCaretXY(position) {
    const mirror = document.createElement('div');
    const style = getComputedStyle(this.input);
    const props = [
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
      'wordSpacing', 'textIndent', 'whiteSpace', 'wordWrap', 'overflowWrap',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    ];
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.width = style.width;
    for (const p of props) mirror.style[p] = style[p];
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';

    const textBefore = this.input.value.slice(0, position);
    mirror.textContent = textBefore;

    const marker = document.createElement('span');
    marker.textContent = '|';
    mirror.appendChild(marker);

    document.body.appendChild(mirror);
    const wrapRect = this.wrapEl.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    const top = markerRect.top - mirrorRect.top - this.input.scrollTop;
    const left = markerRect.left - mirrorRect.left;
    document.body.removeChild(mirror);

    return { top, left };
  }

  // ---- API calls ------------------------------------------------------------

  async _callSuggest(text, signal) {
    const lines = text.split('\n');
    let activeLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) { activeLine = lines[i].trim(); break; }
    }

    // cursor_context: last 200 characters before cursor
    const cursorPos = this.input.selectionEnd || text.length;
    const cursorContext = text.slice(Math.max(0, cursorPos - 200), cursorPos);

    const res = await fetch(`${this.enhancerUrl}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: 'copilot_suggest',
        content_state: 'text',
        mode: 'idea',
        full_text: text.slice(0, 2000),
        active_line: activeLine,
        cursor_context: cursorContext,
      }),
      signal,
    });

    if (!res.ok) return null;
    return res.json();
  }

  // ---- Utilities ------------------------------------------------------------

  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return String(h);
  }
};
