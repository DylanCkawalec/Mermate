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
  const loadingText = document.getElementById('loading-text');
  const resultSection = document.getElementById('result-section');
  const errorBanner = document.getElementById('error-banner');
  const errorMessage = document.getElementById('error-message');
  const typeBadge = document.getElementById('diagram-type-badge');
  const stateBadge = document.getElementById('content-state-badge');
  const chkEnhance = document.getElementById('chk-enhance');
  const inputHint = document.getElementById('input-hint');
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
    showResult(item.paths, item.name);
  });

  // ---- State ----
  let isLoading = false;
  let currentMode = 'idea';
  let currentDiagramName = '';
  let currentPaths = null;
  let isFullscreen = false;
  let copilot = null;

  const ENHANCER_URL = window.location.origin.replace(/:\d+$/, ':8100');

  // ---- Mode config ----
  const MODES = {
    idea: {
      placeholder: 'Describe your system, workflow, or diagram idea...\n\nStart simply:\n  "A user logs in, the server checks credentials, then redirects to dashboard"\n\nOr more structured:\n  "Payment flow: Browser \u2192 API Gateway \u2192 Payment Service \u2192 Stripe \u2192 Bank\n   - on success: return confirmation to browser\n   - on failure: show error, retry up to 3 times \u2192 dead letter queue"\n\nUseful signals: actors, services, arrows (\u2192), steps, decisions, states, failures',
      hint: 'Type an idea and press Render \u00b7 \u2318\u23ce / Ctrl+Return to generate \u00b7 Tab to accept suggestion',
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

  // ---- Mode selector ----
  function setMode(mode) {
    currentMode = mode;
    const cfg = MODES[mode];
    input.placeholder = cfg.placeholder;
    inputHint.textContent = cfg.hint;
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
        enhancerUrl: ENHANCER_URL,
        onAccept: updateBadges,
      });
    } else if (copilot) {
      copilot.destroy();
      copilot = null;
    }
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
    loadingOverlay.hidden = !on;
    btnRender.disabled = on;
    input.readOnly = on;
    if (on && contentState && LOADING_MESSAGES[contentState]) {
      loadingText.textContent = LOADING_MESSAGES[contentState];
    } else if (on) {
      loadingText.textContent = 'Compiling diagram...';
    }
  }

  function showResult(paths, name) {
    currentPaths = paths;
    currentDiagramName = name || 'diagram';
    const ts = Date.now();
    resultSection.hidden = false;
    flipCard.showFront();

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
          enhance: chkEnhance.checked,
          input_mode: currentMode,
        }),
      });

      const data = await resp.json();

      if (!data.success) {
        showError(data.details || data.error || 'Compilation failed');
        return;
      }

      showResult(data.paths, data.diagram_name);

      sidebar.add({
        name: data.diagram_name,
        type: data.diagram_type,
        paths: data.paths,
        timestamp: new Date().toLocaleString(),
        source: source,
        contentState: data.content_state,
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
      render();
    }
  });

  input.addEventListener('input', updateBadges);

  btnNewDiagram.addEventListener('click', () => {
    input.value = '';
    resultSection.hidden = true;
    if (isFullscreen) toggleFullscreen();
    hideError();
    typeBadge.classList.remove('visible');
    stateBadge.classList.remove('visible');
    currentPaths = null;
    currentDiagramName = '';
    if (copilot) copilot._dismissGhost();
    input.focus();
  });

  btnFlip.addEventListener('click', () => flipCard.toggle());

  btnResetZoom.addEventListener('click', () => {
    if (pzFront) pzFront.fitToViewport();
    if (pzBack) pzBack.fitToViewport();
  });

  btnDismissError.addEventListener('click', hideError);

  // ---- Init ----
  setMode('idea');

  fetch('/api/diagrams')
    .then(r => r.json())
    .then(data => {
      if (data.success && data.diagrams) {
        data.diagrams.forEach(d => {
          sidebar.add({
            name: d.name,
            type: '',
            paths: d.paths,
            timestamp: d.created_at ? new Date(d.created_at).toLocaleString() : '',
          });
        });
      }
    })
    .catch(() => { /* server may not be running */ });

})();
