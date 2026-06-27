/**
 * mobile/shell.js — PeachMint mobile UI (Phase 2.0)
 * Swipe-panel layout: Media | Clip Inspector | Color/FX | Export
 */

import { PreviewEngine } from '../../engine/preview-engine.js';
import { AudioEngine }   from '../../engine/audio-engine.js';
import { addTrack, addClip, removeClip, totalDuration } from '../../engine/edl.js';

export function mountMobileShell(container, { projectManager, historyManager, storage }) {
  const shell = new MobileShell(container, { pm: projectManager, history: historyManager, storage });
  shell.mount();
  return shell;
}

const RULER_LEFT  = 58;
const PANEL_COUNT = 4;

class MobileShell {
  constructor(container, { pm, history, storage }) {
    this._el           = container;
    this._pm           = pm;
    this._history      = history;
    this._storage      = storage;
    this._previewEngine = null;
    this._audioEngine  = null;
    this._currentTime  = 0;
    this._isPlaying    = false;
    this._selectedClip = null;
    this._currentPanel = 0;
    this._pxPerSec     = 60;
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

    // AudioContext is created lazily on first play() to satisfy browser autoplay policy.
    this._audioEngine = new AudioEngine({ storage: this._storage });

    this._bindTransport();
    this._bindTimeline();
    this._bindPanelSwipe();
    this._bindPanelNav();
    this._bindProjectEvents();
    this._bindKeyboard();
    this._bindResize();

    this._el.querySelector('#pm-m-menu-btn')?.addEventListener('click', () => this._showMenu());

    if (this._pm.project) {
      this._onProjectOpened(this._pm.project);
    } else {
      this._showStartScreen();
    }
  }

  // ─── Project ───────────────────────────────────────────────────────────────

  _bindProjectEvents() {
    this._pm.addEventListener('project:opened',    (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:recovered', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:closed',    () => this._onProjectClosed());
    this._pm.addEventListener('project:saved',     () => this._setSaveStatus('Saved'));
    this._pm.addEventListener('project:autosaved', () => this._setSaveStatus('Auto-saved'));
    this._pm.addEventListener('project:dirty', () => {
      this._setSaveStatus('*');
      this._renderTimeline();
    });
  }

  _onProjectOpened(project) {
    this._history.clear();
    this._hideStartScreen();
    this._currentTime  = 0;
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
    this._previewEngine?.seekTo(0);
    this._renderTimeline();
    this._goToPanel(0);
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
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  _bindTransport() {
    this._el.querySelector('#pm-m-play')?.addEventListener('click',   () => this._togglePlay());
    this._el.querySelector('#pm-m-rewind')?.addEventListener('click', () => { this._stop(); this._seek(0); });
    this._el.querySelector('#pm-m-fwd')?.addEventListener('click',    () => {
      const t = this._pm.project ? Math.max(totalDuration(this._pm.project), 10) : 0;
      this._stop(); this._seek(t);
    });
    this._el.querySelector('#pm-m-undo')?.addEventListener('click', () => {
      this._history.undo(); this._renderTimeline(); this._renderActivePanel();
    });
    this._el.querySelector('#pm-m-redo')?.addEventListener('click', () => {
      this._history.redo(); this._renderTimeline(); this._renderActivePanel();
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

  // ─── Timeline ─────────────────────────────────────────────────────────────

  _bindTimeline() {
    const tl = this._el.querySelector('#pm-m-tl-scroll');
    if (!tl) return;

    let txStart = 0, tyStart = 0, scrollStart = 0, moved = false;
    tl.addEventListener('touchstart', (e) => {
      txStart = e.touches[0].clientX; tyStart = e.touches[0].clientY;
      scrollStart = tl.scrollLeft; moved = false;
    }, { passive: true });
    tl.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - txStart;
      const dy = e.touches[0].clientY - tyStart;
      if (!moved && Math.abs(dy) > Math.abs(dx)) return;
      tl.scrollLeft = scrollStart - dx; moved = true;
    }, { passive: true });
    tl.addEventListener('touchend', (e) => {
      if (moved) return;
      const rect  = tl.getBoundingClientRect();
      const touch = e.changedTouches[0];
      const hit   = document.elementFromPoint(touch.clientX, touch.clientY);
      if (hit?.classList.contains('pm-m-clip')) { this._selectClipById(hit.dataset.id); return; }
      const rawX = touch.clientX - rect.left + tl.scrollLeft - RULER_LEFT;
      if (rawX >= 0) this._seek(Math.max(0, rawX / this._pxPerSec));
    });
    tl.addEventListener('click', (e) => {
      if (e.target.classList.contains('pm-m-clip')) { this._selectClipById(e.target.dataset.id); return; }
      const rect = tl.getBoundingClientRect();
      const rawX = e.clientX - rect.left + tl.scrollLeft - RULER_LEFT;
      if (rawX >= 0) this._seek(Math.max(0, rawX / this._pxPerSec));
    });

    this._el.querySelector('#pm-m-zoom-in')?.addEventListener('click', () => {
      this._pxPerSec = Math.min(this._pxPerSec * 1.5, 480); this._renderTimeline();
    });
    this._el.querySelector('#pm-m-zoom-out')?.addEventListener('click', () => {
      this._pxPerSec = Math.max(this._pxPerSec / 1.5, 10); this._renderTimeline();
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
    if (this._currentPanel === 0) this._goToPanel(1);
    else this._renderActivePanel();
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
    const dur    = Math.max(totalDuration(project), 30);
    const totalW = Math.ceil(dur * this._pxPerSec) + 120;
    const step   = rulerStep(this._pxPerSec);
    let html = `<div class="pm-m-ruler" style="width:${totalW}px">`;
    for (let t = 0; t <= dur + step; t += step) {
      const x = RULER_LEFT + t * this._pxPerSec;
      html += `<span class="pm-m-ruler-tick" style="left:${x}px">${fmtRulerTime(t)}</span>`;
    }
    html += `</div>`;
    for (const track of project.tracks) {
      const color = track.type === 'audio' ? 'var(--accent-blue)' : 'var(--accent-peach)';
      html += `<div class="pm-m-tl-row" style="width:${totalW}px">
        <span class="pm-m-tl-label">${escHtml((track.name ?? track.type).slice(0, 8))}</span>`;
      for (const clip of track.clips) {
        const x   = RULER_LEFT + clip.startTime * this._pxPerSec;
        const w   = Math.max(4, clip.duration * this._pxPerSec);
        const sel = this._selectedClip?.id === clip.id;
        const lbl = w > 40 ? escHtml((clip.name ?? 'Clip').slice(0, 12)) : '';
        html += `<div class="pm-m-clip${sel ? ' selected' : ''}" data-id="${escHtml(clip.id)}"
          style="left:${x}px;width:${w}px;background:${color}">${lbl}</div>`;
      }
      html += `</div>`;
    }
    container.innerHTML = html;
    this._updatePlayhead(this._currentTime);
  }

  // ─── Panel swipe ──────────────────────────────────────────────────────────

  _bindPanelSwipe() {
    const track = this._el.querySelector('#pm-m-panels-track');
    if (!track) return;
    let startX, startY, dir = null, dragging = false;

    track.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      dir = null; dragging = false;
      track.style.transition = 'none';
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (dir === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      }
      if (dir === 'h') {
        e.preventDefault();
        dragging = true;
        const W    = track.parentElement.clientWidth || window.innerWidth;
        const base = -(this._currentPanel * W);
        const min  = -(PANEL_COUNT - 1) * W;
        track.style.transform = `translateX(${Math.max(min, Math.min(0, base + dx))}px)`;
      }
    }, { passive: false });

    track.addEventListener('touchend', (e) => {
      if (dir !== 'h' || !dragging) return;
      const dx = e.changedTouches[0].clientX - startX;
      let next = this._currentPanel;
      if (dx < -40 && next < PANEL_COUNT - 1) next++;
      else if (dx > 40 && next > 0) next--;
      this._goToPanel(next);
    }, { passive: true });
  }

  _bindPanelNav() {
    this._el.querySelectorAll('.pm-m-panel-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._goToPanel(parseInt(btn.dataset.panel, 10)));
    });
  }

  _bindResize() {
    window.addEventListener('resize', () => {
      const track = this._el.querySelector('#pm-m-panels-track');
      if (!track) return;
      const W = track.parentElement.clientWidth || window.innerWidth;
      track.style.transition = 'none';
      track.style.transform  = `translateX(${-(this._currentPanel * W)}px)`;
    });
  }

  _goToPanel(idx) {
    this._currentPanel = idx;
    const track = this._el.querySelector('#pm-m-panels-track');
    if (track) {
      const W = track.parentElement.clientWidth || window.innerWidth;
      track.style.transition = 'transform 0.22s ease';
      track.style.transform  = `translateX(${-(idx * W)}px)`;
    }
    this._el.querySelectorAll('.pm-m-panel-nav-btn').forEach((btn) => {
      const active = parseInt(btn.dataset.panel, 10) === idx;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this._renderPanel(idx);
  }

  _renderActivePanel() { this._renderPanel(this._currentPanel); }

  _renderPanel(idx) {
    const slide = this._el.querySelector(`#pm-m-panel-${idx}`);
    if (!slide) return;
    switch (idx) {
      case 0: this._renderMediaPanel(slide);   break;
      case 1: this._renderClipPanel(slide);    break;
      case 2: this._renderColorPanel(slide);   break;
      case 3: this._renderExportPanel(slide);  break;
    }
  }

  // ─── Media panel ──────────────────────────────────────────────────────────

  _renderMediaPanel(panel) {
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
              <span class="pm-m-asset-icon">${a.type === 'audio' ? '🎵' : a.type === 'image' ? '🖼' : '🎬'}</span>
              <div class="pm-m-asset-info">
                <span class="pm-m-asset-name">${escHtml(a.name ?? 'Asset')}</span>
                <span class="pm-m-asset-meta">${escHtml(a.type)}${a.duration ? ' · ' + a.duration.toFixed(1) + 's' : ''}</span>
              </div>
              <button class="pm-m-add-btn" data-id="${escHtml(a.id)}" aria-label="Add to timeline">+</button>
            </div>`).join('')
          : `<div class="pm-m-empty-msg">No media yet. Tap + Import.</div>`}
        </div>
      </div>`;
    panel.querySelector('#pm-m-import')?.addEventListener('click', () => this._importFile());
    panel.querySelectorAll('.pm-m-add-btn').forEach((btn) =>
      btn.addEventListener('click', () => this._addAssetToTimeline(btn.dataset.id)));
  }

  async _importFile() {
    if (!this._pm.project) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'video/*,audio/*,image/*'; input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of Array.from(input.files)) await this._ingestFile(file);
      this._renderPanel(0);
    });
    input.click();
  }

  async _ingestFile(file) {
    const ab  = await file.arrayBuffer();
    const key = await this._storage.writeMedia(file.name, ab);
    const type = file.type.startsWith('audio') ? 'audio'
               : file.type.startsWith('image') ? 'image'
               : 'video';
    let duration = null;
    if (type !== 'image') { try { duration = await probeDuration(file); } catch {} }
    const asset = {
      id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name, type, mimeType: file.type, size: file.size, duration, storageKey: key,
    };
    this._pm.mutate((proj) => proj.assets.push(asset));
  }

  _addAssetToTimeline(assetId) {
    const project = this._pm.project;
    if (!project) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const trackType = asset.type === 'audio' ? 'audio' : 'video';
    let track = project.tracks.find((t) => t.type === trackType && !t.locked);
    if (!track) {
      this._pm.mutate((proj) => addTrack(proj, { type: trackType }));
      track = this._pm.project.tracks.at(-1);
    }
    const cmd = this._history.snapshotCommand('Add clip', (proj) => {
      addClip(proj, track.id, { assetId: asset.id, startTime: totalDuration(project), duration: asset.duration || 5 });
    });
    this._history.execute(cmd);
    this._renderTimeline();
  }

  // ─── Clip inspector panel ────────────────────────────────────────────────

  _renderClipPanel(panel) {
    const clip = this._selectedClip;
    if (!clip) {
      panel.innerHTML = `<div class="pm-m-panel-inner"><div class="pm-m-empty-msg">Tap a clip to inspect it.</div></div>`;
      return;
    }
    const p = clip.properties;
    const tr = p.transform;
    panel.innerHTML = `
      <div class="pm-m-panel-inner">
        <div class="pm-m-panel-header">
          <span>${escHtml((clip.name ?? 'Clip').slice(0, 22))}</span>
          <button class="pm-m-pill-btn pm-m-pill-danger" id="pm-m-del-clip">Delete</button>
        </div>
        <div class="pm-m-section-label">Playback</div>
        ${sliderHTML('Volume',   'volume',             p.volume   ?? 1,   0,    2,    0.01, 'vol')}
        ${sliderHTML('Speed',    'speed',              clip.speed ?? 1,   0.25, 4,    0.05, 'x')}
        <div class="pm-m-section-label">Compositing</div>
        ${sliderHTML('Opacity',  'opacity',            p.opacity  ?? 1,   0,    1,    0.01, 'pct')}
        <div class="pm-m-section-label">Transform</div>
        ${sliderHTML('X',        'transform.x',        tr.x,              -500, 500,  1,    'px')}
        ${sliderHTML('Y',        'transform.y',        tr.y,              -500, 500,  1,    'px')}
        ${sliderHTML('Scale X',  'transform.scaleX',   tr.scaleX,         0.1,  5,    0.01, 'x')}
        ${sliderHTML('Scale Y',  'transform.scaleY',   tr.scaleY,         0.1,  5,    0.01, 'x')}
        ${sliderHTML('Rotation', 'transform.rotation', tr.rotation,       -360, 360,  0.5,  'deg')}
      </div>`;
    this._bindSliders(panel, clip);
    panel.querySelector('#pm-m-del-clip')?.addEventListener('click', () => {
      if (!this._pm.project) return;
      this._history.execute(this._history.snapshotCommand('Delete clip', (proj) => removeClip(proj, clip.id)));
      this._selectedClip = null;
      this._renderTimeline();
      this._renderPanel(this._currentPanel);
    });
  }

  // ─── Color / FX panel ────────────────────────────────────────────────────

  _renderColorPanel(panel) {
    const clip = this._selectedClip;
    if (!clip) {
      panel.innerHTML = `<div class="pm-m-panel-inner"><div class="pm-m-empty-msg">Tap a clip first.</div></div>`;
      return;
    }
    const p      = clip.properties;
    const c      = p.color  ?? {};
    const vfx    = p.vfx    ?? {};
    const chroma = p.chroma ?? {};
    panel.innerHTML = `
      <div class="pm-m-panel-inner">
        <div class="pm-m-panel-header"><span>Color &amp; FX</span></div>
        <div class="pm-m-section-label">Color Grading</div>
        ${sliderHTML('Exposure',    'color.exposure',    c.exposure    ?? 0,  -5,   5,     0.01)}
        ${sliderHTML('Contrast',    'color.contrast',    c.contrast    ?? 0,  -1,   1,     0.01)}
        ${sliderHTML('Saturation',  'color.saturation',  c.saturation  ?? 0,  -1,   1,     0.01)}
        ${sliderHTML('Temperature', 'color.temperature', c.temperature ?? 0,  -1,   1,     0.01)}
        ${sliderHTML('Tint',        'color.tint',        c.tint        ?? 0,  -1,   1,     0.01)}
        <div class="pm-m-section-label">VFX</div>
        ${sliderHTML('Vignette',    'vfx.vignette',   vfx.vignette   ?? 0,  0,    1,     0.01)}
        ${sliderHTML('Grain',       'vfx.grain',      vfx.grain      ?? 0,  0,    1,     0.01)}
        ${sliderHTML('Sharpen',     'vfx.sharpen',    vfx.sharpen    ?? 0,  0,    5,     0.1)}
        ${sliderHTML('Aberration',  'vfx.aberration', vfx.aberration ?? 0,  0,    0.05,  0.001)}
        ${sliderHTML('Pixelate',    'vfx.pixelate',   vfx.pixelate   ?? 0,  0,    1,     0.01)}
        <div class="pm-m-section-label">Chroma Key</div>
        <div class="pm-m-toggle-row">
          <span>Enabled</span>
          <label class="pm-m-toggle">
            <input type="checkbox" id="pm-m-chroma-en" ${chroma.enabled ? 'checked' : ''}>
            <span class="pm-m-toggle-track"></span>
          </label>
        </div>
        <label class="pm-m-prop-row">
          <span>Key Color</span>
          <input type="color" id="pm-m-chroma-col" value="${rgbToHex(chroma.color ?? [0, 1, 0])}" style="flex:0 0 40px;height:28px;border:none;background:none;cursor:pointer">
        </label>
        ${sliderHTML('Threshold',  'chroma.threshold', chroma.threshold ?? 0.35, 0, 1, 0.01)}
        ${sliderHTML('Smoothness', 'chroma.smooth',    chroma.smooth    ?? 0.1,  0, 1, 0.01)}
      </div>`;
    this._bindSliders(panel, clip);
    panel.querySelector('#pm-m-chroma-en')?.addEventListener('change', (e) => {
      const c = this._findClip(clip.id);
      if (!c) return;
      if (!c.properties.chroma) c.properties.chroma = { enabled: false, color: [0, 1, 0], threshold: 0.35, smooth: 0.1 };
      c.properties.chroma.enabled = e.target.checked;
      this._pm.markDirty();
    });
    panel.querySelector('#pm-m-chroma-col')?.addEventListener('input', (e) => {
      const c = this._findClip(clip.id);
      if (!c) return;
      if (!c.properties.chroma) c.properties.chroma = { enabled: true, color: [0, 1, 0], threshold: 0.35, smooth: 0.1 };
      c.properties.chroma.color = hexToRgb(e.target.value);
      this._pm.markDirty();
    });
  }

  // ─── Export panel ────────────────────────────────────────────────────────

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
        <label class="pm-m-sel-row"><span>Resolution</span>
          <select class="pm-m-sel" id="pm-m-ex-res">
            <option value="match">Project — ${w}×${h}</option>
            <option value="1920x1080">1080p</option>
            <option value="1280x720">720p</option>
          </select>
        </label>
        <label class="pm-m-sel-row" style="margin-top:8px"><span>Quality</span>
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
          <div class="pm-m-progress-track"><div id="pm-m-ex-bar" class="pm-m-progress-fill" style="width:0%"></div></div>
          <div id="pm-m-ex-lbl" class="pm-m-ex-label">Preparing…</div>
        </div>
        <div id="pm-m-ex-err" class="pm-m-ex-error" style="display:none"></div>
        <button class="pm-m-big-btn" id="pm-m-ex-start" style="margin-top:12px">Export MP4</button>
      </div>`;
    const startBtn = panel.querySelector('#pm-m-ex-start');
    const progDiv  = panel.querySelector('#pm-m-ex-prog');
    const bar      = panel.querySelector('#pm-m-ex-bar');
    const lbl      = panel.querySelector('#pm-m-ex-lbl');
    const errDiv   = panel.querySelector('#pm-m-ex-err');
    startBtn.addEventListener('click', async () => {
      const resVal = panel.querySelector('#pm-m-ex-res').value;
      const vbr    = parseInt(panel.querySelector('#pm-m-ex-vbr').value, 10);
      const inclAud = panel.querySelector('#pm-m-ex-audio').checked;
      let expW = w, expH = h;
      if (resVal !== 'match') [expW, expH] = resVal.split('x').map(Number);
      startBtn.disabled = true; startBtn.textContent = 'Exporting…';
      progDiv.style.display = 'block'; errDiv.style.display = 'none';
      const t0 = Date.now();
      try {
        const { ExportEngine } = await import('../../engine/export-engine.js');
        const eng = new ExportEngine({ storage: this._storage });
        const buffer = await eng.export(
          project, { width: expW, height: expH, fps: f, videoBitrate: vbr, includeAudio: inclAud },
          (progress) => {
            bar.style.width = `${Math.round(progress * 100)}%`;
            lbl.textContent = `${Math.round(progress * 100)}% — ${formatElapsed((Date.now() - t0) / 1000)}`;
          },
        );
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${(project.name ?? 'export').replace(/[^a-z0-9_-]/gi, '_')}.mp4`;
        a.click(); URL.revokeObjectURL(url);
        startBtn.disabled = false; startBtn.textContent = 'Export MP4'; progDiv.style.display = 'none';
      } catch (err) {
        if (err.message !== 'Export cancelled') { errDiv.textContent = `Export failed: ${err.message}`; errDiv.style.display = 'block'; }
        startBtn.disabled = false; startBtn.textContent = 'Retry Export';
      }
    });
  }

  // ─── Slider binding ───────────────────────────────────────────────────────

  _bindSliders(panel, clip) {
    panel.querySelectorAll('.pm-m-prop-slider').forEach((slider) => {
      const prop  = slider.dataset.prop;
      const fmt   = slider.dataset.fmt ?? '';
      const valEl = slider.nextElementSibling;
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        if (valEl) valEl.textContent = fmtPropVal(v, fmt);
        const c = this._findClip(clip.id);
        if (!c) return;
        if (prop === 'speed') { c.speed = v; }
        else { setPropDeep(c.properties, prop, v); }
        this._pm.markDirty();
      });
    });
  }

  // ─── Clip helpers ─────────────────────────────────────────────────────────

  _findClip(clipId) {
    if (!this._pm.project) return null;
    for (const track of this._pm.project.tracks) {
      const c = track.clips.find((x) => x.id === clipId);
      if (c) return c;
    }
    return null;
  }

  // ─── Menu sheet ───────────────────────────────────────────────────────────

  _showMenu() {
    const hasPrj = !!this._pm.project;
    const items = [
      { label: '+ New Project',  action: () => this._showNewProjectDialog() },
      { label: '📂 Open Project', action: () => this._showOpenProjectDialog() },
      { label: '💾 Save',         action: () => this._pm.saveProject(),      disabled: !hasPrj },
      { label: '⬇ Export MP4',   action: () => this._goToPanel(3),          disabled: !hasPrj },
      { label: '🖥 Desktop UI',   action: () => { localStorage.setItem('peachmint_ui_mode', 'desktop'); location.reload(); } },
      { label: '⚙ System Info',  action: () => window.__peachmint?.showSysCheck() },
    ];
    const sheet = document.createElement('div');
    sheet.className = 'pm-m-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
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
    sheet.querySelectorAll('.pm-m-sheet-item:not(:disabled)').forEach((btn) =>
      btn.addEventListener('click', () => { sheet.remove(); items[parseInt(btn.dataset.idx)]?.action(); }));
    sheet.querySelector('.pm-m-sheet-cancel').addEventListener('click', () => sheet.remove());
    sheet.querySelector('.pm-m-sheet-backdrop').addEventListener('click', () => sheet.remove());
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
      if (ctrl && e.key === 'z') { e.preventDefault(); this._history.undo(); this._renderTimeline(); this._renderActivePanel(); }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this._history.redo(); this._renderTimeline(); this._renderActivePanel(); }
      if (ctrl && e.key === 's') { e.preventDefault(); this._pm.saveProject(); }
    });
  }

  // ─── Start screen ─────────────────────────────────────────────────────────

  _showStartScreen() {
    const s = this._el.querySelector('#pm-m-start');
    if (!s) return;
    s.style.display = 'flex';
    s.querySelector('#pm-m-start-new')?.addEventListener('click',  () => this._showNewProjectDialog());
    s.querySelector('#pm-m-start-open')?.addEventListener('click', () => this._showOpenProjectDialog());
  }

  _hideStartScreen() {
    const s = this._el.querySelector('#pm-m-start');
    if (s) s.style.display = 'none';
  }

  // ─── Dialogs ──────────────────────────────────────────────────────────────

  _showNewProjectDialog() {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <h2 style="margin:0 0 16px;font-size:1rem">New Project</h2>
      <label class="pm-m-dlg-label">Name
        <input id="np-m-name" type="text" value="Untitled Project" class="pm-m-input" style="width:100%">
      </label>
      <label class="pm-m-dlg-label" style="margin-top:10px">Canvas Preset
        <select id="np-m-preset" class="pm-m-input" style="width:100%">
          <option value="1920x1080x30">YouTube 1080p 30fps</option>
          <option value="1080x1920x30">Shorts / TikTok 30fps</option>
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
      if (!list.length) { this._showInfoDialog('No saved projects', 'No projects found. Create a new one first.'); return; }
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-modal', 'true');
      const rows = list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((p) => `
        <div class="pm-m-proj-row" data-id="${escHtml(p.id)}" role="button" tabindex="0">
          <span class="pm-m-proj-name">${escHtml(p.name ?? 'Untitled')}</span>
          <span class="pm-m-proj-date">${formatDate(p.updatedAt ?? p._savedAt)}</span>
        </div>`).join('');
      dialog.innerHTML = `
        <h2 style="margin:0 0 14px;font-size:1rem">Open Project</h2>
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
      dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { dialog.close(); dialog.remove(); } });
    });
  }

  _showInfoDialog(title, msg) {
    const d = document.createElement('dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = `
      <h2 style="margin:0 0 10px;font-size:1rem">${escHtml(title)}</h2>
      <p style="color:var(--text-muted);font-size:0.85rem">${escHtml(msg)}</p>
      <div style="text-align:right;margin-top:16px"><button class="pm-m-btn-primary" autofocus>OK</button></div>`;
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('button').addEventListener('click', () => { d.close(); d.remove(); });
  }

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
          <canvas id="pm-m-canvas" width="1280" height="720" aria-label="Video preview"></canvas>
        </div>
        <div class="pm-m-transport" role="group" aria-label="Playback controls">
          <button id="pm-m-undo"   class="pm-m-tbtn pm-m-tbtn-sm" aria-label="Undo" title="Undo (Ctrl+Z)">↩</button>
          <button id="pm-m-rewind" class="pm-m-tbtn" aria-label="Rewind to start">⏮</button>
          <button id="pm-m-play"   class="pm-m-tbtn pm-m-play-btn" aria-label="Play">▶</button>
          <button id="pm-m-fwd"    class="pm-m-tbtn" aria-label="Go to end">⏭</button>
          <span id="pm-m-timecode" class="pm-m-timecode" aria-live="polite">00:00:00:00</span>
          <button id="pm-m-redo"   class="pm-m-tbtn pm-m-tbtn-sm" aria-label="Redo" title="Redo (Ctrl+Y)">↪</button>
        </div>
      </div>

      <div class="pm-m-timeline-area">
        <div class="pm-m-tl-toolbar">
          <button id="pm-m-zoom-out" class="pm-m-tl-zoom-btn" aria-label="Zoom out">−</button>
          <button id="pm-m-zoom-in"  class="pm-m-tl-zoom-btn" aria-label="Zoom in">+</button>
          <span class="pm-m-tl-hint">Timeline</span>
        </div>
        <div id="pm-m-tl-scroll" class="pm-m-tl-scroll">
          <div id="pm-m-tl-inner" class="pm-m-tl-inner"></div>
          <div id="pm-m-playhead" class="pm-m-playhead"></div>
        </div>
      </div>

      <nav class="pm-m-panel-nav" role="tablist" aria-label="Editor panels">
        <button class="pm-m-panel-nav-btn active" data-panel="0" role="tab" aria-selected="true">
          <span class="pm-m-nav-icon">📂</span><span class="pm-m-nav-label">Media</span>
        </button>
        <button class="pm-m-panel-nav-btn" data-panel="1" role="tab" aria-selected="false">
          <span class="pm-m-nav-icon">✂</span><span class="pm-m-nav-label">Clip</span>
        </button>
        <button class="pm-m-panel-nav-btn" data-panel="2" role="tab" aria-selected="false">
          <span class="pm-m-nav-icon">🎨</span><span class="pm-m-nav-label">Color</span>
        </button>
        <button class="pm-m-panel-nav-btn" data-panel="3" role="tab" aria-selected="false">
          <span class="pm-m-nav-icon">⬇</span><span class="pm-m-nav-label">Export</span>
        </button>
      </nav>

      <div class="pm-m-panels-wrap">
        <div id="pm-m-panels-track" class="pm-m-panels-track">
          <div class="pm-m-panel-slide" id="pm-m-panel-0"></div>
          <div class="pm-m-panel-slide" id="pm-m-panel-1"></div>
          <div class="pm-m-panel-slide" id="pm-m-panel-2"></div>
          <div class="pm-m-panel-slide" id="pm-m-panel-3"></div>
        </div>
      </div>

      <div id="pm-m-start" class="pm-m-start" style="display:flex">
        <div class="pm-m-start-inner">
          <div style="font-size:3rem;line-height:1" aria-hidden="true">🍑🌿</div>
          <h1 class="pm-m-start-title">PeachMint</h1>
          <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 12px">Browser Video Editor</p>
          <button id="pm-m-start-new"  class="pm-m-big-btn">+ New Project</button>
          <button id="pm-m-start-open" class="pm-m-btn-ghost" style="margin-top:8px">Open Recent</button>
          <p style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">All media stays on your device. No uploads.</p>
          <button onclick="localStorage.setItem('peachmint_ui_mode','desktop');location.reload()"
            style="margin-top:16px;background:transparent;border:none;color:var(--text-muted);
                   font-size:0.75rem;cursor:pointer;font-family:var(--font-ui)">Switch to Desktop UI →</button>
        </div>
      </div>
    </div>`;
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
    #pm-m-canvas { display:block; width:100%; height:100%; max-height:35vh; object-fit:contain; }

    /* Transport */
    .pm-m-transport { display:flex; align-items:center; gap:6px; padding:4px 10px;
      background:var(--bg-panel); border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-m-tbtn { width:38px; height:38px; border:1px solid var(--border);
      background:var(--bg-surface); color:var(--text-primary); border-radius:50%;
      font-size:0.8rem; cursor:pointer; touch-action:manipulation;
      display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .pm-m-tbtn:active { background:var(--bg-hover); }
    .pm-m-tbtn-sm { width:30px; height:30px; font-size:0.75rem; }
    .pm-m-play-btn { width:44px; height:44px; font-size:0.9rem; font-weight:bold;
      background:var(--accent-peach) !important; border-color:var(--accent-peach) !important;
      color:#181820 !important; }
    .pm-m-timecode { font-family:var(--font-mono); font-size:0.78rem; color:var(--accent-blue);
      flex:1; text-align:center; }

    /* Timeline */
    .pm-m-timeline-area { height:118px; flex-shrink:0; background:var(--bg-panel);
      border-bottom:1px solid var(--border); overflow:hidden; display:flex;
      flex-direction:column; }
    .pm-m-tl-toolbar { height:22px; display:flex; align-items:center; padding:0 6px; gap:4px;
      background:var(--bg-base); border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-m-tl-zoom-btn { width:22px; height:18px; background:var(--bg-surface);
      border:1px solid var(--border); color:var(--text-muted); border-radius:3px;
      font-size:0.85rem; cursor:pointer; touch-action:manipulation;
      display:flex; align-items:center; justify-content:center; }
    .pm-m-tl-hint { font-size:0.6rem; color:var(--text-dim); margin-left:4px; }
    .pm-m-tl-scroll { flex:1; overflow-x:auto; overflow-y:hidden; position:relative;
      -webkit-overflow-scrolling:touch; scrollbar-width:thin; }
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
      white-space:nowrap; overflow:hidden; }
    .pm-m-clip { position:absolute; top:4px; height:32px; border-radius:4px;
      font-size:0.62rem; color:#181820; display:flex; align-items:center; padding:0 4px;
      overflow:hidden; cursor:pointer; white-space:nowrap; text-overflow:ellipsis;
      box-sizing:border-box; user-select:none; -webkit-user-select:none; touch-action:manipulation; }
    .pm-m-clip.selected { outline:2px solid #fff; outline-offset:1px; }
    .pm-m-playhead { position:absolute; top:0; bottom:0; width:2px;
      background:var(--accent-peach); pointer-events:none; z-index:5; transform:translateX(-1px); }
    .pm-m-tl-empty { position:absolute; inset:0; display:flex; align-items:center;
      justify-content:center; color:var(--text-dim); font-size:0.78rem;
      padding:0 ${RULER_LEFT + 12}px; text-align:center; }

    /* Panel nav */
    .pm-m-panel-nav { display:flex; background:var(--bg-panel);
      border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-m-panel-nav-btn { flex:1; height:44px; border:none; background:transparent;
      color:var(--text-muted); cursor:pointer; touch-action:manipulation; font-family:var(--font-ui);
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
      border-bottom:2px solid transparent; transition:color .12s, border-color .12s; }
    .pm-m-panel-nav-btn.active { color:var(--accent-peach); border-bottom-color:var(--accent-peach); }
    .pm-m-panel-nav-btn:active { background:var(--bg-hover); }
    .pm-m-nav-icon { font-size:0.9rem; line-height:1; }
    .pm-m-nav-label { font-size:0.62rem; }

    /* Swipe panels */
    .pm-m-panels-wrap { flex:1; overflow:hidden; position:relative; min-height:0; }
    .pm-m-panels-track { display:flex; height:100%; will-change:transform; }
    .pm-m-panel-slide { min-width:100%; height:100%; overflow-y:auto; overflow-x:hidden;
      background:var(--bg-panel); flex-shrink:0; }

    /* Panel content */
    .pm-m-panel-inner { display:flex; flex-direction:column; gap:8px; padding:10px 12px 20px; }
    .pm-m-panel-header { display:flex; align-items:center; justify-content:space-between;
      padding-bottom:8px; border-bottom:1px solid var(--border); }
    .pm-m-panel-header > span { font-size:0.8rem; font-weight:600; color:var(--text-muted); }
    .pm-m-section-label { font-size:0.64rem; font-weight:700; color:var(--text-dim);
      letter-spacing:0.06em; text-transform:uppercase; padding-top:6px;
      border-top:1px solid var(--border); margin-top:2px; }
    .pm-m-empty-msg { color:var(--text-dim); font-size:0.8rem; text-align:center;
      padding:24px 12px; display:flex; align-items:center; justify-content:center; }

    /* Props / sliders */
    .pm-m-prop-row { display:flex; align-items:center; gap:8px; font-size:0.78rem;
      color:var(--text-primary); padding:2px 0; }
    .pm-m-prop-row > span:first-child { min-width:72px; color:var(--text-muted); font-size:0.74rem; flex-shrink:0; }
    .pm-m-prop-slider { flex:1; accent-color:var(--accent-peach); touch-action:pan-x; min-width:0; }
    .pm-m-prop-val { font-family:var(--font-mono); font-size:0.68rem; min-width:44px;
      text-align:right; color:var(--text-muted); flex-shrink:0; }

    /* Toggle (chroma enabled etc.) */
    .pm-m-toggle-row { display:flex; align-items:center; justify-content:space-between;
      font-size:0.78rem; color:var(--text-primary); padding:4px 0; }
    .pm-m-toggle { position:relative; display:inline-block; width:36px; height:20px; flex-shrink:0; }
    .pm-m-toggle input { opacity:0; width:0; height:0; }
    .pm-m-toggle-track { position:absolute; cursor:pointer; inset:0; background:var(--border);
      border-radius:20px; transition:background .2s; }
    .pm-m-toggle-track::before { content:''; position:absolute; left:3px; top:3px;
      width:14px; height:14px; border-radius:50%; background:#fff; transition:transform .2s; }
    .pm-m-toggle input:checked + .pm-m-toggle-track { background:var(--accent-peach); }
    .pm-m-toggle input:checked + .pm-m-toggle-track::before { transform:translateX(16px); }

    /* Library panel */
    .pm-m-asset-list { display:flex; flex-direction:column; gap:2px; }
    .pm-m-asset-row { display:flex; align-items:center; gap:10px; padding:7px 4px;
      border-bottom:1px solid var(--border); }
    .pm-m-asset-row:last-child { border-bottom:none; }
    .pm-m-asset-icon { font-size:1.2rem; flex-shrink:0; }
    .pm-m-asset-info { flex:1; min-width:0; }
    .pm-m-asset-name { display:block; font-size:0.8rem; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .pm-m-asset-meta { font-size:0.68rem; color:var(--text-dim); font-family:var(--font-mono); }
    .pm-m-add-btn { width:30px; height:30px; border:1px solid var(--accent-peach);
      background:transparent; color:var(--accent-peach); border-radius:6px; font-size:1rem;
      cursor:pointer; touch-action:manipulation; flex-shrink:0;
      display:flex; align-items:center; justify-content:center; }
    .pm-m-add-btn:active { background:var(--accent-peach); color:#181820; }

    /* Export panel */
    .pm-m-sel-row { display:flex; align-items:center; gap:10px; font-size:0.8rem; }
    .pm-m-sel-row > span { min-width:68px; color:var(--text-muted); font-size:0.78rem; }
    .pm-m-sel { flex:1; background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:6px; padding:6px 8px; font-size:0.8rem;
      font-family:var(--font-ui); }
    .pm-m-check-row { display:flex; align-items:center; gap:8px; font-size:0.8rem; color:var(--text-muted); }
    .pm-m-progress-track { height:5px; background:var(--bg-base); border-radius:3px; overflow:hidden; }
    .pm-m-progress-fill { height:100%; background:var(--accent-peach); transition:width .15s; }
    .pm-m-ex-label { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-muted); margin-top:4px; }
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
    .pm-m-dlg-label { display:flex; flex-direction:column; gap:4px; font-size:0.8rem; color:var(--text-muted); }
    .pm-m-input { background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:6px; padding:8px 10px; font-size:0.85rem;
      font-family:var(--font-mono); outline:none; }
    .pm-m-input:focus { border-color:var(--accent-purple); }
    .pm-m-proj-row { padding:10px 12px; border-radius:6px; cursor:pointer; touch-action:manipulation; }
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
    .pm-m-start-title { font-family:var(--font-mono); font-size:1.8rem; font-weight:700;
      color:var(--accent-peach); margin:0; }
  `;
  document.head.appendChild(s);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sliderHTML(label, prop, value, min, max, step, fmt = '') {
  const display = fmtPropVal(value ?? 0, fmt);
  return `<label class="pm-m-prop-row">
    <span>${escHtml(label)}</span>
    <input type="range" class="pm-m-prop-slider"
      data-prop="${escHtml(prop)}" data-fmt="${escHtml(fmt)}"
      min="${min}" max="${max}" step="${step}" value="${value ?? 0}">
    <span class="pm-m-prop-val">${escHtml(display)}</span>
  </label>`;
}

function fmtPropVal(val, fmt) {
  switch (fmt) {
    case 'deg': return `${Math.round(val)}°`;
    case 'x':   return `${val.toFixed(2)}×`;
    case 'pct': return `${Math.round(val * 100)}%`;
    case 'px':  return `${Math.round(val)}px`;
    case 'vol': return val.toFixed(2);
    default:    return parseFloat(val.toFixed(3)).toString();
  }
}

function setPropDeep(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function formatTimecode(secs, fps = 30) {
  const s = Math.floor(secs), f = Math.floor((secs - s) * fps);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}:${pad(f)}`;
}

function formatElapsed(secs) {
  if (!isFinite(secs) || secs < 0) return '0s';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function pad(n) { return String(n).padStart(2, '0'); }

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
  for (const v of [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]) { if (v >= minStep) return v; }
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
