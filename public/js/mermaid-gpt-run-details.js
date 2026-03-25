/**
 * Run Details component — shows metadata and subview gallery for a completed run.
 * Lazy-loaded after a render completes that includes a run_id.
 */
window.MermaidRunDetails = class MermaidRunDetails {
  constructor(containerEl, onSubviewSelect) {
    this.container = containerEl;
    this.onSubviewSelect = onSubviewSelect;
    this._currentRunId = null;
    this._manifest = null;
  }

  hide() {
    this.container.hidden = true;
    this._currentRunId = null;
    this._manifest = null;
  }

  async show(runId) {
    if (!runId) { this.hide(); return; }
    this._currentRunId = runId;
    this.container.hidden = false;
    this._renderLoading();

    try {
      const res = await fetch(`/runs/${runId}.json`);
      if (!res.ok) { this._renderError('Run data not available'); return; }
      this._manifest = await res.json();
      this._render();
    } catch {
      this._renderError('Failed to load run data');
    }
  }

  _renderLoading() {
    this.container.innerHTML = '<div class="run-details-loading">Loading run data...</div>';
  }

  _renderError(msg) {
    this.container.innerHTML = `<div class="run-details-error">${this._esc(msg)}</div>`;
  }

  _render() {
    const m = this._manifest;
    if (!m) return;

    const t = m.totals || {};
    const wallSec = t.wall_clock_ms ? (t.wall_clock_ms / 1000).toFixed(1) : '?';
    const subviewCount = (m.subviews || []).length;
    const mergeStatus = m.merge?.accepted ? 'Merged' : m.merge?.required ? 'Merge rejected' : 'No merge';
    const agentCalls = t.total_agent_calls || 0;
    const cost = t.total_cost_est ? `$${t.total_cost_est.toFixed(4)}` : '';
    const warnings = (m.warnings || []).length;

    let html = `
      <div class="run-details-header">
        <button class="run-details-toggle" aria-expanded="true" aria-label="Toggle run details">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
          Run Details
        </button>
        <span class="run-details-summary">
          ${agentCalls} calls · ${wallSec}s · ${subviewCount} subviews · ${mergeStatus}
          ${cost ? ' · ' + cost : ''}
          ${warnings > 0 ? ` · <span class="run-warn">${warnings} warning${warnings > 1 ? 's' : ''}</span>` : ''}
        </span>
        <a class="run-details-json-link" href="/runs/${m.run_id}.json" target="_blank" rel="noopener" title="View raw JSON">JSON</a>
      </div>
      <div class="run-details-body">
        <div class="run-meta-grid">
          <div class="run-meta-item"><span class="run-meta-label">Pipeline</span><span class="run-meta-value">${this._esc(m.controller?.pipeline || 'direct')}</span></div>
          <div class="run-meta-item"><span class="run-meta-label">Mode</span><span class="run-meta-value">${this._esc(m.settings?.mode || '?')}${m.settings?.max_mode ? ' MAX' : ''}</span></div>
          <div class="run-meta-item"><span class="run-meta-label">Tokens</span><span class="run-meta-value">${(t.total_tokens_in || 0).toLocaleString()} in / ${(t.total_tokens_out || 0).toLocaleString()} out</span></div>
          <div class="run-meta-item"><span class="run-meta-label">Rate Events</span><span class="run-meta-value">${t.total_rate_events || 0}</span></div>
        </div>
    `;

    if (subviewCount > 0) {
      html += '<div class="run-subview-gallery"><span class="run-subview-title">Subviews</span><div class="run-subview-strip">';
      for (const sv of m.subviews) {
        const scoreLabel = sv.score?.composite != null
          ? (sv.score.composite).toFixed(2)
          : sv.score != null ? String(sv.score) : '?';
        const thumbSrc = sv.artifacts?.png || '';
        const name = sv.view_name || 'Subview';
        html += `
          <button class="run-subview-thumb" data-png="${this._esc(thumbSrc)}" data-svg="${this._esc(sv.artifacts?.svg || '')}" title="${this._esc(name)} (score: ${scoreLabel})">
            ${thumbSrc ? `<img src="${thumbSrc}" alt="${this._esc(name)}" loading="lazy" />` : `<span class="run-subview-placeholder">${this._esc(name.slice(0, 20))}</span>`}
            <span class="run-subview-score">${scoreLabel}</span>
          </button>
        `;
      }
      html += '</div></div>';
    }

    html += '</div>';
    this.container.innerHTML = html;

    const toggle = this.container.querySelector('.run-details-toggle');
    const body = this.container.querySelector('.run-details-body');
    if (toggle && body) {
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        body.hidden = expanded;
      });
    }

    this.container.querySelectorAll('.run-subview-thumb').forEach(btn => {
      btn.addEventListener('click', () => {
        const png = btn.dataset.png;
        const svg = btn.dataset.svg;
        if (this.onSubviewSelect) this.onSubviewSelect({ png, svg });
      });
    });
  }

  _esc(s) {
    if (!s) return '';
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }
};
