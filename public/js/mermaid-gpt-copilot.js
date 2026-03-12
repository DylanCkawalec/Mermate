/**
 * MermaidCopilot — Ghost-text suggestion and active enhancement for Simple Idea mode.
 *
 * Spec: archs/copilot-simple-idea-spec.md
 * Exposed as window.MermaidCopilot. Instantiated/destroyed by mermaid-gpt-app.js.
 */
window.MermaidCopilot = class MermaidCopilot {
  constructor(inputEl, options) {
    this.input = inputEl;
    const rawBase = options.apiBase || options.enhancerUrl || '';
    this.apiBase = String(rawBase).replace(/\/+$/, '');
    this.onAccept = options.onAccept || (() => {});
    this.onProfileUpdate = options.onProfileUpdate || null;

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
    this._healthCheckPromise = null;

    // AbortControllers
    this._suggestAC = null;
    this._enhanceAC = null;

    // InputProfile from /api/analyze (updated on debounced input)
    this._profile = null;
    this._analyzeTimer = null;
    this._analyzeAC = null;
    this._lastAnalyzedHash = '';
    this._lastAnalyzeAt = 0;
    this.ANALYZE_DELAY_MS = 800;
    this.ANALYZE_MIN_GAP_MS = 1500;
    this.MIN_ANALYZE_CHARS = 12;

    // Dismiss tracking: stop suggesting after N consecutive dismissals
    this._consecutiveDismissals = 0;
    this.MAX_DISMISSALS_BEFORE_SILENCE = 2;
    this.CHARS_TO_RESET_DISMISSALS = 20;
    this._charsSinceDismissal = 0;

    // Adaptive health: track recent model outcomes
    this._recentModelOutcomes = []; // ring buffer of booleans
    this.MODEL_OUTCOME_WINDOW = 6;

    // Rendered-hash: suppress suggestions for already-rendered text
    this._lastRenderedHash = '';

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
    this._onFocus = this._onFocus.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onWindowFocus = this._onWindowFocus.bind(this);
    this._onOnline = this._onOnline.bind(this);
    this._onOffline = this._onOffline.bind(this);

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
    this.input.addEventListener('focus', this._onFocus);
    this.input.addEventListener('scroll', this._onScroll);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('focus', this._onWindowFocus);
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);

    void this._checkHealth({ force: true });
  }

  // ---- Teardown -------------------------------------------------------------

  destroy() {
    clearTimeout(this._idleTimer);
    clearTimeout(this._analyzeTimer);
    if (this._analyzeAC) this._analyzeAC.abort();
    if (this._suggestAC) this._suggestAC.abort();
    if (this._enhanceAC) this._enhanceAC.abort();
    this.input.removeEventListener('input', this._onInput);
    this.input.removeEventListener('keydown', this._onKeyDown);
    this.input.removeEventListener('blur', this._onBlur);
    this.input.removeEventListener('focus', this._onFocus);
    this.input.removeEventListener('scroll', this._onScroll);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('focus', this._onWindowFocus);
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
    this._dismissGhost();
    this._hideThinking();
    this._idleTimer = null;
    this._analyzeTimer = null;
    this._analyzeAC = null;
    this._profile = null;
    this._healthCheckPromise = null;
  }

  dismissGhost() {
    this._dismissGhost();
  }

  // ---- Health check ---------------------------------------------------------

  async _checkHealth({ force = false } = {}) {
    if (!this.apiBase) {
      this._enhancerHealthy = false;
      this._lastHealthCheck = Date.now();
      return false;
    }

    if (!force && Date.now() - this._lastHealthCheck < this.HEALTH_INTERVAL) {
      return this._enhancerHealthy;
    }

    if (this._healthCheckPromise) {
      return this._healthCheckPromise;
    }

    this._healthCheckPromise = (async () => {
      let timer = null;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.apiBase}/health`, { signal: controller.signal });
        let healthy = res.ok;

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          const data = await res.json().catch(() => null);
          if (data && typeof data.available === 'boolean') {
            healthy = data.available;
          }
        }

        this._enhancerHealthy = healthy;
      } catch {
        this._enhancerHealthy = false;
      } finally {
        if (timer) clearTimeout(timer);
        this._lastHealthCheck = Date.now();
      }

      return this._enhancerHealthy;
    })();

    try {
      return await this._healthCheckPromise;
    } finally {
      this._healthCheckPromise = null;
    }
  }

  _isHealthy() {
    if (!this.apiBase) return false;
    if (Date.now() - this._lastHealthCheck > this.HEALTH_INTERVAL) {
      if (!document.hidden) void this._checkHealth();
      return false;
    }
    if (!this._enhancerHealthy) return false;
    return this._isModelReliable();
  }

  // ---- Event handlers -------------------------------------------------------

  _onInput() {
    this._dismissGhost();
    clearTimeout(this._idleTimer);

    if (Date.now() - this._lastHealthCheck > this.HEALTH_INTERVAL) {
      void this._checkHealth();
    }

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

    // Schedule profile analysis (separate from suggestion idle)
    clearTimeout(this._analyzeTimer);
    const trimmed = this.input.value.trim();
    if (trimmed.length >= this.MIN_ANALYZE_CHARS) {
      this._analyzeTimer = setTimeout(() => this._refreshProfile(), this.ANALYZE_DELAY_MS);
    } else if (this._profile) {
      this._profile = null;
      if (this.onProfileUpdate) this.onProfileUpdate(null);
    }

    // Track chars since last dismissal for resetting dismissal counter
    if (this._consecutiveDismissals > 0) {
      this._charsSinceDismissal++;
      if (this._charsSinceDismissal >= this.CHARS_TO_RESET_DISMISSALS) {
        this._consecutiveDismissals = 0;
        this._charsSinceDismissal = 0;
      }
    }
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
      this._consecutiveDismissals++;
      this._charsSinceDismissal = 0;
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

  _onFocus() {
    void this._checkHealth();
  }

  _onScroll() {
    if (!this.ghostVisible || !this.ghostLayer) return;
    this.ghostLayer.scrollTop = this.input.scrollTop;
    this.ghostLayer.scrollLeft = this.input.scrollLeft;
  }

  _onVisibilityChange() {
    if (!document.hidden) {
      void this._checkHealth();
    }
  }

  _onWindowFocus() {
    void this._checkHealth();
  }

  _onOnline() {
    void this._checkHealth({ force: true });
  }

  _onOffline() {
    this._enhancerHealthy = false;
    this._lastHealthCheck = Date.now();
  }

  // ---- Idle detection -------------------------------------------------------

  _onIdle() {
    const text = this.input.value;

    // Stop conditions: don't suggest if profile says stop, or user dismissed too many times,
    // or the text matches the last rendered hash
    if (this._profile && this._profile.recommendation === 'stop') return;
    if (this._consecutiveDismissals >= this.MAX_DISMISSALS_BEFORE_SILENCE) return;
    if (this._lastRenderedHash && this._hash(text) === this._lastRenderedHash) return;

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
          this._recordModelOutcome(!!data && !!data.suggestion);

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
          this._recordModelOutcome(false);
        });
    } else {
      // ---- Local suggestion path — use profile-aware targeted suggestions ----
      if (!this._canSuggestLocal()) return;
      if (Date.now() - this.lastSuggestAt < this.LOCAL_SUGGEST_GAP) return;

      const suggestion = this._computeSuggestion(text);
      if (suggestion) {
        this.lastSuggestAt = Date.now();
        this._showGhost(suggestion);
      }
    }
  }

  _computeSuggestion(text) {
    // Priority 1: gap-targeted suggestions from profile
    if (this._profile && this._profile.shadow && this._profile.shadow.gaps) {
      const gaps = this._profile.shadow.gaps;
      if (gaps.length > 0) {
        const gap = gaps[0];
        if (/failure|error/.test(gap)) return '\nOn failure: retry → fallback → notify';
        if (/end state|response/.test(gap)) return '\n→ return result to caller';
        if (/trigger|entry/.test(gap)) return 'User initiates → ';
        if (/constraint|limit/.test(gap)) return '\nConstraint: max 3 retries, 5s timeout';
        if (/boundar|layer/.test(gap)) return '\n[Security layer]: ';
      }
    }

    // Priority 2: fall back to pattern-based local suggestions
    return this._localSuggest(text);
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
    this.ghostLayer.scrollLeft = this.input.scrollLeft;
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

    this._emitInput();
    this.onAccept();
  }

  _enterCooldown() {
    this.inCooldown = true;
    this.charsSinceCooldown = 0;
  }

  // ---- Active enhancement ---------------------------------------------------

  async enhance() {
    if (this.isEnhancing) return;
    if (this.input.readOnly) return;
    this._dismissGhost();
    clearTimeout(this._idleTimer);

    const text = this.input.value.trim();
    if (text.length < 10) return;

    const selStart = this.input.selectionStart;
    const selEnd = this.input.selectionEnd;
    const hasSelection = selStart !== selEnd;

    this.isEnhancing = true;
    const inputAtStart = this.input.value;

    let payload;
    let selectedText = '';
    if (hasSelection) {
      selectedText = this.input.value.slice(selStart, selEnd);
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

    if (!this._isHealthy()) {
      await new Promise(resolve => setTimeout(resolve, 140));
      this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
      this._finishEnhance();
      return;
    }

    this._enhanceAC = new AbortController();
    const timeoutId = setTimeout(() => this._enhanceAC && this._enhanceAC.abort(), this.ENHANCE_TIMEOUT);

    try {
      const res = await fetch(`${this.apiBase}/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this._enhanceAC.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
        return;
      }

      const data = await res.json();
      const enhanced = data.enhanced_source || data.suggestion || '';
      if (!enhanced) {
        this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
        return;
      }

      // Avoid stale overwrites if input changed during async request.
      if (!hasSelection && this.input.value !== inputAtStart) return;
      if (hasSelection && this.input.value.slice(selStart, selEnd) !== selectedText) return;

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

      this._emitInput();
      this.onAccept();
    } catch {
      this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
    } finally {
      clearTimeout(timeoutId);
      this._finishEnhance();
    }
  }

  _applyLocalEnhance(hasSelection, selStart, selEnd, selectedText) {
    const current = this.input.value;
    if (!current.trim()) return;

    if (hasSelection) {
      const replacement = this._localEnhanceText(selectedText);
      const before = current.slice(0, selStart);
      const after = current.slice(selEnd);
      this.input.value = before + replacement + after;
      const caret = selStart + replacement.length;
      this.input.setSelectionRange(caret, caret);
    } else {
      const replacement = this._localEnhanceText(current);
      this.input.value = replacement;
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    this._emitInput();
    this.onAccept();
  }

  _localEnhanceText(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return text;

    // Preserve explicit Mermaid-like syntax and arrow-rich content.
    if (/-->|->|==>|subgraph|classDef|flowchart|sequenceDiagram/i.test(normalized)) {
      return text.trim();
    }

    let parts = normalized
      .split(/\s*(?:[.;]|,\s+(?=\b(?:then|next|after|finally|if|when|on)\b)|\bthen\b|\bnext\b|\bafter\b|\bfinally\b)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);

    if (parts.length <= 1) {
      parts = normalized
        .split(/\s+\band\s+(?=\b(?:the|a|an|user|client|api|service|gateway|database|queue|cache)\b)/i)
        .map(s => s.trim())
        .filter(Boolean);
    }

    if (parts.length <= 1) {
      return normalized;
    }

    return parts
      .map((part, idx) => (idx === 0 ? this._capitalize(part) : `→ ${this._decapitalize(part)}`))
      .join('\n');
  }

  _capitalize(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  _decapitalize(str) {
    if (!str) return str;
    return str.charAt(0).toLowerCase() + str.slice(1);
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
    const left = markerRect.left - mirrorRect.left - this.input.scrollLeft;
    document.body.removeChild(mirror);

    return { top, left };
  }

  // ---- API calls ------------------------------------------------------------

  async _callSuggest(text, signal) {
    if (!this.apiBase) return null;

    const lines = text.split('\n');
    let activeLine = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) { activeLine = lines[i].trim(); break; }
    }

    // cursor_context: last 200 characters before cursor
    const cursorPos = this.input.selectionEnd || text.length;
    const cursorContext = text.slice(Math.max(0, cursorPos - 200), cursorPos);

    const res = await fetch(`${this.apiBase}/enhance`, {
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

  // ---- Profile analysis -----------------------------------------------------

  async _refreshProfile() {
    const text = this.input.value;
    if (document.hidden || this.input.readOnly || text.trim().length < this.MIN_ANALYZE_CHARS) return;

    const hash = this._hash(text);
    if (hash === this._lastAnalyzedHash) return;

    const now = Date.now();
    if (now - this._lastAnalyzeAt < this.ANALYZE_MIN_GAP_MS) {
      clearTimeout(this._analyzeTimer);
      this._analyzeTimer = setTimeout(
        () => this._refreshProfile(),
        this.ANALYZE_MIN_GAP_MS - (now - this._lastAnalyzeAt),
      );
      return;
    }

    this._lastAnalyzedHash = hash;
    this._lastAnalyzeAt = now;

    if (this._analyzeAC) this._analyzeAC.abort();
    const controller = new AbortController();
    this._analyzeAC = controller;

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode: 'idea' }),
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.profile) {
        this._profile = data.profile;
        if (this.onProfileUpdate) this.onProfileUpdate(this._profile);
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Non-critical: profile analysis failure doesn't block anything
    } finally {
      if (this._analyzeAC === controller) {
        this._analyzeAC = null;
      }
    }
  }

  getProfile() {
    return this._profile;
  }

  setRenderedHash(text) {
    this._lastRenderedHash = this._hash(text || '');
  }

  // ---- Adaptive health tracking -------------------------------------------

  _recordModelOutcome(success) {
    this._recentModelOutcomes.push(success);
    if (this._recentModelOutcomes.length > this.MODEL_OUTCOME_WINDOW) {
      this._recentModelOutcomes.shift();
    }
  }

  _isModelReliable() {
    if (this._recentModelOutcomes.length < 3) return true;
    const successes = this._recentModelOutcomes.filter(Boolean).length;
    return successes / this._recentModelOutcomes.length >= 0.5;
  }

  // ---- Utilities ------------------------------------------------------------

  _emitInput() {
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return String(h);
  }
};
