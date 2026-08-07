'use strict';

/**
 * Mermate Versions — compact per-tab version control.
 *
 * One chip in the action row (🕘 vN) opens the version list for the ACTIVE
 * tab. Two origins, unified and time-sorted:
 *   run  — system versions from run lineage (idea/mmd reconstructable)
 *   edit — debounced snapshots of user edits (ring-buffered server-side)
 *
 * Restore always snapshots current content first (reversible by default).
 * Snapshots are captured from textarea edits (debounced 4s) and on tab
 * switch. Run lineage is immutable; snapshots are individually deletable.
 */
(function () {
  const DEBOUNCE_MS = 4000;
  const MIN_SNAPSHOT_CHARS = 30;

  let _chip = null;
  let _panel = null;
  let _debounceTimer = null;
  const _lastSnapKey = {};

  const bus = () => window.__mermate || {};
  const diagram = () => bus().currentDiagramName || null;
  const stage = () => bus().currentMode || 'idea';
  const inputEl = () => document.getElementById('mermaid-input') || document.querySelector('textarea');

  function _toast(message, type = 'info') {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast is-${type}`;
    t.innerHTML = `<span>${message}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;
    t.querySelector('.toast-close').addEventListener('click', () => t.remove());
    c.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function _relTime(ts) {
    // Snapshot filenames use dashes in the time part; normalize for Date.
    const norm = ts.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const d = new Date(norm);
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (Number.isNaN(mins)) return ts;
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  }

  function _fmtSize(chars) {
    return chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`;
  }

  async function _api(path, opts) {
    const d = diagram();
    if (!d) return null;
    const res = await fetch(`/api/versions/${encodeURIComponent(d)}${path}`, opts);
    return res.json().catch(() => null);
  }

  async function _snapshot(stageName, content) {
    if (!diagram()) return;
    const key = `${(content || '').length}:${(content || '').slice(0, 64)}`;
    if (_lastSnapKey[stageName] === key) return;
    _lastSnapKey[stageName] = key;
    await _api('/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: stageName, content }),
    }).catch(() => {});
    _refreshChipCount();
  }

  function _snapshotActiveNow() {
    const el = inputEl();
    const content = (el?.value || '').trim();
    if (content.length < MIN_SNAPSHOT_CHARS) return;
    void _snapshot(stage(), content);
  }

  function _scheduleSnapshot() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_snapshotActiveNow, DEBOUNCE_MS);
  }

  async function _restore(version) {
    const el = inputEl();
    if (!el) return;
    // Safety: snapshot current content before replacing it
    const current = (el.value || '').trim();
    if (current.length >= MIN_SNAPSHOT_CHARS) await _snapshot(stage(), current);
    const data = await _api(`/content?id=${encodeURIComponent(version.id)}`);
    if (!data?.success) { _toast('Version not found', 'error'); return; }
    el.value = data.content;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    _toast(`Restored ${stage()} version from ${_relTime(version.ts)}`, 'success');
    _closePanel();
    _refreshChipCount();
  }

  async function _deleteSnapshot(version, rowEl) {
    if (version.origin !== 'edit') return;
    const res = await fetch(
      `/api/versions/${encodeURIComponent(diagram())}/snapshot/${encodeURIComponent(version.id.slice(5))}`,
      { method: 'DELETE' });
    if (res.ok) {
      rowEl.remove();
      _toast('Snapshot deleted', 'info');
      _refreshChipCount();
    }
  }

  function _closePanel() {
    if (_panel) { _panel.remove(); _panel = null; }
  }

  async function _openPanel() {
    if (_panel) { _closePanel(); return; }
    const data = await _api('');
    if (!data?.success) {
      _toast(diagram() ? 'Could not load versions' : 'Name or select a diagram first', 'info');
      return;
    }
    const versions = data.stages[stage()] || [];
    _panel = document.createElement('div');
    _panel.className = 'version-panel';

    const head = document.createElement('div');
    head.className = 'version-panel-head';
    head.textContent = `${stage()} versions (${versions.length})`;
    _panel.appendChild(head);

    if (versions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'version-empty';
      empty.textContent = 'No versions yet — render or edit to create one';
      _panel.appendChild(empty);
    }

    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'version-row';

      const time = document.createElement('span');
      time.className = 'version-time';
      time.textContent = _relTime(v.ts);

      const tag = document.createElement('span');
      tag.className = `version-tag is-${v.origin}`;
      tag.textContent = v.origin === 'run' ? `run ${(v.run_id || '').slice(0, 6)}` : 'edit';

      const size = document.createElement('span');
      size.className = 'version-size';
      size.textContent = _fmtSize(v.chars);

      row.append(time, tag, size);
      row.addEventListener('click', () => void _restore(v));

      if (v.origin === 'edit') {
        const del = document.createElement('button');
        del.className = 'version-del';
        del.textContent = '×';
        del.title = 'Delete this snapshot';
        del.addEventListener('click', (e) => { e.stopPropagation(); void _deleteSnapshot(v, row); });
        row.appendChild(del);
      }
      _panel.appendChild(row);
    }

    document.body.appendChild(_panel);
    const r = _chip.getBoundingClientRect();
    _panel.style.left = `${Math.max(8, r.left)}px`;
    _panel.style.bottom = `${window.innerHeight - r.top + 8}px`;

    setTimeout(() => document.addEventListener('click', _outsideClose), 0);
  }

  function _outsideClose(e) {
    if (_panel && !_panel.contains(e.target) && e.target !== _chip && !_chip.contains(e.target)) {
      _closePanel();
      document.removeEventListener('click', _outsideClose);
    }
  }

  let _refreshQueued = false;
  async function _refreshChipCount() {
    if (!_chip || _refreshQueued) return;
    _refreshQueued = true;
    try {
      const data = await _api('');
      const n = data?.success ? (data.stages[stage()] || []).length : 0;
      _chip.textContent = `🕘 v${n}`;
      _chip.title = diagram()
        ? `${n} saved version(s) of this ${stage()} tab — click to browse`
        : 'Select or name a diagram to enable versions';
      _chip.disabled = !diagram();
    } finally {
      _refreshQueued = false;
    }
  }

  function _injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
.version-chip{background:#1c1c26;border:1px solid #2e2e3e;color:#9aa0b4;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.version-chip:hover:not(:disabled){border-color:#4a4a62;color:#d6d9e6}
.version-chip:disabled{opacity:.4;cursor:default}
.version-panel{position:fixed;z-index:9000;min-width:250px;max-width:320px;max-height:320px;overflow-y:auto;background:#14141c;border:1px solid #2e2e3e;border-radius:10px;padding:6px;box-shadow:0 8px 30px rgba(0,0,0,.55);font-size:12px}
.version-panel-head{padding:6px 8px;color:#9aa0b4;font-weight:600;text-transform:capitalize;border-bottom:1px solid #23232f;margin-bottom:4px}
.version-empty{padding:10px 8px;color:#6b7086}
.version-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:7px;cursor:pointer;color:#c9cddb}
.version-row:hover{background:#1e1e2a}
.version-time{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.version-tag{font-size:10px;padding:2px 6px;border-radius:5px;text-transform:uppercase;letter-spacing:.4px}
.version-tag.is-run{background:#17324a;color:#7ab8f5}
.version-tag.is-edit{background:#2a2438;color:#b89bf5}
.version-size{color:#6b7086}
.version-del{background:none;border:none;color:#6b7086;font-size:15px;cursor:pointer;padding:0 4px;border-radius:4px}
.version-del:hover{color:#f08080;background:#2a1e1e}`;
    document.head.appendChild(s);
  }

  function _init() {
    _injectStyles();
    const enhanceBtn = document.getElementById('btn-enhance');
    if (!enhanceBtn || !enhanceBtn.parentNode) return;
    _chip = document.createElement('button');
    _chip.type = 'button';
    _chip.className = 'version-chip';
    _chip.textContent = '🕘 v0';
    _chip.setAttribute('aria-label', 'Version history for this tab');
    enhanceBtn.parentNode.insertBefore(_chip, enhanceBtn);
    _chip.addEventListener('click', () => void _openPanel());

    // Refresh the chip when the active diagram or tab changes (sidebar load,
    // new diagram, render, tab switch) — the bus has no event emitter, so
    // watch for identity changes after any click (two string reads, cheap).
    let _lastIdentity = null;
    document.addEventListener('click', () => {
      setTimeout(() => {
        const identity = `${diagram()}|${stage()}`;
        if (identity !== _lastIdentity) {
          _lastIdentity = identity;
          _refreshChipCount();
        }
      }, 400);
    }, true);

    // Edit capture: debounced watcher on the active textarea
    const el = inputEl();
    if (el) el.addEventListener('input', _scheduleSnapshot);
    // Tab-switch capture: snapshot the tab being left before content swaps
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('mousedown', () => {
        _snapshotActiveNow();
        setTimeout(_refreshChipCount, 300);
      }, true);
    });
    _refreshChipCount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
