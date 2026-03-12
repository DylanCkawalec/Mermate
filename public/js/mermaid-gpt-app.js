/**
 * Mermaid-GPT — Main application controller.
 * Handles mode selection, file upload, rendering, fullscreen, ZIP download.
 */
(function () {
  'use strict';

  // ---- Elements ----
  const input = document.getElementById('mermaid-input');
  const btnRender = document.getElementById('btn-render');
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

  // Run details panel
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
  let isFullscreen = false;
  let copilot = null;
  let speech = null;
  let renderEffect = null;
  let renderEffectLoader = null;
  let loadingHideTimer = null;
  let profileHint = '';
  let agentState = 'idle';
  let notesDirty = false;

  const COPILOT_API_BASE = '/api/copilot';

  // ---- Mode config ----
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
  };

  const LOADING_MESSAGES = {
    text: 'Converting text to diagram...',
    md: 'Extracting diagram from markdown...',
    mmd: 'Compiling diagram...',
    hybrid: 'Repairing and compiling...',
  };

  const STATE_LABELS = {
    text: 'plain text',
    md: 'markdown',
    mmd: 'mermaid',
    hybrid: 'mixed input',
  };

  const AGENT_MODE_LABELS = {
    thinking: 'Thinking',
    'code-review': 'Code Review',
    'optimize-mmd': 'Optimize',
  };

  function getAgentModeLabel(modeId) {
    return AGENT_MODE_LABELS[modeId] || (modeId ? modeId.replace(/-/g, ' ') : 'Agent');
  }

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
      hint = loadingText.textContent || 'Compiling diagram...';
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

  // ---- Mode selector ----
  function setMode(mode) {
    currentMode = mode;
    const cfg = MODES[mode];
    input.placeholder = cfg.placeholder;
    chkEnhance.checked = cfg.enhanceDefault;

    if (cfg.showUpload) {
      btnUpload.classList.add('visible');
      fileUpload.setAttribute('accept', cfg.accept || '');
    } else {
      btnUpload.classList.remove('visible');
    }

    document.querySelectorAll('.mode-btn').forEach(btn => {
      const isActive = btn.dataset.mode === mode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });

    // Copilot lifecycle: only active in idea mode
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

    syncUiGuidance();
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // ---- File upload ----
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

  // ---- Helpers ----
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
      loadingText.textContent = 'Compiling diagram...';
    }

    if (on) {
      if (loadingHideTimer) {
        clearTimeout(loadingHideTimer);
        loadingHideTimer = null;
      }
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

  function showResult(paths, name, runId) {
    currentPaths = paths;
    currentDiagramName = name || 'diagram';
    const ts = Date.now();
    resultSection.hidden = false;
    flipCard.showFront();

    if (runDetails && runId) {
      runDetails.show(runId);
    } else if (runDetails && !runId) {
      runDetails.hide();
    }

    // ---- PNG (front face) ----
    // Destroy old PanZoom before swapping src so the RAF loop doesn't
    // keep running against a stale element reference.
    if (pzFront) { pzFront.destroy(); pzFront = null; }

    resultPng.onload = () => {
      // Fit large diagrams into the viewport on first load.
      // PanZoom is created here so it starts at the correct scale.
      pzFront = new window.PanZoom(panZoomFront, resultPng);
      pzFront.fitToViewport();
    };
    resultPng.src = paths.png + '?t=' + ts;

    // ---- SVG (back face, loaded as <img> for GPU compositing) ----
    if (pzBack) { pzBack.destroy(); pzBack = null; }

    resultSvg.onload = () => {
      pzBack = new window.PanZoom(panZoomBack, resultSvg);
      pzBack.fitToViewport();
    };
    // SVG served with width="100%" — use a natural pixel size via a
    // direct URL so the browser knows the intrinsic SVG dimensions.
    resultSvg.src = paths.svg + '?t=' + ts;

    resultSection.classList.add('is-revealing');
    window.setTimeout(() => resultSection.classList.remove('is-revealing'), 220);
    syncUiGuidance();
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
    if (renderEffect) {
      renderEffect.dispose();
      renderEffect = null;
    }
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

  // ---- Profile-driven hints ----
  function _onProfileUpdate(profile) {
    profileHint = currentMode === 'idea' && profile?.hint ? profile.hint : '';
    syncUiGuidance();
  }

  // ---- Text transition animation (render path) ----
  // Mirrors the agent's _animateDraftUpdate: word-by-word reveal with
  // orange / indigo / pink highlighting for preserved words.
  const _TRANSITION_COLORS = ['#e8820c', '#4f46e5', '#db2777'];
  let _renderAnimating = false;

  function _tokenize(text) {
    return text.split(/(\s+)/).filter(t => t.trim());
  }

  function _simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
  }

  function _frame() { return new Promise(r => requestAnimationFrame(r)); }
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function animateRenderTransition(oldText, newText) {
    if (_renderAnimating || !newText) return;
    // Respect reduced-motion: just swap the text immediately.
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
    const classified = newWords.map(w => ({
      word: w,
      preserved: oldSet.has(w.toLowerCase()),
    }));

    // Create animation overlay on the textarea wrapper
    const wrap = textarea.closest('.copilot-wrap') || textarea.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'render-typing-overlay';
    overlay.style.cssText = [
      'position:absolute; inset:0; padding:14px;',
      'font-family:var(--font-mono); font-size:0.82rem; line-height:1.6;',
      'white-space:pre-wrap; word-wrap:break-word; overflow:hidden;',
      'z-index:5; pointer-events:none; border-radius:var(--radius);',
      'background:var(--surface);',
    ].join(' ');
    wrap.style.position = 'relative';
    textarea.style.opacity = '0';
    wrap.appendChild(overlay);

    // Reveal words in batches
    const BATCH = 8;
    const DELAY = 12;

    for (let i = 0; i < classified.length; i += BATCH) {
      const batch = classified.slice(i, i + BATCH);
      for (const item of batch) {
        const span = document.createElement('span');
        span.textContent = item.word + ' ';
        if (item.preserved) {
          const color = _TRANSITION_COLORS[Math.abs(_simpleHash(item.word)) % _TRANSITION_COLORS.length];
          span.style.cssText = `color:${color}; font-weight:600; opacity:0; transition:opacity 0.15s, color 0.4s;`;
        } else {
          span.style.cssText = 'color:#9ca3af; opacity:0; transition:opacity 0.12s, color 0.5s;';
        }
        overlay.appendChild(span);
      }

      await _frame();
      const spans = overlay.querySelectorAll('span');
      for (let j = Math.max(0, i); j < Math.min(spans.length, i + BATCH); j++) {
        spans[j].style.opacity = '1';
      }
      if (DELAY > 0) await _sleep(DELAY);
    }

    // Settle: transition all words to the default text color
    await _sleep(120);
    overlay.querySelectorAll('span').forEach(s => {
      s.style.color = 'var(--text)';
      s.style.fontWeight = 'normal';
    });

    await _sleep(250);

    // Swap: set real textarea content and dissolve overlay
    textarea.value = newText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.style.opacity = '1';
    overlay.style.transition = 'opacity 0.15s';
    overlay.style.opacity = '0';
    await _sleep(160);
    overlay.remove();

    _renderAnimating = false;
  }

  // ---- Fullscreen ----
  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    resultSection.classList.toggle('fullscreen', isFullscreen);
    expandBtns.forEach(btn => {
      btn.title = isFullscreen ? 'Exit fullscreen' : 'Expand';
      btn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Expand to fullscreen');
    });
  }

  expandBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) {
      toggleFullscreen();
    }
  });

  // ---- ZIP download ----
  async function downloadBundle() {
    if (!currentPaths || !window.JSZip) return;
    try {
      const [pngRes, svgRes] = await Promise.all([
        fetch(currentPaths.png),
        fetch(currentPaths.svg),
      ]);
      const [pngBlob, svgBlob] = await Promise.all([pngRes.blob(), svgRes.blob()]);

      const zip = new JSZip();
      zip.file(`${currentDiagramName}.png`, pngBlob);
      zip.file(`${currentDiagramName}.svg`, svgBlob);

      const now = new Date();
      const dateStr = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
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

  // ---- Render ----
  async function render() {
    if (isLoading || _renderAnimating) return;
    const source = input.value.trim();
    if (!source) {
      showError('Please enter a diagram description or paste Mermaid source.');
      return;
    }

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
        showError(data.details || data.error || 'Compilation failed');
        return;
      }

      // If the server enhanced text/md → mermaid, animate the transition
      const shouldAnimate = data.enhanced && data.compiled_source
        && data.content_state !== 'mmd';
      if (shouldAnimate) {
        setLoading(false);
        await animateRenderTransition(source, data.compiled_source);
      }

      showResult(data.paths, data.diagram_name, data.run_id);

      const finalText = shouldAnimate ? data.compiled_source : source;
      if (copilot) copilot.setRenderedHash(finalText);

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
      if (err.name === 'TypeError') {
        showError('Could not reach server. Is Mermaid-GPT running?');
      } else {
        showError(err.message || 'Unexpected error');
      }
    } finally {
      setLoading(false);
    }
  }

  // ---- Event listeners ----
  btnRender.addEventListener('click', render);
  btnDownload.addEventListener('click', downloadBundle);

  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (currentMode === 'idea' && copilot) {
        copilot.enhance();
      } else {
        render();
      }
    }
  });

  input.addEventListener('input', updateBadges);
  diagramNameInput?.addEventListener('input', syncUiGuidance);

  btnNewDiagram.addEventListener('click', () => {
    input.value = '';
    if (diagramNameInput) diagramNameInput.value = '';
    resultSection.hidden = true;
    if (isFullscreen) toggleFullscreen();
    hideError();
    typeBadge.classList.remove('visible');
    stateBadge.classList.remove('visible');
    currentPaths = null;
    currentDiagramName = '';
    if (copilot) copilot.dismissGhost();

    // Create a pending sidebar entry and immediately prompt for a name
    sidebar.addPending((name) => {
      if (name && diagramNameInput) {
        diagramNameInput.value = name;
        currentDiagramName = name;
      }
      // After naming, focus the main input for content
      input.focus();
      syncUiGuidance();
    });

    syncUiGuidance();
  });

  btnFlip.addEventListener('click', () => flipCard.toggle());

  btnResetZoom.addEventListener('click', () => {
    if (pzFront) pzFront.fitToViewport();
    if (pzBack) pzBack.fitToViewport();
  });

  btnDismissError.addEventListener('click', hideError);

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

  // ---- Agent mode logic ----

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

    // Update toggle button
    btnAgentToggle.classList.toggle('active', agentModeActive);

    // Update dropdown selection
    agentDropdown.querySelectorAll('.agent-mode-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.agentMode === modeId);
    });

    // Show/hide agent run button vs render button
    if (agentModeActive) {
      btnRender.hidden = true;
      btnAgentRun.hidden = false;
    } else {
      btnRender.hidden = false;
      btnAgentRun.hidden = true;
      agentPanel.hidden = true;
    }

    // Close dropdown
    agentDropdown.hidden = true;
    syncUiGuidance();
  }

  if (btnAgentToggle) {
    btnAgentToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (agentModeActive) {
        setAgentMode(null);
      } else {
        agentDropdown.hidden = !agentDropdown.hidden;
      }
    });
  }

  agentDropdown?.querySelectorAll('.agent-mode-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setAgentMode(opt.dataset.agentMode);
    });
  });

  document.addEventListener('click', () => {
    if (agentDropdown && !agentDropdown.hidden) {
      agentDropdown.hidden = true;
    }
  });

  const agentNotesWrap = document.getElementById('agent-notes-wrap');
  const agentNotesInput = document.getElementById('agent-notes-input');
  const btnAgentCommit = document.getElementById('btn-agent-commit');

  function _createAgent() {
    if (agent) return;
    agent = new window.MermaidAgent({
      input,
      panel: agentPanel,
      panelLog: agentPanelLog,
      panelMode: agentPanelMode,
      notesWrap: agentNotesWrap,
      notesInput: agentNotesInput,
      btnFinalize: btnAgentCommit,
      onPreviewRender: (event) => {
        if (event.paths) {
          showResult(event.paths, event.diagram_name);
          sidebar.add({
            name: event.diagram_name,
            type: event.diagram_type || 'flowchart',
            paths: event.paths,
            timestamp: new Date().toLocaleString(),
            source: input.value,
          });
        }
      },
      onRenderResult: (event) => {
        if (event.paths) {
          showResult(event.paths, event.diagram_name);
          sidebar.add({
            name: event.diagram_name,
            type: event.diagram_type || 'flowchart',
            paths: event.paths,
            timestamp: new Date().toLocaleString(),
            source: input.value,
          });
        }
      },
      onComplete: () => {
        agentState = 'idle';
        btnAgentRun.textContent = 'Run Agent';
        btnAgentRun.classList.remove('is-stopping');
        btnAgentRun.disabled = false;
        input.readOnly = false;
        syncUiGuidance();
      },
      onError: (msg) => {
        agentState = 'idle';
        notesDirty = false;
        showError(msg);
        btnAgentRun.textContent = 'Run Agent';
        btnAgentRun.classList.remove('is-stopping');
        btnAgentRun.disabled = false;
        input.readOnly = false;
        setLoading(false);
        syncUiGuidance();
      },
      onStateChange: (state) => {
        agentState = state;
        if (state === 'running') {
          notesDirty = false;
          btnAgentRun.textContent = 'Stop Agent';
          btnAgentRun.classList.add('is-stopping');
          btnAgentRun.disabled = false;
          btnAgentRun.hidden = false;
        } else if (state === 'awaiting_notes') {
          input.readOnly = false;
          btnAgentRun.hidden = true;
        } else if (state === 'finalizing') {
          notesDirty = false;
          input.readOnly = true;
          btnAgentRun.hidden = true;
          setLoading(true, 'text');
        } else if (state === 'idle') {
          btnAgentRun.textContent = 'Run Agent';
          btnAgentRun.classList.remove('is-stopping');
          btnAgentRun.disabled = false;
          btnAgentRun.hidden = false;
          input.readOnly = false;
          setLoading(false);
        }

        syncUiGuidance();
      },
    });
  }

  if (btnAgentRun) {
    btnAgentRun.addEventListener('click', () => {
      if (isLoading) return;

      if (agent && agent.running) {
        agent.stopAndRestore();
        agentState = 'idle';
        notesDirty = false;
        btnAgentRun.textContent = 'Run Agent';
        btnAgentRun.classList.remove('is-stopping');
        btnAgentRun.disabled = false;
        btnAgentRun.hidden = false;
        input.readOnly = false;
        setLoading(false);
        syncUiGuidance();
        return;
      }

      if (!selectedAgentMode) return;
      _createAgent();
      input.readOnly = true;
      hideError();
      agent.run(selectedAgentMode, diagramNameInput?.value?.trim() || undefined);
    });
  }

  if (btnAgentCommit) {
    btnAgentCommit.addEventListener('click', () => {
      _createAgent();
      agent.finalize();
    });
  }

  if (agentNotesInput) {
    agentNotesInput.addEventListener('input', () => {
      notesDirty = !!agentNotesInput.value.trim();
      syncUiGuidance();
    });
  }

  if (btnAgentStop) {
    btnAgentStop.addEventListener('click', () => {
      if (agent) {
        agent.stopAndRestore();
        agentState = 'idle';
        notesDirty = false;
        btnAgentRun.disabled = false;
        input.readOnly = false;
        setLoading(false);
        syncUiGuidance();
      }
    });
  }

  // ---- Talk-to-Text ----
  const btnMic = document.getElementById('btn-mic');
  if (window.MermaidSpeech && btnMic) {
    speech = new window.MermaidSpeech(input, btnMic, {
      onInsert: () => updateBadges(),
      onError: (msg) => showError(msg),
    });
  }

  // /talk command: detect when user types /talk and trigger recording
  input.addEventListener('input', () => {
    const val = input.value;
    if (val.trimEnd().endsWith('/talk')) {
      input.value = val.slice(0, val.lastIndexOf('/talk')).trimEnd();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (speech && !speech.recording && !speech.processing) {
        speech.start();
      }
    }
  });

  // ---- Init ----
  setMode('idea');
  updateBadges();

  // Check if Max mode is available from the provider chain
  fetch('/api/copilot/health')
    .then(r => r.json())
    .then(data => {
      if (data.maxAvailable && btnMax) {
        btnMax.classList.add('visible');
      }
    })
    .catch(() => {});

  fetch('/api/diagrams')
    .then(r => r.json())
    .then(data => {
      if (data.success && data.diagrams) {
        const serverNames = new Set(data.diagrams.map(d => d.name));
        // Prune stale localStorage entries that no longer exist on server
        sidebar.reconcile(serverNames);
        // Merge server diagrams into sidebar (newest first)
        data.diagrams.forEach(d => {
          sidebar.add({
            name: d.name,
            type: d.diagram_type || '',
            paths: d.paths,
            timestamp: d.created_at ? new Date(d.created_at).toLocaleString() : '',
          });
        });
      }
    })
    .catch(() => {});

})();
