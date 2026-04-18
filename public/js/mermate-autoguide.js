/**
 * Mermate Auto Guide — NemoClaw-powered tutorial overlay.
 *
 * Reads app state via window.__mermate (live getter facade),
 * scores 21 possible actions, highlights the best next step
 * with a breathing pink glow, and cascades through alternatives
 * on inactivity.
 */
(function () {
  'use strict';

  const STAGES = ['idea', 'md', 'mmd', 'tla', 'ts'];
  const INPUT_STAGES = new Set(['idea', 'md', 'mmd']);
  const CASCADE_DELAYS = [1200, 2000, 3000];
  const DEBOUNCE_MS = 400;
  const TYPING_PAUSE_MS = 400;

  let _active = false;
  let _cascadeIndex = 0;
  let _cascadeTimer = null;
  let _debounceTimer = null;
  let _lastTypingTs = 0;
  let _currentTarget = null;
  let _currentRuleId = null;
  let _completedActions = new Set();

  // Opseeq AI-backed guide state
  let _opseeqSuggestions = [];
  let _opseeqPollTimer = null;
  let _opseeqAvailable = false;
  const OPSEEQ_POLL_MS = 5000;

  function bus() { return window.__mermate; }

  // ---- Rule definitions ----

  function _evaluateRules() {
    const m = bus();
    if (!m) return [];

    const results = [];
    const mode = m.currentMode;
    const loading = m.isLoading;
    const aState = m.agentState;
    const agentActive = m.agentModeActive;
    const hasInput = m.hasInput;
    const hasName = m.hasName;
    const hasResult = m.hasResult;
    const enhance = m.enhanceChecked;
    const notes = m.notesDirty;
    const orch = m.orchestrator;

    if (loading) return [{ id: 'pause-loading', target: null, weight: 0, hint: '', pause: true }];
    if (aState === 'running' || aState === 'finalizing') return [{ id: 'pause-agent', target: null, weight: 0, hint: '', pause: true }];
    if (Date.now() - _lastTypingTs < TYPING_PAUSE_MS) return [{ id: 'pause-typing', target: null, weight: 0, hint: '', pause: true }];

    const errorBanner = document.getElementById('error-banner');
    if (errorBanner && !errorBanner.hidden) {
      results.push({ id: 'error-dismiss', target: '#btn-dismiss-error', weight: 100, hint: 'Dismiss the error to continue' });
    }

    if (mode === 'idea' && !hasInput && !hasName) {
      results.push({ id: 'name-project', target: '#diagram-name-input', weight: 80, hint: 'Name your project first' });
    }

    if (INPUT_STAGES.has(mode) && !hasInput) {
      const hints = {
        idea: 'Describe your system or paste an idea',
        md: 'Paste or upload a markdown spec',
        mmd: 'Paste Mermaid source or upload .mmd',
      };
      results.push({ id: `enter-${mode}`, target: '#mermaid-input', weight: 80, hint: hints[mode] || 'Enter your content' });
    }

    if (mode === 'idea' && hasInput && !enhance && !hasResult) {
      results.push({ id: 'enable-enhance', target: '#btn-enhance', weight: 50, hint: 'Enable Enhance for AI refinement' });
    }

    if (hasInput && !agentActive && !hasResult && INPUT_STAGES.has(mode)) {
      results.push({ id: 'select-agent', target: '#btn-agent-toggle', weight: 50, hint: 'Try Agent mode for deeper architecture' });
      results.push({ id: 'try-fullbuild', target: '#btn-agent-toggle', weight: 30, hint: 'Try Full Build for the complete pipeline' });
    }

    if (hasInput && !m.maxMode && agentActive) {
      const maxBtn = document.getElementById('btn-max');
      if (maxBtn && maxBtn.classList.contains('visible')) {
        results.push({ id: 'enable-max', target: '#btn-max', weight: 20, hint: 'Enable Max for premium output' });
      }
    }

    if (hasInput && !loading && !agentActive && !hasResult && INPUT_STAGES.has(mode)) {
      results.push({ id: 'render', target: '#btn-render', weight: 80, hint: 'Render your diagram' });
    }

    if (agentActive && hasInput && aState === 'idle') {
      results.push({ id: 'run-agent', target: '#btn-agent-run', weight: 80, hint: 'Run the agent' });
    }

    if (aState === 'awaiting_notes') {
      if (!notes) {
        results.push({ id: 'agent-notes', target: '#agent-notes-input', weight: 80, hint: 'Add notes to steer the final render' });
      }
      results.push({ id: 'agent-commit', target: '#btn-agent-commit', weight: 80, hint: 'Finalize the agent run' });
    }

    if (hasResult && orch.isUnlocked('tla') && INPUT_STAGES.has(mode)) {
      const cta = document.querySelector('.standalone-continuation[data-continuation-stage="tla"]');
      const seg = document.querySelector('.pipeline-segment[data-stage="tla"]');
      results.push({ id: 'continue-tla', target: cta || seg, weight: 80, hint: 'Continue to TLA+ specification' });
    }

    if (orch.isCompleted('tla') && orch.isUnlocked('ts') && mode !== 'ts') {
      const cta = document.querySelector('.standalone-continuation[data-continuation-stage="ts"]');
      const seg = document.querySelector('.pipeline-segment[data-stage="ts"]');
      results.push({ id: 'continue-ts', target: cta || seg, weight: 80, hint: 'Continue to TypeScript runtime' });
    }

    const downloadCta = document.querySelector('.standalone-continuation[data-continuation-stage="download"]');
    if (orch.isCompleted('ts') || downloadCta) {
      results.push({ id: 'download', target: downloadCta || '#btn-download', weight: 80, hint: 'Download your full codebase bundle' });
    }

    if (hasResult && INPUT_STAGES.has(mode)) {
      results.push({ id: 'inspect-result', target: '#result-section', weight: 20, hint: 'Scroll down to inspect your diagram' });
      results.push({ id: 'refine', target: '#mermaid-input', weight: 20, hint: 'Edit and re-render to refine' });
    }

    for (const r of results) {
      if (_completedActions.has(r.id)) r.weight = Math.floor(r.weight / 2);
    }

    results.sort((a, b) => b.weight - a.weight);
    return results;
  }

  // ---- Resolve target element ----

  function _resolveTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    if (target instanceof HTMLElement) return target;
    return null;
  }

  // ---- Highlight ----

  function _clearHighlight(immediate) {
    if (!_currentTarget) return;
    const el = _currentTarget;
    if (immediate) {
      el.classList.remove('autoguide-target', 'autoguide-exit');
    } else {
      el.classList.add('autoguide-exit');
      el.classList.remove('autoguide-target');
      setTimeout(() => el.classList.remove('autoguide-exit'), 250);
    }
    _currentTarget = null;
    _currentRuleId = null;
    _hideTooltip();
  }

  function _applyHighlight(el, hint, ruleId, step, total) {
    if (_currentTarget === el && _currentRuleId === ruleId) return;
    _clearHighlight(false);

    _currentTarget = el;
    _currentRuleId = ruleId;

    const rect = el.getBoundingClientRect();
    const inView = rect.top >= -60 && rect.bottom <= window.innerHeight + 60;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    requestAnimationFrame(() => {
      el.classList.add('autoguide-target');
      _showTooltip(el, hint, step, total);
    });
  }

  // ---- Tooltip ----

  function _showTooltip(anchor, text, step, total) {
    const tip = document.getElementById('autoguide-tooltip');
    if (!tip) return;

    const stepLabel = (step > 0 && total > 0) ? `Step ${step} of ${total}` : '';
    tip.innerHTML = `<span class="autoguide-tooltip-text">${text}</span>${stepLabel ? `<span class="autoguide-tooltip-step">${stepLabel}</span>` : ''}`;
    tip.hidden = false;

    const r = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const tipH = tip.offsetHeight || 36;
    const spaceAbove = r.top;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - 140, window.innerWidth - 288));

    if (spaceAbove > tipH + 12) {
      tip.style.top = (r.top - tipH - 8) + 'px';
      tip.dataset.pos = 'above';
    } else {
      tip.style.top = (r.bottom + 8) + 'px';
      tip.dataset.pos = 'below';
    }
    tip.style.left = left + 'px';
  }

  function _hideTooltip() {
    const tip = document.getElementById('autoguide-tooltip');
    if (tip) tip.hidden = true;
  }

  // ---- Pipeline beacon ----

  function _updateBeacon() {
    const beacon = document.getElementById('autoguide-beacon');
    if (!beacon) return;
    const m = bus();
    if (!m) return;
    const orch = m.orchestrator;
    const mode = m.currentMode;

    beacon.querySelectorAll('.beacon-seg').forEach(seg => {
      const stage = seg.dataset.stage;
      if (orch.isCompleted(stage)) seg.dataset.state = 'completed';
      else if (stage === mode) seg.dataset.state = 'active';
      else if (orch.isUnlocked(stage)) seg.dataset.state = 'pending';
      else seg.dataset.state = 'locked';
    });
  }

  // ---- Cascade timer ----

  function _startCascade() {
    _stopCascade();
    const delay = CASCADE_DELAYS[Math.min(_cascadeIndex, CASCADE_DELAYS.length - 1)];
    if (_cascadeIndex >= CASCADE_DELAYS.length) return;

    _cascadeTimer = setTimeout(() => {
      _cascadeIndex++;
      _evaluate();
    }, delay);
  }

  function _stopCascade() {
    if (_cascadeTimer) { clearTimeout(_cascadeTimer); _cascadeTimer = null; }
  }

  // ---- Opseeq AI-backed evaluation ----

  async function _pollOpseeq() {
    if (!_active) return;
    const m = bus();
    if (!m) return;
    try {
      const uiState = {
        currentMode: m.currentMode,
        isLoading: m.isLoading,
        agentState: m.agentState,
        agentModeActive: m.agentModeActive,
        hasInput: m.hasInput,
        hasName: m.hasName,
        hasResult: m.hasResult,
        enhanceChecked: m.enhanceChecked,
        maxMode: m.maxMode,
        notesDirty: m.notesDirty,
        currentRunId: m.currentRunId || null,
        currentDiagramName: m.currentDiagramName || null,
        unlockedStages: m.orchestrator ? STAGES.filter(s => m.orchestrator.isUnlocked(s)) : [],
        completedStages: m.orchestrator ? STAGES.filter(s => m.orchestrator.isCompleted(s)) : [],
        errorVisible: !!(document.getElementById('error-banner') && !document.getElementById('error-banner').hidden),
      };
      const res = await fetch('/api/guide/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uiState }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        _opseeqSuggestions = data.suggestions;
        _opseeqAvailable = true;
        if (_active) _evaluate();
      } else {
        _opseeqSuggestions = [];
      }
    } catch {
      _opseeqAvailable = false;
      _opseeqSuggestions = [];
    }
  }

  function _startOpseeqPoll() {
    _stopOpseeqPoll();
    _pollOpseeq();
    _opseeqPollTimer = setInterval(_pollOpseeq, OPSEEQ_POLL_MS);
  }

  function _stopOpseeqPoll() {
    if (_opseeqPollTimer) { clearInterval(_opseeqPollTimer); _opseeqPollTimer = null; }
  }

  // ---- Core evaluation ----

  function _evaluate() {
    if (!_active) return;

    let rules = _evaluateRules();
    // Merge Opseeq AI suggestions (higher priority when available)
    if (_opseeqSuggestions.length > 0) {
      for (const s of _opseeqSuggestions) {
        if (s.pause) { rules = [{ id: 'opseeq-pause', target: null, weight: 0, hint: '', pause: true }]; break; }
        if (s.target && s.hint) {
          const existing = rules.find(r => r.target === s.target);
          if (existing) {
            existing.weight = Math.max(existing.weight, s.weight || 80);
            existing.hint = s.hint;
          } else {
            rules.push({ id: `opseeq-${s.target}`, target: s.target, weight: s.weight || 80, hint: s.hint });
          }
        }
      }
      rules.sort((a, b) => b.weight - a.weight);
    }
    if (rules.length === 0 || (rules[0] && rules[0].pause)) {
      _clearHighlight(false);
      _stopCascade();
      if (rules[0]?.pause) {
        setTimeout(_evaluate, 500);
      }
      return;
    }

    const pipelineSteps = rules.filter(r => r.weight >= 50);
    const total = pipelineSteps.length;
    const idx = Math.min(_cascadeIndex, rules.length - 1);
    const rule = rules[idx];
    if (!rule) { _clearHighlight(false); return; }

    const el = _resolveTarget(rule.target);
    if (!el) {
      if (_cascadeIndex < rules.length - 1) { _cascadeIndex++; _evaluate(); }
      else _clearHighlight(false);
      return;
    }

    const stepNum = pipelineSteps.indexOf(rule) + 1;
    _applyHighlight(el, rule.hint, rule.id, stepNum, total);
    _updateBeacon();
    _startCascade();
  }

  // ---- Interaction tracker ----

  function _onInteraction(e) {
    if (!_active) return;

    if (e.type === 'input' || e.type === 'keydown') {
      const target = e.target;
      if (target && (target.id === 'mermaid-input' || target.id === 'diagram-name-input' || target.id === 'agent-notes-input')) {
        _lastTypingTs = Date.now();
      }
    }

    if (_currentTarget && e.target && (_currentTarget === e.target || _currentTarget.contains(e.target))) {
      if (_currentRuleId) _completedActions.add(_currentRuleId);
    }

    _clearHighlight(false);
    _cascadeIndex = 0;
    _stopCascade();

    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_evaluate, DEBOUNCE_MS);
  }

  function _bindListeners() {
    document.addEventListener('click', _onInteraction, true);
    document.addEventListener('input', _onInteraction, true);
    document.addEventListener('keydown', _onInteraction, true);
    document.addEventListener('focusin', _onInteraction, true);
  }

  function _unbindListeners() {
    document.removeEventListener('click', _onInteraction, true);
    document.removeEventListener('input', _onInteraction, true);
    document.removeEventListener('keydown', _onInteraction, true);
    document.removeEventListener('focusin', _onInteraction, true);
  }

  // ---- Public API ----

  function start() {
    if (_active) return;
    _active = true;
    _cascadeIndex = 0;
    _completedActions.clear();

    const beacon = document.getElementById('autoguide-beacon');
    if (beacon) beacon.hidden = false;

    _bindListeners();
    _startOpseeqPoll();
    _evaluate();

    try { localStorage.setItem('mermate_guide_enabled', 'true'); } catch {}
  }

  function stop() {
    if (!_active) return;
    _active = false;
    _stopCascade();
    _stopOpseeqPoll();
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    _clearHighlight(true);
    _unbindListeners();

    const beacon = document.getElementById('autoguide-beacon');
    if (beacon) beacon.hidden = true;
    _hideTooltip();

    try { localStorage.setItem('mermate_guide_enabled', 'false'); } catch {}
  }

  function toggle() {
    if (_active) stop(); else start();
    return _active;
  }

  function isActive() { return _active; }

  function resetSession() {
    _completedActions.clear();
    _cascadeIndex = 0;
    if (_active) _evaluate();
  }

  window.MermateAutoGuide = Object.freeze({ start, stop, toggle, isActive, resetSession });

  if (localStorage.getItem('mermate_guide_enabled') === 'true') {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(start, 800);
    });
  }
})();
