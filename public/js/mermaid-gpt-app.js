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

  // =========================================================================
  //  STAGE_REGISTRY — the single source of truth for every stage's identity,
  //  visuals, input config, expected wait times, and IPO contract.
  //  Every label map, color config, placeholder, and duration band in the
  //  app derives from this object. Never duplicate stage semantics elsewhere.
  // =========================================================================

  const STAGE_REGISTRY = {
    idea: {
      id: 'idea',
      label: 'Simple Idea',
      color: '#fbbf24', rgb: '251,191,36',
      revealLabel: 'STAGE 1 \u00b7 IDEA',
      icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a4.5 4.5 0 0 1 2.25 8.4v1.85a1.25 1.25 0 0 1-1.25 1.25h-2a1.25 1.25 0 0 1-1.25-1.25V9.9A4.5 4.5 0 0 1 8 1.5z"/></svg>',
      placeholder: 'Describe your system, workflow, or diagram idea...\n\nStart simply:\n  "A user logs in, the server checks credentials, then redirects to dashboard"\n\nOr more structured:\n  "Payment flow: Browser \u2192 API Gateway \u2192 Payment Service \u2192 Stripe \u2192 Bank\n   - on success: return confirmation to browser\n   - on failure: show error, retry up to 3 times \u2192 dead letter queue"\n\nUseful signals: actors, services, arrows (\u2192), steps, decisions, states, failures',
      hint: 'Type an idea \u00b7 \u2318\u23ce / Ctrl+Return to enhance text \u00b7 Tab to accept suggestion',
      enhanceDefault: true,
      showUpload: false,
      duration: { label: '\u22485\u201315s', ms: 15000 },
      ipo: {
        input: 'Raw text dump \u2014 ideas, notes, speech',
        process: 'Copilot profile analysis + AI enhancement',
        output: 'Refined idea, ready for Markdown structuring',
      },
    },
    md: {
      id: 'md',
      label: 'Markdown Spec',
      color: '#38bdf8', rgb: '56,189,248',
      revealLabel: 'STAGE 2 \u00b7 MARKDOWN',
      icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1.5" width="12" height="13" rx="1.5"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/></svg>',
      placeholder: 'Paste your Markdown architecture specification...\n\nInclude diagram descriptions in markdown format:\n  ## User Authentication Flow\n  The user submits credentials to the login API...\n\nSupported formats: .md, .markdown, .txt',
      hint: 'Paste or upload a markdown spec with diagram descriptions',
      enhanceDefault: true,
      showUpload: true,
      accept: '.md,.markdown,.txt',
      duration: { label: '\u224810\u201360s', ms: 60000 },
      ipo: {
        input: 'Idea artifact or pasted/uploaded .md',
        process: 'Agent planning + spec refinement',
        output: 'Corrected architecture spec, Mermaid unlocked',
      },
    },
    mmd: {
      id: 'mmd',
      label: 'Mermaid',
      color: '#818cf8', rgb: '129,140,248',
      revealLabel: 'STAGE 3 \u00b7 DIAGRAM',
      icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="5 4 2 8 5 12"/><polyline points="11 4 14 8 11 12"/><line x1="9" y1="2" x2="7" y2="14"/></svg>',
      placeholder: 'Paste or upload Mermaid (.mmd) source code...\n\nExample:\n  graph TD\n    A[User] \u2192|logs in| B[Server]\n    B \u2192|checks| C[Database]\n\nSupported format: .mmd',
      hint: 'Paste Mermaid source directly for compilation',
      enhanceDefault: false,
      showUpload: true,
      accept: '.mmd',
      duration: { label: '\u22485\u201330s', ms: 30000 },
      ipo: {
        input: 'Markdown spec or raw .mmd source',
        process: 'Compile + repair + depth scoring',
        output: 'Mastered diagram (PNG/SVG) \u2014 the run TLA+/TS build from',
      },
    },
    tla: {
      id: 'tla',
      label: 'TLA+',
      color: '#a78bfa', rgb: '167,139,250',
      revealLabel: 'STAGE 4 \u00b7 TLA+',
      icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z"/><path d="M5 8h6"/><path d="M8 5.5v5"/></svg>',
      placeholder: 'TLA+ specification source...\n\nGenerated after a successful Mermaid render.\nEdit the specification, then press Render to verify with SANY and TLC.\n\nThe spec includes:\n  - State variables\n  - Invariants\n  - Next-state relation',
      hint: 'Edit the TLA+ specification, then Render to verify with SANY/TLC',
      enhanceDefault: false,
      showUpload: false,
      duration: { label: '\u22481\u20132 min', ms: 120000 },
      ipo: {
        input: 'Mastered run (run_id + diagram)',
        process: 'Specula generation \u2192 SANY parse \u2192 TLC model check',
        output: 'Verified formal spec + config, invariants, traces',
      },
    },
    ts: {
      id: 'ts',
      label: 'TypeScript',
      color: '#34d399', rgb: '52,211,153',
      revealLabel: 'STAGE 5 \u00b7 TYPESCRIPT',
      icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M8 6v5"/></svg>',
      placeholder: 'TypeScript runtime source...\n\nGenerated after TLA+ verification.\nEdit the runtime code, then press Render to compile and run the test harness.\n\nThe runtime includes:\n  - State machine implementation\n  - Test harness\n  - Coverage reports',
      hint: 'Edit the TypeScript runtime, then Render to compile and test',
      enhanceDefault: false,
      showUpload: false,
      duration: { label: '\u224820\u201390s', ms: 90000 },
      ipo: {
        input: 'Verified TLA+ spec of the mastered run',
        process: 'Compile to single runtime \u2192 tsc \u2192 harness \u2192 coverage',
        output: 'One script \u2014 the functional replica proving the architecture',
      },
    },
  };

  // Named confidence levels — every orchestrator confidence write uses these.
  // Meaning is fixed: what the value SAYS about the artifact's verification.
  const CONFIDENCE = {
    RENDERED: 1.0,   // diagram compiled and rendered — definitive for its stage
    VERIFIED: 0.95,  // formally verified (TLC clean / tests pass)
    COMPILED: 0.94,  // mermaid compiled successfully from the plan
    PASS: 0.9,       // primary check passed (SANY / tsc)
    DRAFT: 0.86,     // agent-generated draft, not yet verified
    PARTIAL: 0.7,    // primary passed, secondary incomplete
    WEAK: 0.6,       // compiles but tests fail
    FAILED: 0.45,    // generated but failed verification
    BROKEN: 0.3,     // hard failure
    REJECTED: 0.2,   // unusable output
  };

  // Stages unlocked up to and including `stage` — replaces hand-typed arrays.
  const unlockedThrough = (stage) => STAGES.slice(0, STAGES.indexOf(stage) + 1);

  // Derived view for the reveal pod (stage colors + labels + final variant).
  const _STAGE_CFG = Object.fromEntries(
    STAGES.map(s => [s, { color: STAGE_REGISTRY[s].color, rgb: STAGE_REGISTRY[s].rgb, label: STAGE_REGISTRY[s].revealLabel }])
  );
  _STAGE_CFG.final = { color: '#f59e0b', rgb: '245,158,11', label: '\u2726 COMPLETE' };

  class WorkflowOrchestrator {
    constructor() {
      this.state = {
        currentStage: 'idea',
        unlockedStages: ['idea', 'md', 'mmd'],
        completed: {},
        confidence: {},
        guidance: {},
        nextRecommended: null,
      };
      this.artifacts = {};
      // Session lineage — the mastered run all downstream stages derive from.
      // Owned here so state + artifacts + session persist as ONE payload.
      this.session = { runId: null, diagramName: '', paths: null };
      this._subscribers = [];
      this._storageDegraded = false;  // HealthAlarm: tracked so recovery fires once
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
      this._persist();
      this._notify();
      return true;
    }

    setArtifact(stage, source) {
      this.artifacts[stage] = source || '';
      // Auto-persist on every artifact change. Critical for ensuring data
      // is never lost across refresh, agent runs, or tab switches.
      this._persist();
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
        // Two-axis confidence (F1): numeric score drives badges; the formal
        // verification level is an independent axis so a rendered-but-
        // unverified artifact can never masquerade as a verified one.
        // verification: 'none' | 'draft' | 'compiled' | 'sany' | 'tlc' | 'tests'
        this.state.confidence[payload.stage] = {
          value: payload.confidence,
          verification: payload.verification || null,
        };
      }
      if (payload.guidance && payload.stage) {
        this.state.guidance[payload.stage] = payload.guidance;
      }
      // nextRecommended is a HINT, not a switch. Silently mutating
      // currentStage here desynced the visible tab from the FSM — stage
      // changes go through switchTo()/setMode() only.
      this.state.nextRecommended = payload.nextRecommended || null;
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
        nextRecommended: null,
      };
      this.artifacts = {};
      this.session = { runId: null, diagramName: '', paths: null };
      this._persist();
      this._notify();
    }

    subscribe(cb) { this._subscribers.push(cb); }

    _notify() {
      for (const cb of this._subscribers) {
        try { cb(this.state); } catch { /* subscriber errors must not break orchestrator */ }
      }
    }

    setSession(patch) {
      this.session = { ...this.session, ...patch };
      this._persist();
    }

    _persist() {
      // Coalesce: one gesture often mutates several times (setArtifact +
      // switchTo + setSession on every tab switch), and each used to pay a
      // full stringify+write of ALL artifacts. Now: one write per task.
      // Durability still lands inside the gesture's task — SyncDisks
      // semantics preserved, 3 writes → 1.
      if (this._persistScheduled) return;
      this._persistScheduled = true;
      queueMicrotask(() => {
        this._persistScheduled = false;
        this._persistNow();
      });
    }

    _persistNow() {
      const payload = JSON.stringify({
        state: this.state,
        artifacts: this.artifacts,
        session: this.session,
      });
      try {
        localStorage.setItem('mermate_workflow', payload);
        if (this._storageDegraded) {
          // RecoverStorage: durability resumed — clear the alarm.
          this._storageDegraded = false;
          window.dispatchEvent(new CustomEvent('mermate:storage-ok'));
        }
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') {
          // localStorage is full — trim large artifacts and retry once.
          // The session state + runId are small; artifacts (especially a
          // 50K-char pasted idea or generated TLA+ spec) are the bulk.
          const trimmed = {};
          for (const [k, v] of Object.entries(this.artifacts)) {
            trimmed[k] = (v && v.length > 50000) ? v.slice(0, 50000) + '\n[…truncated for storage…]' : v;
          }
          try {
            localStorage.setItem('mermate_workflow', JSON.stringify({
              state: this.state,
              artifacts: trimmed,
              session: this.session,
            }));
            console.warn('[orchestrator] localStorage quota exceeded — trimmed large artifacts to fit');
            this._storageDegraded = true;
            window.dispatchEvent(new CustomEvent('mermate:storage-degraded', { detail: { trimmed: true } }));
            return;
          } catch (err2) {
            // Still failing — save just the session + state (no artifacts)
            // so at least the runId and stage progression survive.
            try {
              localStorage.setItem('mermate_workflow', JSON.stringify({
                state: this.state,
                artifacts: {},
                session: this.session,
              }));
              console.error('[orchestrator] localStorage quota exceeded even after trimming — saved session only, artifacts dropped');
              this._storageDegraded = true;
              window.dispatchEvent(new CustomEvent('mermate:storage-degraded', { detail: { artifactsDropped: true } }));
            } catch {
              console.error('[orchestrator] localStorage completely unavailable — all session data lost on refresh');
              this._storageDegraded = true;
              window.dispatchEvent(new CustomEvent('mermate:storage-degraded', { detail: { unavailable: true } }));
            }
          }
        } else {
          console.error('[orchestrator] persist failed:', err);
        }
      }
    }

    restore() {
      try {
        // localStorage is the sole persistence layer (durable across restarts).
        const raw = localStorage.getItem('mermate_workflow');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.state) this.state = { ...this.state, ...saved.state };
        if (saved.artifacts) this.artifacts = saved.artifacts;
        if (saved.session) {
          this.session = { ...this.session, ...saved.session };
        } else {
          // One-time migration from the legacy split store.
          const legacy = localStorage.getItem('mermate_session');
          if (legacy) {
            const s = JSON.parse(legacy);
            this.session = {
              runId: s.runId || null,
              diagramName: s.diagramName || '',
              paths: s.paths || null,
            };
            localStorage.removeItem('mermate_session');
          }
        }
      } catch { /* corrupt or missing */ }
    }
  }

  const orchestrator = new WorkflowOrchestrator();

  // =========================================================================
  //  DOM Elements
  // =========================================================================

  const input = document.getElementById('mermaid-input');
  const copilotWrap = input?.closest('.copilot-wrap') || null;
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
  const tlaEmptyEl = document.getElementById('tla-empty');
  const tsEmptyEl = document.getElementById('ts-empty');
  const toastContainer = document.getElementById('toast-container');
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
  }, (msg, type = 'info', duration = 3000) => {
    showToast(msg, type, duration);
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

  // ---- Max mode (toggled from the Agent dropdown) ----
  let maxMode = false;
  let maxAvailable = false;

  // ---- Agent mode ----
  const btnAgentToggle = document.getElementById('btn-agent-toggle');
  const agentDropdown = document.getElementById('agent-dropdown');
  const btnAgentRun = document.getElementById('btn-agent-run');
  const agentPanel = document.getElementById('agent-panel');
  const agentPanelLog = document.getElementById('agent-panel-log');
  const agentPanelMode = document.getElementById('agent-panel-mode');
  const btnAgentStop = document.getElementById('btn-agent-stop');
  const stageTrackerEl = document.getElementById('stage-tracker');
  let agentModeActive = false;
  let selectedAgentMode = null;
  let agent = null;

  // ---- State ----
  let isLoading = false;
  let currentMode = 'idea';
  let currentDiagramName = '';
  let currentPaths = null;
  let currentRunId = null;
  let _agentHandoffToken = 0;
  let _agentGazeTimer = null;
  let _isBootRestore = false;

  // =========================================================================
  //  RuntimeState — single source of truth for "is the app doing work?"
  //
  //  Every periodic poller (Opseeq heartbeat, autoguide) must consult this
  //  before firing. The app is "active" when:
  //    - An agent is running or finalizing
  //    - A render is in progress
  //    - The user interacted within the last IDLE_TIMEOUT_MS
  //  Otherwise the app is "idle" and pollers must stand down.
  // =========================================================================

  const IDLE_TIMEOUT_MS = 60_000; // 60s since last interaction = idle
  let _lastInteractionAt = Date.now();

  const RuntimeState = {
    _agentState: 'idle',
    _isLoading: false,

    setAgentState(state) {
      this._agentState = state;
      _lastInteractionAt = Date.now(); // state transitions count as activity
    },
    setLoading(on) {
      this._isLoading = on;
    },
    touch() {
      _lastInteractionAt = Date.now();
    },
    get isAgentActive() {
      return this._agentState === 'running' || this._agentState === 'finalizing';
    },
    get isBusy() {
      return this._isLoading || this.isAgentActive;
    },
    get isRecentlyActive() {
      return (Date.now() - _lastInteractionAt) < IDLE_TIMEOUT_MS;
    },
    get shouldPoll() {
      return this.isBusy || this.isRecentlyActive;
    },
    get snapshot() {
      return {
        agentState: this._agentState,
        isLoading: this._isLoading,
        isAgentActive: this.isAgentActive,
        isBusy: this.isBusy,
        isRecentlyActive: this.isRecentlyActive,
        shouldPoll: this.shouldPoll,
        msSinceInteraction: Date.now() - _lastInteractionAt,
      };
    },
  };

  // Track user interactions that reset the idle timer
  function _initInteractionTracking() {
    const events = ['mousedown', 'keydown', 'input', 'scroll', 'touchstart'];
    let _interactionDebounce = null;
    function _onInteraction() {
      // Debounce rapid events (e.g. typing) to avoid excessive touch() calls
      if (_interactionDebounce) return;
      _interactionDebounce = setTimeout(() => {
        RuntimeState.touch();
        _interactionDebounce = null;
      }, 500);
    }
    events.forEach(evt => document.addEventListener(evt, _onInteraction, { passive: true }));
  }
  _initInteractionTracking();

  // The local currentRunId/currentDiagramName/currentPaths variables are
  // in-memory working mirrors; the orchestrator owns persistence (single
  // payload alongside FSM state + artifacts).
  function _persistSession() {
    orchestrator.setSession({
      runId: currentRunId, diagramName: currentDiagramName, paths: currentPaths,
    });
  }

  function _restoreSession() {
    const s = orchestrator.session;
    if (s.runId) currentRunId = s.runId;
    if (s.diagramName) currentDiagramName = s.diagramName;
    if (s.paths) currentPaths = s.paths;
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

  function setAgentState(state) {
    agentState = state;
    RuntimeState.setAgentState(state);
  }

  const AGENT_MODES_BY_STAGE = {
    idea: [
      { id: 'full-build',   icon: '\u{1F3D7}', name: 'Full Build',  desc: 'Idea \u2192 Diagram \u2192 TLA+ \u2192 TypeScript \u2192 Bundle' },
      { id: 'thinking',     icon: '\u{1F4A1}', name: 'Thinking',    desc: 'Build architecture from ideas or notes' },
      { id: 'code-review',  icon: '\u{1F50D}', name: 'Code Review', desc: 'Recover architecture from a codebase' },
      { id: 'optimize-mmd', icon: '\u26A1',     name: 'Optimize',    desc: 'Improve existing Mermaid or markdown' },
    ],
    md: [
      { id: 'thinking',     icon: '\u{1F4A1}', name: 'Continue Spec', desc: 'Continue from this Markdown artifact and rebuild preview' },
      { id: 'optimize-mmd', icon: '\u26A1',     name: 'Optimize Spec', desc: 'Tighten Markdown structure and regenerate Mermaid' },
      { id: 'full-build',   icon: '\u{1F3D7}', name: 'Full Build',     desc: 'Markdown \u2192 Diagram \u2192 TLA+ \u2192 TypeScript \u2192 Bundle' },
    ],
    mmd: [
      { id: 'optimize-mmd', icon: '\u26A1',     name: 'Optimize Mermaid', desc: 'Repair, simplify, and compile this Mermaid source' },
      { id: 'thinking',     icon: '\u{1F4A1}', name: 'Explain / Rework',   desc: 'Reinterpret this diagram and regenerate architecture' },
      { id: 'full-build',   icon: '\u{1F3D7}', name: 'Full Build',         desc: 'Mermaid \u2192 TLA+ \u2192 TypeScript \u2192 Bundle' },
    ],
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

  function _defaultAgentModeForStage(stage) {
    if (stage === 'mmd') return 'optimize-mmd';
    if (stage === 'tla') return 'tla-verify';
    if (stage === 'ts') return 'ts-generate';
    return 'thinking';
  }

  function _rebuildAgentDropdown() {
    const dropdown = document.getElementById('agent-dropdown');
    if (!dropdown) return;

    const modes = _getAgentModesForStage(currentMode);
    const validIds = modes.map(m => m.id);
    if (selectedAgentMode && !validIds.includes(selectedAgentMode)) {
      selectedAgentMode = _defaultAgentModeForStage(currentMode);
    }
    dropdown.innerHTML = '';

    // Add header label for current stage
    const header = document.createElement('div');
    header.className = 'agent-dropdown-header';
    header.textContent = `Agent for ${_stageLabel(currentMode)}`;
    dropdown.appendChild(header);

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

    // Max mode toggle — lives in the dropdown to keep the controls row lean
    if (maxAvailable) {
      const maxBtn = document.createElement('button');
      maxBtn.className = 'agent-mode-option agent-mode-max';
      if (maxMode) maxBtn.classList.add('selected');
      maxBtn.innerHTML = `<span class="agent-mode-icon">\u26a1</span>`
        + `<span class="agent-mode-info">`
        + `<span class="agent-mode-name">Max mode ${maxMode ? 'ON' : 'OFF'}</span>`
        + `<span class="agent-mode-desc">Use strongest premium model for architect-grade output</span>`
        + `</span>`;
      maxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        maxMode = !maxMode;
        _rebuildAgentDropdown();
      });
      dropdown.appendChild(maxBtn);
    }

    // Add disable option when agent mode is active
    if (agentModeActive) {
      const disableBtn = document.createElement('button');
      disableBtn.className = 'agent-mode-option agent-mode-disable';
      disableBtn.innerHTML = `<span class="agent-mode-icon">\u2715</span>`
        + `<span class="agent-mode-info">`
        + `<span class="agent-mode-name">Disable Agent Mode</span>`
        + `<span class="agent-mode-desc">Switch back to manual render</span>`
        + `</span>`;
      disableBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAgentMode(null);
      });
      dropdown.appendChild(disableBtn);
    }
  }

  const COPILOT_API_BASE = '/api/copilot';

  // =========================================================================
  //  Mode Configuration — placeholders/hints/upload config live in
  //  STAGE_REGISTRY (top of file). LOADING_MESSAGES is keyed by content
  //  state (not stage), so it stays separate.
  // =========================================================================

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
    'full-build': 'Full Build',
    thinking: 'Thinking',
    'code-review': 'Code Review',
    'optimize-mmd': 'Optimize',
    'tla-verify': 'Verify Spec',
    'tla-optimize': 'Optimize TLA+',
    'ts-generate': 'Generate Runtime',
    'ts-optimize': 'Optimize TS',
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
        const confRaw = state.confidence[btnMode];
        // Legacy numeric entries (pre-split sessions) read through unchanged.
        const conf = typeof confRaw === 'number' ? confRaw : confRaw?.value;
        if (conf !== undefined && conf !== null) {
          badge.hidden = false;
          badge.textContent = `${Math.round(conf * 100)}%`;
          badge.className = 'stage-badge';
          badge.title = (confRaw && typeof confRaw === 'object' && confRaw.verification)
            ? `verification: ${confRaw.verification}`
            : '';
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
      renderIcon.innerHTML = (STAGE_REGISTRY[mode] || STAGE_REGISTRY.idea).icon;
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
      if (tlaEmptyEl) tlaEmptyEl.hidden = mode !== 'tla' || (orchestrator.getArtifact('tla') || '').trim() !== '';
      if (tsEmptyEl) tsEmptyEl.hidden = mode !== 'ts' || (orchestrator.getArtifact('ts') || '').trim() !== '';
    }

    if (isDiagramMode && currentPaths && (currentPaths.png || currentPaths.svg)) {
      resultSection.hidden = false;
    } else if (!isDiagramMode) {
      if (artifactResults && !artifactResults.hidden) {
        resultSection.hidden = false;
      }
    } else {
      // Diagram mode but no valid paths — keep result section hidden
      resultSection.hidden = true;
    }

  }

  orchestrator.subscribe(renderUI);

  // =========================================================================
  //  Agentic focus choreography — artifact handoff + gaze chip
  // =========================================================================

  const _agentSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function _stageLabel(stage) {
    return STAGE_REGISTRY[stage]?.label || stage;
  }

  function _agentTargetForPhase(phase) {
    if (phase === 'ingest' || phase === 'planning' || phase === 'refining') return 'idea';
    if (phase === 'preview') return 'mmd';
    if (phase === 'tla_build') return 'tla';
    if (phase === 'ts_build') return 'ts';
    return currentMode || 'idea';
  }

  function _animateTabHandoff() {
    // Pipeline progress bar was removed — stage state is shown on the mode
    // selector tabs. Kept as a no-op so agent choreography timing is stable.
    return Promise.resolve();
  }

  function _ensureAgentGazeChip() {
    if (!copilotWrap) return null;
    let chip = copilotWrap.querySelector('.agent-gaze-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'agent-gaze-chip';
      chip.innerHTML = [
        '<span class="gaze-pulse"></span>',
        '<span class="gaze-role"></span>',
        '<span class="gaze-target"></span>',
        '<span class="gaze-summary"></span>',
      ].join('');
      copilotWrap.appendChild(chip);
    }
    return chip;
  }

  function _showAgentGaze({ role = 'MERMATE', domain = '', stage = '', summary = '', target = null } = {}) {
    const chip = _ensureAgentGazeChip();
    if (!chip) return;

    const focusStage = target || _agentTargetForPhase(stage);
    const shortRole = String(role || 'MERMATE').replace(/^Doctor_/, 'Dr. ').replace(/_/g, ' ');
    const shortDomain = domain && domain !== 'general' ? ` · ${String(domain).replace(/_/g, ' ')}` : '';

    chip.querySelector('.gaze-role').textContent = shortRole + shortDomain;
    chip.querySelector('.gaze-target').textContent = `reviewing ${_stageLabel(focusStage)}`;
    chip.querySelector('.gaze-summary').textContent = summary ? String(summary).slice(0, 96) : 'tracking architecture state';
    chip.dataset.target = focusStage;
    chip.hidden = false;
    chip.classList.remove('pulse-once');
    void chip.offsetWidth;
    chip.classList.add('pulse-once');

    if (copilotWrap) copilotWrap.dataset.agentFocus = focusStage;
    clearTimeout(_agentGazeTimer);
    _agentGazeTimer = setTimeout(() => {
      chip.classList.remove('pulse-once');
    }, 1200);
  }

  function _hideAgentGaze() {
    const chip = copilotWrap?.querySelector('.agent-gaze-chip');
    if (chip) chip.hidden = true;
    if (copilotWrap) delete copilotWrap.dataset.agentFocus;
  }

  // Tracks which stages received new content during the current agent run.
  // Reset on agent start, populated by `_applyAgentArtifacts`, consumed by
  // the completion banner when the run finishes.
  let _agentRunPopulatedStages = new Set();
  let _agentRunMetrics = null;

  // Canonical agent-event adapter — the ONE place that understands both the
  // canonical envelope (`artifacts: {md, mmd, tla, ts}`) and the legacy
  // per-key payloads (md_source/draft_text, mmd_source/compiled_source…).
  // Everything downstream consumes the normalized shape only.
  let _legacyKeysWarned = false;
  function normalizeAgentEvent(event) {
    if (!event) {
      return {
        artifacts: { md: '', mmd: '', tla: '', ts: '' },
        verification: { sanyValid: false, tsCompiled: false },
        runId: null, diagramName: '', paths: null, metrics: null, progressionUpdate: null,
      };
    }
    const canonical = event.artifacts || null;
    if (!canonical && (event.draft_text || event.compiled_source) && !_legacyKeysWarned) {
      _legacyKeysWarned = true;
      console.warn('[normalizeAgentEvent] legacy payload keys detected (draft_text/compiled_source) — server should emit the canonical `artifacts` envelope');
    }
    return {
      artifacts: {
        md: (canonical?.md ?? event.md_source ?? event.draft_text ?? event.final_text ?? '') || '',
        mmd: (canonical?.mmd ?? event.mmd_source ?? event.compiled_source ?? '') || '',
        tla: (canonical?.tla ?? event.tla_source ?? '') || '',
        ts: (canonical?.ts ?? event.ts_source ?? '') || '',
      },
      verification: {
        sanyValid: !!event.sany_valid,
        tlcChecked: !!event.tlc_checked,
        tsCompiled: !!(event.compile_ok || event.ts_compiled),
      },
      runId: event.run_id || null,
      diagramName: event.diagram_name || '',
      paths: (event.paths && (event.paths.png || event.paths.svg)) ? event.paths : null,
      metrics: event.metrics || null,
      progressionUpdate: event.progressionUpdate || null,
    };
  }

  // Per-stage artifact application config — how each stage's arrival is
  // scored, what it unlocks, and how it's described. Confidence resolvers
  // read the normalized verification block.
  const AGENT_ARTIFACT_RULES = {
    md: {
      unlocks: 'mmd',
      confidence: () => CONFIDENCE.DRAFT,
      verification: () => 'draft',
      guidance: 'Markdown spec generated from agent planning/refinement.',
    },
    mmd: {
      unlocks: 'tla',  // WINNING (F2): mmd unlocks the tla TAB only — never ts
      confidence: () => CONFIDENCE.COMPILED,
      verification: () => 'compiled',
      guidance: 'Mermaid source compiled from the Markdown/architecture plan.',
    },
    tla: {
      // WINNING (TSRequiresVerifiedTLA): ts is granted ONLY when SANY passed
      unlocks: (v) => (v.sanyValid ? 'ts' : 'tla'),
      confidence: (v) => (v.sanyValid ? CONFIDENCE.PASS : CONFIDENCE.FAILED),
      verification: (v) => (v.sanyValid ? (v.tlcChecked ? 'tlc' : 'sany') : 'none'),
      guidance: 'TLA+ specification generated from the current diagram run.',
    },
    ts: {
      unlocks: 'ts',
      confidence: (v) => (v.tsCompiled ? CONFIDENCE.PASS : CONFIDENCE.FAILED),
      verification: (v) => (v.tsCompiled ? 'compiled' : 'none'),
      guidance: 'TypeScript runtime generated from the verified TLA+ artifact.',
    },
  };

  function _applyAgentArtifacts(event) {
    const ev = normalizeAgentEvent(event);

    if (ev.diagramName) currentDiagramName = ev.diagramName;
    if (ev.runId) currentRunId = ev.runId;
    if (ev.paths) currentPaths = ev.paths;

    // One registry-driven loop replaces the four hand-rolled stage blocks.
    let highestNewStage = null;
    for (const stage of ['md', 'mmd', 'tla', 'ts']) {
      const src = ev.artifacts[stage];
      if (!src.trim()) continue;
      highestNewStage = stage;

      const rule = AGENT_ARTIFACT_RULES[stage];
      const prev = orchestrator.getArtifact(stage) || '';
      orchestrator.setArtifact(stage, src);
      // Server progressionUpdate is authoritative when provided; the local
      // rule is the fallback during the legacy-payload transition.
      orchestrator.updateFromBackend(ev.progressionUpdate?.stage === stage
        ? ev.progressionUpdate
        : {
            stage,
            unlockedStages: unlockedThrough(typeof rule.unlocks === 'function'
              ? rule.unlocks(ev.verification)
              : rule.unlocks),
            confidence: rule.confidence(ev.verification),
            verification: rule.verification ? rule.verification(ev.verification) : undefined,
            guidance: rule.guidance,
          });
      if (prev.trim() !== src.trim()) {
        showToast(`${_stageLabel(stage)} tab populated (${src.length.toLocaleString()} chars)`, 'success', 3000);
        _markTabHasNewContent(stage);
        _agentRunPopulatedStages.add(stage);
      }
    }

    // Track metrics from the most recent render event for the completion banner
    if (ev.metrics) _agentRunMetrics = ev.metrics;

    // Deterministic auto-switch — guarantees the user lands on the tab
    // that just received new content, even if the animated walk in
    // _agenticallyReviewArtifacts gets cancelled by a subsequent event.
    if (highestNewStage && orchestrator.isUnlocked(highestNewStage)) {
      _scheduleAutoSwitchToStage(highestNewStage);
    }

    _persistSession();
  }

  // Debounced auto-switch — only the latest target wins. Survives across
  // rapid agent events (preview_render → final_render → pipeline_stage)
  // because each new call just resets the timer.
  let _autoSwitchTimer = null;
  let _autoSwitchUserOverride = false;
  function _scheduleAutoSwitchToStage(targetStage) {
    if (_autoSwitchUserOverride) return; // user clicked a tab themselves
    if (_autoSwitchTimer) clearTimeout(_autoSwitchTimer);
    _autoSwitchTimer = setTimeout(() => {
      _autoSwitchTimer = null;
      if (_autoSwitchUserOverride) return;
      if (currentMode !== targetStage && orchestrator.isUnlocked(targetStage)) {
        setMode(targetStage);
        showToast(`Switched to ${_stageLabel(targetStage)} tab`, 'info', 2500);
      }
    }, 800);
  }

  // Marks a tab as having unseen agent-produced content. The badge is
  // cleared automatically the first time the user visits that tab via
  // setMode (see clear logic in setMode below).
  function _markTabHasNewContent(stage) {
    const btn = document.querySelector(`.mode-btn[data-mode="${stage}"]`);
    if (!btn) return;
    // Skip if user is already on this tab — no point flashing the tab
    // they're already looking at.
    if (currentMode === stage) return;
    btn.classList.add('has-new-content');
  }

  function _clearTabNewContent(stage) {
    const btn = document.querySelector(`.mode-btn[data-mode="${stage}"]`);
    if (btn) btn.classList.remove('has-new-content');
  }

  async function _agenticallyReviewArtifacts(event) {
    const token = ++_agentHandoffToken;
    const ev = normalizeAgentEvent(event);
    const stages = ['md', 'mmd', 'tla', 'ts'].filter(s => ev.artifacts[s].trim());
    if (stages.length === 0) return;

    await _agentSleep(450);
    for (const stage of stages) {
      if (token !== _agentHandoffToken || !orchestrator.isUnlocked(stage)) return;
      _showAgentGaze({
        role: 'MERMATE',
        stage,
        target: stage,
        summary: `Populating ${_stageLabel(stage)} artifact from the live agent run`,
      });
      // Toast user before tab switch so they understand the move
      if (currentMode !== stage) {
        showToast(`Agent moving to ${_stageLabel(stage)} tab — populating artifact`, 'info', 2500);
      }
      await _animateTabHandoff(currentMode, stage);
      if (token !== _agentHandoffToken) return;

      // THE rainbow moment — the raw idea dump becoming a structured
      // architecture spec is the flagship transformation of the pipeline.
      // Play the word-level semantic transition from idea → md so the user
      // SEES their words become architecture (agent runs included).
      const isMdHandoff = stage === 'md' && _agentRunPopulatedStages.has('md');
      const priorIdea = isMdHandoff ? (orchestrator.getArtifact('idea') || '') : '';

      if (currentMode === stage) {
        input.value = orchestrator.getArtifact(stage);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        syncUiGuidance();
      } else {
        setMode(stage);
      }
      if (isMdHandoff && priorIdea.trim()) {
        await animateRenderTransition(priorIdea, orchestrator.getArtifact('md'));
        if (token !== _agentHandoffToken) return;
        _playRenderReveal({
          stage: 'md',
          isFinal: false,
          diagramName: currentDiagramName,
          metrics: null,
          paths: null,
        });
      }
      copilotWrap?.classList.add('is-agent-reviewing');
      await _agentSleep(stage === 'md' ? 1800 : 1300);
      copilotWrap?.classList.remove('is-agent-reviewing');
    }
  }

  // =========================================================================
  //  Mode Selector (save/restore per-tab content)
  // =========================================================================

  // Tracks whether the textarea has loaded the current artifact yet. Prevents
  // setMode from overwriting a stored artifact with an empty input on the
  // initial page load (when the textarea hasn't yet been populated).
  let _inputLoaded = false;

  // Populate a TLA+/TS tab from artifacts already persisted on disk for the
  // current run — avoids launching a fresh (and costly) compile when the
  // spec/runtime already exists. Returns true when the tab was populated.
  async function _hydratePersistedArtifact(mode) {
    if (!currentRunId || (mode !== 'tla' && mode !== 'ts')) return false;
    const runId = currentRunId;
    try {
      const url = mode === 'tla'
        ? `/api/render/tla/errors/${runId}`
        : `/api/render/ts/source/${runId}`;
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const data = await resp.json();
      const src = mode === 'tla' ? data.tla_source : data.ts_source;
      if (!src || !src.trim()) return false;

      orchestrator.setArtifact(mode, src);
      const confidence = mode === 'tla'
        ? (data.metrics?.sany_valid ? CONFIDENCE.PASS : CONFIDENCE.FAILED)
        : (data.compile_ok ? CONFIDENCE.PASS : CONFIDENCE.WEAK);
      // WINNING (F2): hydrating a failed/unverified tla artifact must not
      // unlock ts — the gate opens only on sany_valid.
      const unlockTarget = mode === 'tla'
        ? (data.metrics?.sany_valid ? 'ts' : 'tla')
        : 'ts';
      orchestrator.updateFromBackend({
        stage: mode,
        unlockedStages: unlockedThrough(unlockTarget),
        confidence,
        verification: mode === 'tla'
          ? (data.metrics?.sany_valid ? 'sany' : 'none')
          : (data.compile_ok ? 'compiled' : 'none'),
      });

      // Only type into the visible textarea when the user is still viewing
      // this tab; otherwise just stash the artifact + flag the tab.
      if (currentMode === mode) {
        input.style.opacity = '0';
        input.style.transition = 'opacity 0.25s ease';
        input.value = src;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => { input.style.opacity = '1'; });
      } else {
        _markTabHasNewContent(mode);
      }
      showToast(`${_stageLabel(mode)} loaded from run ${runId.slice(0, 8)} — no recompile needed`, 'success', 3000);
      return true;
    } catch {
      return false;
    }
  }

  function setMode(mode) {
    if (!orchestrator.isUnlocked(mode)) return;

    // Only save current input back to the current-mode artifact if the
    // textarea has actually loaded that artifact. On initial load, the
    // textarea is empty regardless of stored artifacts; saving '' here
    // would wipe the previously stored content.
    if (_inputLoaded) {
      orchestrator.setArtifact(currentMode, input.value);
    }

    currentMode = mode;
    orchestrator.switchTo(mode);

    // User is now viewing this tab — clear the "new content" indicator
    // if it was set by a prior agent run.
    _clearTabNewContent(mode);

    const cfg = STAGE_REGISTRY[mode] || STAGE_REGISTRY.idea;
    input.value = orchestrator.getArtifact(mode);
    _inputLoaded = true;  // Textarea now reflects the artifact for this mode
    input.placeholder = cfg.placeholder;
    chkEnhance.checked = cfg.enhanceDefault;
    const _btnEnh = document.getElementById('btn-enhance');
    if (_btnEnh) _btnEnh.classList.toggle('active', chkEnhance.checked);

    // Always allow editing/pasting in the active tab unless the agent is
    // actively running. The TLA+/TS auto-generation branch below may
    // re-enable readOnly when an empty stage is auto-filling itself, but
    // by default users must be able to paste their own content.
    if (agentState !== 'running' && agentState !== 'finalizing') {
      input.readOnly = false;
    }

    if (cfg.showUpload) {
      btnUpload.classList.add('visible');
      if (fileUpload) fileUpload.setAttribute('accept', cfg.accept || '');
    } else {
      btnUpload.classList.remove('visible');
    }

    // Hint text is owned by syncUiGuidance() (called below) and the
    // placeholder was already set above — no duplicate writes.

    try {
      if (mode === 'idea' && window.MermaidCopilot) {
        if (copilot) copilot.destroy();
        copilot = new window.MermaidCopilot(input, {
          apiBase: COPILOT_API_BASE,
          onAccept: updateBadges,
          onEnhanceStart: ({ inputChars }) => {
            showToast(`Enhancement started — processing file in tab view (${inputChars.toLocaleString()} chars)`, 'info', 3000);
          },
          onEnhanceComplete: ({ applied, error, elapsedMs, outputChars }) => {
            if (applied) {
              showToast(`Enhancement completed — data updated (${outputChars.toLocaleString()} chars, ${(elapsedMs / 1000).toFixed(1)}s)`, 'success', 4000);
            } else if (error) {
              showToast(`Enhancement failed — ${error}`, 'error', 6000);
            } else {
              showToast('Enhancement completed — no changes applied', 'info', 3000);
            }
          },
          onProfileUpdate: _onProfileUpdate,
        });
      } else if (copilot) {
        copilot.destroy();
        copilot = null;
      }
    } catch { copilot = null; }

    _rebuildAgentDropdown();
    syncUiGuidance();

    if ((mode === 'tla' || mode === 'ts') && currentRunId && currentDiagramName) {
      const artifact = orchestrator.getArtifact(mode);
      if (!artifact || !artifact.trim()) {
        // The agent's own pipeline may still be generating this stage
        // server-side. Auto-starting a render here spawned a SECOND, competing
        // compile — doubled API calls and the runaway "Compiling TypeScript…"
        // loader. While the agent is active, wait for its artifact instead.
        if (agentState === 'running' || (agent && agent.running)) {
          input.placeholder = mode === 'tla'
            ? `The agent is generating the TLA+ specification…\n\nThis tab fills in automatically when the agent's pipeline reaches it — no need to press Render.`
            : `The agent is compiling the TypeScript runtime…\n\nThis tab fills in automatically when the agent's pipeline reaches it — no need to press Render.`;
        } else {
          // Hydrate from disk FIRST — if this run already produced the
          // artifact, show it instead of paying to regenerate it. Only when
          // nothing is persisted do we fall back to auto-starting generation.
          input.placeholder = mode === 'tla'
            ? `Loading TLA+ specification for "${currentDiagramName}"…`
            : `Loading TypeScript runtime for "${currentDiagramName}"…`;
          _hydratePersistedArtifact(mode).then((hydrated) => {
            if (hydrated || currentMode !== mode) return;
            // Don't auto-fire expensive AI API calls — let the user press Render.
            input.placeholder = mode === 'tla'
              ? `No TLA+ specification found for "${currentDiagramName}".\n\nPress Render to generate one from run ${currentRunId.slice(0, 8)}.`
              : `No TypeScript runtime found for "${currentDiagramName}".\n\nPress Render to generate one from run ${currentRunId.slice(0, 8)}.`;
          });
        }
      }
    }
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _agentHandoffToken++;
      // User manually switched tabs — disable agent auto-switching for
      // this run. A new agent run resets this flag in `_createAgent` /
      // the Run-Agent click handler.
      _autoSwitchUserOverride = true;
      if (_autoSwitchTimer) {
        clearTimeout(_autoSwitchTimer);
        _autoSwitchTimer = null;
      }
      const targetMode = btn.dataset.mode;
      if (!orchestrator.isUnlocked(targetMode)) {
        // Explicit state, never implied: a locked tab explains why (ui-eval
        // gate 4) instead of silently ignoring the click.
        showToast(targetMode === 'ts'
          ? 'TypeScript is locked \u2014 verify the TLA+ specification first (SANY must pass)'
          : `${_stageLabel(targetMode)} is locked \u2014 complete the earlier stages first`, 'info', 3500);
        return;
      }
      setMode(targetMode);
    });
  });

  // =========================================================================
  //  UI Guidance
  // =========================================================================

  function syncUiGuidance() {
    const source = input.value || '';
    const hasInput = source.trim().length > 0;
    const hasName = !!diagramNameInput?.value?.trim();
    const hasResult = !!currentPaths;
    const activeMode = STAGE_REGISTRY[currentMode] || STAGE_REGISTRY.idea;
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
        ? `Agent: ${getAgentModeLabel(selectedAgentMode)} mode. ${agent ? 'Continue from the current artifact.' : 'Run the agent when the prompt is ready.'}`
        : `Agent: ${getAgentModeLabel(selectedAgentMode)} mode. Enter the architecture prompt to begin.`;
      nextAction = hasInput ? (agent ? `Next: continue from ${_stageLabel(currentMode)}` : 'Next: run agent') : (hasName ? 'Next: describe the architecture' : 'Next: enter prompt');
      tone = 'ready';
    } else if (currentMode === 'tla') {
      const hasRun = !!(currentRunId && currentDiagramName);
      if (hasInput) {
        hint = activeMode.hint;
        nextAction = `Next: render to verify TLA+ (${activeMode.duration.label})`;
      } else if (hasRun) {
        hint = `Ready to generate TLA+ for "${currentDiagramName}" — auto-starting (${activeMode.duration.label})...`;
        nextAction = 'Next: generating TLA+ specification via Specula';
        tone = 'busy';
      } else {
        hint = 'Render a diagram first — the TLA+ pipeline will auto-start when ready.';
        nextAction = 'Next: go back to Simple Idea and render a diagram';
      }
      tone = tone || 'ready';
    } else if (currentMode === 'ts') {
      const hasRun = !!(currentRunId && currentDiagramName);
      if (hasInput) {
        hint = activeMode.hint;
        nextAction = `Next: render to compile TypeScript (${activeMode.duration.label})`;
      } else if (hasRun) {
        hint = `Ready to generate TypeScript for "${currentDiagramName}" — auto-starting (${activeMode.duration.label})...`;
        nextAction = 'Next: compiling TypeScript runtime';
        tone = 'busy';
      } else {
        hint = 'Complete the TLA+ stage first — TypeScript generation will auto-start.';
        nextAction = 'Next: go to TLA+ tab first';
      }
      tone = tone || 'ready';
    } else if (!hasInput) {
      const enhanceLabel = chkEnhance.checked ? 'Enhance ON — AI will refine before rendering' : 'Enhance OFF — click Enhance to enable AI refinement';
      if (currentMode === 'idea') {
        hint = hasName ? 'Describe the system, actors, and flow direction.' : activeMode.hint;
        nextAction = hasName ? 'Next: describe the architecture' : 'Next: enter an idea';
      } else if (currentMode === 'md') {
        nextAction = 'Next: paste or upload a markdown spec';
      } else {
        nextAction = 'Next: paste Mermaid source or upload .mmd';
      }
      if (currentMode === 'idea' || currentMode === 'md') hint += ' · ' + enhanceLabel;
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
      nextAction = (currentMode === 'idea' && chkEnhance.checked)
        ? 'Next: \u2318+Enter to enhance, or Render to compile'
        : (currentMode === 'idea' ? 'Next: render or press \u2318/Ctrl+Enter to enhance' : 'Next: render the current source');
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

  function showToast(message, type = 'info', duration = 4000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast is-${type}`;
    toast.innerHTML = `
      <span>${message}</span>
      <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => dismissToast(toast));
    toastContainer.appendChild(toast);
    if (duration > 0) {
      setTimeout(() => dismissToast(toast), duration);
    }
    return toast;
  }

  function dismissToast(toast) {
    if (!toast || toast.classList.contains('is-exiting')) return;
    toast.classList.add('is-exiting');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }

  // ---- Storage durability alarm (WINNING HealthAlarm) ----------------------
  // The orchestrator's _persist() dispatches these events; the UI owns the
  // visible signal. Degraded = ONE sticky warning that stays until storage
  // recovers — state is explicit, never implied (ui-eval gate 4).
  let _storageToast = null;
  window.addEventListener('mermate:storage-degraded', (e) => {
    if (_storageToast) return; // one sticky alarm at a time
    const d = e.detail || {};
    _storageToast = showToast(
      d.unavailable
        ? 'Browser storage unavailable — your work is NOT being saved. Export or copy it now.'
        : d.artifactsDropped
          ? 'Browser storage is full — only session state is being saved. Download the full bundle to keep your artifacts.'
          : 'Browser storage is full — large artifacts were trimmed to preserve your session. Download the full bundle for untrimmed output.',
      'warning', 0);
  });
  window.addEventListener('mermate:storage-ok', () => {
    if (_storageToast) { dismissToast(_storageToast); _storageToast = null; }
    showToast('Storage recovered — your work is being saved again', 'success', 3000);
  });

  // ---- Document title management ------------------------------------------
  // Reflects agent state in the browser tab so users know the run is still
  // active even when they switch to another browser tab. Cleared automatically
  // when the agent transitions back to idle.
  const _BASE_TITLE = 'MERMATE';
  let _titleResetTimer = null;

  function _setDocTitle(prefix, project) {
    if (_titleResetTimer) { clearTimeout(_titleResetTimer); _titleResetTimer = null; }
    const proj = (project || '').trim();
    document.title = prefix
      ? (proj ? `${prefix} ${proj} · ${_BASE_TITLE}` : `${prefix} ${_BASE_TITLE}`)
      : _BASE_TITLE;
  }

  function _resetDocTitleAfter(ms) {
    if (_titleResetTimer) clearTimeout(_titleResetTimer);
    _titleResetTimer = setTimeout(() => {
      document.title = _BASE_TITLE;
      _titleResetTimer = null;
    }, ms);
  }

  // ---- Top-level completion notification ----------------------------------
  // Shown at the top of the screen when an agent run completes. Lists every
  // tab that received content, the project name, and provides quick actions
  // (View, Download, Dismiss). More prominent than a toast because it
  // represents the end of a long-running operation the user may have
  // walked away from.
  function _showCompletionBanner({ project, populatedStages, runId, paths, metrics }) {
    // Remove any existing banner so we don't stack them
    const existing = document.querySelector('.completion-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = 'completion-banner';
    const stageLabels = (populatedStages || [])
      .map(s => `<span class="completion-tag" data-stage="${s}">${_stageLabel(s)}</span>`)
      .join('');
    const metricsLine = metrics
      ? `<span class="completion-meta">${metrics.nodeCount || 0} nodes · ${metrics.edgeCount || 0} edges</span>`
      : '';
    banner.innerHTML = `
      <div class="completion-banner-icon">✓</div>
      <div class="completion-banner-body">
        <div class="completion-banner-title">Agent run complete${project ? ` — ${project}` : ''}</div>
        <div class="completion-banner-detail">
          <span class="completion-meta">Populated:</span>
          ${stageLabels || '<span class="completion-meta">no new artifacts</span>'}
          ${metricsLine}
        </div>
      </div>
      <div class="completion-banner-actions">
        ${(populatedStages && populatedStages.length) ? `<button class="completion-btn completion-btn-primary" data-action="view">View ${_stageLabel(populatedStages[populatedStages.length - 1])}</button>` : ''}
        ${paths ? `<button class="completion-btn" data-action="download">Download</button>` : ''}
        <button class="completion-btn-close" aria-label="Dismiss">&times;</button>
      </div>
    `;

    // View action — switch to the highest stage that was populated
    banner.querySelector('[data-action="view"]')?.addEventListener('click', () => {
      const lastStage = populatedStages[populatedStages.length - 1];
      if (lastStage && orchestrator.isUnlocked(lastStage)) {
        setMode(lastStage);
      }
      _dismissCompletionBanner(banner);
    });

    // Download action — open the bundle for the run
    banner.querySelector('[data-action="download"]')?.addEventListener('click', () => {
      if (runId) {
        window.open(`/api/runs/${runId}/bundle`, '_blank');
      }
    });

    // Close button
    banner.querySelector('.completion-banner-close, .completion-btn-close')?.addEventListener('click', () => {
      _dismissCompletionBanner(banner);
    });

    document.body.appendChild(banner);
    // Animate in
    requestAnimationFrame(() => banner.classList.add('is-visible'));

    // Auto-dismiss after 12s — long enough to read but not stuck on screen
    setTimeout(() => _dismissCompletionBanner(banner), 12000);
  }

  function _dismissCompletionBanner(banner) {
    if (!banner || banner.classList.contains('is-exiting')) return;
    banner.classList.add('is-exiting');
    banner.addEventListener('transitionend', () => banner.remove(), { once: true });
    setTimeout(() => banner.remove(), 600);  // safety fallback
  }

  // ---- Stage progress tracker ---------------------------------------------
  // Drives the visible pipeline progression in the agent panel header.
  // Status values: 'active' (currently processing), 'complete' (passed),
  // 'error' (failed), or null (reset).
  function _updateStageTracker(stage, status) {
    if (!stageTrackerEl) return;
    stageTrackerEl.hidden = false;
    const steps = stageTrackerEl.querySelectorAll('.stage-tracker-step');
    const targetIdx = STAGES.indexOf(stage);
    if (targetIdx === -1) return;

    steps.forEach((el) => {
      const s = el.dataset.stage;
      const idx = STAGES.indexOf(s);
      el.classList.remove('is-active', 'is-complete', 'is-error');
      if (s === stage) {
        if (status === 'complete') el.classList.add('is-complete');
        else if (status === 'error') el.classList.add('is-error');
        else el.classList.add('is-active');
      } else if (idx < targetIdx) {
        // Previous stages — mark as complete unless explicitly reset
        el.classList.add('is-complete');
      }
    });
  }

  function _resetStageTracker() {
    if (!stageTrackerEl) return;
    stageTrackerEl.querySelectorAll('.stage-tracker-step').forEach((el) => {
      el.classList.remove('is-active', 'is-complete', 'is-error');
    });
  }

  // (Duplicate mode-btn listener + duplicate syncUiGuidance block removed —
  //  the canonical versions are defined earlier in this IIFE.)

  // Elapsed-time ticker for the loading overlay. Long stages (TLA+ ≈1–2 min,
  // TS ≈20–90s) need proof-of-life: the user sees elapsed seconds against
  // the expected band, so a slow verification never reads as a hang.
  let _loadingTicker = null;
  let _loadingStartedAt = 0;

  function _startLoadingTicker(baseMessage, durationLabel) {
    _stopLoadingTicker();
    _loadingStartedAt = Date.now();
    const suffix = durationLabel ? ` · expected ${durationLabel}` : '';
    const expectedMs = STAGE_REGISTRY[currentMode]?.duration?.ms || 0;
    loadingText.textContent = `${baseMessage}${suffix}`;
    loadingText.classList.remove('is-over-estimate');
    _loadingTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - _loadingStartedAt) / 1000);
      const overEstimate = expectedMs > 0 && (Date.now() - _loadingStartedAt) > expectedMs;
      if (overEstimate) {
        loadingText.textContent = `${baseMessage} — ${elapsed}s · taking longer than expected`;
        loadingText.classList.add('is-over-estimate');
      } else {
        loadingText.textContent = `${baseMessage} — ${elapsed}s${suffix}`;
        loadingText.classList.remove('is-over-estimate');
      }
    }, 1000);
  }

  function _stopLoadingTicker() {
    if (_loadingTicker) { clearInterval(_loadingTicker); _loadingTicker = null; }
    loadingText.classList.remove('is-over-estimate');
  }

  function setLoading(on, contentState) {
    // Don't show loading overlay during agent operations - agent panel shows progress
    if (on && (agentState === 'running' || agentState === 'finalizing' || agentState === 'awaiting_notes')) {
      isLoading = on;
      RuntimeState.setLoading(on);
      btnRender.disabled = on;
      input.readOnly = on;
      syncUiGuidance();
      return;
    }

    isLoading = on;
    RuntimeState.setLoading(on);
    btnRender.disabled = on;
    input.readOnly = on;
    if (on) {
      const baseMessage = (contentState && LOADING_MESSAGES[contentState]) || 'Compiling...';
      // contentState maps to a stage for tla/ts — surface its duration band.
      const durationLabel = STAGE_REGISTRY[contentState]?.duration?.label || '';
      _startLoadingTicker(baseMessage, durationLabel);
    } else {
      _stopLoadingTicker();
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

  /**
   * Update the depth badge in the result-controls bar.
   * `meta` is `{ score, tier }` (typically from render_meta or top-level
   * depth_score / depth_tier on the render response). Hidden when missing.
   */
  function _renderDepthBadge(meta) {
    const el = document.getElementById('depth-badge');
    if (!el) return;
    if (!meta || (meta.tier == null && meta.score == null)) {
      el.hidden = true;
      el.removeAttribute('data-tier');
      return;
    }
    const tier = meta.tier || 'shallow';
    const score = typeof meta.score === 'number' ? meta.score.toFixed(2) : '—';
    el.dataset.tier = tier;
    const text = el.querySelector('.depth-badge-text');
    if (text) text.textContent = `Depth · ${tier} · ${score}`;
    const tierMeaning = {
      deep: 'rich state space — TLA+ verification will cover more behavior',
      medium: 'moderate state space — good TLA+ coverage expected',
      shallow: 'simple structure — consider adding actors/failure paths before TLA+',
    }[tier] || '';
    el.title = `Architecture depth tier: ${tier} (score ${score})${tierMeaning ? ' · ' + tierMeaning : ''}`;
    el.hidden = false;
  }

  function showResult(paths, name, runId, metrics, depthMeta) {
    // Validate paths before showing — guard against stale / partial paths
    if (!paths || (!paths.png && !paths.svg)) {
      console.warn('[showResult] Invalid paths, skipping render', paths);
      resultSection.hidden = true;
      currentPaths = null;
      _persistSession();
      return;
    }

    currentPaths = paths;
    currentDiagramName = name || 'diagram';
    currentRunId = runId || null;
    const ts = Date.now();
    resultSection.hidden = false;

    // Architecture depth badge — shows the tier (shallow / medium / deep) and
    // raw score. Depth comes from the render response; we tolerate older
    // responses that don't include it by simply leaving the chip empty.
    _renderDepthBadge(depthMeta);

    if (INPUT_STAGES.has(currentMode)) {
      flipCard.showFront();
      if (btnFlip) btnFlip.setAttribute('aria-checked', 'false');
      if (flipCardContainer) flipCardContainer.hidden = false;
    }

    if (runDetails && runId) {
      runDetails.show(runId);
    } else if (runDetails && !runId) {
      runDetails.hide();
    }

    let pngLoaded = false;
    let svgLoaded = false;

    resultPng.onload = () => {
      pngLoaded = true;
      if (!pzFront) pzFront = new window.PanZoom(panZoomFront, resultPng);
      pzFront.fitToViewport();
    };
    resultPng.onerror = () => {
      console.error('[showResult] PNG failed to load:', paths.png);
      if (!svgLoaded) {
        showToast('Diagram image not available — try re-rendering', 'warning', 4000);
        // If both fail, hide the result section
        if (!pngLoaded) {
          resultSection.hidden = true;
          currentPaths = null;
          _persistSession();
        }
      }
    };
    if (paths.png) {
      resultPng.src = paths.png + '?t=' + ts;
    } else {
      resultPng.removeAttribute('src');
    }

    resultSvg.onload = () => {
      svgLoaded = true;
      if (!pzBack) pzBack = new window.PanZoom(panZoomBack, resultSvg);
      pzBack.fitToViewport();
    };
    resultSvg.onerror = () => {
      console.error('[showResult] SVG failed to load:', paths.svg);
    };
    if (paths.svg) {
      resultSvg.src = paths.svg + '?t=' + ts;
    } else {
      resultSvg.removeAttribute('src');
    }

    resultSection.classList.add('is-revealing');
    window.setTimeout(() => resultSection.classList.remove('is-revealing'), 220);

    const resultStage = INPUT_STAGES.has(currentMode) ? 'mmd' : currentMode;
    const unlockedUpTo = resultStage === 'mmd'
      ? unlockedThrough('tla')
      : STAGES.filter(s => orchestrator.isUnlocked(s));
    orchestrator.updateFromBackend({
      stage: resultStage,
      unlockedStages: unlockedUpTo,
      confidence: CONFIDENCE.RENDERED,
      verification: resultStage === 'mmd' ? 'compiled' : undefined,
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

    if (INPUT_STAGES.has(currentMode) && currentRunId) {
      // Timeline anchor — this render IS the mastered run. Downstream
      // stages (TLA+ / TypeScript) derive from exactly this run_id, and
      // the user should know that without having to think about it.
      _showStandaloneContinuation(
        'tla',
        `\u2605 Mastered run — "${currentDiagramName}" · TLA+ & TypeScript will build from this diagram`,
        'Continue to TLA+ Specification',
      );
      sidebar.markActiveLineage?.(currentRunId);
    }
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

  // Stage colors/labels for the reveal pod come from STAGE_REGISTRY via the
  // derived _STAGE_CFG defined at the top of this file.

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
    if (stage === 'md') {
      const chars = (orchestrator.getArtifact('md') || '').length;
      return `\u2726 ${name} — idea structured into an architecture spec (${chars.toLocaleString()} chars). Review it, then continue to Mermaid.`;
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
  //  Standalone Continuation CTA (used outside agent mode)
  // =========================================================================

  function _showStandaloneContinuation(nextStage, label, buttonText) {
    _removeStandaloneContinuation();
    const container = artifactResults || resultSection;
    if (!container) return;

    const wrap = document.createElement('div');
    wrap.className = 'agent-continuation standalone-continuation';
    wrap.dataset.continuationStage = nextStage;

    const span = document.createElement('span');
    span.className = 'continuation-label';
    span.textContent = label;

    const btn = document.createElement('button');
    btn.className = 'btn btn-continuation';
    btn.dataset.nextStage = nextStage;
    btn.textContent = buttonText;
    btn.addEventListener('click', () => {
      _removeStandaloneContinuation();
      if (nextStage === 'download') {
        downloadBundle();
      } else if (orchestrator.isUnlocked(nextStage)) {
        setMode(nextStage);
      }
    });

    wrap.append(span, btn);
    container.appendChild(wrap);
  }

  function _removeStandaloneContinuation() {
    document.querySelectorAll('.standalone-continuation').forEach(el => el.remove());
  }

  // =========================================================================
  //  ZIP Download
  // =========================================================================

  async function downloadBundle() {
    if (!window.JSZip) return;

    try {
      const zip = new JSZip();
      const now = new Date();
      const dateStr = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
      const timeStr = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

      if (currentRunId) {
        try {
          const bundleRes = await fetch(`/api/runs/${currentRunId}/bundle`);
          const bundleData = await bundleRes.json();
          if (bundleData.success && bundleData.files) {
            for (const [filePath, b64] of Object.entries(bundleData.files)) {
              zip.file(filePath, b64, { base64: true });
            }
            const zipName = `${dateStr}_${timeStr}_${bundleData.diagram_name || currentDiagramName}_full_bundle.zip`;
            const content = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = zipName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            showToast(`Bundle downloaded — ${Object.keys(bundleData.files).length} files`, 'success', 3500);
            return;
          }
        } catch { /* fall through to basic bundle */ }
      }

      if (!currentPaths) {
        showError('No diagram to download — render a diagram first');
        return;
      }
      const [pngRes, svgRes] = await Promise.all([fetch(currentPaths.png), fetch(currentPaths.svg)]);
      const [pngBlob, svgBlob] = await Promise.all([pngRes.blob(), svgRes.blob()]);
      zip.file(`${currentDiagramName}.png`, pngBlob);
      zip.file(`${currentDiagramName}.svg`, svgBlob);
      const zipName = `${dateStr}_${timeStr}_${currentDiagramName}_bundle.zip`;
      const content = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(content);
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      showToast(`Bundle downloaded — ${currentDiagramName} (PNG + SVG)`, 'success', 3000);
    } catch (err) {
      showError('Download failed: ' + err.message);
      showToast('Download failed — see error banner', 'error', 5000);
    }
  }

  // =========================================================================
  //  Render Strategies (Strategy pattern — one per stage family)
  // =========================================================================

  // One sidebar-entry shape for every producer (manual render, agent
  // preview, agent final) — no more per-call-site field drift.
  function buildSidebarEntry(data, source) {
    return {
      name: data.diagram_name,
      type: data.diagram_type || 'flowchart',
      paths: data.paths,
      timestamp: new Date().toLocaleString(),
      source: source || '',
      contentState: data.content_state || undefined,
      run_id: data.run_id || null,
    };
  }

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
      if (!data.success) {
        const errMsg = data.details || data.error || 'Compilation failed';
        showError(errMsg);
        showToast(`Render failed — ${errMsg.slice(0, 80)}${errMsg.length > 80 ? '...' : ''}`, 'error', 6000);
        return;
      }

      const shouldAnimate = data.enhanced && data.compiled_source && data.content_state !== 'mmd';
      if (shouldAnimate) { setLoading(false); await animateRenderTransition(source, data.compiled_source); }

      const depthMeta = (data.depth_score != null || data.depth_tier != null)
        ? { score: data.depth_score, tier: data.depth_tier }
        : (data.render_meta && (data.render_meta.depth_score != null || data.render_meta.depth_tier != null))
          ? { score: data.render_meta.depth_score, tier: data.render_meta.depth_tier }
          : null;
      showResult(data.paths, data.diagram_name, data.run_id, data.metrics, depthMeta);

      // Surface direct-provider fallback events
      if (data.fallback_events && data.fallback_events.length > 0) {
        _showFallbackBanner(data.fallback_events);
      }

      const finalText = shouldAnimate ? data.compiled_source : source;
      if (copilot) copilot.setRenderedHash(finalText);

      orchestrator.resetDownstream(currentMode);

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }

      showToast(`Diagram rendered — ${data.diagram_name || currentDiagramName}`, 'success', 3000);


      sidebar.add(buildSidebarEntry(data, source));
    } catch (err) {
      if (err.name === 'TypeError') { showError('Could not reach server. Is Mermaid-GPT running?'); }
      else { showError(err.message || 'Unexpected error'); }
      showToast('Render failed — see error banner', 'error', 5000);
    } finally {
      setLoading(false);
    }
  }

  async function renderTla() {
    if (!currentRunId || !currentDiagramName) {
      const lastEntry = sidebar.getLatestWithRunId?.();
      if (lastEntry?.run_id && lastEntry?.name) {
        currentRunId = lastEntry.run_id;
        currentDiagramName = lastEntry.name;
      } else {
        showError('No diagram available. Render a diagram first, then the TLA+ pipeline will auto-start.');
        return;
      }
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
      input.readOnly = false;

      const statusEl = document.getElementById('tla-status');
      const provenanceEl = document.getElementById('tla-provenance');
      const sourceEl = document.getElementById('tla-source');
      const invEl = document.getElementById('tla-invariants');
      const violPanel = document.getElementById('tla-violations-panel');
      const violEl = document.getElementById('tla-violations');
      const metricsEl = document.getElementById('tla-metrics');

      if (artifactResults) artifactResults.hidden = false;
      if (tlaResultsEl) tlaResultsEl.hidden = false;
      resultSection.hidden = false;

      if (!data.success) {
        const errMsg = data.error || 'TLA+ generation failed';
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${errMsg}</span>`;
        if (sourceEl) sourceEl.textContent = '';
        if (invEl) invEl.innerHTML = '';
        showError(errMsg);
        showToast(`TLA+ generation failed — ${errMsg.slice(0, 80)}${errMsg.length > 80 ? '...' : ''}`, 'error', 6000);
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

      if (provenanceEl && data.verification) {
        const v = data.verification;
        const toolboxVerified = v.sany?.valid && v.tlc?.checked;
        const verifiedBadge = toolboxVerified
          ? '<span class="tla-provenance-chip tla-provenance-verified" title="Passed SANY syntax check and TLC model check">Toolbox-verified</span>'
          : '<span class="tla-provenance-chip" title="Verification did not complete">Toolbox-pending</span>';
        const writer = v.generator?.provider === 'deterministic'
          ? 'deterministic compiler'
          : `${v.generator?.provider || 'unknown'} ${v.generator?.model || ''}`.trim();
        const sanySec = ((v.toolbox?.sanyMs || 0) / 1000).toFixed(1);
        const tlcSec = ((v.toolbox?.tlcMs || 0) / 1000).toFixed(1);
        const spsRaw = v.tlc?.statesPerSec || 0;
        const sps = spsRaw >= 1000 ? `${(spsRaw / 1000).toFixed(1)}k` : String(spsRaw);
        const repairs = v.generator?.repairAttempts ?? 0;
        const chipParts = [
          `written by ${writer}`,
          `SANY ${sanySec}s`,
          `TLC ${tlcSec}s`,
          `${sps} states/s`,
          `${repairs} repair${repairs === 1 ? '' : 's'}`,
        ];
        provenanceEl.innerHTML = `${verifiedBadge}<span class="tla-provenance-chip">${chipParts.join(' \u00b7 ')}</span>`;
      }

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

      const tlaConfidence = data.sany?.valid
        ? (data.tlc?.success ? CONFIDENCE.VERIFIED : CONFIDENCE.PARTIAL)
        : CONFIDENCE.BROKEN;
      orchestrator.updateFromBackend({
        stage: 'tla',
        unlockedStages: unlockedThrough(data.sany?.valid ? 'ts' : 'tla'),
        confidence: tlaConfidence,
        verification: data.sany?.valid ? (data.tlc?.success ? 'tlc' : 'sany') : 'none',
        nextRecommended: data.sany?.valid ? 'ts' : undefined,
      });

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }

      if (data.sany?.valid) {
        if (agent && typeof agent.showTsContinuation === 'function') {
          agent.showTsContinuation({ autoChain: false });
        } else {
          _showStandaloneContinuation('ts', 'TLA+ verified — SANY passed', 'Continue to TypeScript Runtime');
        }
      }
    } catch (err) {
      const errMsg = err.message || 'TLA+ generation error';
      if (tlaResultsEl) {
        if (artifactResults) artifactResults.hidden = false;
        tlaResultsEl.hidden = false;
        const statusEl = document.getElementById('tla-status');
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${errMsg}</span>`;
      }
      showError(errMsg);
      showToast(`TLA+ generation failed — ${errMsg.slice(0, 80)}${errMsg.length > 80 ? '...' : ''}`, 'error', 6000);
    } finally {
      setLoading(false);
    }
  }

  async function renderTs() {
    if (!currentRunId || !currentDiagramName) {
      const lastEntry = sidebar.getLatestWithRunId?.();
      if (lastEntry?.run_id && lastEntry?.name) {
        currentRunId = lastEntry.run_id;
        currentDiagramName = lastEntry.name;
      } else {
        showError('No TLA+ specification available. Complete the TLA+ stage first.');
        return;
      }
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
      input.readOnly = false;

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
        const errMsg = data.error || 'TypeScript generation failed';
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">TypeScriptRuntime failed</span>`;
        if (compileEl) compileEl.textContent = errMsg;
        if (testsEl) testsEl.textContent = data.details || '';
        if (coverageEl) coverageEl.textContent = '';
        if (sourceEl) sourceEl.textContent = data.ts_source || '';
        if (tracesEl) tracesEl.textContent = '';
        showError(errMsg);
        showToast(`TypeScript generation failed — ${errMsg.slice(0, 80)}${errMsg.length > 80 ? '...' : ''}`, 'error', 6000);
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
      // Each coverage metric is tied back to its TLA+ counterpart so the
      // user knows exactly WHAT the harness proved about the architecture.
      if (coverageEl) coverageEl.innerHTML = `<span title="Share of TLA+ state entities exercised by the runtime">Entities: ${((coverage.entityCoverage || 0) * 100).toFixed(0)}%</span><span title="Share of TLA+ actions the harness executed">Actions: ${((coverage.actionCoverage || 0) * 100).toFixed(0)}%</span><span title="Share of TLA+ invariants the harness verified at runtime">Invariants: ${((coverage.invariantCoverage || 0) * 100).toFixed(0)}%</span>`;
      if (sourceEl) sourceEl.textContent = data.ts_source || '';

      if (Array.isArray(data.traces) && data.traces.length > 0) {
        if (tracesEl) tracesEl.textContent = data.traces.map(t => { const code = t.code ? ` ${t.code}` : ''; return `${t.type}${code}: ${t.message || t.raw || JSON.stringify(t)}`; }).join('\n');
      } else {
        if (tracesEl) tracesEl.textContent = 'No failure traces.';
      }

      const tsConfidence = data.success
        ? CONFIDENCE.VERIFIED
        : (compileOk ? CONFIDENCE.WEAK : CONFIDENCE.REJECTED);
      orchestrator.updateFromBackend({ stage: 'ts', confidence: tsConfidence });

      if (data.progressionUpdate) {
        orchestrator.updateFromBackend(data.progressionUpdate);
      }

      if (data.success) {
        // The finale — the entire pipeline (idea → md → mmd → tla → ts) is
        // now proven by one runnable script. Celebrate it like it deserves.
        _playRenderReveal({
          stage: 'ts',
          isFinal: true,
          diagramName: currentDiagramName,
          metrics: null,
          paths: currentPaths,
        });
        _showCompletionBanner({
          project: currentDiagramName,
          populatedStages: STAGES.filter(s => orchestrator.isCompleted(s)),
          runId: currentRunId,
          paths: currentPaths,
          metrics: _agentRunMetrics,
        });
        _showStandaloneContinuation('download', 'TypeScript compiled — pipeline complete · the runtime proves the full architecture', 'Download Full Bundle');
      }
    } catch (err) {
      const errMsg = err.message || 'TypeScript generation error';
      if (tsResultsEl) {
        if (artifactResults) artifactResults.hidden = false;
        tsResultsEl.hidden = false;
        const statusEl = document.getElementById('ts-status');
        if (statusEl) statusEl.innerHTML = `<span class="tla-badge tla-fail">Error: ${errMsg}</span>`;
      }
      showError(errMsg);
      showToast(`TypeScript generation failed — ${errMsg.slice(0, 80)}${errMsg.length > 80 ? '...' : ''}`, 'error', 6000);
    } finally {
      input.readOnly = false;
      setLoading(false);
      syncUiGuidance();
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

  // Debounced auto-save: every paste/edit is mirrored into the orchestrator
  // within ~400ms so we never lose user content if they reload or switch
  // tabs before the explicit save in `setMode` fires. Pairs with the paste
  // listener below for instant-save on paste.
  let _autoSaveTimer = null;
  input.addEventListener('input', () => {
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
      _autoSaveTimer = null;
      orchestrator.setArtifact(currentMode, input.value);
      orchestrator._persist();
    }, 400);
  });

  // Instant-save on paste — large pastes deserve immediate persistence
  // because the user expects the content to be safe the moment it hits
  // the textarea (especially when pasting a whitepaper into Simple Idea).
  input.addEventListener('paste', () => {
    // Defer to the next tick so input.value reflects the pasted content.
    setTimeout(() => {
      orchestrator.setArtifact(currentMode, input.value);
      orchestrator._persist();
      showToast(`Pasted into ${_stageLabel(currentMode)} tab — saved`, 'info', 2000);
    }, 0);
  });

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
        showToast(`New diagram "${name}" created — enter your idea`, 'success', 3000);
      } else {
        showToast('New diagram workspace — ready for your idea', 'info', 2500);
      }
      input.focus();
      syncUiGuidance();
    });

    syncUiGuidance();
  });

  btnFlip.addEventListener('click', () => {
    flipCard.toggle();
    btnFlip.setAttribute('aria-checked', String(flipCard.flipped));
  });
  btnResetZoom.addEventListener('click', () => { if (pzFront) pzFront.fitToViewport(); if (pzBack) pzBack.fitToViewport(); });
  btnDismissError.addEventListener('click', hideError);

  // Keyboard focus management
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !errorBanner.hidden) {
      hideError();
      input.focus();
    }
  });

  // ---- Enhance button ------------------------------------------------------
  // Behavior depends on the active input mode:
  //   • idea          → Click fires copilot.enhance() right away (rainbow
  //                     ring + textarea sheen visualize the work).
  //   • md/mmd/tla/ts → Click fires direct enhance via /api/copilot/enhance,
  //                     replacing the textarea with the refined text.
  //                     This is what the user expects when they click the
  //                     Enhance button on any tab — see request 2026-05-21.
  const _btnEnhanceClick = document.getElementById('btn-enhance');
  if (_btnEnhanceClick) {
    _btnEnhanceClick.addEventListener('click', () => {
      if (currentMode === 'idea') {
        if (!copilot) return;
        if (input.value.trim().length < 10) {
          _btnEnhanceClick.title = 'Type at least 10 characters to enhance';
          return;
        }
        _btnEnhanceClick.title = 'Refine your idea (Cmd+Enter)';
        copilot.enhance();
        return;
      }
      // md / mmd / tla / ts: directly enhance the current textarea content
      // via the same /api/copilot/enhance endpoint the idea-mode copilot uses.
      _enhanceCurrentTab();
    });
  }

  // Direct-enhance for non-idea tabs. Calls /api/copilot/enhance with the
  // current textarea content, then replaces the textarea with the refined
  // result. Auto-saves to the orchestrator artifact for the current stage so
  // the enhanced text persists across refresh.
  let _enhanceInFlight = false;
  async function _enhanceCurrentTab() {
    if (_enhanceInFlight) return;  // prevent double-clicks
    const sourceText = input.value;
    const trimmed = sourceText.trim();
    if (trimmed.length < 10) {
      showToast('Type or paste at least 10 characters to enhance', 'info', 3000);
      return;
    }
    if (input.readOnly) {
      showToast('Cannot enhance while agent is running', 'info', 3000);
      return;
    }

    _enhanceInFlight = true;
    // Reuse the existing animated 'is-enhancing' class (rainbow halo + pulse)
    // for visual consistency with the idea-mode copilot enhancement.
    _btnEnhanceClick?.classList.add('is-enhancing');
    showToast(`Enhancing ${_stageLabel(currentMode)} (${trimmed.length.toLocaleString()} chars)…`, 'info', 3500);

    const startMs = Date.now();
    try {
      const controller = new AbortController();
      // Scale timeout with input size: ~1 KB per second + 30s base, capped at 120s
      const timeoutMs = Math.min(180000, 30000 + Math.floor(trimmed.length / 100) * 1000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${COPILOT_API_BASE}/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: 'copilot_enhance',
          content_state: ({ mmd: 'mmd', md: 'md', tla: 'tla', ts: 'ts' })[currentMode] || 'text',
          mode: currentMode,
          enhance_mode: 'full',
          full_text: trimmed.slice(0, 80000),
          selected_text: null,
          preceding_context: '',
          following_context: '',
          previous_text: '',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.details || err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const enhancedSource = (data.enhanced_source || '').trim();

      if (!enhancedSource || enhancedSource === trimmed) {
        showToast('Enhancement returned no changes — text was already optimal', 'info', 4000);
        return;
      }

      // Apply the enhancement to the textarea and persist
      input.value = enhancedSource;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      orchestrator.setArtifact(currentMode, enhancedSource);  // auto-persists

      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
      const charDelta = enhancedSource.length - trimmed.length;
      const deltaStr = charDelta >= 0 ? `+${charDelta.toLocaleString()}` : charDelta.toLocaleString();
      showToast(
        `Enhanced ${_stageLabel(currentMode)} — ${enhancedSource.length.toLocaleString()} chars (${deltaStr}, ${elapsedSec}s, ${data.flavor || 'refine'})`,
        'success',
        5000,
      );
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Enhancement timed out' : (err.message || 'Enhancement failed');
      showToast(`Enhance failed — ${msg}`, 'error', 6000);
    } finally {
      _enhanceInFlight = false;
      _btnEnhanceClick?.classList.remove('is-enhancing');
    }
  }

  // ---- Top-bar New Diagram button (mirrors sidebar btn-new-diagram) ----
  const btnNewDiagramFloat = document.getElementById('btn-new-diagram-float');
  if (btnNewDiagramFloat) {
    btnNewDiagramFloat.addEventListener('click', () => btnNewDiagram.click());
  }

  // =========================================================================
  //  Agent Mode (unchanged)
  // =========================================================================

  function setAgentMode(modeId) {
    if (!modeId && agent && agent.running) {
      agent.stopAndPause();
      setAgentState('idle');
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
      // Always rebuild dropdown for current stage before showing
      _rebuildAgentDropdown();
      const wasHidden = agentDropdown.hidden;
      agentDropdown.hidden = !wasHidden;
      if (!agentDropdown.hidden) _positionAgentDropdown();
    });
  }

  // Agent mode option clicks are handled dynamically by _rebuildAgentDropdown()
  // Clicking outside the dropdown closes it (but not when clicking inside)
  document.addEventListener('click', (e) => {
    if (agentDropdown && !agentDropdown.hidden) {
      if (!agentDropdown.contains(e.target) && e.target !== btnAgentToggle && !btnAgentToggle?.contains(e.target)) {
        agentDropdown.hidden = true;
      }
    }
  });

  const agentNotesWrap = document.getElementById('agent-notes-wrap');
  const agentNotesInput = document.getElementById('agent-notes-input');
  const btnAgentCommit = document.getElementById('btn-agent-commit');

  function _createAgent() {
    if (agent) return;
    agent = new window.MermaidAgent({
      input, panel: agentPanel, panelLog: agentPanelLog, panelMode: agentPanelMode,
      notesWrap: agentNotesWrap, notesInput: agentNotesInput, btnFinalize: btnAgentCommit,
      onDraftUpdate: (event) => {
        // Draft text is the working idea/markdown architecture — it belongs
        // to the stage the agent was started from (idea or md), NEVER to
        // whatever tab the user happens to be viewing. Route it to the
        // owning artifact; only allow typing into the visible input when
        // the user is actually on that stage's tab.
        const draftStage = (currentMode === 'idea' || currentMode === 'md') ? currentMode : 'md';
        orchestrator.setArtifact(draftStage, event.text);
        if (currentMode === draftStage) return true;
        _markTabHasNewContent(draftStage);
        showToast(`Draft updated — see the ${_stageLabel(draftStage)} tab`, 'info', 2500);
        return false;
      },
      onPreviewRender: (event) => {
        _applyAgentArtifacts(event);
        _agenticallyReviewArtifacts(event);
        if (event.paths) {
          const depthMeta = (event.depth_score != null || event.depth_tier != null)
            ? { score: event.depth_score, tier: event.depth_tier } : null;
          showResult(event.paths, event.diagram_name, event.run_id, event.metrics, depthMeta);
          sidebar.add(buildSidebarEntry(event, input.value));
          showToast(`Preview ready — ${event.metrics?.nodeCount || '?'} nodes, ${event.metrics?.edgeCount || '?'} edges`, 'success', 3500);
        }
        _updateStageTracker('mmd', 'complete');
      },
      onRenderResult: (event) => {
        _applyAgentArtifacts(event);
        _agenticallyReviewArtifacts(event);
        if (event.paths) {
          const depthMeta = (event.depth_score != null || event.depth_tier != null)
            ? { score: event.depth_score, tier: event.depth_tier } : null;
          showResult(event.paths, event.diagram_name, event.run_id, event.metrics, depthMeta);
          sidebar.add(buildSidebarEntry(event, input.value));
          showToast(`Diagram finalized — ${event.diagram_name}`, 'success', 4000);
        }
      },
      onContinue: (stage) => {
        if (!orchestrator.isUnlocked(stage)) return;
        showToast(`Continuing to ${_stageLabel(stage)} stage`, 'info', 2500);
        setMode(stage);
        setTimeout(() => render(), 300);
      },
      onAgentFocus: (focus) => _showAgentGaze(focus),
      onPipelineStage: (event) => {
        _applyAgentArtifacts(event);
        _agenticallyReviewArtifacts(event);
        if (event.stage === 'tla') {
          const tlaOk = event.success && event.sany_valid;
          showToast(
            tlaOk ? `TLA+ verified — SANY passed, ${event.violations || 0} violations` : `TLA+ stage ${event.success ? 'completed' : 'failed'}`,
            tlaOk ? 'success' : 'error',
            4500,
          );
          _updateStageTracker('tla', tlaOk ? 'complete' : 'error');
        } else if (event.stage === 'ts') {
          showToast(
            event.success ? `TypeScript compiled — tsc ${event.compile_ok ? 'pass' : 'fail'}, tests ${event.tests_ok ? 'pass' : 'fail'}` : 'TypeScript stage failed',
            event.success ? 'success' : 'error',
            4500,
          );
          _updateStageTracker('ts', event.success ? 'complete' : 'error');
        }
      },
      onBundleReady: (event) => {
        _applyAgentArtifacts(event);
        const completedStages = event.stages_completed || [];
        if (completedStages.includes('tla')) {
          // WINNING (F2): bundle completion only opens the ts gate when the
          // TLA+ artifact actually passed SANY.
          orchestrator.updateFromBackend({
            stage: 'tla',
            unlockedStages: unlockedThrough(event.tla_valid ? 'ts' : 'tla'),
            confidence: event.tla_valid ? CONFIDENCE.PASS : CONFIDENCE.FAILED,
          });
        }
        if (completedStages.includes('ts')) {
          orchestrator.updateFromBackend({ stage: 'ts', confidence: event.ts_compiled ? CONFIDENCE.PASS : CONFIDENCE.BROKEN });
        }
        showToast(`Full build complete — ${completedStages.join(' \u2192 ')}`, 'success', 5000);
        _showStandaloneContinuation('download', `Full build complete — ${completedStages.join(' \u2192 ')}`, 'Download Full Bundle');
      },
      onComplete: () => {
        setAgentState('idle');
        btnAgentRun.textContent = 'Continue Agent';
        btnAgentRun.classList.remove('is-stopping');
        btnAgentRun.disabled = false;
        input.readOnly = false;
        showToast('Agent workflow complete', 'success', 3500);
        syncUiGuidance();

        // Top-level completion notification — surfaces the run summary even
        // if the user has switched away to another browser tab. Lists every
        // stage populated and offers one-click navigation/download actions.
        const populated = Array.from(_agentRunPopulatedStages);
        const projectName = (diagramNameInput?.value?.trim()) || currentDiagramName || '';
        _showCompletionBanner({
          project: projectName,
          populatedStages: populated,
          runId: currentRunId,
          paths: currentPaths,
          metrics: _agentRunMetrics,
        });

        // Update the browser tab title so users in other tabs see the
        // completion. Reverts to MERMATE after 8s.
        _setDocTitle('✓ Complete —', projectName);
        _resetDocTitleAfter(8000);
      },
      onError: (msg) => {
        setAgentState('idle');
        notesDirty = false;
        showError(msg);
        showToast(`Agent error: ${msg}`, 'error', 6000);
        btnAgentRun.textContent = 'Continue Agent';
        btnAgentRun.classList.remove('is-stopping');
        btnAgentRun.disabled = false;
        input.readOnly = false;
        setLoading(false);
        syncUiGuidance();

        // Surface error in browser tab title so it's visible from other tabs
        const projectName = (diagramNameInput?.value?.trim()) || currentDiagramName || '';
        _setDocTitle('⚠ Agent error —', projectName);
        _resetDocTitleAfter(6000);
      },
      onStateChange: (state) => {
        setAgentState(state);
        if (state === 'running') {
          notesDirty = false;
          btnAgentRun.textContent = 'Pause Agent';
          btnAgentRun.classList.add('is-stopping');
          btnAgentRun.disabled = false;
          btnAgentRun.hidden = false;
          // Reset completion tracking and reflect agent activity in the title
          _agentRunPopulatedStages = new Set();
          _agentRunMetrics = null;
          const projectName = (diagramNameInput?.value?.trim()) || currentDiagramName || '';
          _setDocTitle('⚡ Agent running —', projectName);
        }
        else if (state === 'awaiting_notes') { input.readOnly = false; btnAgentRun.hidden = true; }
        else if (state === 'finalizing') { notesDirty = false; input.readOnly = true; btnAgentRun.hidden = true; setLoading(true, 'text'); }
        else if (state === 'idle') { btnAgentRun.textContent = agent ? 'Continue Agent' : 'Run Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; btnAgentRun.hidden = !agentModeActive; btnRender.hidden = agentModeActive; input.readOnly = false; setLoading(false); }
        syncUiGuidance();
      },
    });
  }

  if (btnAgentRun) {
    btnAgentRun.addEventListener('click', () => {
      if (isLoading) return;
      if (agent && agent.running) {
        orchestrator.setArtifact(currentMode, input.value);
        agent.stopAndPause(); setAgentState('idle'); notesDirty = false;
        btnAgentRun.textContent = 'Continue Agent'; btnAgentRun.classList.remove('is-stopping'); btnAgentRun.disabled = false; btnAgentRun.hidden = false;
        input.readOnly = false; setLoading(false); syncUiGuidance(); return;
      }
      if (!selectedAgentMode) selectedAgentMode = _defaultAgentModeForStage(currentMode);
      _createAgent(); input.readOnly = true; hideError();
      orchestrator.setArtifact(currentMode, input.value);
      _resetStageTracker();
      _updateStageTracker(currentMode, 'active');
      // Fresh agent run — re-enable deterministic auto-switching. The user
      // can override mid-run by clicking a tab; until then we'll route them
      // to whichever artifact the agent produces.
      _autoSwitchUserOverride = false;
      if (_autoSwitchTimer) { clearTimeout(_autoSwitchTimer); _autoSwitchTimer = null; }
      showToast(`Agent started — ${getAgentModeLabel(selectedAgentMode)} on ${_stageLabel(currentMode)}`, 'info', 3000);
      _showAgentGaze({
        role: 'MERMATE',
        stage: currentMode,
        target: currentMode,
        summary: `Continuing from ${_stageLabel(currentMode)} artifact`,
      });
      agent.run(selectedAgentMode, diagramNameInput?.value?.trim() || currentDiagramName || undefined, currentMode, currentRunId);
    });
  }

  if (btnAgentCommit) {
    btnAgentCommit.addEventListener('click', () => {
      _createAgent();
      orchestrator.setArtifact(currentMode, input.value);
      agent.finalize(input.value, currentMode, currentRunId);
    });
  }
  if (agentNotesInput) { agentNotesInput.addEventListener('input', () => { notesDirty = !!agentNotesInput.value.trim(); syncUiGuidance(); }); }
  if (btnAgentStop) {
    btnAgentStop.addEventListener('click', () => {
      if (agent) {
        orchestrator.setArtifact(currentMode, input.value);
        agent.stopAndPause(); setAgentState('idle'); notesDirty = false; btnAgentRun.disabled = false; input.readOnly = false; setLoading(false); syncUiGuidance();
      }
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
  _isBootRestore = true;
  setMode(orchestrator.currentStage);
  _isBootRestore = false;
  _rebuildAgentDropdown();
  updateBadges();

  // ---- Recover artifacts from a completed run (WINNING F4/Reload) ---------
  // When the agent finished while the browser was detached, the SSE events
  // carrying stage artifacts never reached this client. The server already
  // persists everything per-run; /api/artifacts/:run_id returns it. Only
  // fills stages that are missing locally — newer local content always wins.
  async function _recoverCompletedRun(runId) {
    if (!runId) return false;
    try {
      const res = await fetch(`/api/artifacts/${runId}`);
      if (!res.ok) return false;
      const data = await res.json();
      const stages = data.stages || {};
      let recovered = 0;

      const mmdSrc = stages.mermaid?.source;
      if (mmdSrc?.trim() && !(orchestrator.getArtifact('mmd') || '').trim()) {
        orchestrator.setArtifact('mmd', mmdSrc);
        orchestrator.updateFromBackend({
          stage: 'mmd', unlockedStages: unlockedThrough('tla'),
          confidence: CONFIDENCE.COMPILED, verification: 'compiled',
        });
        recovered++;
      }

      const tlaSrc = stages.tla?.source;
      if (tlaSrc?.trim() && !(orchestrator.getArtifact('tla') || '').trim()) {
        const sanyOk = !!stages.tla?.metrics?.sany_valid;
        orchestrator.setArtifact('tla', tlaSrc);
        orchestrator.updateFromBackend({
          stage: 'tla', unlockedStages: unlockedThrough(sanyOk ? 'ts' : 'tla'),
          confidence: sanyOk ? CONFIDENCE.PASS : CONFIDENCE.FAILED,
          verification: sanyOk ? (stages.tla.metrics.tlc_success ? 'tlc' : 'sany') : 'none',
        });
        recovered++;
      }

      const tsSrc = stages.typescript?.source;
      if (tsSrc?.trim() && !(orchestrator.getArtifact('ts') || '').trim()) {
        const compileOk = !!stages.typescript?.metrics?.compilePassed;
        orchestrator.setArtifact('ts', tsSrc);
        orchestrator.updateFromBackend({
          stage: 'ts',
          confidence: compileOk ? CONFIDENCE.PASS : CONFIDENCE.WEAK,
          verification: compileOk ? 'compiled' : 'none',
        });
        recovered++;
      }

      if (stages.mermaid?.diagramName && !currentDiagramName) {
        currentDiagramName = stages.mermaid.diagramName;
        if (diagramNameInput) diagramNameInput.value = currentDiagramName;
      }
      if (stages.mermaid?.paths && !currentPaths) currentPaths = stages.mermaid.paths;

      if (recovered > 0) {
        _persistSession();
        updateBadges();
        showToast(`Recovered ${recovered} stage${recovered > 1 ? 's' : ''} from completed run ${runId.slice(0, 8)} — the agent finished while you were away`, 'success', 5000);
      }
      return recovered > 0;
    } catch {
      return false;
    }
  }

  // ---- Reattach to a live agent run after a page refresh ----
  // The server keeps agent pipelines running when the browser disconnects;
  // if we stored a session id and it's still live, reattach and replay
  // instead of restarting the whole pipeline.
  (async () => {
    const saved = window.MermaidAgent?.readSavedSession?.();
    if (!saved?.id) return;
    try {
      const res = await fetch('/api/agent/active');
      const data = await res.json();
      const live = (data.sessions || []).find(s => s.session_id === saved.id && s.status === 'running');
      if (!live) {
        // WINNING (F4/Reload): the run may have COMPLETED while the browser
        // was detached — recover its artifacts from the server before
        // dropping the session pointer, or those stages are lost.
        await _recoverCompletedRun(currentRunId);
        window.MermaidAgent.clearSavedSession();
        return;
      }
      selectedAgentMode = saved.mode || selectedAgentMode;
      _createAgent();
      agentModeActive = true;
      btnAgentToggle?.classList.add('active');
      btnRender.hidden = true;
      btnAgentRun.hidden = false;
      input.readOnly = true;
      showToast('Agent still running — reattached to live progress', 'info', 4000);
      agent.attach(saved.id, saved.mode);
    } catch {
      window.MermaidAgent?.clearSavedSession?.();
    }
  })();

  // Restore pending entry if it exists
  const pendingItem = sidebar.items.find(i => i._pending);
  if (pendingItem && pendingItem.name && diagramNameInput) {
    diagramNameInput.value = pendingItem.name;
    currentDiagramName = pendingItem.name;
  }

  if (currentPaths && (currentPaths.png || currentPaths.svg)) {
    // Verify the restored paths actually resolve before showing — stale
    // paths from a deleted run would otherwise render as a black box.
    const verifyPath = currentPaths.png || currentPaths.svg;
    fetch(verifyPath, { method: 'HEAD' })
      .then(res => {
        if (res.ok) {
          showResult(currentPaths, currentDiagramName, currentRunId);
        } else {
          console.warn('[restore] Stored paths no longer exist, clearing session');
          currentPaths = null;
          currentRunId = null;
          _persistSession();
        }
      })
      .catch(() => {
        currentPaths = null;
        currentRunId = null;
        _persistSession();
      });
  }

  // =========================================================================
  //  Boot Sequence — coordinated health checks before app is ready
  // =========================================================================

  const _bootOverlay = document.getElementById('boot-overlay');
  const _bootStatusText = document.getElementById('boot-status-text');
  const _bootBadges = document.getElementById('boot-badges');

  function _bootBadge(label, state) {
    if (!_bootBadges) return;
    let el = _bootBadges.querySelector(`[data-badge="${label}"]`);
    if (!el) {
      el = document.createElement('span');
      el.dataset.badge = label;
      el.className = 'boot-badge pending';
      el.innerHTML = `<span class="boot-badge-dot"></span><span>${label}</span>`;
      _bootBadges.appendChild(el);
    }
    el.className = `boot-badge ${state}`;
  }

  function _bootProgress(msg) {
    if (_bootStatusText) _bootStatusText.textContent = msg;
  }

  function _bootComplete() {
    if (_bootOverlay) {
      _bootOverlay.style.transition = 'opacity 0.4s ease';
      _bootOverlay.style.opacity = '0';
      setTimeout(() => _bootOverlay.remove(), 500);
    }
  }

  function _bootFail(msg) {
    if (_bootStatusText) {
      _bootStatusText.textContent = 'Boot failed: ' + msg;
      _bootStatusText.style.color = '#ff6b6b';
    }
    // Remove overlay after 3s even on failure so user can interact
    setTimeout(() => {
      if (_bootOverlay) _bootOverlay.remove();
    }, 3000);
  }

  async function _runBootSequence() {
    let healthData = null;
    let copilotData = null;
    let tlaData = null;
    let diagramsData = null;

    // Step 1: Server health + payload-contract compatibility
    const EXPECTED_SCHEMA_VERSION = 1;
    _bootProgress('Checking server health...');
    _bootBadge('Server', 'pending');
    try {
      const res = await fetch('/api/health');
      healthData = await res.json();
      if (!healthData.success) throw new Error('health endpoint returned failure');
      if (healthData.schema_version != null && healthData.schema_version !== EXPECTED_SCHEMA_VERSION) {
        console.warn(`[boot] payload-contract mismatch — server schema_version ${healthData.schema_version}, frontend expects ${EXPECTED_SCHEMA_VERSION}. Artifact envelopes may not parse correctly.`);
      }
      _bootBadge('Server', 'ok');
    } catch (err) {
      _bootBadge('Server', 'fail');
      _bootFail('server health check failed');
      healthData = null;
    }

    // Step 2: Copilot + Max mode availability
    _bootProgress('Checking inference providers...');
    _bootBadge('AI', 'pending');
    try {
      const res = await fetch('/api/copilot/health');
      copilotData = await res.json();
      if (copilotData.maxAvailable) maxAvailable = true;
      // Feed health result to copilot if it exists (avoids redundant fetch)
      if (copilot && typeof copilot.setHealthState === 'function') {
        copilot.setHealthState(copilotData.available);
      }
      _bootBadge('AI', copilotData?.available ? 'ok' : 'warn');
    } catch { copilotData = null; _bootBadge('AI', 'fail'); }

    // Step 3: TLA+ status
    _bootProgress('Checking TLA+ toolchain...');
    _bootBadge('TLA+', 'pending');
    _bootBadge('Specula', 'pending');
    try {
      const res = await fetch('/api/render/tla/status');
      tlaData = await res.json();
      const tlaBtn = document.querySelector('.mode-btn[data-mode="tla"]');
      if (tlaBtn && tlaData) {
        const speculaReady = tlaData.specula?.apiKeyPresent && tlaData.available;
        if (speculaReady) {
          tlaBtn.dataset.specula = 'ready';
          tlaBtn.title = `TLA+ — Specula ready (${tlaData.specula.model})`;
        } else {
          tlaBtn.dataset.specula = 'unavailable';
          tlaBtn.title = tlaData.specula?.apiKeyPresent
            ? 'TLA+ — Java/TLC not available'
            : 'TLA+ — Specula unavailable (set CLAUDE_API_KEY)';
        }
      }
      _bootBadge('TLA+', tlaData?.available ? 'ok' : 'warn');
      _bootBadge('Specula', tlaData?.specula?.apiKeyPresent ? 'ok' : 'warn');
    } catch { tlaData = null; _bootBadge('TLA+', 'fail'); _bootBadge('Specula', 'fail'); }

    // Step 4: Diagrams list (sidebar reconciliation)
    _bootProgress('Loading diagrams...');
    _bootBadge('Diagrams', 'pending');
    try {
      const res = await fetch('/api/diagrams');
      diagramsData = await res.json();
      if (diagramsData.success && diagramsData.diagrams) {
        const serverNames = new Set(diagramsData.diagrams.map(d => d.name));
        sidebar.reconcile(serverNames);
        diagramsData.diagrams.forEach(d => {
          sidebar.add({ name: d.name, type: d.diagram_type || '', paths: d.paths, timestamp: d.created_at ? new Date(d.created_at).toLocaleString() : '', run_id: d.run_id || null });
        });
      }
      _bootBadge('Diagrams', 'ok');
    } catch { diagramsData = null; _bootBadge('Diagrams', 'fail'); }

    // Step 5: Complete — show Opseeq status (poll if warming up)
    if (healthData?.opseeq?.warming && !healthData.opseeq.healthy) {
      _bootProgress('Opseeq warming up...');
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const pollRes = await fetch('/api/health');
          const pollData = await pollRes.json();
          if (pollData.opseeq?.healthy) {
            healthData.opseeq = pollData.opseeq;
            break;
          }
        } catch { /* keep polling */ }
      }
    }
    const providerCount = healthData
      ? ['premium', 'ollama', 'enhancer'].filter(k => healthData.providers?.[k]).length
      : 0;
    const opseeqStatus = healthData?.opseeq
      ? (healthData.opseeq.healthy ? 'Opseeq ready' : (healthData.opseeq.warming ? 'Opseeq warming' : 'Opseeq offline'))
      : '';
    if (healthData?.opseeq) {
      _bootBadge('Opseeq', healthData.opseeq.healthy ? 'ok' : (healthData.opseeq.warming ? 'warn' : 'fail'));
    }
    _bootProgress(
      healthData
        ? `Ready — ${providerCount} provider(s), ${healthData.agents?.active || 0} agents${opseeqStatus ? ', ' + opseeqStatus : ''}`
        : 'Ready (limited — no server health)'
    );
    _bootComplete();
  }

  // ---- Opseeq gateway lifecycle (browser-window heartbeat) -----------------
  // Pings the backend every 20s while the tab is visible AND the app is
  // active (agent running, loading, or user recently interacted).
  // When idle, heartbeats stop and the backend shuts down Opseeq after
  // its idle timeout — no wasted API calls.
  let _opseeqHeartbeatTimer = null;

  async function _opseeqHeartbeat() {
    if (!RuntimeState.shouldPoll) return;
    try {
      await fetch('/api/opseeq/heartbeat', { method: 'POST' });
    } catch { /* server may be briefly unreachable */ }
  }

  function _startOpseeqHeartbeat() {
    if (_opseeqHeartbeatTimer) return;
    _opseeqHeartbeat();
    _opseeqHeartbeatTimer = setInterval(_opseeqHeartbeat, 20_000);
  }

  function _stopOpseeqHeartbeat() {
    if (_opseeqHeartbeatTimer) {
      clearInterval(_opseeqHeartbeatTimer);
      _opseeqHeartbeatTimer = null;
    }
  }

  // Start heartbeat immediately — ensures Opseeq is running when the app loads
  _startOpseeqHeartbeat();

  // Pause heartbeat when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      _stopOpseeqHeartbeat();
    } else {
      _startOpseeqHeartbeat();
    }
  });

  // Stop heartbeat when page is unloaded — backend will shut down Opseeq after idle timeout
  window.addEventListener('beforeunload', () => {
    _stopOpseeqHeartbeat();
    navigator.sendBeacon('/api/opseeq/stop', new Blob([''], { type: 'application/json' }));
  });

  _runBootSequence();

  // =========================================================================
  //  State Bus — read-only facade for external modules (autoguide, etc.)
  // =========================================================================

  const _busState = {
    get currentMode() { return currentMode; },
    get isLoading() { return isLoading; },
    get agentState() { return agentState; },
    get agentModeActive() { return agentModeActive; },
    get selectedAgentMode() { return selectedAgentMode; },
    get currentRunId() { return currentRunId; },
    get currentDiagramName() { return currentDiagramName; },
    get currentPaths() { return currentPaths; },
    get maxMode() { return maxMode; },
    get enhanceChecked() { return chkEnhance.checked; },
    get notesDirty() { return notesDirty; },
    get hasInput() { return !!(input.value || '').trim(); },
    get hasName() { return !!diagramNameInput?.value?.trim(); },
    get hasResult() { return !!currentPaths; },
    runtimeState: RuntimeState,
    orchestrator: {
      get state() { return Object.freeze({ ...orchestrator.state }); },
      isUnlocked(s) { return orchestrator.isUnlocked(s); },
      isCompleted(s) { return orchestrator.isCompleted(s); },
    },
  };
  Object.defineProperty(window, '__mermate', { value: Object.freeze(_busState), configurable: false });

})();
