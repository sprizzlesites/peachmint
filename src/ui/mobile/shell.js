/**
 * mobile/shell.js — PeachMint mobile UI shell (Phase 1.10)
 *
 * Touch-first vertical layout with bottom tab navigation.
 * Shares all engine modules with the desktop shell — no code duplication.
 */

import { PreviewEngine } from '../../engine/preview-engine.js';
import { AudioEngine }   from '../../engine/audio-engine.js';
import { addTrack, addClip, removeClip, totalDuration } from '../../engine/edl.js';

export function mountMobileShell(container, { projectManager, historyManager, storage }) {
  const shell = new MobileShell(container, { pm: projectManager, history: historyManager, storage });
  shell.mount();
  return shell;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RULER_LEFT = 58; // px reserved for track label column

// ─── MobileShell ─────────────────────────────────────────────────────────────

class MobileShell {
  constructor(container, { pm, history, storage }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._storage = storage;
    this._previewEngine = null;
    this._audioEngine = null;
    this._currentTime = 0;
    this._isPlaying = false;
    this._selectedClip = null;
    this._activeTab = null;
    this._pxPerSec = 60;
  }

  mount() {
    injectStyles();
    this._el.innerHTML = buildHTML();

    const canvas = this._el.querySelector('#pm-m-canvas');
    this._previewEngine = new PreviewEngine({ canvas, storage: this._storage });
    this._previewEngine.init();
    this._previewEngine.addEventListener('preview:tick', (e) => {
      const t = e.detail.time;
      this._currentTime = t;
      this._updateTimecode(t);
      this._updatePlayhead(t);
    });
    this._previewEngine.addEventListener('preview:ended', () => {
      this._isPlaying = false;
      this._updatePlayBtn(false);
      this._audioEngine?.stop();
      this._currentTime = 0;
      this._updateTimecode(0);
      this._updatePlayhead(0);
    });

    this._audioEngine = new AudioEngine({ storage: this._storage });
    this._audioEngine.init();

    this._bindTransport();
    this._bindTimeline();
    this._bindTabs();
    this._bindProjectEvents();
    this._bindKeyboard();

    this._el.querySelector('#pm-m-menu-btn')?.addEventListener('click', () => this._showMenu());

    if (this._pm.project) {
      this._onProjectOpened(this._pm.project);
    } else {
      this._showStartScreen();
    }
  }

  // ─── Project events ──────────────────────────────────────────────────────────

  _bindProjectEvents() {
    this._pm.addEventListener('project:opened',   (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:recovered', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:closed',   () => this._onProjectClosed());
    this._pm.addEventListener('project:saved',    () => this._setSaveStatus('Saved'));
    this._pm.addEventListener('project:autosaved',() => this._setSaveStatus('Auto-saved'));
    this._pm.addEventListener('project:dirty',    () => {
      this._setSaveStatus('*');
      this._renderTimeline();
    });
  }

  _onProjectOpened(project) {
    this._history.clear();
    this._hideStartScreen();
    this._currentTime = 0;
    this._selectedClip = null;
    this._updateTimecode(0);
    this._updatePlayhead(0);
    this._setSaveStatus('');
    this._el.querySelector('#pm-m-name').textContent = project.name ?? 'Untitled';
    this._previewEngine?.setProject(project);
    this._audioEngine?.setProject(project);
    const { width, height } = project.canvas;
    const wrap = this._el.querySelector('.pm-m-canvas-wrap');
    if (wrap) wrap.style.aspectRatio = `${width} / ${height}`;
    this._renderTimeline();
    this._showTab('library');
  }

  _onProjectClosed() {
    this._history.clear();
    this._stop();
    this._previewEngine?.setProject(null);
    this._audioEngine?.setProject(null);
    this._showStartScreen();
    this._el.querySelector('#pm-m-name').textContent = '';
    this._setSaveStatus('');
    this._renderTimeline();
    this._showTab(null);
  }

  // ─── Transport ───────────────────────────────────────────────────────────────

  _bindTransport() {
    this._el.querySelector('#pm-m-play')?.addEventListener('click', () => this._togglePlay());
    this._el.querySelector('#pm-m-rewind')?.addEventListener('click', () => { this._stop(); this._seek(0); });
    this._el.querySelector('#pm-m-fwd')?.addEventListener('click', () => {
      const t = this._pm.project ? Math.max(totalDuration(this._pm.project), 10) : 0;
      this._stop(); this._seek(t);
    });
    this._el.querySelector('.pm-m-canvas-wrap')?.addEventListener('click', () => {
      if (this._pm.project) this._togglePlay();
    });
  }

  _togglePlay() { this._isPlaying ? this._stop() : this._play(); }

  _play() {
    if (this._isPlaying || !this._pm.project) return;
    this._isPlaying = true;
    this._updatePlayBtn(true);
    this._previewEngine?.play(this._currentTime);
    this._audioEngine?.play(this._currentTime).catch(() => {});
  }

  _stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    this._updatePlayBtn(false);
    this._previewEngine?.stop();
    this._audioEngine?.stop();
  }

  _seek(t) {
    this._currentTime = t;
    this._updateTimecode(t);
    this._updatePlayhead(t);
    this._previewEngine?.seekTo(t);
    if (this._isPlaying) {
      this._audioEngine?.stop();
      this._audioEngine?.play(t).catch(() => {});
    }
  }

  _updatePlayBtn(playing) {
    const btn = this._el.querySelector('#pm-m-play');
    if (!btn) return;
    btn.textContent = playing ? '⏸' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  _updateTimecode(t) {
    const el = this._el.querySelector('#pm-m-timecode');
    if (el) el.textContent = formatTimecode(t, this._pm.project?.canvas?.fps ?? 30);
  }

  // ─── Timeline ─────────────────────────────────────────────────────────────────

  _bindTimeline() {
    const tl = this._el.querySelector('#pm-m-tl-scroll');
    if (!tl) return;

    let txStart = 0, tyStart = 0, scrollStart = 0, moved = false;

    tl.addEventListener('touchstart', (e) => {
      txStart = e.touches[0].clientX;
      tyStart = e.touches[0].clientY;
      scrollStart = tl.scrollLeft;
      moved = false;
    }, { passive: true });

    tl.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - txStart;
      const dy = e.touches[0].clientY - tyStart;
      if (!moved && Math.abs(dy) > Math.abs(dx)) return;
      tl.scrollLeft = scrollStart - dx;
      moved = true;
    }, { passive: true });

    tl.addEventListener('touchend', (e) => {
      if (moved) return;
      const rect = tl.getBoundingClientRect();
      const rawX = e.changedTouches[0].clientX - rect.left + tl.scrollLeft - RULER_LEFT;
      if (rawX < 0) return;

      // Check if a clip was tapped
      const touch = e.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el?.classList.contains('pm-m-clip')) {
        this._selectClipById(el.dataset.id);
        return;
      }
      this._seek(Math.max(0, rawX / this._pxPerSec));
    });

    // Click / mouse fallback (for desktop "mobile UI" mode)
    tl.addEventListener('click', (e) => {
      if (e.target.classList.contains('pm-m-clip')) {
        this._selectClipById(e.target.dataset.id);
        return;
      }
      const rect = tl.getBoundingClientRect();
      const rawX = e.clientX - rect.left + tl.scrollLeft - RULER_LEFT;
      if (rawX >= 0) this._seek(Math.max(0, rawX / this._pxPerSec));
    });
  }

  _selectClipById(clipId) {
    const project = this._pm.project;
    if (!project) return;
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) { this._selectClip(clip); return; }
    }
  }

  _selectClip(clip) {
    this._selectedClip = clip;
    this._renderTimeline();
    if (this._activeTab !== 'clip') this._showTab('clip');
    else this._renderClipPanel(this._el.querySelector('#pm-m-panel'));
  }

  _updatePlayhead(t) {
    const ph = this._el.querySelector('#pm-m-playhead');
    if (ph) ph.style.left = `${RULER_LEFT + t * this._pxPerSec}px`;
  }

  _renderTimeline() {
    const container = this._el.querySelector('#pm-m-tl-inner');
    if (!container) return;
    const project = this._pm.project;
    if (!project || !project.tracks.length) {
      container.innerHTML = `<div class="pm-m-tl-empty">Import media to get started.</div>`;
      this._updatePlayhead(this._currentTime);
      return;
    }

    const dur = Math.max(totalDuration(project), 30);
    const totalW = Math.ceil(dur * this._pxPerSec) + 120;

    let html = `<div class="pm-m-ruler" style="width:${totalW}px">`;
    const step = rulerStep(this._pxPerSec);
    for (let t = 0; t <= dur + step; t += step) {
      const x = RULER_LEFT + t * this._pxPerSec;
      html += `<span class="pm-m-ruler-tick" style="left:${x}px">${fmtRulerTime(t)}</span>`;
    }
    html += `</div>`;

    for (const track of project.tracks) {
      const color = track.type === 'audio' ? 'var(--accent-blue)' : 'var(--accent-peach)';
      html += `<div class="pm-m-tl-row" style="width:${totalW}px">
        <span class="pm-m-tl-label" aria-label="${escHtml(track.name ?? track.type)}">${escHtml((track.name ?? track.type).slice(0, 8))}</span>`;
      for (const clip of track.clips) {
        const x  = RULER_LEFT + clip.startTime * this._pxPerSec;
        const w  = Math.max(4, clip.duration * this._pxPerSec);
        const sel = this._selectedClip?.id === clip.id;
        const label = w > 40 ? escHtml((clip.name ?? 'Clip').slice(0, 12)) : '';
        html += `<div class="pm-m-clip${sel ? ' selected' : ''}" data-id="${escHtml(clip.id)}"
          style="left:${x}px;width:${w}px;background:${color}">${label}</div>`;
      }
      html += `</div>`;
    }

    container.innerHTML = html;
    this._updatePlayhead(this._currentTime);
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────────

  _bindTabs() {
    this._el.querySelectorAll('.pm-m-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        this._showTab(this._activeTab === tab ? null : tab);
      });
    });
  }

  _showTab(tab) {
    this._activeTab = tab;
    this._el.querySelectorAll('.pm-m-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
      btn.setAttribute('aria-selected', btn.dataset.tab === tab ? 'true' : 'false');
    });
    const panel = this._el.querySelector('#pm-m-panel');
    if (!panel) return;
    if (!tab) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
    panel.style.display = 'flex';
    if (tab === 'library') this._renderLibraryPanel(panel);
    else if (tab === 'clip')    this._renderClipPanel(panel);
    else if (tab === 'export')  this._renderExportPanel(panel);
  }

  // ─── Library panel ────────────────────────────────────────────────────────────

  _renderLibraryPanel(panel) {
    const assets = this._pm.project?.assets ?? [];
    panel.innerHTML = `
      <div class="pm-m-panel-inner">
        <div class="pm-m-panel-header">
          <span>Media Library</span>
          <button class="pm-m-pill-btn" id="pm-m-import">+ Import</button>
        </div>
        <div class="pm-m-asset-list">
          ${assets.length ? assets.map((a) => `
            <div class="pm-m-asset-row">
              <span class="pm-m-asset-icon">${a.type === 'audio' ? '🎵' : '🎬'}</span>
              <div class="pm-m-asset-info">
                <span class="pm-m-asset-name">${escHtml(a.name ?? 'Asset')}</span>
                <span class="pm-m-asset-meta">${escHtml(a.type)}${a.duration ? ' · ' + a.duration.toFixed(1) + 's' : ''}</span>
              </div>
              <button class="pm-m-add-btn" data-id="${escHtml(a.id)}" aria-label="Add ${escHtml(a.name ?? 'asset')} to timeline">+</button>
            </div>
          `).join('') : `<div class="pm-m-empty-msg">No media yet. Tap + Import to add files.</div>`}
        </div>
      </div>
    `;
    panel.querySelector('#pm-m-import')?.addEventListener('click', () => this._importFile());
    panel.querySelectorAll('.pm-m-add-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._addAssetToTimeline(btn.dataset.id));
    });
  }

  async _importFile() {
    if (!this._pm.project) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,audio/*,image/*';
    input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of Array.from(input.files)) {
        await this._ingestFile(file);
      }
      if (this._activeTab === 'library') {
        this._renderLibraryPanel(this._el.querySelector('#pm-m-panel'));
      }
    });
    input.click();
  }

  async _ingestFile(file) {
    const ab = await file.arrayBuffer();
    const key = await this._storage.writeMedia(file.name, ab);
    const type = file.type.startsWith('audio') ? 'audio' : 'video';
    let duration = 0;
    try { duration = await probeDuration(file); } catch {}
    const asset = {
      id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name, type, mimeType: file.type,
      size: file.size, duration, storageKey: key,
    };
    this._pm.mutate((proj) => proj.assets.push(asset));
  }

  _addAssetToTimeline(assetId) {
    const project = this._pm.project;
    if (!project) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    let track = project.tracks.find((t) => t.type === asset.type && !t.locked);
    if (!track) {
      this._pm.mutate((proj) => addTrack(proj, { type: asset.type }));
      track = this._pm.project.tracks.at(-1);
    }
    const startTime = totalDuration(project);
    const cmd = this._history.snapshotCommand('Add clip', (proj) => {
      addClip(proj, track.id, { assetId: asset.id, startTime, duration: asset.duration ?? 5 });
    });
    this._history.execute(cmd);
    this._renderTimeline();
  }

  // ─── Clip panel ──────────────────────────────────────────────────────────────

  _renderClipPanel(panel) {
    const clip = this._selectedClip;
    if (!clip) {
      panel.innerHTML = `<div class="pm-m-panel-inner"><div class="pm-m-empty-msg">Tap a clip in the timeline to select it.</div></div>`;
      return;
    }
    const vol   = clip.properties?.volume ?? 1;
    const speed = clip.speed ?? 1;
    panel.innerHTML = `
      <div class="pm-m-panel-inner">
        <div class="pm-m-panel-header">
          <span>${escHtml((clip.name ?? 'Clip').slice(0, 22))}</span>
          <button class="pm-m-pill-btn pm-m-pill-danger" id="pm-m-del-clip">Delete</button>
        </div>
        <label class="pm-m-prop-row">
          <span>Volume</span>
          <input type="range" id="pm-m-vol" min="0" max="2" step="0.01" value="${vol}">
          <span id="pm-m-vol-val">${vol.toFixed(2)}</span>
        </label>
        <label class="pm-m-prop-row">
          <span>Speed</span>
          <input type="range" id="pm-m-spd" min="0.25" max="4" step="0.05" value="${speed}">
          <span id="pm-m-spd-val">${speed.toFixed(2)}×</span>
        </label>
      </div>
    `;

    const volInput = panel.querySelector('#pm-m-vol');
    const volVal   = panel.querySelector('#pm-m-vol-val');
    volInput.addEventListener('input', () => {
      const v = parseFloat(volInput.value);
      volVal.textContent = v.toFixed(2);
      const c = this._findClip(clip.id);
      if (c) { if (!c.properties) c.properties = {}; c.properties.volume = v; this._pm.markDirty(); }
    });

    const spdInput = panel.querySelector('#pm-m-spd');
    const spdVal   = panel.querySelector('#pm-m-spd-val');
    spdInput.addEventListener('input', () => {
      const v = parseFloat(spdInput.value);
      spdVal.textContent = v.toFixed(2) + '×';
      const c = this._findClip(clip.id);
      if (c) { c.speed = v; this._pm.markDirty(); }
    });

    panel.querySelector('#pm-m-del-clip')?.addEventListener('click', () => {
      if (!this._pm.project) return;
      const cmd = this._history.snapshotCommand('Delete clip', (proj) => removeClip(proj, clip.id));
      this._history.execute(cmd);
      this._selectedClip = null;
      this._renderTimeline();
      this._showTab(null);
    });
  }

  _findClip(clipId) {
    if (!this._pm.project) return null;
    for (const track of this._pm.project.tracks) {
      const c = track.clips.find((x) => x.id === clipId);
      if (c) return c;
    }
    return null;
  }

  // ─── Export panel ─────────────────────────────────────────────────────────────

  _renderExportPanel(panel) {
    const project = this._pm.project;
    if (!project) {
      panel.innerHTML = `<div class="pm-m-panel-inner"><div class="pm-m-empty-msg">No project open.</div></div>`;
      return;
    }
    const w = project.canvas.width, h = project.canvas.height, f = project.canvas.fps ?? 30;
    panel.innerHTML = `
      <div class="pm-m-panel-inner">
        <div class="pm-m-panel-header"><span>Export MP4</span></div>
        <label class="pm-m-sel-row">
          <span>Resolution</span>
          <select class="pm-m-sel" id="pm-m-ex-res">
            <option value="match">Project — ${w}×${h}</option>
            <option value="1920x1080">1080p</option>
            <option value="1280x720">720p</option>
          </select>
        </label>
        <label class="pm-m-sel-row" style="margin-top:8px">
          <span>Quality</span>
          <select class="pm-m-sel" id="pm-m-ex-vbr">
            <option value="4000000">4 Mbps</option>
            <option value="8000000" selected>8 Mbps</option>
            <option value="16000000">16 Mbps</option>
          </select>
        </label>
        <label class="pm-m-check-row" style="margin-top:8px">
          <input type="checkbox" id="pm-m-ex-audio" checked> Include audio
        </label>
        <div id="pm-m-ex-prog" style="display:none;margin-top:10px">
          <div class="pm-m-progress-track">
            <div id="pm-m-ex-bar" class="pm-m-progress-fill" style="width:0%"></div>
          </div>
          <div id="pm-m-ex-lbl" class="pm-m-ex-label">Preparing…</div>
        </div>
        <div id="pm-m-ex-err" class="pm-m-ex-error" style="display:none"></div>
        <button class="pm-m-big-btn" id="pm-m-ex-start" style="margin-top:12px">Export MP4</button>
      </div>
    `;

    let exportEngine = null;
    const startBtn  = panel.querySelector('#pm-m-ex-start');
    const progDiv   = panel.querySelector('#pm-m-ex-prog');
    const bar       = panel.querySelector('#pm-m-ex-bar');
    const lbl       = panel.querySelector('#pm-m-ex-lbl');
    const errDiv    = panel.querySelector('#pm-m-ex-err');

    startBtn.addEventListener('click', async () => {
      const resVal  = panel.querySelector('#pm-m-ex-res').value;
      const vbr     = parseInt(panel.querySelector('#pm-m-ex-vbr').value, 10);
      const inclAud = panel.querySelector('#pm-m-ex-audio').checked;
      let expW = w, expH = h;
      if (resVal !== 'match') [expW, expH] = resVal.split('x').map(Number);

      startBtn.disabled = true;
      startBtn.textContent = 'Exporting…';
      progDiv.style.display = 'block';
      errDiv.style.display = 'none';
      const t0 = Date.now();

      try {
        const { ExportEngine } = await import('../../engine/export-engine.js');
        exportEngine = new ExportEngine({ storage: this._storage });
        const buffer = await exportEngine.export(
          project,
          { width: expW, height: expH, fps: f, videoBitrate: vbr, includeAudio: inclAud },
          (progress) => {
            bar.style.width = `${Math.round(progress * 100)}%`;
            lbl.textContent = `${Math.round(progress * 100)}% — ${formatElapsed((Date.now() - t0) / 1000)}`;
          },
        );
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `${(project.name ?? 'export').replace(/[^a-z0-9_-]/gi, '_')}.mp4`;
        a.click();
        URL.revokeObjectURL(url);
        startBtn.disabled = false;
        startBtn.textContent = 'Export MP4';
        progDiv.style.display = 'none';
      } catch (err) {
        if (err.message !== 'Export cancelled') {
          errDiv.textContent = `Export failed: ${err.message}`;
          errDiv.style.display = 'block';
        }
        startBtn.disabled = false;
        startBtn.textContent = 'Retry Export';
      }
    });
  }

  // ─── Menu sheet ──────────────────────────────────────────────────────────────

  _showMenu() {
    const hasPrj = !!this._pm.project;
    const items = [
      { label: '+ New Project',  action: () => this._showNewProjectDialog() },
      { label: '📂 Open Project', action: () => this._showOpenProjectDialog() },
      { label: '💾 Save',         action: () => this._pm.saveProject(), disabled: !hasPrj },
      { label: '⬇ Export MP4',   action: () => this._showTab('export'), disabled: !hasPrj },
      { label: '🖥 Desktop UI',   action: () => { localStorage.setItem('peachmint_ui_mode', 'desktop'); location.reload(); } },
      { label: '⚙ System Info',  action: () => window.__peachmint?.showSysCheck() },
    ];
    const sheet = document.createElement('div');
    sheet.className = 'pm-m-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Menu');
    sheet.innerHTML = `
      <div class="pm-m-sheet-backdrop"></div>
      <div class="pm-m-sheet-panel">
        ${items.map((it, i) =>
          `<button class="pm-m-sheet-item${it.disabled ? ' disabled' : ''}"
            ${it.disabled ? 'disabled' : ''} data-idx="${i}">${escHtml(it.label)}</button>`
        ).join('')}
        <button class="pm-m-sheet-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(sheet);

    sheet.querySelectorAll('.pm-m-sheet-item:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', () => {
        sheet.remove();
        items[parseInt(btn.dataset.idx)]?.action();
      });
    });
    sheet.querySelector('.pm-m-sheet-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('.pm-m-sheet-backdrop').addEventListener('click', () => sheet.remove());
  }

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────────

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
      if (ctrl && e.key === 'z') { e.preventDefault(); this._history.undo(); this._renderTimeline(); }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this._history.redo(); this._renderTimeline(); }
      if (ctrl && e.key === 's') { e.preventDefault(); this._pm.saveProject(); }
    });
  }

  // ─── Start screen ─────────────────────────────────────────────────────────────

  _showStartScreen() {
    const s = this._el.querySelector('#pm-m-start');
    if (!s) return;
    s.style.display = 'flex';
    s.querySelector('#pm-m-start-new')?.addEventListener('click', () => this._showNewProjectDialog());
    s.querySelector('#pm-m-start-open')?.addEventListener('click', () => this._showOpenProjectDialog());
  }

  _hideStartScreen() {
    const s = this._el.querySelector('#pm-m-start');
    if (s) s.style.display = 'none';
  }

  // ─── Project dialogs ──────────────────────────────────────────────────────────

  _showNewProjectDialog() {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'np-m-title');
    dialog.innerHTML = `
      <h2 id="np-m-title" style="margin:0 0 16px;font-size:1rem">New Project</h2>
      <label class="pm-m-dlg-label">Name
        <input id="np-m-name" type="text" value="Untitled Project" class="pm-m-input" style="width:100%">
      </label>
      <label class="pm-m-dlg-label" style="margin-top:10px">Canvas Preset
        <select id="np-m-preset" class="pm-m-input" style="width:100%">
          <option value="1920x1080x30">YouTube 1080p 30fps</option>
          <option value="1080x1920x30">Shorts / TikTok / Reels 30fps</option>
          <option value="1080x1080x30">Square 1:1 30fps</option>
          <option value="1280x720x30">720p 30fps</option>
        </select>
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button class="pm-m-btn-ghost" id="np-m-cancel">Cancel</button>
        <button class="pm-m-btn-primary" id="np-m-create" autofocus>Create</button>
      </div>`;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('#np-m-cancel').addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.querySelector('#np-m-create').addEventListener('click', async () => {
      const name = dialog.querySelector('#np-m-name').value.trim() || 'Untitled Project';
      const [width, height, fps] = dialog.querySelector('#np-m-preset').value.split('x').map(Number);
      dialog.close(); dialog.remove();
      await this._pm.newProject({ name, width, height, fps });
    });
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { dialog.close(); dialog.remove(); } });
  }

  _showOpenProjectDialog() {
    this._storage.listProjects().then((list) => {
      if (!list.length) {
        this._showInfoDialog('No saved projects', 'No projects found. Create a new one to get started.');
        return;
      }
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'op-m-title');
      const rows = list
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .map((p) => `
          <div class="pm-m-proj-row" data-id="${escHtml(p.id)}" role="button" tabindex="0">
            <span class="pm-m-proj-name">${escHtml(p.name ?? 'Untitled')}</span>
            <span class="pm-m-proj-date">${formatDate(p.updatedAt ?? p._savedAt)}</span>
          </div>`).join('');
      dialog.innerHTML = `
        <h2 id="op-m-title" style="margin:0 0 14px;font-size:1rem">Open Project</h2>
        <div style="max-height:50vh;overflow-y:auto">${rows}</div>
        <div style="text-align:right;margin-top:16px">
          <button class="pm-m-btn-ghost" id="op-m-cancel">Cancel</button>
        </div>`;
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('#op-m-cancel').addEventListener('click', () => { dialog.close(); dialog.remove(); });
      dialog.addEventListener('click', async (e) => {
        const row = e.target.closest('.pm-m-proj-row');
        if (!row) return;
        dialog.close(); dialog.remove();
        await this._pm.openProject(row.dataset.id);
      });
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { dialog.close(); dialog.remove(); }
        if (e.key === 'Enter' && document.activeElement.classList.contains('pm-m-proj-row')) {
          document.activeElement.click();
        }
      });
    });
  }

  _showInfoDialog(title, msg) {
    const d = document.createElement('dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = `
      <h2 style="margin:0 0 10px;font-size:1rem">${escHtml(title)}</h2>
      <p style="color:var(--text-muted);font-size:0.85rem">${escHtml(msg)}</p>
      <div style="text-align:right;margin-top:16px">
        <button class="pm-m-btn-primary" autofocus>OK</button>
      </div>`;
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('button').addEventListener('click', () => { d.close(); d.remove(); });
  }

  // ─── Save status ──────────────────────────────────────────────────────────────

  _setSaveStatus(msg) {
    const el = this._el.querySelector('#pm-m-status');
    if (el) el.textContent = msg;
  }
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHTML() {
  return `
    <div class="pm-mobile">
      <header class="pm-m-header">
        <span class="pm-brand" aria-label="PeachMint">🍑🌿</span>
        <span id="pm-m-name" class="pm-m-name"></span>
        <div class="pm-m-header-right">
          <span id="pm-m-status" class="pm-m-status" aria-live="polite"></span>
          <button id="pm-m-menu-btn" class="pm-m-icon-btn" aria-label="Menu" aria-haspopup="menu">☰</button>
        </div>
      </header>

      <div class="pm-m-preview-area">
        <div class="pm-m-canvas-wrap" style="aspect-ratio:16/9">
          <canvas id="pm-m-canvas" width="1280" height="720" aria-label="Video preview canvas"></canvas>
        </div>
        <div class="pm-m-transport" role="group" aria-label="Playback controls">
          <button id="pm-m-rewind" class="pm-m-tbtn" aria-label="Rewind to start" title="Rewind">⏮</button>
          <button id="pm-m-play"   class="pm-m-tbtn pm-m-play-btn" aria-label="Play" title="Play/Pause (Space)">▶</button>
          <button id="pm-m-fwd"    class="pm-m-tbtn" aria-label="Go to end" title="Go to end">⏭</button>
          <span id="pm-m-timecode" class="pm-m-timecode" aria-live="polite">00:00:00:00</span>
        </div>
      </div>

      <div class="pm-m-timeline-area">
        <div id="pm-m-tl-scroll" class="pm-m-tl-scroll">
          <div id="pm-m-tl-inner" class="pm-m-tl-inner"></div>
          <div id="pm-m-playhead" class="pm-m-playhead"></div>
        </div>
      </div>

      <div id="pm-m-panel" class="pm-m-panel" style="display:none" aria-live="polite"></div>

      <nav class="pm-m-tabs" role="tablist" aria-label="Editor panels">
        <button class="pm-m-tab" data-tab="library" role="tab" aria-selected="false" aria-label="Media library">📂 Media</button>
        <button class="pm-m-tab" data-tab="clip"    role="tab" aria-selected="false" aria-label="Clip properties">✂ Clip</button>
        <button class="pm-m-tab" data-tab="export"  role="tab" aria-selected="false" aria-label="Export">⬇ Export</button>
      </nav>

      <div id="pm-m-start" class="pm-m-start" style="display:flex">
        <div class="pm-m-start-inner">
          <div class="pm-m-start-logo" aria-hidden="true">🍑🌿</div>
          <h1 class="pm-m-start-title">PeachMint</h1>
          <p class="pm-m-start-sub">Browser Video Editor</p>
          <button id="pm-m-start-new"  class="pm-m-big-btn">+ New Project</button>
          <button id="pm-m-start-open" class="pm-m-btn-ghost" style="margin-top:8px">Open Recent</button>
          <p class="pm-m-start-note">All media stays on your device. No uploads.</p>
          <button onclick="localStorage.setItem('peachmint_ui_mode','desktop');location.reload()"
            style="margin-top:16px;background:transparent;border:none;color:var(--text-muted);
                   font-size:0.75rem;cursor:pointer;font-family:var(--font-ui)">
            Switch to Desktop UI →
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .pm-mobile { display:flex; flex-direction:column; height:100%; width:100%;
      overflow:hidden; background:var(--bg-base); position:relative; }

    /* Header */
    .pm-m-header { display:flex; align-items:center; gap:8px; padding:0 12px; height:44px;
      background:var(--bg-panel); border-bottom:1px solid var(--border); flex-shrink:0;
      user-select:none; -webkit-user-select:none; }
    .pm-m-name { flex:1; font-size:0.82rem; color:var(--text-muted); min-width:0;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-m-header-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .pm-m-status { font-family:var(--font-mono); font-size:0.68rem; color:var(--accent-peach); }
    .pm-m-icon-btn { width:36px; height:36px; border:none; background:transparent;
      color:var(--text-primary); font-size:1.1rem; cursor:pointer; border-radius:6px;
      touch-action:manipulation; display:flex; align-items:center; justify-content:center; }
    .pm-m-icon-btn:active { background:var(--bg-hover); }

    /* Preview */
    .pm-m-preview-area { flex-shrink:0; display:flex; flex-direction:column;
      align-items:stretch; background:#000; }
    .pm-m-canvas-wrap { width:100%; max-height:35vh; background:#000;
      display:flex; align-items:center; justify-content:center; overflow:hidden; }
    #pm-m-canvas { display:block; width:100%; height:100%;
      max-height:35vh; object-fit:contain; }
    .pm-m-transport { display:flex; align-items:center; gap:8px; padding:6px 12px;
      background:var(--bg-panel); border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-m-tbtn { width:40px; height:40px; border:1px solid var(--border);
      background:var(--bg-surface); color:var(--text-primary); border-radius:50%;
      font-size:0.8rem; cursor:pointer; touch-action:manipulation;
      display:flex; align-items:center; justify-content:center; }
    .pm-m-tbtn:active { background:var(--bg-hover); }
    .pm-m-play-btn { width:44px; height:44px; font-size:0.9rem; font-weight:bold;
      background:var(--accent-peach) !important; border-color:var(--accent-peach) !important;
      color:#181820 !important; }
    .pm-m-timecode { font-family:var(--font-mono); font-size:0.82rem;
      color:var(--accent-blue); margin-left:4px; }

    /* Timeline */
    .pm-m-timeline-area { height:110px; flex-shrink:0; background:var(--bg-panel);
      border-bottom:1px solid var(--border); overflow:hidden; position:relative; }
    .pm-m-tl-scroll { width:100%; height:100%; overflow-x:auto; overflow-y:hidden;
      position:relative; -webkit-overflow-scrolling:touch; scrollbar-width:thin; }
    .pm-m-tl-inner { height:100%; position:relative; min-width:100%; }
    .pm-m-ruler { height:18px; position:relative; background:var(--bg-base);
      border-bottom:1px solid var(--border); }
    .pm-m-ruler-tick { position:absolute; bottom:2px; font-family:var(--font-mono);
      font-size:0.58rem; color:var(--text-dim); transform:translateX(-50%);
      white-space:nowrap; pointer-events:none; }
    .pm-m-tl-row { height:40px; position:relative; border-bottom:1px solid var(--border); }
    .pm-m-tl-label { position:absolute; left:0; top:0; width:${RULER_LEFT}px; height:100%;
      display:flex; align-items:center; padding:0 5px; font-size:0.62rem; color:var(--text-muted);
      background:var(--bg-panel); z-index:2; border-right:1px solid var(--border);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex-shrink:0; }
    .pm-m-clip { position:absolute; top:4px; height:32px; border-radius:4px;
      font-size:0.62rem; color:#181820; display:flex; align-items:center;
      padding:0 4px; overflow:hidden; cursor:pointer; white-space:nowrap;
      text-overflow:ellipsis; box-sizing:border-box; user-select:none;
      -webkit-user-select:none; touch-action:manipulation; }
    .pm-m-clip.selected { outline:2px solid #fff; outline-offset:1px; }
    .pm-m-playhead { position:absolute; top:0; bottom:0; width:2px;
      background:var(--accent-peach); pointer-events:none; z-index:5;
      transform:translateX(-1px); }
    .pm-m-tl-empty { position:absolute; inset:0; display:flex; align-items:center;
      justify-content:center; color:var(--text-dim); font-size:0.78rem;
      padding:0 ${RULER_LEFT + 12}px; text-align:center; }

    /* Tab panel */
    .pm-m-panel { flex:1; overflow:hidden; background:var(--bg-panel); min-height:0;
      flex-direction:column; }
    .pm-m-panel-inner { display:flex; flex-direction:column; gap:10px; padding:12px;
      height:100%; overflow-y:auto; }
    .pm-m-panel-header { display:flex; align-items:center; justify-content:space-between;
      padding-bottom:8px; border-bottom:1px solid var(--border); }
    .pm-m-panel-header > span { font-size:0.8rem; font-weight:600; color:var(--text-muted); }
    .pm-m-empty-msg { color:var(--text-dim); font-size:0.8rem; text-align:center;
      padding:20px 12px; flex:1; display:flex; align-items:center; justify-content:center; }

    /* Bottom tabs */
    .pm-m-tabs { display:flex; background:var(--bg-panel); border-top:1px solid var(--border);
      flex-shrink:0; padding-bottom:max(0px, env(safe-area-inset-bottom)); }
    .pm-m-tab { flex:1; height:52px; border:none; background:transparent; color:var(--text-muted);
      font-size:0.72rem; cursor:pointer; touch-action:manipulation; font-family:var(--font-ui);
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
      border-top:2px solid transparent; transition:color .1s, border-color .1s; }
    .pm-m-tab.active { color:var(--accent-peach); border-top-color:var(--accent-peach); }
    .pm-m-tab:active { background:var(--bg-hover); }

    /* Library panel */
    .pm-m-asset-list { display:flex; flex-direction:column; gap:2px; overflow-y:auto; flex:1; }
    .pm-m-asset-row { display:flex; align-items:center; gap:10px; padding:8px 4px;
      border-bottom:1px solid var(--border); }
    .pm-m-asset-row:last-child { border-bottom:none; }
    .pm-m-asset-icon { font-size:1.2rem; flex-shrink:0; }
    .pm-m-asset-info { flex:1; min-width:0; }
    .pm-m-asset-name { display:block; font-size:0.8rem; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .pm-m-asset-meta { font-size:0.68rem; color:var(--text-dim); font-family:var(--font-mono); }
    .pm-m-add-btn { width:32px; height:32px; border:1px solid var(--accent-peach);
      background:transparent; color:var(--accent-peach); border-radius:6px; font-size:1rem;
      cursor:pointer; touch-action:manipulation; flex-shrink:0; display:flex;
      align-items:center; justify-content:center; }
    .pm-m-add-btn:active { background:var(--accent-peach); color:#181820; }

    /* Clip panel */
    .pm-m-prop-row { display:flex; align-items:center; gap:10px; font-size:0.8rem;
      color:var(--text-primary); }
    .pm-m-prop-row > span:first-child { min-width:52px; color:var(--text-muted);
      font-size:0.78rem; }
    .pm-m-prop-row input[type=range] { flex:1; accent-color:var(--accent-peach);
      touch-action:pan-x; }
    .pm-m-prop-row > span:last-child { font-family:var(--font-mono); font-size:0.72rem;
      min-width:42px; text-align:right; color:var(--text-muted); }

    /* Export panel */
    .pm-m-sel-row { display:flex; align-items:center; gap:10px; font-size:0.8rem; }
    .pm-m-sel-row > span { min-width:68px; color:var(--text-muted); font-size:0.78rem; }
    .pm-m-sel { flex:1; background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:6px; padding:6px 8px; font-size:0.8rem;
      font-family:var(--font-ui); }
    .pm-m-check-row { display:flex; align-items:center; gap:8px; font-size:0.8rem;
      color:var(--text-muted); }
    .pm-m-progress-track { height:5px; background:var(--bg-base); border-radius:3px; overflow:hidden; }
    .pm-m-progress-fill { height:100%; background:var(--accent-peach); transition:width .15s; }
    .pm-m-ex-label { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-muted);
      margin-top:4px; }
    .pm-m-ex-error { background:#2d1010; border:1px solid #ff5555; border-radius:6px;
      padding:8px 10px; font-size:0.78rem; color:#ff8080; }

    /* Buttons */
    .pm-m-big-btn { width:100%; height:48px; background:var(--accent-peach); border:none;
      color:#181820; font-size:0.9rem; font-weight:700; border-radius:8px; cursor:pointer;
      touch-action:manipulation; font-family:var(--font-ui); }
    .pm-m-big-btn:active { background:#ffaa88; }
    .pm-m-big-btn:disabled { background:var(--border); color:var(--text-dim); cursor:default; }
    .pm-m-pill-btn { background:var(--bg-hover); border:1px solid var(--border);
      color:var(--text-muted); border-radius:100px; padding:4px 12px; font-size:0.75rem;
      cursor:pointer; touch-action:manipulation; font-family:var(--font-ui); }
    .pm-m-pill-btn:active { background:var(--border-hi); }
    .pm-m-pill-danger { border-color:var(--accent-err); color:var(--accent-err); }
    .pm-m-btn-ghost { background:transparent; border:1px solid var(--border-hi);
      color:var(--text-muted); border-radius:6px; padding:8px 16px; font-size:0.8rem;
      cursor:pointer; font-family:var(--font-ui); touch-action:manipulation; }
    .pm-m-btn-ghost:active { background:var(--bg-hover); }
    .pm-m-btn-primary { background:var(--accent-peach); border:none; color:#181820;
      border-radius:6px; padding:8px 20px; font-size:0.85rem; font-weight:700;
      cursor:pointer; font-family:var(--font-ui); touch-action:manipulation; }
    .pm-m-btn-primary:active { background:#ffaa88; }

    /* Dialogs */
    .pm-m-dlg-label { display:flex; flex-direction:column; gap:4px;
      font-size:0.8rem; color:var(--text-muted); }
    .pm-m-input { background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:6px; padding:8px 10px; font-size:0.85rem;
      font-family:var(--font-mono); outline:none; }
    .pm-m-input:focus { border-color:var(--accent-purple); }
    .pm-m-proj-row { padding:10px 12px; border-radius:6px; cursor:pointer;
      touch-action:manipulation; }
    .pm-m-proj-row:hover, .pm-m-proj-row:focus { background:var(--bg-hover); outline:none; }
    .pm-m-proj-name { display:block; font-size:0.85rem; }
    .pm-m-proj-date { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-dim); }

    /* Menu sheet */
    .pm-m-sheet { position:fixed; inset:0; z-index:999; display:flex;
      flex-direction:column; justify-content:flex-end; }
    .pm-m-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.6); }
    .pm-m-sheet-panel { position:relative; background:var(--bg-surface);
      border-radius:16px 16px 0 0; padding:8px 0 max(8px, env(safe-area-inset-bottom));
      display:flex; flex-direction:column; }
    .pm-m-sheet-item { background:transparent; border:none; color:var(--text-primary);
      padding:16px 20px; font-size:0.9rem; font-family:var(--font-ui); cursor:pointer;
      text-align:left; width:100%; touch-action:manipulation; }
    .pm-m-sheet-item:active { background:var(--bg-hover); }
    .pm-m-sheet-item.disabled { color:var(--text-dim); cursor:default; }
    .pm-m-sheet-cancel { background:transparent; border-top:1px solid var(--border);
      border-bottom:none; border-left:none; border-right:none; color:var(--text-muted);
      padding:14px 20px; font-size:0.85rem; font-family:var(--font-ui); cursor:pointer;
      text-align:center; width:100%; touch-action:manipulation; margin-top:4px; }
    .pm-m-sheet-cancel:active { background:var(--bg-hover); }

    /* Start screen */
    .pm-m-start { position:absolute; inset:0; background:var(--bg-base); z-index:10;
      align-items:center; justify-content:center; }
    .pm-m-start-inner { display:flex; flex-direction:column; align-items:center;
      text-align:center; gap:8px; padding:24px; width:100%; max-width:360px; }
    .pm-m-start-logo { font-size:3rem; line-height:1; }
    .pm-m-start-title { font-family:var(--font-mono); font-size:1.8rem; font-weight:700;
      color:var(--accent-peach); margin:0; }
    .pm-m-start-sub { font-size:0.85rem; color:var(--text-muted); margin:0 0 12px; }
    .pm-m-start-note { font-size:0.72rem; color:var(--text-dim); margin-top:4px; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTimecode(secs, fps = 30) {
  const s  = Math.floor(secs);
  const f  = Math.floor((secs - s) * fps);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}:${pad(f)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatElapsed(secs) {
  if (!isFinite(secs) || secs < 0) return '0s';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtRulerTime(t) {
  const s = Math.floor(t), m = Math.floor(s / 60), sc = s % 60;
  return m > 0 ? `${m}:${pad(sc)}` : `${sc}s`;
}

function rulerStep(pxPerSec) {
  const minStep = 60 / pxPerSec;
  for (const v of [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]) {
    if (v >= minStep) return v;
  }
  return 600;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el  = file.type.startsWith('audio') ? new Audio() : document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration || 0); };
    el.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    el.src = url;
  });
}
