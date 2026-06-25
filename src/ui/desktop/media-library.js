/**
 * media-library.js — Left-panel media library
 *
 * Phase 1.4: Shows project assets, has import button (wired in Phase 1.6).
 * Phase 1.6: Full import (drag-drop, file picker, WebCodecs probe).
 */

export class MediaLibrary {
  constructor(container, { pm, history }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._project = null;
    this._mount();
  }

  _mount() {
    injectStyles();
    this._el.innerHTML = `
      <div class="pm-lib-root">
        <div class="pm-lib-header">
          <span class="pm-lib-title">Media Library</span>
          <button class="pm-lib-import-btn" id="pm-lib-import"
                  title="Import media (Phase 1.6)" aria-label="Import media files" disabled>
            + Import
          </button>
        </div>
        <div class="pm-lib-search" role="search">
          <input id="pm-lib-search" type="search" placeholder="Search assets…"
                 aria-label="Search media library" class="pm-lib-search-input">
        </div>
        <div class="pm-lib-list" id="pm-lib-list" role="list" aria-label="Media assets">
          <div class="pm-lib-empty" id="pm-lib-empty">
            <div class="pm-lib-empty-icon" aria-hidden="true">📂</div>
            <p>No media imported yet.</p>
            <p class="pm-lib-empty-sub">Import will be available in Phase 1.6.</p>
          </div>
        </div>
        <div class="pm-lib-drop-hint" id="pm-lib-drop" aria-hidden="true">
          Drop files here to import
        </div>
      </div>
    `;

    this._listEl = this._el.querySelector('#pm-lib-list');
    this._emptyEl = this._el.querySelector('#pm-lib-empty');

    // Phase 1.6: wire import button + drag-drop
    this._el.querySelector('#pm-lib-import')?.addEventListener('click', () => {
      this._showImportComingSoon();
    });

    // Search filter
    this._el.querySelector('#pm-lib-search')?.addEventListener('input', (e) => {
      this._renderList(e.target.value.toLowerCase());
    });

    // Drag-over hint
    this._el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this._el.querySelector('#pm-lib-drop')?.classList.add('visible');
    });
    this._el.addEventListener('dragleave', () => {
      this._el.querySelector('#pm-lib-drop')?.classList.remove('visible');
    });
    this._el.addEventListener('drop', (e) => {
      e.preventDefault();
      this._el.querySelector('#pm-lib-drop')?.classList.remove('visible');
      this._showImportComingSoon();
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setProject(project) {
    this._project = project;
    this._renderList('');
    // Enable import button when project is open
    const btn = this._el.querySelector('#pm-lib-import');
    if (btn) btn.disabled = false;
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  _renderList(filter) {
    const assets = this._project?.assets ?? [];
    const filtered = filter
      ? assets.filter((a) => (a.name ?? '').toLowerCase().includes(filter))
      : assets;

    this._emptyEl.style.display = filtered.length ? 'none' : 'flex';

    // Remove old asset rows
    this._listEl.querySelectorAll('.pm-lib-asset').forEach((el) => el.remove());

    filtered.forEach((asset) => {
      const el = document.createElement('div');
      el.className = 'pm-lib-asset';
      el.setAttribute('role', 'listitem');
      el.setAttribute('draggable', 'true');
      el.dataset.assetId = asset.id;
      el.innerHTML = `
        <span class="pm-lib-asset-icon" aria-hidden="true">${assetIcon(asset.type)}</span>
        <div class="pm-lib-asset-info">
          <span class="pm-lib-asset-name" title="${escHtml(asset.name ?? '')}">${escHtml(asset.name ?? 'Untitled')}</span>
          <span class="pm-lib-asset-meta">${assetMeta(asset)}</span>
        </div>
        <button class="pm-lib-asset-del" data-asset-id="${escHtml(asset.id)}"
                title="Remove asset" aria-label="Remove ${escHtml(asset.name ?? 'asset')}">✕</button>
      `;

      // Drag to timeline (Phase 1.6 will complete this)
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/peachmint-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      });

      el.querySelector('.pm-lib-asset-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAsset(asset.id);
      });

      this._listEl.appendChild(el);
    });
  }

  _removeAsset(assetId) {
    if (!this._project) return;
    const idx = this._project.assets.findIndex((a) => a.id === assetId);
    if (idx === -1) return;
    const asset = this._project.assets[idx];
    this._history.execute({
      label: 'Remove asset',
      execute: () => {
        this._project.assets.splice(idx, 1);
        this._pm.markDirty();
        this._renderList('');
      },
      undo: () => {
        this._project.assets.splice(idx, 0, asset);
        this._pm.markDirty();
        this._renderList('');
      },
    });
  }

  _showImportComingSoon() {
    const d = document.createElement('dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-labelledby', 'imp-title');
    d.innerHTML = `
      <h2 id="imp-title" style="margin:0 0 12px;font-size:1rem">Media Import — Phase 1.6</h2>
      <p style="color:var(--text-muted);font-size:0.85rem;line-height:1.6">
        Full media import (file picker, drag-and-drop, WebCodecs probe, OPFS storage)
        is coming in Phase 1.6.
        <br><br>
        The engine storage, EDL model, and timeline UI are already wired up and ready to receive clips.
      </p>
      <div style="text-align:right;margin-top:16px">
        <button class="btn-primary" autofocus>Got it</button>
      </div>
    `;
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('button').addEventListener('click', () => { d.close(); d.remove(); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.close(); d.remove(); } });
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .pm-lib-root { display:flex; flex-direction:column; height:100%; position:relative; }
    .pm-lib-header { display:flex; align-items:center; justify-content:space-between;
      padding:8px 10px; border-bottom:1px solid var(--border); flex-shrink:0; gap:8px; }
    .pm-lib-title { font-size:0.7rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.08em; color:var(--text-muted); }
    .pm-lib-import-btn { background:var(--accent-peach); border:none; color:#181820;
      border-radius:5px; padding:4px 10px; font-size:0.75rem; font-weight:700;
      cursor:pointer; font-family:var(--font-ui); }
    .pm-lib-import-btn:hover:not(:disabled) { background:#ffaa88; }
    .pm-lib-import-btn:disabled { background:var(--border); color:var(--text-dim); cursor:default; }
    .pm-lib-import-btn:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-lib-search { padding:6px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-lib-search-input { width:100%; background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:5px; padding:5px 8px; font-size:0.78rem;
      outline:none; font-family:var(--font-ui); }
    .pm-lib-search-input:focus { border-color:var(--accent-purple); }
    .pm-lib-list { flex:1; overflow-y:auto; }
    .pm-lib-empty { display:flex; flex-direction:column; align-items:center;
      justify-content:center; height:100%; gap:8px; padding:20px; text-align:center; }
    .pm-lib-empty-icon { font-size:2rem; opacity:0.4; }
    .pm-lib-empty p { margin:0; font-size:0.78rem; color:var(--text-dim); line-height:1.5; }
    .pm-lib-empty-sub { font-size:0.72rem !important; color:var(--text-dim) !important; }
    .pm-lib-asset { display:flex; align-items:center; gap:8px; padding:6px 10px;
      cursor:pointer; border-bottom:1px solid var(--border); }
    .pm-lib-asset:hover { background:var(--bg-hover); }
    .pm-lib-asset-icon { font-size:1.1rem; flex-shrink:0; }
    .pm-lib-asset-info { flex:1; min-width:0; }
    .pm-lib-asset-name { display:block; font-size:0.78rem; color:var(--text-primary);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-lib-asset-meta { font-family:var(--font-mono); font-size:0.65rem; color:var(--text-dim); }
    .pm-lib-asset-del { background:transparent; border:none; color:var(--text-dim);
      width:20px; height:20px; border-radius:3px; cursor:pointer; font-size:0.7rem;
      flex-shrink:0; opacity:0; display:flex; align-items:center; justify-content:center; }
    .pm-lib-asset:hover .pm-lib-asset-del { opacity:1; }
    .pm-lib-asset-del:hover { background:var(--accent-err); color:#fff; }
    .pm-lib-drop-hint { position:absolute; inset:0; background:rgba(189,147,249,0.15);
      border:2px dashed var(--accent-purple); border-radius:6px; display:none;
      align-items:center; justify-content:center; color:var(--accent-purple);
      font-size:0.85rem; pointer-events:none; }
    .pm-lib-drop-hint.visible { display:flex; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function assetIcon(type) {
  switch (type) {
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'image': return '🖼';
    default: return '📄';
  }
}

function assetMeta(asset) {
  const parts = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.duration != null) parts.push(`${asset.duration.toFixed(1)}s`);
  if (asset.mimeType) parts.push(asset.mimeType.split('/')[1]?.toUpperCase() ?? asset.mimeType);
  return parts.join(' · ') || asset.type ?? '';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
