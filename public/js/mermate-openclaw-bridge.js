(function () {
  'use strict';

  const dialog = document.getElementById('openclaw-dialog');
  const btnOpen = document.getElementById('btn-openclaw');
  const btnClose = document.getElementById('btn-openclaw-close');
  const btnRefresh = document.getElementById('btn-openclaw-refresh');
  const btnLaunch = document.getElementById('btn-openclaw-launch');
  const chip = document.getElementById('openclaw-status-chip');
  const baseUrlEl = document.getElementById('openclaw-base-url');
  const routeEl = document.getElementById('openclaw-route-summary');
  const architectEl = document.getElementById('openclaw-architect-summary');
  const agentsEl = document.getElementById('openclaw-agent-summary');
  const iframe = document.getElementById('openclaw-frame');

  if (!dialog || !btnOpen || !btnClose || !btnRefresh || !btnLaunch || !chip || !baseUrlEl || !routeEl || !architectEl || !agentsEl || !iframe) {
    return;
  }

  let cachedBaseUrl = 'http://127.0.0.1:8787';
  let _btnDownTs = 0;

  function setChip(text, state) {
    chip.textContent = text;
    chip.dataset.state = state;
  }

  async function loadStatus() {
    setChip('Checking claw…', 'loading');

    try {
      const res = await fetch('/api/openclaw/status');
      const data = await res.json();
      cachedBaseUrl = data.baseUrl || cachedBaseUrl;

      const inferenceAvail = Boolean(data.inference?.available);
      const modelCount = Array.isArray(data.inference?.models) ? data.inference.models.length : 0;
      const mermateRunning = Boolean(data.mermate?.running);
      const providerCount = Array.isArray(data.providers) ? data.providers.length : 0;

      baseUrlEl.textContent = cachedBaseUrl;
      routeEl.textContent = inferenceAvail
        ? `${modelCount} models via ${providerCount} provider(s)`
        : 'No inference providers configured';
      architectEl.textContent = data.inference?.defaultModel
        ? `Default: ${data.inference.defaultModel}`
        : 'No default model';
      agentsEl.textContent = data.mcp?.enabled
        ? `MCP enabled · Mermate ${mermateRunning ? 'online' : 'offline'}`
        : `MCP disabled · Mermate ${mermateRunning ? 'online' : 'offline'}`;

      iframe.src = `${cachedBaseUrl}/?embed=mermate`;
      chip.hidden = false;
      setChip(inferenceAvail ? 'Opseeq online' : 'Opseeq degraded', inferenceAvail ? 'online' : 'warning');
    } catch (error) {
      routeEl.textContent = 'Opseeq gateway unreachable';
      architectEl.textContent = String(error);
      agentsEl.textContent = 'Start opseeq container: docker compose up -d';
      iframe.removeAttribute('src');
      setChip('Opseeq offline', 'offline');
      chip.hidden = true;
    }
  }

  function _updateGuideButton(active) {
    if (active) {
      btnOpen.classList.add('guide-active');
      btnOpen.querySelector('span')?.remove();
      const span = document.createElement('span');
      span.textContent = 'Guide';
      btnOpen.textContent = '';
      btnOpen.appendChild(span);
    } else {
      btnOpen.classList.remove('guide-active');
      btnOpen.querySelector('span')?.remove();
      btnOpen.textContent = 'Opseeq';
    }
  }

  btnOpen.addEventListener('mousedown', () => { _btnDownTs = Date.now(); });

  btnOpen.addEventListener('mouseup', async (e) => {
    const held = Date.now() - _btnDownTs;
    _btnDownTs = 0;

    if (held >= 400) {
      await loadStatus();
      if (typeof dialog.showModal === 'function') dialog.showModal();
    } else {
      if (window.MermateAutoGuide) {
        const active = window.MermateAutoGuide.toggle();
        _updateGuideButton(active);
      }
    }
  });

  btnOpen.addEventListener('click', (e) => { e.preventDefault(); });

  btnClose.addEventListener('click', () => { dialog.close(); });
  btnRefresh.addEventListener('click', async () => { await loadStatus(); });
  btnLaunch.addEventListener('click', () => { window.open(cachedBaseUrl, '_blank', 'noopener'); });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  void loadStatus();

  if (localStorage.getItem('mermate_guide_enabled') === 'true') {
    setTimeout(() => {
      if (window.MermateAutoGuide) {
        window.MermateAutoGuide.start();
        _updateGuideButton(true);
      }
    }, 1000);
  }

  // ---- Sidebar flip: diagrams <-> Opseeq chat ----
  const sidebar = document.getElementById('sidebar');
  const btnFlipToOpseeq = document.getElementById('btn-sidebar-flip');
  const btnFlipBack = document.getElementById('btn-sidebar-unflip');
  const sidebarOpseeqFrame = document.getElementById('sidebar-opseeq-frame');
  const sidebarOpseeqStatus = document.getElementById('sidebar-opseeq-status');

  if (sidebar && btnFlipToOpseeq && btnFlipBack) {
    btnFlipToOpseeq.addEventListener('click', () => {
      sidebar.classList.add('flipped');
      if (sidebarOpseeqFrame && !sidebarOpseeqFrame.src) {
        sidebarOpseeqFrame.src = `${cachedBaseUrl}/?embed=mermate&mode=guide`;
        if (sidebarOpseeqStatus) sidebarOpseeqStatus.textContent = `Connected to ${cachedBaseUrl}`;
      }
    });
    btnFlipBack.addEventListener('click', () => {
      sidebar.classList.remove('flipped');
    });
  }
})();
