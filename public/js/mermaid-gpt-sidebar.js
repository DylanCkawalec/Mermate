/**
 * Sidebar component for Mermaid-GPT.
 * Manages diagram history, context menu deletion, and localStorage persistence.
 */
window.MermaidSidebar = class MermaidSidebar {
  constructor(listEl, onSelect) {
    this.listEl = listEl;
    this.onSelect = onSelect;
    this.STORAGE_KEY = 'mermaid-gpt-history';
    this.items = this._load();
    this.activeIndex = -1;
    this._pendingDelete = null;
    this._initDeleteDialog();
    this.render();
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.items));
    } catch { /* quota exceeded */ }
  }

  _initDeleteDialog() {
    this.dialog = document.getElementById('delete-dialog');
    this.dialogName = document.getElementById('delete-diagram-name');
    const btnCancel = document.getElementById('btn-delete-cancel');
    const btnConfirm = document.getElementById('btn-delete-confirm');

    if (!this.dialog) return;

    btnCancel.addEventListener('click', () => {
      this._pendingDelete = null;
      this.dialog.close();
    });

    btnConfirm.addEventListener('click', async () => {
      if (!this._pendingDelete) return;
      const name = this._pendingDelete;
      this._pendingDelete = null;
      this.dialog.close();

      try {
        await fetch(`/api/diagrams/${encodeURIComponent(name)}`, { method: 'DELETE' });
      } catch { /* best effort */ }

      this.items = this.items.filter(i => i.name !== name);
      if (this.activeIndex >= this.items.length) this.activeIndex = -1;
      this._save();
      this.render();
    });
  }

  _showDeleteDialog(name) {
    if (!this.dialog) return;
    this._pendingDelete = name;
    this.dialogName.textContent = name;
    this.dialog.showModal();
  }

  add(entry) {
    this.items = this.items.filter(i => i.name !== entry.name);
    this.items.unshift(entry);
    if (this.items.length > 50) this.items.length = 50;
    this._save();
    this.activeIndex = 0;
    this.render();
  }

  render() {
    this.listEl.innerHTML = '';
    this.items.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.className = 'sidebar-item' + (idx === this.activeIndex ? ' active' : '');
      btn.innerHTML = `
        <span class="sidebar-item-name">${this._esc(item.name)}</span>
        <span class="sidebar-item-meta">${item.type ? item.type + ' · ' : ''}${item.timestamp || ''}</span>
        <span class="sidebar-item-actions">
          <button class="btn-trash" aria-label="Delete ${this._esc(item.name)}" title="Delete">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5"/>
              <path d="M4.5 4.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5"/>
            </svg>
          </button>
        </span>
      `;

      const trashBtn = btn.querySelector('.btn-trash');
      trashBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showDeleteDialog(item.name);
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._showDeleteDialog(item.name);
      });

      btn.addEventListener('click', (e) => {
        if (e.target.closest('.btn-trash')) return;
        this.activeIndex = idx;
        this.render();
        this.onSelect(item);
      });

      this.listEl.appendChild(btn);
    });
  }

  setActive(name) {
    this.activeIndex = this.items.findIndex(i => i.name === name);
    this.render();
  }

  _esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }
};
