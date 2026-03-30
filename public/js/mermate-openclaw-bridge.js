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

      const routeHealthy = Boolean(data.route?.healthy);
      const routeModels = Array.isArray(data.route?.models) ? data.route.models.length : 0;
      const agentModes = Array.isArray(data.mermate?.agentModes) ? data.mermate.agentModes.length : 0;

      baseUrlEl.textContent = cachedBaseUrl;
      routeEl.textContent = routeHealthy
        ? `${routeModels} managed models reachable`
        : data.route?.error || 'Route unavailable';
      architectEl.textContent = data.architect?.orchestratorModel
        ? `${data.architect.orchestratorModel} orchestrator · ${data.architect.workerModel || 'unknown'} worker`
        : 'Architect profile unavailable';
      agentsEl.textContent = data.mermate
        ? `${agentModes} modes · ${data.mermate.agentsLoaded || 0} specialists`
        : 'Mermate agent inventory unavailable';

      iframe.src = `${cachedBaseUrl}/?embed=mermate`;
      chip.hidden = false;
      setChip(routeHealthy ? 'Claw online' : 'Claw degraded', routeHealthy ? 'online' : 'warning');
    } catch (error) {
      routeEl.textContent = 'Wrapper unreachable from Mermate';
      architectEl.textContent = String(error);
      agentsEl.textContent = 'Open `/Users/dylanckawalec/Desktop/OpenClaw Desktop.command` to start the wrapper.';
      iframe.removeAttribute('src');
      setChip('Claw offline', 'offline');
      chip.hidden = true;
    }
  }

  btnOpen.addEventListener('click', async () => {
    await loadStatus();
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  });

  btnClose.addEventListener('click', () => {
    dialog.close();
  });

  btnRefresh.addEventListener('click', async () => {
    await loadStatus();
  });

  btnLaunch.addEventListener('click', () => {
    window.open(cachedBaseUrl, '_blank', 'noopener');
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  void loadStatus();
})();
