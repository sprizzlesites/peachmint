/**
 * media-library.js — Left-panel media library
 *
 * Phase 1.5: Full file import (file picker + drag-drop from desktop),
 *            media probing, OPFS storage, asset registration, and
 *            quick "Add to Timeline" to demo the preview pipeline.
 * Phase 1.6: Drag-from-library → timeline drop (full clip placement UI).
 */

import { addAsset, addTrack, addClip } from '../../engine/edl.js';
import { parseSRT, parseVTT }          from '../../engine/captions.js';

const PROXY_ENGINE_URL = new URL('../../engine/proxy-engine.js', import.meta.url).href;

export class MediaLibrary {
  /**
   * @param {HTMLElement} container
   * @param {{ pm, history, storage, onProjectChanged }} opts
   */
  constructor(container, { pm, history, storage, onProjectChanged }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._storage = storage;
    this._onProjectChanged = onProjectChanged ?? (() => {});
    this._project = null;
    this._proxyInProgress = new Map(); // assetId → progress 0-1 | null (done)
    this._mount();
  }

  _mount() {
    injectStyles();
    this._el.innerHTML = `
      <div class="pm-lib-root">
        <div class="pm-lib-header">
          <span class="pm-lib-title">Media Library</span>
          <div style="display:flex;gap:6px">
            <button class="pm-lib-text-btn" id="pm-lib-add-text"
                    title="Add text clip" aria-label="Add text clip" disabled>T+</button>
            <button class="pm-lib-text-btn" id="pm-lib-add-draw"
                    title="Add draw layer" aria-label="Add draw layer" disabled>✏+</button>
            <button class="pm-lib-text-btn" id="pm-lib-add-adj"
                    title="Add adjustment layer" aria-label="Add adjustment layer" disabled>Adj</button>
            <button class="pm-lib-import-btn" id="pm-lib-import"
                    title="Import media files" aria-label="Import media files" disabled>
              + Import
            </button>
          </div>
        </div>
        <div class="pm-lib-search" role="search">
          <input id="pm-lib-search" type="search" placeholder="Search assets…"
                 aria-label="Search media library" class="pm-lib-search-input">
        </div>
        <div class="pm-lib-list" id="pm-lib-list" role="list" aria-label="Media assets">
          <div class="pm-lib-empty" id="pm-lib-empty">
            <div class="pm-lib-empty-icon" aria-hidden="true">📂</div>
            <p>No media imported yet.</p>
            <p class="pm-lib-empty-sub">Click <strong>+ Import</strong> or drag files here.</p>
          </div>
        </div>
        <div class="pm-lib-drop-hint" id="pm-lib-drop" aria-hidden="true">
          Drop files here to import
        </div>
        <div class="pm-lib-progress" id="pm-lib-progress" aria-live="polite" style="display:none">
          <span class="pm-lib-progress-spinner" aria-hidden="true">⏳</span>
          <span id="pm-lib-progress-text">Importing…</span>
        </div>
      </div>
    `;

    this._listEl     = this._el.querySelector('#pm-lib-list');
    this._emptyEl    = this._el.querySelector('#pm-lib-empty');
    this._progressEl = this._el.querySelector('#pm-lib-progress');
    this._progressTx = this._el.querySelector('#pm-lib-progress-text');

    // Hidden file picker (no visible input, triggered programmatically)
    this._filePicker = document.createElement('input');
    this._filePicker.type = 'file';
    this._filePicker.accept = 'video/*,audio/*,image/*,.ttf,.otf,.woff,.woff2,.srt,.vtt';
    this._filePicker.multiple = true;
    this._filePicker.style.display = 'none';
    this._el.appendChild(this._filePicker);
    this._filePicker.addEventListener('change', () => {
      if (this._filePicker.files?.length) this._importFiles(this._filePicker.files);
      this._filePicker.value = ''; // reset so same file can be re-picked
    });

    // Add text clip button
    this._el.querySelector('#pm-lib-add-text')?.addEventListener('click', () => {
      this._addTextClip();
    });

    // Add draw layer button
    this._el.querySelector('#pm-lib-add-draw')?.addEventListener('click', () => {
      this._addDrawClip();
    });

    // Add adjustment layer button
    this._el.querySelector('#pm-lib-add-adj')?.addEventListener('click', () => {
      this._addAdjClip();
    });

    // Import button → open file picker
    this._el.querySelector('#pm-lib-import')?.addEventListener('click', () => {
      this._filePicker.click();
    });

    // Search filter
    this._el.querySelector('#pm-lib-search')?.addEventListener('input', (e) => {
      this._renderList(e.target.value.toLowerCase());
    });

    // Drag-over hint (system files dragged from OS)
    this._el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this._el.querySelector('#pm-lib-drop')?.classList.add('visible');
    });
    this._el.addEventListener('dragleave', (e) => {
      // Only hide if leaving the library panel (not just moving between children)
      if (!this._el.contains(e.relatedTarget)) {
        this._el.querySelector('#pm-lib-drop')?.classList.remove('visible');
      }
    });
    this._el.addEventListener('drop', (e) => {
      e.preventDefault();
      this._el.querySelector('#pm-lib-drop')?.classList.remove('visible');
      const files = e.dataTransfer?.files;
      if (files?.length && this._project) {
        this._importFiles(files);
      } else if (!this._project) {
        this._showNoProjectBanner();
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setProject(project) {
    this._project = project;
    this._renderList('');
    const importBtn = this._el.querySelector('#pm-lib-import');
    if (importBtn) importBtn.disabled = !project;
    const textBtn = this._el.querySelector('#pm-lib-add-text');
    if (textBtn) textBtn.disabled = !project;
    const drawBtn = this._el.querySelector('#pm-lib-add-draw');
    if (drawBtn) drawBtn.disabled = !project;
    const adjBtn = this._el.querySelector('#pm-lib-add-adj');
    if (adjBtn) adjBtn.disabled = !project;
  }

  // ─── Import ──────────────────────────────────────────────────────────────────

  async _importFiles(fileList) {
    if (!this._project || !this._storage) return;
    const files = [...fileList].filter((f) => {
      const t = f.type;
      const n = f.name.toLowerCase();
      return t.startsWith('video/') || t.startsWith('audio/') || t.startsWith('image/') ||
             t.startsWith('font/') || n.endsWith('.ttf') || n.endsWith('.otf') ||
             n.endsWith('.woff') || n.endsWith('.woff2') ||
             n.endsWith('.srt') || n.endsWith('.vtt');
    });
    if (!files.length) return;

    this._setProgress(true, `Importing 0 / ${files.length}…`);
    let imported = 0;

    for (const file of files) {
      try {
        this._setProgress(true, `Importing "${file.name}" (${imported + 1} / ${files.length})…`);

        // Caption files: parse text only, no OPFS write needed
        const lname = file.name.toLowerCase();
        if (lname.endsWith('.srt') || lname.endsWith('.vtt')) {
          const text   = await file.text();
          const cues   = lname.endsWith('.srt') ? parseSRT(text) : parseVTT(text);
          const duration = cues.length ? cues[cues.length - 1].end : 10;
          addAsset(this._project, { name: file.name, type: 'caption', captions: cues, duration });
          this._pm.markDirty();
          imported++;
          this._renderList(this._currentFilter());
          continue;
        }

        // Probe metadata before reading the full buffer
        const meta = await probeFile(file);

        // Read file into ArrayBuffer and write to OPFS
        const buf = await file.arrayBuffer();
        const storageKey = await this._storage.writeMedia(file.name, buf);

        // Register as EDL asset (direct mutation, no undo — import is not typically undoable)
        const asset = addAsset(this._project, {
          name: file.name,
          type: meta.type,
          mimeType: file.type || 'application/octet-stream',
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          storageKey,
          ...(meta.type === 'font' ? { fontFamily: file.name.replace(/\.(ttf|otf|woff2?)$/i, '') } : {}),
        });

        this._pm.markDirty();
        imported++;
        this._renderList(this._currentFilter());
      } catch (err) {
        console.error('Import failed for', file.name, err);
        this._showError(`Failed to import "${file.name}": ${err.message}`);
      }
    }

    this._setProgress(false);
    if (imported > 0) {
      this._renderList(this._currentFilter());
    }
  }

  // ─── Add to Timeline ─────────────────────────────────────────────────────────

  _addToTimeline(asset) {
    if (!this._project) return;

    if (asset.type === 'caption') {
      const cmd = this._history.snapshotCommand(`Add "${asset.name}" to timeline`, (proj) => {
        let track = proj.tracks.find((t) => t.type === 'overlay');
        if (!track) track = addTrack(proj, { type: 'overlay' });
        let endTime = 0;
        for (const c of track.clips) endTime = Math.max(endTime, c.startTime + c.duration);
        const clip = addClip(proj, track.id, {
          assetId:   asset.id,
          startTime: endTime,
          duration:  asset.duration || 10,
          trimIn:    0,
          trimOut:   asset.duration || 10,
          speed:     1,
        });
        clip.properties.caption = { fontSize: 36, color: '#ffffff', fontFamily: 'sans-serif' };
      });
      this._history.execute(cmd);
      this._onProjectChanged();
      return;
    }

    const targetType = asset.type === 'audio' ? 'audio' : 'video';

    const cmd = this._history.snapshotCommand(`Add "${asset.name}" to timeline`, (proj) => {
      // Find or create a track of the right type
      let track = proj.tracks.find((t) => t.type === targetType);
      if (!track) track = addTrack(proj, { type: targetType });

      // Append after the last clip on this track
      let endTime = 0;
      for (const c of track.clips) endTime = Math.max(endTime, c.startTime + c.duration);

      addClip(proj, track.id, {
        assetId: asset.id,
        startTime: endTime,
        duration: asset.duration || 5,
        trimIn: 0,
        trimOut: asset.duration || 5,
        speed: 1,
      });
    });

    this._history.execute(cmd);
    this._onProjectChanged();
  }

  _addTextClip() {
    if (!this._project) return;
    const cmd = this._history.snapshotCommand('Add text clip', (proj) => {
      let track = proj.tracks.find((t) => t.type === 'overlay') ?? proj.tracks.find((t) => t.type === 'video');
      if (!track) track = addTrack(proj, { type: 'overlay' });
      let endTime = 0;
      for (const c of track.clips) endTime = Math.max(endTime, c.startTime + c.duration);
      const clip = addClip(proj, track.id, {
        assetId: null,
        startTime: endTime,
        duration: 5,
        trimIn: 0,
        trimOut: 5,
        speed: 1,
      });
      clip.properties.text = {
        content: 'Text',
        fontFamily: 'sans-serif',
        fontSize: 72,
        color: '#ffffff',
        align: 'center',
        bold: false,
        italic: false,
        lineHeight: 1.3,
      };
    });
    this._history.execute(cmd);
    this._onProjectChanged();
  }

  _addAdjClip() {
    if (!this._project) return;
    const cmd = this._history.snapshotCommand('Add adjustment layer', (proj) => {
      let track = proj.tracks.find((t) => t.type === 'overlay') ?? proj.tracks.find((t) => t.type === 'video');
      if (!track) track = addTrack(proj, { type: 'overlay' });
      let endTime = 0;
      for (const c of track.clips) endTime = Math.max(endTime, c.startTime + c.duration);
      const dur = 10;
      const clip = addClip(proj, track.id, {
        assetId: null,
        startTime: endTime,
        duration: dur,
        trimIn: 0,
        trimOut: dur,
        speed: 1,
      });
      clip.properties.adjustment = true;
    });
    this._history.execute(cmd);
    this._onProjectChanged();
  }

  _addDrawClip() {
    if (!this._project) return;
    const cmd = this._history.snapshotCommand('Add draw layer', (proj) => {
      let track = proj.tracks.find((t) => t.type === 'overlay') ?? proj.tracks.find((t) => t.type === 'video');
      if (!track) track = addTrack(proj, { type: 'overlay' });
      let endTime = 0;
      for (const c of track.clips) endTime = Math.max(endTime, c.startTime + c.duration);
      const clip = addClip(proj, track.id, {
        assetId: null,
        startTime: endTime,
        duration: 10,
        trimIn: 0,
        trimOut: 10,
        speed: 1,
      });
      clip.properties.drawing = { fps: 12, frames: {} };
    });
    this._history.execute(cmd);
    this._onProjectChanged();
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  _renderList(filter) {
    const assets = this._project?.assets ?? [];
    const filtered = filter
      ? assets.filter((a) => (a.name ?? '').toLowerCase().includes(filter))
      : assets;

    this._emptyEl.style.display = filtered.length ? 'none' : 'flex';

    this._listEl.querySelectorAll('.pm-lib-asset').forEach((el) => el.remove());

    for (const asset of filtered) {
      const el = document.createElement('div');
      el.className = 'pm-lib-asset';
      el.setAttribute('role', 'listitem');
      el.setAttribute('draggable', 'true');
      el.dataset.assetId = asset.id;

      const proxyHtml = this._proxyButtonHtml(asset);

      el.innerHTML = `
        <span class="pm-lib-asset-icon" aria-hidden="true">${assetIcon(asset.type)}</span>
        <div class="pm-lib-asset-info">
          <span class="pm-lib-asset-name" title="${escHtml(asset.name ?? '')}">${escHtml(asset.name ?? 'Untitled')}</span>
          <span class="pm-lib-asset-meta">${assetMeta(asset)}</span>
        </div>
        ${proxyHtml}
        <button class="pm-lib-asset-add" data-asset-id="${escHtml(asset.id)}"
                title="Add to timeline" aria-label="Add ${escHtml(asset.name ?? 'asset')} to timeline">+</button>
        <button class="pm-lib-asset-del" data-asset-id="${escHtml(asset.id)}"
                title="Remove asset" aria-label="Remove ${escHtml(asset.name ?? 'asset')}">✕</button>
      `;

      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/peachmint-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      });

      if (asset.type === 'video') {
        const proxyBtn = el.querySelector('.pm-lib-asset-proxy');
        if (proxyBtn) {
          proxyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._handleProxyClick(asset, el);
          });
        }
      }

      el.querySelector('.pm-lib-asset-add')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._addToTimeline(asset);
      });

      el.querySelector('.pm-lib-asset-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAsset(asset.id);
      });

      this._listEl.appendChild(el);
    }
  }

  _proxyButtonHtml(asset) {
    if (asset.type !== 'video') return '';
    const inProgress = this._proxyInProgress.get(asset.id);
    if (inProgress !== undefined) {
      const pct = Math.round(inProgress * 100);
      return `<button class="pm-lib-asset-proxy pm-lib-asset-proxy--busy" disabled
                      title="Generating proxy…" aria-label="Generating proxy ${pct}%">${pct}%</button>`;
    }
    if (asset.proxyKey) {
      return `<button class="pm-lib-asset-proxy pm-lib-asset-proxy--done"
                      title="Proxy ready — click to remove" aria-label="Remove proxy">✓P</button>`;
    }
    const { ProxyEngine } = window._proxyEngineModule ?? {};
    const avail = ProxyEngine
      ? ProxyEngine.isAvailable
      : (typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated));
    return avail
      ? `<button class="pm-lib-asset-proxy"
                 title="Generate 480p proxy for smooth preview" aria-label="Generate proxy">P</button>`
      : `<button class="pm-lib-asset-proxy" disabled
                 title="Proxy requires Cross-Origin Isolation (reload page)" aria-label="Proxy unavailable">P</button>`;
  }

  _handleProxyClick(asset, rowEl) {
    if (asset.proxyKey) {
      // Remove proxy
      const oldKey = asset.proxyKey;
      asset.proxyKey = null;
      this._pm.markDirty();
      this._storage.deleteMedia(oldKey).catch(() => {});
      this._refreshProxyBtn(asset, rowEl);
      return;
    }
    this._generateProxy(asset, rowEl);
  }

  async _generateProxy(asset, rowEl) {
    if (this._proxyInProgress.has(asset.id)) return;
    this._proxyInProgress.set(asset.id, 0);
    this._refreshProxyBtn(asset, rowEl);

    try {
      if (!window._proxyEngineModule) {
        window._proxyEngineModule = await import(PROXY_ENGINE_URL);
      }
      const { ProxyEngine } = window._proxyEngineModule;
      const eng = new ProxyEngine({ storage: this._storage });
      const proxyKey = await eng.generate(asset, (p) => {
        this._proxyInProgress.set(asset.id, p);
        this._refreshProxyBtn(asset, rowEl);
      });
      asset.proxyKey = proxyKey;
      this._pm.markDirty();
    } catch (err) {
      this._showError(`Proxy failed: ${err.message ?? err}`);
    } finally {
      this._proxyInProgress.delete(asset.id);
      this._refreshProxyBtn(asset, rowEl);
    }
  }

  _refreshProxyBtn(asset, rowEl) {
    const existing = rowEl.querySelector('.pm-lib-asset-proxy');
    if (!existing) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this._proxyButtonHtml(asset);
    const next = tmp.firstElementChild;
    if (!next) { existing.remove(); return; }
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      this._handleProxyClick(asset, rowEl);
    });
    existing.replaceWith(next);
  }

  _currentFilter() {
    return (this._el.querySelector('#pm-lib-search')?.value ?? '').toLowerCase();
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
        this._renderList(this._currentFilter());
      },
      undo: () => {
        this._project.assets.splice(idx, 0, asset);
        this._pm.markDirty();
        this._renderList(this._currentFilter());
      },
    });
  }

  // ─── UI helpers ──────────────────────────────────────────────────────────────

  _setProgress(visible, text = '') {
    this._progressEl.style.display = visible ? 'flex' : 'none';
    if (text) this._progressTx.textContent = text;
  }

  _showError(msg) {
    const banner = document.createElement('div');
    banner.className = 'pm-lib-error';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `${escHtml(msg)} <button aria-label="Dismiss" class="pm-lib-error-close">×</button>`;
    banner.querySelector('button').addEventListener('click', () => banner.remove());
    this._el.querySelector('.pm-lib-root').prepend(banner);
    setTimeout(() => banner.remove(), 6000);
  }

  _showNoProjectBanner() {
    this._showError('Open or create a project first to import media.');
  }
}

// ─── File probe ───────────────────────────────────────────────────────────────

/**
 * Probe a File's type, resolution, and duration without reading the full buffer.
 * @param {File} file
 * @returns {Promise<{ type: string, width: number, height: number, duration: number }>}
 */
function probeFile(file) {
  return new Promise((resolve) => {
    const mime = file.type || '';
    const type = mime.startsWith('video/') ? 'video'
               : mime.startsWith('audio/') ? 'audio'
               : mime.startsWith('image/') ? 'image'
               : mime.startsWith('font/')  ? 'font'
               : /\.(ttf|otf|woff2?)$/i.test(file.name) ? 'font'
               : 'video'; // fallback

    if (type === 'font') { resolve({ type, width: 0, height: 0, duration: 0 }); return; }

    const url = URL.createObjectURL(file);
    const done = (width, height, duration) => { URL.revokeObjectURL(url); resolve({ type, width, height, duration }); };

    if (type === 'image') {
      const img = new Image();
      img.addEventListener('load',  () => done(img.naturalWidth, img.naturalHeight, 0), { once: true });
      img.addEventListener('error', () => done(0, 0, 0), { once: true });
      img.src = url;
    } else if (type === 'audio') {
      const aud = new Audio();
      aud.preload = 'metadata';
      aud.addEventListener('loadedmetadata', () => done(0, 0, isFinite(aud.duration) ? aud.duration : 0), { once: true });
      aud.addEventListener('error', () => done(0, 0, 0), { once: true });
      aud.src = url;
    } else {
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.muted = true;
      vid.addEventListener('loadedmetadata', () => done(vid.videoWidth, vid.videoHeight, isFinite(vid.duration) ? vid.duration : 0), { once: true });
      vid.addEventListener('error', () => done(0, 0, 0), { once: true });
      vid.src = url;
    }
  });
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
    .pm-lib-text-btn { background:var(--bg-ui,#2a2a3a); border:1px solid var(--border);
      color:var(--text-primary); border-radius:5px; padding:4px 8px; font-size:0.75rem;
      font-weight:700; cursor:pointer; font-family:var(--font-ui); }
    .pm-lib-text-btn:hover:not(:disabled) { border-color:var(--accent-peach); color:var(--accent-peach); }
    .pm-lib-text-btn:disabled { color:var(--text-dim); cursor:default; }
    .pm-lib-import-btn { background:var(--accent-peach); border:none; color:#181820;
      border-radius:5px; padding:4px 10px; font-size:0.75rem; font-weight:700;
      cursor:pointer; font-family:var(--font-ui); }
    .pm-lib-import-btn:hover:not(:disabled) { background:#ffaa88; }
    .pm-lib-import-btn:disabled { background:var(--border); color:var(--text-dim); cursor:default; }
    .pm-lib-import-btn:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-lib-search { padding:6px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-lib-search-input { width:100%; background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:5px; padding:5px 8px; font-size:0.78rem;
      outline:none; font-family:var(--font-ui); box-sizing:border-box; }
    .pm-lib-search-input:focus { border-color:var(--accent-purple); }
    .pm-lib-list { flex:1; overflow-y:auto; }
    .pm-lib-empty { display:flex; flex-direction:column; align-items:center;
      justify-content:center; height:100%; gap:8px; padding:20px; text-align:center; }
    .pm-lib-empty-icon { font-size:2rem; opacity:0.4; }
    .pm-lib-empty p { margin:0; font-size:0.78rem; color:var(--text-dim); line-height:1.5; }
    .pm-lib-empty-sub { font-size:0.72rem !important; }

    .pm-lib-asset { display:flex; align-items:center; gap:8px; padding:6px 10px;
      cursor:default; border-bottom:1px solid var(--border); }
    .pm-lib-asset:hover { background:var(--bg-hover); }
    .pm-lib-asset-icon { font-size:1.1rem; flex-shrink:0; }
    .pm-lib-asset-info { flex:1; min-width:0; }
    .pm-lib-asset-name { display:block; font-size:0.78rem; color:var(--text-primary);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-lib-asset-meta { font-family:var(--font-mono); font-size:0.65rem; color:var(--text-dim); }

    .pm-lib-asset-add,
    .pm-lib-asset-del { background:transparent; border:none; color:var(--text-dim);
      width:22px; height:22px; border-radius:3px; cursor:pointer; font-size:0.8rem;
      flex-shrink:0; opacity:0; display:flex; align-items:center; justify-content:center; }
    .pm-lib-asset:hover .pm-lib-asset-add,
    .pm-lib-asset:hover .pm-lib-asset-del { opacity:1; }
    .pm-lib-asset-add:hover { background:var(--accent-mint); color:#181820; }
    .pm-lib-asset-del:hover { background:var(--accent-err); color:#fff; }

    .pm-lib-asset-proxy { background:transparent; border:1px solid var(--border);
      color:var(--text-dim); height:18px; min-width:22px; padding:0 3px; border-radius:3px;
      cursor:pointer; font-size:0.6rem; font-family:var(--font-mono); font-weight:700;
      flex-shrink:0; opacity:0; display:flex; align-items:center; justify-content:center; }
    .pm-lib-asset:hover .pm-lib-asset-proxy { opacity:1; }
    .pm-lib-asset-proxy:hover:not(:disabled) { border-color:var(--accent-peach); color:var(--accent-peach); }
    .pm-lib-asset-proxy:disabled { cursor:default; opacity:0.4; }
    .pm-lib-asset-proxy--done { border-color:var(--accent-mint); color:var(--accent-mint); }
    .pm-lib-asset-proxy--done:hover { border-color:var(--accent-err) !important; color:var(--accent-err) !important; }
    .pm-lib-asset-proxy--busy { opacity:1 !important; border-color:var(--accent-purple); color:var(--accent-purple); }

    .pm-lib-drop-hint { position:absolute; inset:0; background:rgba(189,147,249,0.15);
      border:2px dashed var(--accent-purple); border-radius:6px; display:none;
      align-items:center; justify-content:center; color:var(--accent-purple);
      font-size:0.85rem; pointer-events:none; }
    .pm-lib-drop-hint.visible { display:flex; }

    .pm-lib-progress { flex-shrink:0; padding:6px 10px; border-top:1px solid var(--border);
      align-items:center; gap:6px; font-size:0.75rem; color:var(--text-muted);
      font-family:var(--font-mono); }

    .pm-lib-error { background:rgba(255,85,85,0.12); border:1px solid var(--accent-err);
      color:var(--text-primary); border-radius:5px; padding:6px 10px; margin:6px;
      font-size:0.75rem; display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .pm-lib-error-close { background:transparent; border:none; color:var(--text-dim);
      cursor:pointer; font-size:0.9rem; flex-shrink:0; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function assetIcon(type) {
  switch (type) {
    case 'video':   return '🎬';
    case 'audio':   return '🎵';
    case 'image':   return '🖼';
    case 'font':    return 'Aa';
    case 'lut':     return '🎨';
    case 'caption': return '💬';
    default:        return '📄';
  }
}

function assetMeta(asset) {
  if (asset.type === 'caption') {
    const parts = [];
    if (typeof asset.captions?.length === 'number') parts.push(`${asset.captions.length} cues`);
    if (asset.duration != null && asset.duration > 0) parts.push(`${asset.duration.toFixed(1)}s`);
    return parts.join(' · ') || 'caption';
  }
  const parts = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.duration != null && asset.duration > 0) parts.push(`${asset.duration.toFixed(1)}s`);
  if (asset.mimeType) parts.push(asset.mimeType.split('/')[1]?.toUpperCase() ?? asset.mimeType);
  return parts.join(' · ') || asset.type ?? '';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
