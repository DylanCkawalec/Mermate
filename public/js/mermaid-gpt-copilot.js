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
    this.onEnhanceStart = options.onEnhanceStart || (() => {});
    this.onEnhanceComplete = options.onEnhanceComplete || (() => {});
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

    // Initial health check is deferred to the boot sequence in mermaid-gpt-app.js
    // which calls setHealthState() after fetching /api/copilot/health.
    // This avoids a redundant API call on page load.
  }

  /**
   * Set health state externally (from boot sequence or other coordinator).
   * Avoids redundant /api/copilot/health fetches when another caller already
   * has the result.
   */
  setHealthState(healthy) {
    this._enhancerHealthy = !!healthy;
    this._lastHealthCheck = Date.now();
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
    const enhanceStartedAt = Date.now();
    this._setEnhancingVisuals(true);

    // Fire start callback (used for toast notifications, etc.)
    try { this.onEnhanceStart({ inputChars: this.input.value.length, hasSelection }); } catch {}

    // Iterative-context support: stash the previous accepted version so the
    // server can use it as context on the next click. This is what powers
    // "click expand → edit → click again to refine" without losing intent.
    const previousText = this._lastEnhancedSource || '';

    // Full input goes to the server (up to ~80K chars). The old slice(0,2000)
    // silently truncated whitepapers and LaTeX pastes to their preamble,
    // which is why large-input enhance felt broken. The distill flavor on
    // the server is the consumer of this; refine/expand will ignore the
    // excess characters since their token-budget is smaller.
    const MAX_INPUT_CHARS = 80000;
    const fullValue = this.input.value;
    const inputChars = fullValue.length;
    const sentToServer = fullValue.length > MAX_INPUT_CHARS
      ? fullValue.slice(0, MAX_INPUT_CHARS)
      : fullValue;

    let payload;
    let selectedText = '';
    if (hasSelection) {
      selectedText = this.input.value.slice(selStart, selEnd);
      payload = {
        stage: 'copilot_enhance',
        content_state: 'text',
        mode: 'idea',
        enhance_mode: 'selection',
        full_text: sentToServer,
        selected_text: selectedText,
        preceding_context: this.input.value.slice(Math.max(0, selStart - 500), selStart),
        following_context: this.input.value.slice(selEnd, selEnd + 200),
        previous_text: previousText.slice(0, 1500),
      };
      this._showThinking('selection', selEnd);
    } else {
      payload = {
        stage: 'copilot_enhance',
        content_state: 'text',
        mode: 'idea',
        enhance_mode: 'full',
        full_text: sentToServer,
        selected_text: null,
        preceding_context: '',
        following_context: '',
        previous_text: previousText.slice(0, 1500),
      };
      this._showThinking('full');
    }

    // Visible status hint: lets the user see that a large paste is being
    // processed (e.g. "Enhancing 24 KB → distill mode"). Without this, a
    // 30s wait on a whitepaper feels like the button is broken.
    this._showEnhanceStatus(inputChars);

    // Always attempt the API call on user click. The network request is
    // itself a faster, more accurate health probe than the cached
    // _isHealthy() flag (which races with first-click cold-start). If the
    // request fails, the catch block falls through to the local heuristic.
    //
    // Timeout scales with input size. A 100-char seed needs ≤12 s. A 100K-char
    // whitepaper through the distill prompt needs the full 120 s window so
    // the model can actually read and compress the document.
    this._enhanceAC = new AbortController();
    const scaledTimeoutMs = this._computeEnhanceTimeout(inputChars);
    const timeoutId = setTimeout(() => this._enhanceAC && this._enhanceAC.abort(), scaledTimeoutMs);

    let applied = false;
    let lastError = null;
    try {
      const res = await fetch(`${this.apiBase}/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: this._enhanceAC.signal,
      });
      clearTimeout(timeoutId);

      // Successful API response also doubles as a positive health signal,
      // so subsequent calls skip the local fallback bypass.
      if (res.ok) {
        this._enhancerHealthy = true;
        this._lastHealthCheck = Date.now();
      }

      if (!res.ok) {
        // Try to extract the server's reason for the 503 so the no-op
        // tooltip can be specific (e.g. "Enhancer offline" vs
        // "Provider exhausted on distill flavor").
        try {
          const errJson = await res.json();
          lastError = errJson?.details || errJson?.error || `HTTP ${res.status}`;
        } catch {
          lastError = `HTTP ${res.status}`;
        }
        applied = this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
      } else {
        const data = await res.json();
        const enhanced = data.enhanced_source || data.suggestion || '';

        // Avoid stale overwrites if input changed during async request.
        const stillFresh = hasSelection
          ? this.input.value.slice(selStart, selEnd) === selectedText
          : this.input.value === inputAtStart;

        if (!enhanced || !stillFresh) {
          applied = this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
        } else {
          // Treat "API returned same text" as a no-op too — don't pretend
          // we enhanced when the model echoed the input back.
          const original = hasSelection ? selectedText : inputAtStart;
          if (enhanced.trim() === original.trim()) {
            applied = this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
          } else {
            // Typewriter animation: progressively reveal the enhanced text
            // so the user perceives the prompt-bar "blooming" while the
            // rainbow ring + textarea sheen run. This is the visible UX
            // payoff that signals "the agent did work for me".
            if (hasSelection) {
              const before = this.input.value.slice(0, selStart);
              const after = this.input.value.slice(selEnd);
              await this._typewriterReplace(before + enhanced + after, selStart + enhanced.length);
            } else {
              await this._typewriterReplace(enhanced, enhanced.length);
            }
            this._lastEnhancedSource = enhanced;
            this._emitInput();
            this.onAccept();
            applied = true;
          }
        }
      }
    } catch (err) {
      // AbortError from our timeout is the dominant failure mode on big
      // pastes; distinguish it so the no-op tooltip is actionable.
      if (err && err.name === 'AbortError') {
        lastError = `Timed out after ${Math.round(scaledTimeoutMs / 1000)}s — try Max mode or trim the input`;
      } else {
        lastError = (err && err.message) ? err.message : 'network error';
      }
      applied = this._applyLocalEnhance(hasSelection, selStart, selEnd, selectedText);
    } finally {
      clearTimeout(timeoutId);

      // Guarantee the rainbow ring is visible long enough for the user to
      // perceive it. 700ms is the lower bound that registers as a
      // deliberate animation rather than a flash.
      const MIN_ANIM_MS = 700;
      const elapsed = Date.now() - enhanceStartedAt;
      if (elapsed < MIN_ANIM_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_ANIM_MS - elapsed));
      }

      // If neither the API nor the heuristic produced a change, the user
      // would otherwise see nothing happen. Surface that explicitly via
      // the button's title attribute so they know the enhancer ran but
      // had nothing to add (instead of silently feeling broken).
      if (!applied) {
        this._signalEnhanceNoOp(lastError);
      }

      this._finishEnhance();

      // Fire completion callback (used for toast notifications, etc.)
      try {
        this.onEnhanceComplete({
          applied,
          error: lastError || null,
          elapsedMs: Date.now() - enhanceStartedAt,
          outputChars: this.input.value.length,
        });
      } catch {}
    }
  }

  /**
   * Heuristic local enhance fallback. Returns true only if it actually
   * changed the input (so the caller can show a "no-op" hint otherwise).
   */
  _applyLocalEnhance(hasSelection, selStart, selEnd, selectedText) {
    const current = this.input.value;
    if (!current.trim()) return false;

    if (hasSelection) {
      const replacement = this._localEnhanceText(selectedText);
      if (replacement.trim() === selectedText.trim()) return false;
      const before = current.slice(0, selStart);
      const after = current.slice(selEnd);
      this.input.value = before + replacement + after;
      const caret = selStart + replacement.length;
      this.input.setSelectionRange(caret, caret);
    } else {
      const replacement = this._localEnhanceText(current);
      if (replacement.trim() === current.trim()) return false;
      this.input.value = replacement;
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    this._emitInput();
    this.onAccept();
    return true;
  }

  /**
   * Progressively replace the textarea content over ~900–1500ms so the
   * rainbow ring is visibly doing work and the new architecture text
   * "blooms" in front of the user. Uses requestAnimationFrame so the
   * animation cooperates with browser paint cycles instead of fighting
   * them. Resolves only after the full target string is on screen.
   *
   * The total duration is bounded so even long expansions feel snappy:
   *   ≤ 80 chars  → ~600ms
   *   ≤ 400 chars → ~1100ms
   *   > 400 chars → ~1600ms (capped)
   */
  _typewriterReplace(targetText, finalCaretPos) {
    return new Promise((resolve) => {
      const len = targetText.length;
      const totalMs = Math.min(1600, Math.max(600, 600 + len * 1.6));
      const startedAt = performance.now();
      const stepFrame = (now) => {
        const elapsed = now - startedAt;
        const t = Math.min(1, elapsed / totalMs);
        // ease-out for a satisfying decelerating reveal
        const eased = 1 - Math.pow(1 - t, 2.2);
        const showLen = Math.max(1, Math.round(eased * len));
        this.input.value = targetText.slice(0, showLen);
        if (showLen < len) {
          requestAnimationFrame(stepFrame);
        } else {
          this.input.value = targetText;
          try { this.input.setSelectionRange(finalCaretPos, finalCaretPos); } catch {}
          resolve();
        }
      };
      requestAnimationFrame(stepFrame);
    });
  }

  /**
   * Surface "enhancer ran but produced no change" via the button's title
   * + a transient .enhance-noop class on the wrapper. Auto-clears so the
   * user can retry without a dangling indicator.
   *
   * @param {string} [reason] - Optional server-side or network reason
   *   string used to make the tooltip actionable (e.g. "Timed out after
   *   75s — try Max mode" instead of a generic "offline" message).
   */
  _signalEnhanceNoOp(reason) {
    const btn = document.getElementById('btn-enhance');
    if (btn) {
      const originalTitle = btn.title;
      const message = reason
        ? `Enhance returned no change — ${reason}`
        : 'Enhancer offline or had nothing to add — try a longer description';
      btn.title = message;
      btn.classList.add('enhance-noop');
      // Also log to the console so a developer inspecting the page can
      // see exactly why the click did not produce a result.
      try { console.warn('[copilot] enhance no-op:', reason || 'unknown'); } catch {}
      clearTimeout(this._noopTimer);
      this._noopTimer = setTimeout(() => {
        btn.classList.remove('enhance-noop');
        btn.title = originalTitle || 'Refine your idea (Cmd+Enter)';
      }, 3600);
    }
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
    this._hideEnhanceStatus();
    this._setEnhancingVisuals(false);
    this._enterCooldown();
  }

  /**
   * Scale the abort timeout by input size. Sparse seeds stay snappy; a
   * 100K-char paste gets the full 120 s window because the model needs to
   * actually read and compress it.
   *
   * Tiers (chars → timeout):
   *   ≤ 2 000   → 12 s   (seed / refine)
   *   ≤ 10 000  → 30 s   (small distill)
   *   ≤ 40 000  → 75 s   (medium distill)
   *   > 40 000  → 120 s  (large distill, full INFER_TIMEOUT_MS budget)
   */
  _computeEnhanceTimeout(chars) {
    if (chars <= 2000)  return 12000;
    if (chars <= 10000) return 30000;
    if (chars <= 40000) return 75000;
    return 180000;
  }

  /**
   * Render a small "Enhancing 24 KB → distill mode" pill above the button
   * so the user has visible confirmation that work is happening on large
   * pastes. Without it a 60s wait feels like a broken button.
   */
  _showEnhanceStatus(chars) {
    const wrap = this.wrapEl;
    if (!wrap) return;

    const kb = chars >= 1024 ? (chars / 1024).toFixed(1) + ' KB' : chars + ' chars';
    // Predict the flavor the server will choose so the pill matches reality.
    let predictedFlavor = 'refine';
    if (chars < 240) predictedFlavor = 'expand';
    else if (chars >= 2000) predictedFlavor = 'distill';

    let pill = wrap.querySelector('.copilot-enhance-status');
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'copilot-enhance-status';
      wrap.appendChild(pill);
    }
    pill.textContent = `Enhancing ${kb} → ${predictedFlavor} mode`;
    pill.hidden = false;
  }

  _hideEnhanceStatus() {
    const wrap = this.wrapEl;
    if (!wrap) return;
    const pill = wrap.querySelector('.copilot-enhance-status');
    if (pill) pill.hidden = true;
  }

  /**
   * Toggle the rainbow-ring + textarea-sheen visual state.
   * Idempotent: safe to call multiple times during the enhance lifecycle.
   */
  _setEnhancingVisuals(active) {
    const btn = document.getElementById('btn-enhance');
    const wrap = this.wrapEl;
    if (active) {
      btn?.classList.add('is-enhancing');
      wrap?.classList.add('is-enhancing');
    } else {
      btn?.classList.remove('is-enhancing');
      wrap?.classList.remove('is-enhancing');
    }
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
