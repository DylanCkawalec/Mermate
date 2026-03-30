/**
 * Mermaid-GPT — Main application controller.
 *
 * 5-tab agentic artifact progression:
 *   Simple Idea | Markdown Spec | Mermaid | TLA+ | TypeScript
 *
 * WorkflowOrchestrator owns all staging state. Readiness comes from
 * backend progressionUpdate payloads — the frontend never guesses.
 * Single Render button dispatches via per-stage strategies.
 */
(function () {
  'use strict';

  // =========================================================================
  //  WorkflowOrchestrator — FSM + artifact graph + pub/sub
  // =========================================================================

  const STAGES = ['idea', 'md', 'mmd', 'tla', 'ts'];
  const INPUT_STAGES = new Set(['idea', 'md', 'mmd']);
  const RENDER_ICON_SVGS = {
    idea: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a4.5 4.5 0 0 1 2.25 8.4v1.85a1.25 1.25 0 0 1-1.25 1.25h-2a1.25 1.25 0 0 1-1.25-1.25V9.9A4.5 4.5 0 0 1 8 1.5z"/></svg>',
    md:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1.5" width="12" height="13" rx="1.5"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/></svg>',
    mmd:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="5 4 2 8 5 12"/><polyline points="11 4 14 8 11 12"/><line x1="9" y1="2" x2="7" y2="14"/></svg>',
    tla:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z"/><path d="M5 8h6"/><path d="M8 5.5v5"/></svg>',
    ts:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M8 6v5"/></svg>',
  };

  class WorkflowOrchestrator {
    constructor() {
      this.state = {
        currentStage: 'idea',
        unlockedStages: ['idea', 'md', 'mmd'],
        completed: {},
        confidence: {},
        guidance: {},
      };
      this.artifacts = {};
      this._subscribers = [];
    }

    get currentStage() { return this.state.currentStage; }
    get unlockedStages() { return this.state.unlockedStages; }

    isUnlocked(stage) {
      return this.state.unlockedStages.includes(stage);
    }

    isCompleted(stage) {
      return !!this.state.completed[stage];
    }

    switchTo(stage) {
      if (!this.isUnlocked(stage)) return false;
      this.state.currentStage = stage;
      this._notify();
      return true;
    }

    setArtifact(stage, source) {
      this.artifacts[stage] = source || '';
    }

    getArtifact(stage) {
      return this.artifacts[stage] || '';
    }

    updateFromBackend(payload) {
      if (!payload) return;
      if (payload.unlockedStages) {
        const merged = new Set([...this.state.unlockedStages, ...payload.unlockedStages]);
        this.state.unlockedStages = STAGES.filter(s => merged.has(s));
      }
      if (payload.stage) {
        this.state.completed[payload.stage] = true;
      }
      if (typeof payload.confidence === 'number' && payload.stage) {
        this.state.confidence[payload.stage] = payload.confidence;
      }
      if (payload.guidance && payload.stage) {
        this.state.guidance[payload.stage] = payload.guidance;
      }
      if (payload.nextRecommended && this.isUnlocked(payload.nextRecommended)) {
        this.state.currentStage = payload.nextRecommended;
      }
      this._persist();
      this._notify();
    }

    resetDownstream(fromStage) {
      const idx = STAGES.indexOf(fromStage);
      if (idx < 0) return;
      for (let i = idx + 1; i < STAGES.length; i++) {
        const s = STAGES[i];
        delete this.state.completed[s];
        delete this.state.confidence[s];
        delete this.state.guidance[s];
        delete this.artifacts[s];
      }
      this.state.unlockedStages = this.state.unlockedStages.filter(s => STAGES.indexOf(s) <= idx);
      this._persist();
      this._notify();
    }

    resetAll() {
      this.state = {
        currentStage: 'idea',
        unlockedStages: ['idea', 'md', 'mmd'],
        completed: {},
        confidence: {},
        guidance: {},
      };
      this.artifacts = {};
      this._persist();
      this._notify();
    }

    subscribe(cb) { this._subscribers.push(cb); }

    _notify() {
      for (const cb of this._subscribers) {
        try { cb(this.state); } catch { /* subscriber errors must not break orchestrator */ }
      }
    }

    _persist() {
      try {
        sessionStorage.setItem('mermate_workflow', JSON.stringify({
          state: this.state,
          artifacts: this.artifacts,
        }));
      } catch { /* storage full or unavailable */ }
    }

    restore() {
      try {
        const raw = sessionStorage.getItem('mermate_workflow');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.state) this.state = { ...this.state, ...saved.state };
        if (saved.artifacts) this.artifacts = saved.artifacts;
      } catch { /* corrupt or missing */ }
    }
  }

  const orchestrator = new WorkflowOrchestrator();

  // =========================================================================
  //  DOM Elements
  // =========================================================================

  const input = document.getElementById('mermaid-input');
  const btnRender = document.getElementById('btn-render');
  const renderIcon = document.getElementById('render-icon');
  const btnNewDiagram = document.getElementById('btn-new-diagram');
  const btnFlip = document.getElementById('btn-flip');
  const btnResetZoom = document.getElementById('btn-reset-zoom');
  const btnDownload = document.getElementById('btn-download');
  const btnDismissError = document.getElementById('btn-dismiss-error');
  const btnUpload = document.getElementById('btn-upload');
  const fileUpload = document.getElementById('file-upload');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingVisual = document.getElementById('loading-visual');
  const diagramNameInput = document.getElementById('diagram-name-input');
  const loadingText = document.getElementById('loading-text');
  const resultSection = document.getElementById('result-section');
  const artifactResults = document.getElementById('artifact-results');
  const tlaResultsEl = document.getElementById('tla-results');
  const tsResultsEl = document.getElementById('ts-results');
  const errorBanner = document.getElementById('error-banner');
  const errorMessage = document.getElementById('error-message');
  const typeBadge = document.getElementById('diagram-type-badge');
  const stateBadge = document.getElementById('content-state-badge');
  const chkEnhance = document.getElementById('chk-enhance');
  const inputHint = document.getElementById('input-hint');
  const nextActionChip = document.getElementById('next-action-chip');
  const resultPng = document.getElementById('result-png');
  const resultSvg = document.getElementById('result-svg');
  const flipCardEl = document.getElementById('flip-card');
  const flipCardContainer = document.getElementById('flip-card-container');
  const panZoomFront = document.getElementById('pan-zoom-front');
  const panZoomBack = document.getElementById('pan-zoom-back');
  const sidebarList = document.getElementById('sidebar-list');
  const expandBtns = document.querySelectorAll('.btn-expand');

  // ---- Components ----
  const flipCard = new window.FlipCard(flipCardEl);
  let pzFront = null;
  let pzBack = null;

  const sidebar = new window.MermaidSidebar(sidebarList, (item) => {
    showResult(item.paths, item.name, item.run_id);
  });

  const runDetailsEl = document.getElementById('run-details');
  const btnBackToMain = document.getElementById('btn-back-to-main');
  let _mainPaths = null;
  const runDetails = runDetailsEl
    ? new window.MermaidRunDetails(runDetailsEl, (sv) => {
        if (sv.png || sv.svg) {
          _mainPaths = currentPaths;
          showResult({ png: sv.png, svg: sv.svg }, 'subview');
          if (btnBackToMain) btnBackToMain.hidden = false;
        }
      })
    : null;

  if (btnBackToMain) {
    btnBackToMain.addEventListener('click', () => {
      if (_mainPaths) {
        showResult(_mainPaths, currentDiagramName);
        _mainPaths = null;
      }
      btnBackToMain.hidden = true;
    });
  }

  // ---- Max mode ----
  const btnMax = document.getElementById('btn-max');
  let maxMode = false;

  // ---- Agent mode ----
  const btnAgentToggle = document.getElementById('btn-agent-toggle');
  const agentDropdown = document.getElementById('agent-dropdown');
  const btnAgentRun = document.getElementById('btn-agent-run');
  const agentPanel = document.getElementById('agent-panel');
  const agentPanelLog = document.getElementById('agent-panel-log');
  const agentPanelMode = document.getElementById('agent-panel-mode');
  const btnAgentStop = document.getElementById('btn-agent-stop');
  let agentModeActive = false;
  let selectedAgentMode = null;
  let agent = null;

  // ---- State ----
  let isLoading = false;
  let currentMode = 'idea';
  let currentDiagramName = '';
  let currentPaths = null;
  let currentRunId = null;

  function _persistSession() {
    try {
      sessionStorage.setItem('mermate_session', JSON.stringify({
        runId: currentRunId, diagramName: currentDiagramName, paths: currentPaths,
      }));
    } catch {}
  }

  function _restoreSession() {
    try {
      const raw = sessionStorage.getItem('mermate_session');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.runId) currentRunId = s.runId;
      if (s.diagramName) currentDiagramName = s.diagramName;
      if (s.paths) currentPaths = s.paths;
    } catch {}
  }
  let isFullscreen = false;
  let copilot = null;
  let speech = null;
  let renderEffect = null;
  let renderEffectLoader = null;
  let loadingHideTimer = null;
  let profileHint = '';
  let agentState = 'idle';
  let notesDirty = false;

  const AGENT_MODES_BY_STAGE = {
    idea: [
      { id: 'thinking',     icon: '\u{1F4A1}', name: 'Thinking',    desc: 'Build architecture from ideas or notes' },
      { id: 'code-review',  icon: '\u{1F50D}', name: 'Code Review', desc: 'Recover architecture from a codebase' },
      { id: 'optimize-mmd', icon: '\u26A1',     name: 'Optimize',    desc: 'Improve existing Mermaid or markdown' },
    ],
    md:  null,
    mmd: null,
    tla: [
      { id: 'tla-verify',   icon: '\u2713',     name: 'Verify Spec',   desc: 'Validate and repair TLA+ specification' },
      { id: 'tla-optimize', icon: '\u26A1',     name: 'Optimize TLA+', desc: 'Strengthen invariants and state coverage' },
    ],
    ts: [
      { id: 'ts-generate',  icon: '\u{1F528}', name: 'Generate Runtime', desc: 'Compile TLA+ spec to TypeScript' },
      { id: 'ts-optimize',  icon: '\u26A1',     name: 'Optimize TS',     desc: 'Improve generated TypeScript quality' },
    ],
  };

  function _getAgentModesForStage(stage) {
    return AGENT_MODES_BY_STAGE[stage] || AGENT_MODES_BY_STAGE.idea;
  }

  function _rebuildAgentDropdown() {
    const dropdown = document.getElementById('agent-dropdown');
    if (!dropdown) return;

    const modes = _getAgentModesForStage(currentMode);
    dropdown.innerHTML = '';

    for (const mode of modes) {
      const btn = document.createElement('button');
      btn.className = 'agent-mode-option';
      btn.dataset.agentMode = mode.id;
      if (mode.id === selectedAgentMode) btn.classList.add('selected');

      btn.innerHTML = `<span class="agent-mode-icon">${mode.icon}</span>`
        + `<span class="agent-mode-info">`
        + `<span class="agent-mode-name">${mode.name}</span>`
        + `<span class="agent-mode-desc">${mode.desc}</span>`
        + `</span>`;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAgentMode(mode.id);
      });

      dropdown.appendChild(btn);
    }

    if (selectedAgentMode) {
      const validIds = modes.map(m => m.id);
      if (!validIds.includes(selectedAgentMode)) {
        setAgentMode(null);
      }
    }
  }

  const COPILOT_API_BASE = '/api/copilot';

  // =========================================================================
  //  Mode Configuration (5 stages)
  // =========================================================================

  const MODES = {
    idea: {
      placeholder: 'Describe your system, workflow, or diagram idea...\n\nStart simply:\n  "A user logs in, the server checks credentials, then redirects to dashboard"\n\nOr more structured:\n  "Payment flow: Browser \u2192 API Gateway \u2192 Payment Service \u2192 Stripe \u2192 Bank\n   - on success: return confirmation to browser\n   - on failure: show error, retry up to 3 times \u2192 dead letter queue"\n\nUseful signals: actors, services, arrows (\u2192), steps, decisions, states, failures',
      hint: 'Type an idea \u00b7 \u2318\u23ce / Ctrl+Return to enhance text \u00b7 Tab to accept suggestion',
      enhanceDefault: true,
      showUpload: false,
    },
    md: {
      placeholder: 'Paste your markdown architecture specification...',
      hint: 'Paste or upload a markdown spec with diagram descriptions',
      enhanceDefault: true,
      showUpload: true,
      accept: '.md,.markdown,.txt',
    },
    mmd: {
      placeholder: 'Paste or upload .mmd Mermaid source...',
      hint: 'Paste Mermaid source directly for compilation',
      enhanceDefault: false,
      showUpload: true,
      accept: '.mmd',
    },
    tla: {
      placeholder: 'TLA+ specification source...\n\nGenerated after a successful Mermaid render.\nPress Render to verify with SANY and TLC.',
      hint: 'Edit the TLA+ specification, then Render to verify with SANY/TLC',
      enhanceDefault: false,
      showUpload: false,
    },
    ts: {
      placeholder: 'TypeScript runtime source...\n\nGenerated after TLA+ verification.\nPress Render to compile and run the test harness.',
      hint: 'Edit the TypeScript runtime, then Render to compile and test',
      enhanceDefault: false,
      showUpload: false,
    },
  };

  const LOADING_MESSAGES = {
    text: 'Converting text to diagram...',
    md: 'Extracting diagram from markdown...',
    mmd: 'Compiling diagram...',
    hybrid: 'Repairing and compiling...',
    tla: 'Verifying TLA+ specification...',
    ts: 'Compiling TypeScript runtime...',
  };

  const STATE_LABELS = {
    text: 'plain text',
    md: 'markdown',
    mmd: 'mermaid',
    hybrid: 'mixed input',
    tla: 'TLA+',
    ts: 'TypeScript',
  };

  const AGENT_MODE_LABELS = {
    thinking: 'Thinking',
    'code-review': 'Code Review',
    'optimize-mmd': 'Optimize',
  };

  function getAgentModeLabel(modeId) {
    return AGENT_MODE_LABELS[modeId] || (modeId ? modeId.replace(/-/g, ' ') : 'Agent');
  }

  // =========================================================================
  //  Reactive View — renderUI() called on orchestrator state changes
  // =========================================================================

  function renderUI(state) {
    const mode = state.currentStage;

    document.querySelectorAll('.mode-btn').forEach(btn => {
      const btnMode = btn.dataset.mode;
      const unlocked = orchestrator.isUnlocked(btnMode);
      const wasHidden = btn.hidden;
      btn.hidden = !unlocked;
      btn.classList.toggle('active', btnMode === mode);
      btn.setAttribute('aria-checked', btnMode === mode ? 'true' : 'false');

      if (wasHidden && unlocked && (btnMode === 'tla' || btnMode === 'ts')) {
        btn.classList.add('newly-unlocked');
        setTimeout(() => btn.classList.remove('newly-unlocked'), 800);
      }

      const badge = btn.querySelector('.stage-badge');
      if (badge) {
        const conf = state.confidence[btnMode];
        if (conf !== undefined) {
          badge.hidden = false;
          badge.textContent = `${Math.round(conf * 100)}%`;
          badge.className = 'stage-badge';
          if (conf >= 0.8) badge.classList.add('stage-pass');
          else if (conf >= 0.5) badge.classList.add('stage-warn');
          else badge.classList.add('stage-fail');
        } else if (orchestrator.isCompleted(btnMode)) {
          badge.hidden = false;
          badge.textContent = '\u2713';
          badge.className = 'stage-badge stage-pass';
        } else if (unlocked && !orchestrator.isCompleted(btnMode) && (btnMode === 'tla' || btnMode === 'ts')) {
          badge.hidden = false;
          badge.textContent = 'Ready';
          badge.className = 'stage-badge stage-ready';
        } else {
          badge.hidden = true;
        }
      }
    });

    if (renderIcon) {
      renderIcon.innerHTML = RENDER_ICON_SVGS[mode] || RENDER_ICON_SVGS.idea;
    }

    const isDiagramMode = INPUT_STAGES.has(mode);
    if (flipCardContainer) flipCardContainer.hidden = !isDiagramMode;
    const resultControls = document.querySelector('.result-controls');
    if (resultControls) resultControls.hidden = !isDiagramMode;

    if (artifactResults) {
      const showArtifacts = (mode === 'tla' || mode === 'ts');
      artifactResults.hidden = !showArtifacts;
      if (tlaResultsEl) tlaResultsEl.hidden = mode !== 'tla';
      if (tsResultsEl) tsResultsEl.hidden = mode !== 'ts';
    }

    if (isDiagramMode && currentPaths) {
      resultSection.hidden = false;
    } else if (!isDiagramMode) {
      if (artifactResults && !artifactResults.hidden) {
        resultSection.hidden = false;
      }
    }
  }

  orchestrator.subscribe(renderUI);

  // =========================================================================
  //  Mode Selector (save/restore per-tab content)
  // =========================================================================

  function setMode(mode) {
    if (!orchestrator.isUnlocked(mode)) return;

    orchestrator.setArtifact(currentMode, input.value);

    currentMode = mode;
    orchestrator.switchTo(mode);

    const cfg = MODES[mode] || MODES.idea;
    input.value = orchestrator.getArtifact(mode);
    input.placeholder = cfg.placeholder;
    chkEnhance.checked = cfg.enhanceDefault;
    const _btnEnh = document.getElementById('btn-enhance');
    if (_btnEnh) _btnEnh.classList.toggle('active', chkEnhance.checked);

    if (cfg.showUpload) {
      btnUpload.classList.add('visible');
      if (fileUpload) fileUpload.setAttribute('accept', cfg.accept || '');
    } else {
      btnUpload.classList.remove('visible');
    }

    try {
      if (mode === 'idea' && window.MermaidCopilot) {
        if (copilot) copilot.destroy();
        copilot = new window.MermaidCopilot(input, {
          apiBase: COPILOT_API_BASE,
          onAccept: updateBadges,
          onProfileUpdate: _onProfileUpdate,
        });
      } else if (copilot) {
        copilot.destroy();
        copilot = null;
      }
    } catch { copilot = null; }

    _rebuildAgentDropdown();
    syncUiGuidance();
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // =========================================================================
  //  UI Guidance
  // =========================================================================

  function syncUiGuidance() {
    const source = input.value || '';
    const hasInput = source.trim().length > 0;
    const hasName = !!diagramNameInput?.value?.trim();
    const hasResult = !!currentPaths;
    const activeMode = MODES[currentMode] || MODES.idea;
    let hint = activeMode.hint;
    let nextAction = '';
    let tone = 'ready';

    if (isLoading) {
      hint = loadingText.textContent || 'Compiling...';
      nextAction = 'Next: wait for the current render';
      tone = 'busy';
    } else if (agentState === 'running') {
      hint = `${getAgentModeLabel(selectedAgentMode)} agent is building a preview from your prompt.`;
      nextAction = 'Next: wait for the preview';
      tone = 'busy';
    } else if (agentState === 'awaiting_notes') {
      hint = notesDirty
        ? 'Preview ready. Your notes will steer the final Max pass.'
        : 'Preview ready. Add notes for the final pass or keep the current draft.';
      nextAction = notesDirty ? 'Next: enhance with notes' : 'Next: render as is or add notes';
      tone = 'ready';
    } else if (agentState === 'finalizing') {
      hint = 'Applying the final pass and compiling the diagram.';
      nextAction = 'Next: wait for the final result';
      tone = 'busy';
    } else if (agentModeActive && selectedAgentMode) {
      hint = hasInput
        ? `Agent: ${getAgentModeLabel(selectedAgentMode)} mode. Run the agent when the prompt is ready.`
        : `Agent: ${getAgentModeLabel(selectedAgentMode)} mode. Enter the architecture prompt to begin.`;
      nextAction = hasInput ? 'Next: run agent' : (hasName ? 'Next: describe the architecture' : 'Next: enter prompt');
      tone = 'ready';
    } else if (currentMode === 'tla') {
      hint = hasInput ? activeMode.hint : 'Switch to the TLA+ tab and press Render to generate and verify.';
      nextAction = hasInput ? 'Next: render to verify TLA+' : 'Next: render to generate TLA+ spec';
      tone = 'ready';
    } else if (currentMode === 'ts') {
      hint = hasInput ? activeMode.hint : 'Switch to the TypeScript tab and press Render to generate.';
      nextAction = hasInput ? 'Next: render to compile TypeScript' : 'Next: render to generate TypeScript runtime';
      tone = 'ready';
    } else if (!hasInput) {
      if (currentMode === 'idea') {
        hint = hasName ? 'Describe the system, actors, and flow direction.' : activeMode.hint;
        nextAction = hasName ? 'Next: describe the architecture' : 'Next: enter an idea';
      } else if (currentMode === 'md') {
        nextAction = 'Next: paste or upload a markdown spec';
      } else {
        nextAction = 'Next: paste Mermaid source or upload .mmd';
      }
    } else if (hasResult) {
      hint = currentMode === 'idea'
        ? 'Diagram rendered. Refine the prompt, rerender, or inspect the result.'
        : 'Compiled output is ready. Refine the source or download the bundle.';
      nextAction = currentMode === 'idea'
        ? 'Next: refine prompt or rerender'
        : 'Next: update source or download';
      tone = 'result';
    } else {
      if (currentMode === 'idea' && profileHint) {
        hint = profileHint;
      }
      nextAction = currentMode === 'idea'
        ? 'Next: render or press Cmd/Ctrl+Enter to enhance'
        : 'Next: render the current source';
    }

    inputHint.textContent = hint;

    if (nextActionChip) {
      nextActionChip.textContent = nextAction;
      nextActionChip.dataset.tone = tone;
      nextActionChip.classList.toggle('is-visible', !!nextAction);
    }

    if (btnAgentCommit) {
      btnAgentCommit.textContent = notesDirty ? 'Enhance with notes' : 'Render as is';
      btnAgentCommit.disabled = agentState !== 'awaiting_notes';
    }

    input.setAttribute('aria-busy', isLoading || agentState === 'running' || agentState === 'finalizing' ? 'true' : 'false');
  }

  // =========================================================================
  //  File Upload
  // =========================================================================

  btnUpload.addEventListener('click', () => fileUpload.click());

  fileUpload.addEventListener('change', () => {
    const file = fileUpload.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      input.value = reader.result;
      updateBadges();
    };
    reader.readAsText(file);
    fileUpload.value = '';
  });

  // =========================================================================
  //  Helpers
  // =========================================================================

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.hidden = true;
  }

  function setLoading(on, contentState) {
    isLoading = on;
    btnRender.disabled = on;
    input.readOnly = on;
    if (on && contentState && LOADING_MESSAGES[contentState]) {
      loadingText.textContent = LOADING_MESSAGES[contentState];
    } else if (on) {
      loadingText.textContent = 'Compiling...';
    }

    if (on) {
      if (loadingHideTimer) { clearTimeout(loadingHideTimer); loadingHideTimer = null; }
      loadingOverlay.hidden = false;
      loadingOverlay.classList.add('is-visible');
      void ensureRenderEffect();
    } else {
      loadingOverlay.classList.remove('is-visible');
      teardownRenderEffect();
      loadingHideTimer = setTimeout(() => {
        loadingOverlay.hidden = true;
        loadingHideTimer = null;
      }, 220);
    }
    syncUiGuidance();
  }

  function showResult(paths, name, runId, metrics) {
    currentPaths = paths;
    currentDiagramName = name || 'diagram';
    currentRunId = runId || null;
    const ts = Date.now();
    resultSection.hidden = false;

    if (INPUT_STAGES.has(currentMode)) {
      flipCard.showFront();
      if (flipCardContainer) flipCardContainer.hidden = false;
    }

    if (runDetails && runId) {
      runDetails.show(runId);
    } else if (runDetails && !runId) {
      runDetails.hide();
    }

    resultPng.onload = () => {
      if (!pzFront) pzFront = new window.PanZoom(panZoomFront, resultPng);
      pzFront.fitToViewport();
    };
    resultPng.src = paths.png + '?t=' + ts;

    resultSvg.onload = () => {
      if (!pzBack) pzBack = new window.PanZoom(panZoomBack, resultSvg);
      pzBack.fitToViewport();
    };
    resultSvg.src = paths.svg + '?t=' + ts;

    resultSection.classList.add('is-revealing');
    window.setTimeout(() => resultSection.classList.remove('is-revealing'), 220);

    orchestrator.updateFromBackend({
      stage: 'mmd',
      unlockedStages: ['idea', 'md', 'mmd', 'tla'],
      confidence: 1.0,
    });

    _persistSession();
    syncUiGuidance();

    _playRenderReveal({
      stage: currentMode,
      isFinal: false,
      diagramName: currentDiagramName,
      metrics: metrics || null,
      paths: currentPaths,
    });
  }

  // ============================================================
  //  MERMATE Reveal System — stage-aware notification pod
  //  · Small, bottom-center, non-blocking
  //  · 6x video speed → plays in < 1 second
  //  · Stage-colored glow (yellow → cyan → indigo → violet → emerald)
  //  · Subtitle message at bottom — click to copy
  //  · Click video → focus result section
  //  · Click anywhere outside pod → dismiss
  //  · Raindrop sound on mount
  // ============================================================

  let _revealActive = false;

  const _STAGE_CFG = {
    idea:  { color: '#fbbf24', rgb: '251,191,36',   label: 'STAGE 1 · IDEA'      },
    md:    { color: '#38bdf8', rgb: '56,189,248',   label: 'STAGE 2 · MARKDOWN'  },
    mmd:   { color: '#818cf8', rgb: '129,140,248',  label: 'STAGE 3 · DIAGRAM'   },
    tla:   { color: '#a78bfa', rgb: '167,139,250',  label: 'STAGE 4 · TLA+'      },
    ts:    { color: '#34d399', rgb: '52,211,153',   label: 'STAGE 5 · TYPESCRIPT' },
    final: { color: '#f59e0b', rgb: '245,158,11',   label: '✦ COMPLETE'          },
  };

  function _buildRevealMessage({ stage, isFinal, diagramName, metrics }) {
    const name = diagramName ? `"${diagramName}"` : 'architecture';
    if (isFinal && stage === 'ts') {
      return `✦ ${name} COMPLETE ✦ — All stages verified. Runtime compiled. Full architecture stack live.`;
    }
    if (isFinal && stage === 'tla') {
      const v = metrics?.variableCount ?? '?';
      const inv = metrics?.invariantCount ?? '?';
      return `★ ${name} formally verified · ${v} variables · ${inv} invariants — Generate TypeScript next?`;
    }
    if (stage === 'mmd' || isFinal) {
      const n = metrics?.nodeCount ?? '?';
      const e = metrics?.edgeCount ?? '?';
      return `★ ${name} rendered · ${n} nodes · ${e} edges — Open TLA+ to verify behavior, or Render as is.`;
    }
    const cfg = _STAGE_CFG[stage];
    return `${cfg?.label ?? 'MERMATE'} · ${name} updated — continue to next stage.`;
  }

  function _playRaindropSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      osc.connect(lp);
      lp.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(320, ctx.currentTime + 0.28);
      gain.gain.setValueAtTime(0.07, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch { /* audio not available */ }
  }

  function _playRenderReveal({ stage = 'mmd', isFinal = false, diagramName = '', metrics = null, paths = null } = {}) {
    if (_revealActive) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    _revealActive = true;

    const cfg = _STAGE_CFG[isFinal && stage === 'ts' ? 'final' : stage] || _STAGE_CFG.mmd;
    const message = _buildRevealMessage({ stage, isFinal, diagramName, metrics });

    // Raindrop sound
    _playRaindropSound();

    // ---- Inject keyframe styles (once) ----
    if (!document.getElementById('_rmRevealStyles')) {
      const s = document.createElement('style');
      s.id = '_rmRevealStyles';
      s.textContent = `
        @keyframes _rmGlowPulse {
          0%,100% { box-shadow: 0 0 12px 2px rgba(var(--rm-rgb),0.45), 0 0 40px 8px rgba(var(--rm-rgb),0.12), 0 8px 32px rgba(0,0,0,0.6); }
          50%     { box-shadow: 0 0 22px 5px rgba(var(--rm-rgb),0.70), 0 0 70px 18px rgba(var(--rm-rgb),0.22), 0 8px 32px rgba(0,0,0,0.6); }
        }
        @keyframes _rmSparkle {
          0%   { transform:scale(0) rotate(0deg);   opacity:0; }
          50%  { transform:scale(1.3) rotate(180deg); opacity:1; }
          100% { transform:scale(0) rotate(360deg); opacity:0; }
        }
        @keyframes _rmMsgSlide {
          from { transform:translateY(8px); opacity:0; }
          to   { transform:translateY(0);   opacity:1; }
        }
        @keyframes _rmBorderSpin {
          to { background-position: 200% center; }
        }
      `;
      document.head.appendChild(s);
    }

    // ---- Backdrop (click-away to dismiss) ----
    const backdrop = document.createElement('div');
    backdrop.style.cssText = [
      'position:fixed;inset:0;z-index:9990;',
      'cursor:pointer;',
    ].join('');
    backdrop.addEventListener('click', () => dismiss(), { once: true });
    document.body.appendChild(backdrop);

    // ---- Pod wrapper (bottom-center, small) ----
    const pod = document.createElement('div');
    pod.style.cssText = [
      'position:fixed;bottom:28px;left:50%;z-index:9999;',
      'transform:translateX(-50%) translateY(20px) scale(0.93);',
      'width:360px;',
      'border-radius:18px;overflow:hidden;',
      `border:1.5px solid rgba(${cfg.rgb},0.35);`,
      `--rm-rgb:${cfg.rgb};`,
      'background:rgba(5,10,28,0.82);',
      'backdrop-filter:blur(28px) saturate(1.5);',
      '-webkit-backdrop-filter:blur(28px) saturate(1.5);',
      'animation:_rmGlowPulse 2.2s ease-in-out infinite;',
      'opacity:0;',
      'transition:transform 0.5s cubic-bezier(0.34,1.56,0.64,1), opacity 0.4s ease;',
      'pointer-events:all;',
      'cursor:pointer;',
    ].join('');

    // Top pill label
    const pill = document.createElement('div');
    pill.style.cssText = [
      'position:absolute;top:9px;left:50%;transform:translateX(-50%);z-index:20;',
      `background:rgba(${cfg.rgb},0.15);`,
      `border:1px solid rgba(${cfg.rgb},0.35);`,
      `color:${cfg.color};`,
      'font-size:9px;font-weight:700;letter-spacing:0.14em;font-family:monospace;',
      'padding:3px 10px;border-radius:999px;white-space:nowrap;',
    ].join('');
    pill.textContent = cfg.label;
    pod.appendChild(pill);

    // Stage dot
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;top:10px;right:12px;z-index:20;width:7px;height:7px;border-radius:50%;background:${cfg.color};box-shadow:0 0 8px 2px rgba(${cfg.rgb},0.8);animation:_rmGlowPulse 1.6s ease-in-out infinite;`;
    pod.appendChild(dot);

    // Video (16:9 ratio inside pod)
    const videoWrap = document.createElement('div');
    videoWrap.style.cssText = 'position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;cursor:pointer;';

    const video = document.createElement('video');
    video.src = '/MERMATE_VIDEO.mp4';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.playbackRate = 6;   // <-- 6x speed: plays in < 1 second
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    videoWrap.appendChild(video);

    // Sparkles around video
    const sparkleColors = [cfg.color, 'rgba(167,139,250,0.9)', '#f9a8d4'];
    [['-8px','-8px'],['-8px','auto','auto','-8px'],['auto','-8px','auto','auto']].forEach((pos, i) => {
      const sp = document.createElement('div');
      const [top,right,bottom,left] = pos;
      sp.style.cssText = `position:absolute;${top!=='auto'?`top:${top};`:''}${right!=='auto'?`right:${right};`:''}${bottom!=='auto'?`bottom:${bottom};`:''}${left!=='auto'?`left:${left};`:''}z-index:15;pointer-events:none;animation:_rmSparkle ${1.8+i*0.4}s ease-in-out infinite ${i*300}ms;`;
      sp.innerHTML = `<svg width="10" height="10" viewBox="0 0 20 20" fill="${sparkleColors[i]}"><path d="M10 0 L11.8 8.2 L20 10 L11.8 11.8 L10 20 L8.2 11.8 L0 10 L8.2 8.2 Z"/></svg>`;
      videoWrap.appendChild(sp);
    });

    // Click video → jump to result section
    video.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
      const rs = document.getElementById('result-section');
      if (rs) {
        rs.hidden = false;
        rs.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    pod.appendChild(videoWrap);

    // Message subtitle bar
    const msgBar = document.createElement('div');
    msgBar.style.cssText = [
      `background:rgba(${cfg.rgb},0.08);`,
      `border-top:1px solid rgba(${cfg.rgb},0.2);`,
      'padding:10px 14px;',
      'cursor:pointer;',
      'display:flex;align-items:center;gap:8px;',
      'animation:_rmMsgSlide 0.5s ease 0.3s both;',
    ].join('');

    const msgText = document.createElement('span');
    msgText.style.cssText = `font-size:11px;color:rgba(255,255,255,0.82);font-family:monospace;line-height:1.4;flex:1;`;
    msgText.textContent = message;
    msgBar.appendChild(msgText);

    const copyBtn = document.createElement('span');
    copyBtn.style.cssText = `font-size:9px;color:rgba(${cfg.rgb},0.7);font-family:monospace;letter-spacing:0.08em;white-space:nowrap;border:1px solid rgba(${cfg.rgb},0.3);padding:2px 6px;border-radius:4px;flex-shrink:0;transition:all 0.15s;`;
    copyBtn.textContent = 'COPY';
    msgBar.appendChild(copyBtn);

    // Click message → copy to clipboard
    msgBar.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(message).then(() => {
        copyBtn.textContent = '✓ COPIED';
        copyBtn.style.color = cfg.color;
        setTimeout(() => { copyBtn.textContent = 'COPY'; copyBtn.style.color = ''; }, 1800);
      }).catch(() => {});
    });

    pod.appendChild(msgBar);

    // Click pod itself (not video/msg) → dismiss
    pod.addEventListener('click', (e) => {
      if (e.target === pod) dismiss();
    });

    document.body.appendChild(pod);

    // Animate in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pod.style.opacity = '1';
      pod.style.transform = 'translateX(-50%) translateY(0) scale(1)';
    }));

    function dismiss() {
      backdrop.remove();
      pod.style.opacity = '0';
      pod.style.transform = 'translateX(-50%) translateY(16px) scale(0.94)';
      pod.style.transition = 'transform 0.35s ease, opacity 0.3s ease';
      setTimeout(() => { pod.remove(); _revealActive = false; }, 360);
    }

    // Start video at 6x — catches 'canplay' in case not ready yet
    const tryPlay = () => {
      video.playbackRate = 6;
      video.play().catch(() => dismiss());
    };
    video.readyState >= 3 ? tryPlay() : video.addEventListener('canplay', tryPlay, { once: true });
    video.addEventListener('ended', dismiss, { once: true });

    // Safety: auto-dismiss after 3 seconds regardless
    const safetyTimer = setTimeout(dismiss, 3000);
    video.addEventListener('ended', () => clearTimeout(safetyTimer), { once: true });
  }

  async function ensureRenderEffect() {
    if (!loadingVisual || renderEffect) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      loadingVisual.classList.add('is-fallback');
      return;
    }
    try {
      renderEffectLoader ||= import('/js/rendering-effect.js');
      const { RenderWaitingEffect } = await renderEffectLoader;
      if (!isLoading || !loadingVisual.isConnected) return;
      loadingVisual.classList.remove('is-fallback');
      renderEffect = new RenderWaitingEffect(loadingVisual);
    } catch {
      loadingVisual.classList.add('is-fallback');
    }
  }

  function teardownRenderEffect() {
    loadingVisual?.classList.remove('is-fallback');
    if (renderEffect) { renderEffect.dispose(); renderEffect = null; }
  }

  function updateBadges() {
    const val = input.value;
    const diagramType = window.MermaidClassifier.classify(val);
    if (diagramType) {
      typeBadge.textContent = diagramType;
      typeBadge.classList.add('visible');
    } else {
      typeBadge.classList.remove('visible');
    }

    const contentState = window.MermaidClassifier.detectState(val);
    if (contentState) {
      stateBadge.textContent = STATE_LABELS[contentState] || contentState;
      stateBadge.setAttribute('data-state', contentState);
      stateBadge.classList.add('visible');
    } else {
      stateBadge.classList.remove('visible');
    }
    syncUiGuidance();
  }

  function _onProfileUpdate(profile) {
    profileHint = currentMode === 'idea' && profile?.hint ? profile.hint : '';
    syncUiGuidance();
  }

  // =========================================================================
  //  Text Transition Animation
  // =========================================================================

  const _TRANSITION_COLORS = ['#e8820c', '#4f46e5', '#db2777'];
  let _renderAnimating = false;

  function _tokenize(text) { return text.split(/(\s+)/).filter(t => t.trim()); }
  function _simpleHash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0; return h; }
  function _frame() { return new Promise(r => requestAnimationFrame(r)); }
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function animateRenderTransition(oldText, newText) {
    if (_renderAnimating || !newText) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      input.value = newText;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    _renderAnimating = true;
    const textarea = input;
    const oldWords = _tokenize(oldText || '');
    const newWords = _tokenize(newText);
    const oldSet = new Set(oldWords.map(w => w.toLowerCase()));
    const classified = newWords.map(w => ({ word: w, preserved: oldSet.has(w.toLowerCase()) }));

    const wrap = textarea.closest('.copilot-wrap') || textarea.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'render-typing-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;padding:14px;font-family:var(--font-mono);font-size:0.82rem;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;z-index:5;pointer-events:none;border-radius:var(--radius);background:var(--surface);';
    wrap.style.position = 'relative';
    textarea.style.opacity = '0';
    wrap.appendChild(overlay);

    const BATCH = 8, DELAY = 12;
    for (let i = 0; i < classified.length; i += BATCH) {
      const batch = classified.slice(i, i + BATCH);
      for (const item of batch) {
        const span = document.createElement('span');
        span.textContent = item.word + ' ';
        if (item.preserved) {
          const color = _TRANSITION_COLORS[Math.abs(_simpleHash(item.word)) % _TRANSITION_COLORS.length];
          span.style.cssText = `color:${color};font-weight:600;opacity:0;transition:opacity 0.15s,color 0.4s;`;
        } else {
          span.style.cssText = 'color:#9ca3af;opacity:0;transition:opacity 0.12s,color 0.5s;';
        }
        overlay.appendChild(span);
      }
      await _frame();
      const spans = overlay.querySelectorAll('span');
      for (let j = Math.max(0, i); j < Math.min(spans.length, i + BATCH); j++) spans[j].style.opacity = '1';
      if (DELAY > 0) await _sleep(DELAY);
    }
    await _sleep(120);
    overlay.querySelectorAll('span').forEach(s => { s.style.color = 'var(--text)'; s.style.fontWeight = 'normal'; });
    await _sleep(250);
    textarea.value = newText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.style.opacity = '1';
    overlay.style.transition = 'opacity 0.15s';
    overlay.style.opacity = '0';
    await _sleep(160);
    overlay.remove();
    _renderAnimating = false;
  }

  // =========================================================================
  //  Fullscreen
  // =========================================================================

  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    resultSection.classList.toggle('fullscreen', isFullscreen);
    expandBtns.forEach(btn => {
      btn.title = isFullscreen ? 'Exit fullscreen' : 'Expand';
      btn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen');
    });
  }

  expandBtns.forEach(btn => { btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFullscreen) toggleFullscreen(); });

  // =========================================================================
  //  ZIP Download
  // =========================================================================

  async function downloadBundle() {
    if (!currentPaths || !window.JSZip) return;
    try {
      const [pngRes, svgRes] = await Promise.all([fetch(currentPaths.png), fetch(currentPaths.svg)]);
      const [pngBlob, svgBlob] = await Promise.all([pngRes.blob(), svgRes.blob()]);
      const zip = new JSZip();
      zip.file(`${currentDiagramName}.png`, pngBlob);
      zip.file(`${currentDiagramName}.svg`, svgBlob);
      const now = new Date();
      const dateStr = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
      const timeStr = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const zipName = `${dateStr}_${timeStr}_${currentDiagramName}_bundle.zip`;
      const content = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(content);
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showError('Download failed: ' + err.message);
    }
  }

  // =========================================================================
  //  Render Strategies (Strategy pattern — one per stage family)
  // =========================================================================

  async function renderMermaid() {
    const source = input.value.trim();
    if (!source) { showError('Please enter a diagram description or paste Mermaid source.'); return; }

    hideError();
    const contentState = window.MermaidClassifier.detectState(source);
    setLoading(true, contentState);
    resultSection.hidden = true;
    if (isFullscreen) toggleFullscreen();

    try {
      const resp = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mermaid_source: source,
          diagram_name: diagramNameInput?.value?.trim() || undefined,
          enhance: chkEnhance.checked,
          input_mode: currentMode,
          max_mode: maxMode,
        }),
      });
      const data = await resp.json();
      if (!data.success) { showError(data.details || data.error || 'Compilation failed'); return; }

      const shouldAnimate = data.enhanced && data.compiled_source && data.content_state !== 'mmd';
      if (shouldAnimate) { setLoading(false); await animateRenderTransition(source, data.compiled_source); }

      showResult(data.paths, data.diagram_name, data.run_id, data.metrics);

      const finalText = shouldAnimate ? data.compiled_source : source;
      if (copilot) copilot.setRenderedHash(finalText);

      orchestrator.resetDownstream(currentMode);

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }

      sidebar.add({
        name: data.diagram_name,
        type: data.diagram_type,
        paths: data.paths,
        timestamp: new Date().toLocaleString(),
        source: source,
        contentState: data.content_state,
        run_id: data.run_id || null,
      });
    } catch (err) {
      if (err.name === 'TypeError') { showError('Could not reach server. Is Mermaid-GPT running?'); }
      else { showError(err.message || 'Unexpected error'); }
    } finally {
      setLoading(false);
    }
  }

  async function renderTla() {
    if (!currentRunId || !currentDiagramName) {
      showError('Render a diagram first to generate a TLA+ specification.');
      return;
    }

    hideError();
    setLoading(true, 'tla');

    try {
      const res = await fetch('/api/render/tla', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram_name: currentDiagramName, run_id: currentRunId }),
      });
      const data = await res.json();

      orchestrator.setArtifact('tla', data.tla_source || '');
      input.value = data.tla_source || '';

      const statusEl = document.getElementById('tla-status');
      const sourceEl = document.getElementById('tla-source');
      const invEl = document.getElementById('tla-invariants');
      const violPanel = document.getElementById('tla-violations-panel');
      const violEl = document.getElementById('tla-violations');
      const metricsEl = document.getElementById('tla-metrics');

      if (artifactResults) artifactResults.hidden = false;
      if (tlaResultsEl) tlaResultsEl.hidden = false;
      resultSection.hidden = false;

      if (!data.success) {
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${data.error || 'Unknown'}</span>`;
        if (sourceEl) sourceEl.textContent = '';
        if (invEl) invEl.innerHTML = '';
        return;
      }

      const sanyBadge = data.sany?.valid
        ? '<span class="tla-badge tla-pass">SANY: Pass</span>'
        : `<span class="tla-badge tla-fail">SANY: Fail (${data.sany?.repairAttempts || 0} repairs)</span>`;
      let tlcBadge = '';
      if (data.tlc?.checked) {
        tlcBadge = data.tlc.violations.length === 0
          ? `<span class="tla-badge tla-pass">TLC: ${data.tlc.statesExplored} states verified</span>`
          : `<span class="tla-badge tla-warn">TLC: ${data.tlc.violations.length} violation(s) found</span>`;
      } else {
        tlcBadge = '<span class="tla-badge tla-skip">TLC: Not run</span>';
      }

      if (statusEl) statusEl.innerHTML = `${sanyBadge} ${tlcBadge}`;
      if (sourceEl) sourceEl.textContent = data.tla_source || '';

      const invItems = (data.tlc?.invariantsChecked || []).map(inv =>
        `<div class="tla-inv-item">${inv} <span class="tla-badge tla-pass">checked</span></div>`
      ).join('');
      if (invEl) invEl.innerHTML = invItems || '<span class="tla-muted">No invariants checked</span>';

      if (data.tlc?.violations?.length > 0) {
        if (violPanel) violPanel.hidden = false;
        if (violEl) violEl.innerHTML = data.tlc.violations.map(v => {
          const steps = (v.trace || []).map(s =>
            `<div class="tla-trace-step">Step ${s.step}: <code>${s.action}</code> \u2014 ${JSON.stringify(s.variables)}</div>`
          ).join('');
          return `<div class="tla-violation"><strong>${v.invariant}</strong> violated after ${v.stateCount} states<div class="tla-trace">${steps || 'No trace available'}</div></div>`;
        }).join('');
      } else {
        if (violPanel) violPanel.hidden = true;
      }

      if (data.metrics && metricsEl) {
        const m = data.metrics;
        metricsEl.innerHTML = `<span>Variables: ${m.variableCount}</span><span>Actions: ${m.actionCount}</span><span>Invariants: ${m.invariantCount}</span><span>Entity coverage: ${(m.entityCoverage * 100).toFixed(0)}%</span><span>State space: ~${m.stateSpaceEstimate}</span>`;
      }

      const tlaConfidence = data.sany?.valid ? (data.tlc?.success ? 0.95 : 0.7) : 0.3;
      orchestrator.updateFromBackend({
        stage: 'tla',
        unlockedStages: data.sany?.valid ? ['idea', 'md', 'mmd', 'tla', 'ts'] : ['idea', 'md', 'mmd', 'tla'],
        confidence: tlaConfidence,
        nextRecommended: data.sany?.valid ? 'ts' : undefined,
      });

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }

      if (data.sany?.valid && agent && typeof agent.showTsContinuation === 'function') {
        agent.showTsContinuation();
      }
    } catch (err) {
      if (tlaResultsEl) {
        if (artifactResults) artifactResults.hidden = false;
        tlaResultsEl.hidden = false;
        const statusEl = document.getElementById('tla-status');
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${err.message}</span>`;
      }
    } finally {
      setLoading(false);
    }
  }

  async function renderTs() {
    if (!currentRunId || !currentDiagramName) {
      showError('Verify with TLA+ first before generating TypeScript.');
      return;
    }

    hideError();
    setLoading(true, 'ts');

    try {
      const res = await fetch('/api/render/ts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram_name: currentDiagramName, run_id: currentRunId }),
      });
      const data = await res.json();

      orchestrator.setArtifact('ts', data.ts_source || '');
      input.value = data.ts_source || '';

      if (artifactResults) artifactResults.hidden = false;
      if (tsResultsEl) tsResultsEl.hidden = false;
      resultSection.hidden = false;

      const statusEl = document.getElementById('ts-status');
      const compileEl = document.getElementById('ts-compile');
      const testsEl = document.getElementById('ts-tests');
      const coverageEl = document.getElementById('ts-coverage');
      const sourceEl = document.getElementById('ts-source');
      const tracesEl = document.getElementById('ts-traces');

      if (!data.success && !data.compile) {
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">TypeScriptRuntime failed</span>`;
        if (compileEl) compileEl.textContent = data.error || 'Compilation failed';
        if (testsEl) testsEl.textContent = data.details || '';
        if (coverageEl) coverageEl.textContent = '';
        if (sourceEl) sourceEl.textContent = data.ts_source || '';
        if (tracesEl) tracesEl.textContent = '';
        return;
      }

      const compileOk = data.compile?.success;
      const testsOk = data.tests?.success;
      const covOk = data.coverage?.ok;
      const compileBadge = compileOk ? `<span class="tla-badge tla-pass">tsc: pass (${data.compile?.wallClockMs || 0}ms)</span>` : `<span class="tla-badge tla-fail">tsc: fail</span>`;
      const testBadge = testsOk ? `<span class="tla-badge tla-pass">harness: pass (${data.tests?.wallClockMs || 0}ms)</span>` : `<span class="tla-badge tla-fail">harness: fail</span>`;
      const covBadge = covOk ? `<span class="tla-badge tla-pass">coverage: pass</span>` : `<span class="tla-badge tla-warn">coverage: partial</span>`;
      if (statusEl) statusEl.innerHTML = `${compileBadge} ${testBadge} ${covBadge}`;

      if (compileEl) compileEl.innerHTML = `<span>Repairs: ${data.compile?.repairs || 0}</span><span>Timed out: ${data.compile?.timedOut ? 'yes' : 'no'}</span>`;
      if (testsEl) testsEl.innerHTML = `<span>Checked: ${data.tests?.checked ? 'yes' : 'no'}</span><span>Repairs: ${data.tests?.repairs || 0}</span><span>Timed out: ${data.tests?.timedOut ? 'yes' : 'no'}</span>`;
      const coverage = data.coverage || {};
      if (coverageEl) coverageEl.innerHTML = `<span>Entities: ${((coverage.entityCoverage || 0) * 100).toFixed(0)}%</span><span>Actions: ${((coverage.actionCoverage || 0) * 100).toFixed(0)}%</span><span>Invariants: ${((coverage.invariantCoverage || 0) * 100).toFixed(0)}%</span>`;
      if (sourceEl) sourceEl.textContent = data.ts_source || '';

      if (Array.isArray(data.traces) && data.traces.length > 0) {
        if (tracesEl) tracesEl.textContent = data.traces.map(t => { const code = t.code ? ` ${t.code}` : ''; return `${t.type}${code}: ${t.message || t.raw || JSON.stringify(t)}`; }).join('\n');
      } else {
        if (tracesEl) tracesEl.textContent = 'No failure traces.';
      }

      const tsConfidence = data.success ? 0.95 : (compileOk ? 0.6 : 0.2);
      orchestrator.updateFromBackend({ stage: 'ts', confidence: tsConfidence });

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }
    } catch (err) {
      if (tsResultsEl) {
        if (artifactResults) artifactResults.hidden = false;
        tsResultsEl.hidden = false;
        const statusEl = document.getElementById('ts-status');
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${err.message}</span>`;
      }
    } finally {
      setLoading(false);
    }
  }

  // =========================================================================
  //  Render — single entry point dispatches by current stage
  // =========================================================================

  async function render() {
    if (isLoading || _renderAnimating) return;

    if (currentMode === 'tla') return renderTla();
    if (currentMode === 'ts') return renderTs();

    if (INPUT_STAGES.has(currentMode)) {
      orchestrator.resetDownstream(currentMode);
    }

    return renderMermaid();
  }

  // =========================================================================
  //  Event Listeners
  // =========================================================================

  btnRender.addEventListener('click', render);
  btnDownload.addEventListener('click', downloadBundle);

  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (currentMode === 'idea' && copilot) { copilot.enhance(); }
      else { render(); }
    }
  });

  input.addEventListener('input', updateBadges);
  diagramNameInput?.addEventListener('input', syncUiGuidance);

  btnNewDiagram.addEventListener('click', () => {
    input.value = '';
    if (diagramNameInput) diagramNameInput.value = '';
    resultSection.hidden = true;
    if (artifactResults) artifactResults.hidden = true;
    if (isFullscreen) toggleFullscreen();
    hideError();
    typeBadge.classList.remove('visible');
    stateBadge.classList.remove('visible');
    currentPaths = null;
    currentDiagramName = '';
    currentRunId = null;
    _persistSession();
    if (pzFront) { pzFront.destroy(); pzFront = null; }
    if (pzBack) { pzBack.destroy(); pzBack = null; }
    if (copilot) copilot.dismissGhost();

    orchestrator.resetAll();

    sidebar.addPending((name) => {
      if (name && diagramNameInput) {
        diagramNameInput.value = name;
        currentDiagramName = name;
      }
      input.focus();
      syncUiGuidance();
    });

    syncUiGuidance();
  });

  btnFlip.addEventListener('click', () => flipCard.toggle());
  btnResetZoom.addEventListener('click', () => { if (pzFront) pzFront.fitToViewport(); if (pzBack) pzBack.fitToViewport(); });
  btnDismissError.addEventListener('click', hideError);

  // ---- Enhance toggle (mirrors hidden chk-enhance checkbox) ----
  const _btnEnhanceClick = document.getElementById('btn-enhance');
  if (_btnEnhanceClick) {
    _btnEnhanceClick.addEventListener('click', () => {
      chkEnhance.checked = !chkEnhance.checked;
      _btnEnhanceClick.classList.toggle('active', chkEnhance.checked);
    });
  }

  // ---- Top-bar New Diagram button (mirrors sidebar btn-new-diagram) ----
  const btnNewDiagramFloat = document.getElementById('btn-new-diagram-float');
  if (btnNewDiagramFloat) {
    btnNewDiagramFloat.addEventListener('click', () => btnNewDiagram.click());
  }

  // ---- Max mode toggle ----
  if (btnMax) {
    btnMax.addEventListener('click', () => {
      maxMode = !maxMode;
      btnMax.classList.toggle('active', maxMode);
      btnMax.title = maxMode
        ? 'Max mode ON: strongest premium model will be used for render'
        : 'Max: use strongest premium model for architect-grade output';
    });
  }

  // =========================================================================
  //  Agent Mode (unchanged)
  // =========================================================================

  function setAgentMode(modeId) {
    if (!modeId && agent && agent.running) {
      agent.stopAndRestore();
      agentState = 'idle';
      notesDirty = false;
      input.readOnly = false;
      setLoading(false);
    }

    selectedAgentMode = modeId;
    agentModeActive = !!modeId;

    btnAgentToggle.classList.toggle('active', agentModeActive);

    agentDropdown.querySelectorAll('.agent-mode-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.agentMode === modeId);
    });

    if (agentModeActive) {
      btnRender.hidden = true;
      btnAgentRun.hidden = false;
    } else {
      btnRender.hidden = false;
      btnAgentRun.hidden = true;
      agentPanel.hidden = true;
    }

    agentDropdown.hidden = true;
    syncUiGuidance();
  }

  function _positionAgentDropdown() {
    if (!btnAgentToggle || !agentDropdown) return;
    const r = btnAgentToggle.getBoundingClientRect();
    const vh = window.innerHeight;
    agentDropdown.style.left = r.left + 'px';
    agentDropdown.style.maxHeight = '';

    const dropH = agentDropdown.scrollHeight || 200;
    const spaceBelow = vh - r.bottom - 8;
    const spaceAbove = r.top - 8;

    if (spaceBelow >= dropH || spaceBelow >= spaceAbove) {
      agentDropdown.style.top = (r.bottom + 8) + 'px';
      agentDropdown.style.bottom = '';
      if (spaceBelow < dropH) agentDropdown.style.maxHeight = spaceBelow + 'px';
    } else {
      agentDropdown.style.top = '';
      agentDropdown.style.bottom = (vh - r.top + 8) + 'px';
      if (spaceAbove < dropH) agentDropdown.style.maxHeight = spaceAbove + 'px';
    }
  }

  if (btnAgentToggle) {
    btnAgentToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (agentModeActive) { setAgentMode(null); }
      else {
        const wasHidden = agentDropdown.hidden;
        agentDropdown.hidden = !wasHidden;
        if (!agentDropdown.hidden) _positionAgentDropdown();
      }
    });
  }

  // Agent mode option clicks are handled dynamically by _rebuildAgentDropdown()

  document.addEventListener('click', () => { if (agentDropdown && !agentDropdown.hidden) agentDropdown.hidden = true; });

  const agentNotesWrap = document.getElementById('agent-notes-wrap');
  const agentNotesInput = document.getElementById('agent-notes-input');
  const btnAgentCommit = document.getElementById('btn-agent-commit');

  function _createAgent() {
    if (agent) return;
    agent = new window.MermaidAgent({
      input, panel: agentPanel, panelLog: agentPanelLog, panelMode: agentPanelMode,
      notesWrap: agentNotesWrap, notesInput: agentNotesInput, btnFinalize: btnAgentCommit,
      onPreviewRender: (event) => {
        if (event.paths) {
          showResult(event.paths, event.diagram_name, event.run_id);
          sidebar.add({ name: event.diagram_name, type: event.diagram_type || 'flowchart', paths: event.paths, timestamp: new Date().toLocaleString(), source: input.value, run_id: event.run_id || null });
        }
      },
      onRenderResult: (event) => {
        if (event.paths) {
          showResult(event.paths, event.diagram_name, event.run_id);
          sidebar.add({ name: event.diagram_name, type: event.diagram_type || 'flowchart', paths: event.paths, timestamp: new Date().toLocaleString(), source: input.value, run_id: event.run_id || null });
        }
      },
      onContinue: (stage) => {
        if (!orchestrator.isUnlocked(stage)) return;
        setMode(stage);
        setTimeout(() => render(), 300);
      },
      onComplete: () => { agentState = 'idle'; btnAgentRun.textContent = 'Run Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; input.readOnly = false; syncUiGuidance(); },
      onError: (msg) => { agentState = 'idle'; notesDirty = false; showError(msg); btnAgentRun.textContent = 'Run Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; input.readOnly = false; setLoading(false); syncUiGuidance(); },
      onStateChange: (state) => {
        agentState = state;
        if (state === 'running') { notesDirty = false; btnAgentRun.textContent = 'Stop Agent'; btnAgentRun.classList.add('is-stopping'); btnAgentRun.disabled = false; btnAgentRun.hidden = false; }
        else if (state === 'awaiting_notes') { input.readOnly = false; btnAgentRun.hidden = true; }
        else if (state === 'finalizing') { notesDirty = false; input.readOnly = true; btnAgentRun.hidden = true; setLoading(true, 'text'); }
        else if (state === 'idle') { btnAgentRun.textContent = 'Run Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; btnAgentRun.hidden = !agentModeActive; btnRender.hidden = agentModeActive; input.readOnly = false; setLoading(false); }
        syncUiGuidance();
      },
    });
  }

  if (btnAgentRun) {
    btnAgentRun.addEventListener('click', () => {
      if (isLoading) return;
      if (agent && agent.running) {
        agent.stopAndRestore(); agentState = 'idle'; notesDirty = false;
        btnAgentRun.textContent = 'Run Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; btnAgentRun.hidden = false;
        input.readOnly = false; setLoading(false); syncUiGuidance(); return;
      }
      if (!selectedAgentMode) return;
      _createAgent(); input.readOnly = true; hideError();
      agent.run(selectedAgentMode, diagramNameInput?.value?.trim() || undefined);
    });
  }

  if (btnAgentCommit) { btnAgentCommit.addEventListener('click', () => { _createAgent(); agent.finalize(); }); }
  if (agentNotesInput) { agentNotesInput.addEventListener('input', () => { notesDirty = !!agentNotesInput.value.trim(); syncUiGuidance(); }); }
  if (btnAgentStop) {
    btnAgentStop.addEventListener('click', () => {
      if (agent) { agent.stopAndRestore(); agentState = 'idle'; notesDirty = false; btnAgentRun.disabled = false; input.readOnly = false; setLoading(false); syncUiGuidance(); }
    });
  }

  // =========================================================================
  //  Talk-to-Text
  // =========================================================================

  const btnMic = document.getElementById('btn-mic');
  if (window.MermaidSpeech && btnMic) {
    speech = new window.MermaidSpeech(input, btnMic, { onInsert: () => updateBadges(), onError: (msg) => showError(msg) });
  }

  input.addEventListener('input', () => {
    const val = input.value;
    if (val.trimEnd().endsWith('/talk')) {
      input.value = val.slice(0, val.lastIndexOf('/talk')).trimEnd();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (speech && !speech.recording && !speech.processing) speech.start();
    }
  });

  // =========================================================================
  //  Init
  // =========================================================================

  orchestrator.restore();
  _restoreSession();
  setMode(orchestrator.currentStage);
  _rebuildAgentDropdown();
  updateBadges();

  if (currentPaths && (currentPaths.png || currentPaths.svg)) {
    showResult(currentPaths, currentDiagramName, currentRunId);
  }

  fetch('/api/copilot/health')
    .then(r => r.json())
    .then(data => { if (data.maxAvailable && btnMax) btnMax.classList.add('visible'); })
    .catch(() => {});

  fetch('/api/diagrams')
    .then(r => r.json())
    .then(data => {
      if (data.success && data.diagrams) {
        const serverNames = new Set(data.diagrams.map(d => d.name));
        sidebar.reconcile(serverNames);
        data.diagrams.forEach(d => {
          sidebar.add({ name: d.name, type: d.diagram_type || '', paths: d.paths, timestamp: d.created_at ? new Date(d.created_at).toLocaleString() : '', run_id: d.run_id || null });
        });
      }
    })
    .catch(() => {});

})();
