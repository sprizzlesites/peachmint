/**
 * timeline.js — Multitrack timeline component
 *
 * Renders the EDL as a visual timeline:
 *   - Time ruler (canvas) + playhead
 *   - Track headers: name, type, mute/solo/lock, z-order arrows
 *   - Clip blocks: positioned absolutely by startTime/duration
 *   - Zoom (wheel + buttons), horizontal scroll with ruler sync
 *   - Clip drag (horizontal move), playhead scrub (click/drag on ruler)
 *   - Track add/remove/reorder via HistoryManager commands
 *
 * No DOM outside this component. No engine imports below engine/.
 */

import {
  addTrack, removeTrack, addClip, removeClip,
  createTrack, totalDuration, splitClip, createMarker, removeMarker,
} from '../../engine/edl.js';

// ─── Layout constants ─────────────────────────────────────────────────────────

const HEADER_W = 180;        // px — width of track header column
const RULER_H  = 28;         // px — height of time ruler
const VIDEO_TRACK_H   = 72;  // px — height of video track lanes
const AUDIO_TRACK_H   = 56;  // px — height of audio track lanes
const OVERLAY_TRACK_H = 56;  // px — height of overlay track lanes (same as before)
const ADD_BTN_H = 36;        // px — height of "add track" row
const MIN_PX_PER_SEC = 5;
const MAX_PX_PER_SEC = 2000;
const DEFAULT_PX_PER_SEC = 80;
const SNAP_THRESHOLD_PX = 6; // snap-to clip edge threshold in pixels

// ─── Track colors ─────────────────────────────────────────────────────────────

const TRACK_COLORS = {
  video:   { bg: '#ff8c69', hi: '#ffaa88', text: '#1a1a1a', lane: '#1e1414' },
  audio:   { bg: '#50fa7b', hi: '#78fca0', text: '#0f1a13', lane: '#131e16' },
  overlay: { bg: '#bd93f9', hi: '#d0b4ff', text: '#1a1320', lane: '#16121e' },
};

// ─── Timeline ─────────────────────────────────────────────────────────────────

export class Timeline {
  constructor(container, { pm, history, onSeek, onClipSelect, onTrackSelect }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._onSeek = onSeek ?? (() => {});
    this._onClipSelect = onClipSelect ?? (() => {});
    this._onTrackSelect = onTrackSelect ?? (() => {});

    this._project = null;
    this._pxPerSec = DEFAULT_PX_PER_SEC;
    this._currentTime = 0;
    this._selectedClipId = null;
    this._tool = 'pointer'; // 'pointer' | 'razor' | 'hand'

    // Drag state
    this._drag = null;   // { type:'playhead'|'clip'|'trim', ... }
    this._scrollLeft = 0;
    this._laneYMap = []; // [{ trackId, top, bottom }] built by _renderLanes

    // DOM refs (set in mount)
    this._rulerCanvas = null;
    this._rulerCtx = null;
    this._lanesInner = null;
    this._lanesScroll = null;
    this._headersEl = null;
    this._playheadEl = null;
    this._playheadRulerEl = null;

    this._mounted = false;
    this._selectedClipIds = new Set();
    this._waveformCache   = null;
    this._snapEnabled     = true;
    this._audioEngine     = null;
    this._vuRafId         = null;
    this._vuBuf           = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setProject(project) {
    this._project = project;
    if (!this._mounted) this._mount();
    this._render();
    if (project) this._startVuLoop();
    else this._stopVuLoop();
  }

  seekTo(time) {
    this._currentTime = Math.max(0, time);
    this._updatePlayhead();
  }

  setTool(tool) {
    this._tool = tool;
    if (this._lanesInner) {
      this._lanesInner.dataset.tool = tool;
    }
  }

  zoomIn()  { this._setZoom(this._pxPerSec * 1.5); }
  zoomOut() { this._setZoom(this._pxPerSec / 1.5); }

  setWaveformCache(cache) { this._waveformCache = cache; }
  setAudioEngine(engine)  { this._audioEngine = engine; }

  /** Set in-point to `time` seconds. Creates an undoable history command. */
  setInPoint(time) {
    if (!this._project) return;
    const old = this._project.inPoint;
    this._history.execute({
      label: 'Set in-point',
      execute: () => { this._project.inPoint = time; this._pm.markDirty(); this._drawRuler(); },
      undo:    () => { this._project.inPoint = old;  this._pm.markDirty(); this._drawRuler(); },
    });
  }

  /** Set out-point to `time` seconds. Creates an undoable history command. */
  setOutPoint(time) {
    if (!this._project) return;
    const old = this._project.outPoint;
    this._history.execute({
      label: 'Set out-point',
      execute: () => { this._project.outPoint = time; this._pm.markDirty(); this._drawRuler(); },
      undo:    () => { this._project.outPoint = old;  this._pm.markDirty(); this._drawRuler(); },
    });
  }

  /** Remove both in-point and out-point. Creates an undoable history command. */
  clearInOut() {
    if (!this._project) return;
    const oldIn = this._project.inPoint, oldOut = this._project.outPoint;
    this._history.execute({
      label: 'Clear in/out points',
      execute: () => { this._project.inPoint = null; this._project.outPoint = null; this._pm.markDirty(); this._drawRuler(); },
      undo:    () => { this._project.inPoint = oldIn; this._project.outPoint = oldOut; this._pm.markDirty(); this._drawRuler(); },
    });
  }

  /** Redraw the ruler (call after external changes to project in/out points). */
  refreshRuler() { this._drawRuler(); }

  /** Add a marker at `time` seconds. Called by shell on M key. */
  addMarker(time) {
    if (!this._project) return;
    if (!this._project.markers) this._project.markers = [];
    const marker = createMarker({ time });
    this._project.markers.push(marker);
    this._project.markers.sort((a, b) => a.time - b.time);
    this._pm.markDirty();
    this._drawRuler();
    this._renderMarkerLines();
    // Open rename input immediately
    this._showMarkerRenameInput(marker);
  }

  // Align each Ctrl-selected clip so its loudest audio peak lands at the
  // same absolute project time as the first selected clip's peak.
  syncSelectedClips() {
    if (!this._project || !this._waveformCache || this._selectedClipIds.size < 2) return false;
    const entries = [];
    for (const clipId of this._selectedClipIds) {
      const clip = this._findClip(clipId);
      if (!clip?.assetId) continue;
      const asset = this._project.assets.find((a) => a.id === clip.assetId);
      if (!asset?.storageKey || !asset.duration) continue;
      if (asset.type !== 'video' && asset.type !== 'audio') continue;
      const ft = this._waveformCache.peakFileTime(asset.storageKey, asset.duration);
      if (ft === null) continue;
      const localT = Math.max(0, Math.min(clip.duration,
        (ft - (clip.trimIn ?? 0)) / (clip.speed ?? 1)));
      entries.push({ clip, localT, oldStart: clip.startTime });
    }
    if (entries.length < 2) return false;
    const anchorAbsT = entries[0].clip.startTime + entries[0].localT;
    const moves = entries.slice(1)
      .map((e) => ({ clip: e.clip, oldStart: e.oldStart, newStart: Math.max(0, anchorAbsT - e.localT) }))
      .filter((m) => Math.abs(m.newStart - m.oldStart) > 0.001);
    if (!moves.length) return false;
    this._history.execute({
      label:   'Sync clips by audio peak',
      execute: () => { moves.forEach((m) => { m.clip.startTime = m.newStart; }); this._pm.markDirty(); this._render(); },
      undo:    () => { moves.forEach((m) => { m.clip.startTime = m.oldStart;  }); this._pm.markDirty(); this._render(); },
    });
    return true;
  }

  // ─── VU metering ────────────────────────────────────────────────────────────

  _startVuLoop() {
    if (this._vuRafId) return;
    const tick = () => {
      this._paintVuMeters();
      this._vuRafId = requestAnimationFrame(tick);
    };
    this._vuRafId = requestAnimationFrame(tick);
  }

  _stopVuLoop() {
    if (this._vuRafId) { cancelAnimationFrame(this._vuRafId); this._vuRafId = null; }
  }

  _paintVuMeters() {
    if (!this._audioEngine || !this._headersEl) return;
    const canvases = this._headersEl.querySelectorAll('.pm-tl-vu-meter');
    if (!canvases.length) return;
    if (!this._vuBuf) this._vuBuf = new Float32Array(256);
    const buf = this._vuBuf;
    for (const canvas of canvases) {
      const analyser = this._audioEngine.getTrackAnalyser?.(canvas.dataset.trackId);
      const ctx2d = canvas.getContext('2d');
      const cw = canvas.width, ch = canvas.height;
      ctx2d.clearRect(0, 0, cw, ch);
      if (!analyser) continue;
      analyser.getFloatTimeDomainData(buf);
      let rms = 0;
      for (const v of buf) rms += v * v;
      rms = Math.sqrt(rms / buf.length);
      if (rms < 0.001) continue;
      const level = Math.min(1, rms * 3);
      const fillW = Math.round(level * cw);
      const grad = ctx2d.createLinearGradient(0, 0, cw, 0);
      grad.addColorStop(0, '#50fa7b');
      grad.addColorStop(0.65, '#f1fa8c');
      grad.addColorStop(1,   '#ff5555');
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(0, 0, fillW, ch);
      ctx2d.fillStyle = 'rgba(255,255,255,0.04)';
      ctx2d.fillRect(fillW, 0, cw - fillW, ch);
    }
  }

  // ─── Mount ──────────────────────────────────────────────────────────────────

  _mount() {
    if (this._mounted) return;
    injectStyles();

    this._el.innerHTML = `
      <div class="pm-tl-root">
        <!-- Header row: corner + ruler -->
        <div class="pm-tl-header-row">
          <div class="pm-tl-corner">
            <button class="pm-tl-zoom-btn" id="pm-tl-zi" title="Zoom in (+)">+</button>
            <span class="pm-tl-zoom-val" id="pm-tl-zv">100%</span>
            <button class="pm-tl-zoom-btn" id="pm-tl-zo" title="Zoom out (-)">−</button>
            <button class="pm-tl-snap-toggle active" id="pm-tl-snap-toggle"
                    title="Toggle magnetic snap — hold Alt to disable temporarily">Snap</button>
            <button class="pm-tl-sync-btn" id="pm-tl-sync" style="display:none" disabled
                    title="Sync selected clips by audio peak — Ctrl+Shift+S">Sync</button>
          </div>
          <div class="pm-tl-ruler-scroll" id="pm-tl-ruler-scroll">
            <canvas class="pm-tl-ruler" id="pm-tl-ruler" height="${RULER_H}"></canvas>
            <div class="pm-tl-ph-head" id="pm-tl-ph-head" aria-hidden="true"></div>
          </div>
        </div>
        <!-- Body row: track headers + lanes -->
        <div class="pm-tl-body-row">
          <div class="pm-tl-headers" id="pm-tl-headers">
            <!-- track header divs -->
            <div class="pm-tl-add-track-wrap" id="pm-tl-add-wrap">
              <button class="pm-tl-add-btn" id="pm-tl-add-video" title="Add video track">+ Video</button>
              <button class="pm-tl-add-btn" id="pm-tl-add-audio" title="Add audio track">+ Audio</button>
              <button class="pm-tl-add-btn" id="pm-tl-add-overlay" title="Add overlay track">+ Overlay</button>
            </div>
          </div>
          <div class="pm-tl-lanes-scroll" id="pm-tl-lanes-scroll">
            <div class="pm-tl-lanes-inner" id="pm-tl-lanes-inner" data-tool="pointer">
              <!-- lane divs + playhead line + snap indicator -->
              <div class="pm-tl-playhead" id="pm-tl-playhead" aria-hidden="true"></div>
              <div class="pm-tl-snap-line" id="pm-tl-snap-line" aria-hidden="true"></div>
            </div>
          </div>
        </div>
        <!-- Empty state -->
        <div class="pm-tl-empty" id="pm-tl-empty" aria-live="polite">
          No tracks — use the buttons above to add a track
        </div>
      </div>
    `;

    // Cache DOM refs
    this._rulerCanvas = this._el.querySelector('#pm-tl-ruler');
    this._rulerCtx = this._rulerCanvas.getContext('2d');
    this._lanesScroll = this._el.querySelector('#pm-tl-lanes-scroll');
    this._lanesInner = this._el.querySelector('#pm-tl-lanes-inner');
    this._headersEl = this._el.querySelector('#pm-tl-headers');
    this._playheadEl = this._el.querySelector('#pm-tl-playhead');
    this._playheadRulerEl = this._el.querySelector('#pm-tl-ph-head');
    const rulerScroll = this._el.querySelector('#pm-tl-ruler-scroll');

    // Scroll sync: lanes → ruler
    this._lanesScroll.addEventListener('scroll', () => {
      this._scrollLeft = this._lanesScroll.scrollLeft;
      rulerScroll.scrollLeft = this._scrollLeft;
      this._updatePlayhead();
      this._drawRuler();
    }, { passive: true });

    // Ruler scroll (don't allow, mirror only)
    rulerScroll.addEventListener('scroll', () => {
      if (rulerScroll.scrollLeft !== this._scrollLeft) {
        rulerScroll.scrollLeft = this._scrollLeft;
      }
    }, { passive: true });

    // Zoom buttons
    this._el.querySelector('#pm-tl-zi').addEventListener('click', () => this.zoomIn());
    this._el.querySelector('#pm-tl-zo').addEventListener('click', () => this.zoomOut());
    this._el.querySelector('#pm-tl-sync').addEventListener('click', () => this.syncSelectedClips());
    this._el.querySelector('#pm-tl-snap-toggle').addEventListener('click', (e) => {
      this._snapEnabled = !this._snapEnabled;
      e.currentTarget.classList.toggle('active', this._snapEnabled);
    });

    // Wheel zoom (Ctrl + wheel)
    this._lanesScroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      // Zoom toward cursor position in time
      const rect = this._lanesScroll.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + this._scrollLeft;
      const cursorTime = cursorX / this._pxPerSec;
      this._setZoom(this._pxPerSec * factor, cursorTime, e.clientX - rect.left);
    }, { passive: false });

    // Add track buttons
    this._el.querySelector('#pm-tl-add-video').addEventListener('click', () => this._cmdAddTrack('video'));
    this._el.querySelector('#pm-tl-add-audio').addEventListener('click', () => this._cmdAddTrack('audio'));
    this._el.querySelector('#pm-tl-add-overlay').addEventListener('click', () => this._cmdAddTrack('overlay'));

    // Ruler click/drag → seek (or marker interaction)
    this._rulerCanvas.addEventListener('pointerdown', (e) => this._onRulerPointerDown(e));
    this._rulerCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const m = this._markerAtRulerX(e);
      if (m) this._cmdDeleteMarker(m.id);
    });
    this._rulerCanvas.addEventListener('dblclick', (e) => {
      const m = this._markerAtRulerX(e);
      if (m) { e.preventDefault(); this._showMarkerRenameInput(m); }
    });

    // Clip + lane interactions (delegated)
    this._lanesInner.addEventListener('pointerdown', (e) => this._onLanesPointerDown(e));

    // Global pointer move/up for dragging
    document.addEventListener('pointermove', (e) => this._onPointerMove(e));
    document.addEventListener('pointerup', (e) => this._onPointerUp(e));

    // Observe container resize → redraw ruler
    new ResizeObserver(() => this._onResize()).observe(this._el);

    this._mounted = true;
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  _render() {
    if (!this._project) return;
    const tracks = this._project.tracks ?? [];

    // Show/hide empty state
    const emptyEl = this._el.querySelector('#pm-tl-empty');
    if (emptyEl) emptyEl.style.display = tracks.length ? 'none' : 'flex';

    // Total timeline width
    const totalSecs = Math.max(totalDuration(this._project), 30);
    const totalW = Math.ceil(totalSecs * this._pxPerSec) + 400; // extra padding

    // Build sorted track list (by zIndex ascending = bottom to top render order)
    const sorted = [...tracks].sort((a, b) => a.zIndex - b.zIndex);

    // Update headers
    this._renderHeaders(sorted);

    // Update lanes
    this._renderLanes(sorted, totalW);

    // Update ruler
    this._onResize();

    // Update playhead
    this._updatePlayhead();
  }

  _renderHeaders(sortedTracks) {
    const addWrap = this._el.querySelector('#pm-tl-add-wrap');
    // Clear previous headers (not the add-wrap)
    Array.from(this._headersEl.children).forEach((el) => {
      if (el.id !== 'pm-tl-add-wrap') el.remove();
    });

    sortedTracks.forEach((track, idx) => {
      const h = trackHeight(track);
      const col = TRACK_COLORS[track.type] ?? TRACK_COLORS.video;
      const hasMixer = track.type === 'audio' || track.type === 'video';
      const div = document.createElement('div');
      div.className = `pm-tl-track-header${hasMixer ? ' pm-tl-track-header--mix' : ''}`;
      div.dataset.trackId = track.id;
      div.style.height = `${h}px`;
      div.style.borderLeftColor = col.bg;

      const controlsHtml = `
        <div class="pm-tl-th-type" style="background:${col.bg};color:${col.text}" aria-hidden="true">
          ${typeIcon(track.type)}
        </div>
        <div class="pm-tl-th-name" contenteditable="true" spellcheck="false"
             aria-label="Track name" title="Double-click to rename">${escHtml(track.name)}</div>
        <div class="pm-tl-th-controls">
          <button class="pm-tl-th-btn ${track.muted ? 'active' : ''}"
                  data-action="mute" title="Mute" aria-label="Mute track"
                  aria-pressed="${track.muted}">${track.muted ? '🔇' : '🔊'}</button>
          <button class="pm-tl-th-btn ${track.solo ? 'active' : ''}"
                  data-action="solo" title="Solo" aria-label="Solo track"
                  aria-pressed="${track.solo}">S</button>
          <button class="pm-tl-th-btn" data-action="lock"
                  title="${track.locked ? 'Unlock' : 'Lock'}" aria-label="Lock track"
                  aria-pressed="${track.locked}">${track.locked ? '🔒' : '🔓'}</button>
          <button class="pm-tl-th-btn" data-action="del" title="Remove track" aria-label="Remove track">✕</button>
        </div>
        <div class="pm-tl-th-zorder" aria-label="Track z-order controls">
          <button class="pm-tl-zo-btn" data-action="zup" title="Move layer up" aria-label="Move layer up" ${idx === sortedTracks.length - 1 ? 'disabled' : ''}>▲</button>
          <span class="pm-tl-zo-num" aria-label="Z-order">${track.zIndex}</span>
          <button class="pm-tl-zo-btn" data-action="zdown" title="Move layer down" aria-label="Move layer down" ${idx === 0 ? 'disabled' : ''}>▼</button>
        </div>
      `;

      if (hasMixer) {
        const volPct = Math.round((track.volume ?? 1) * 100);
        div.innerHTML = `
          <div class="pm-tl-th-top">${controlsHtml}</div>
          <div class="pm-tl-th-mixer">
            <canvas class="pm-tl-vu-meter" data-track-id="${track.id}" width="44" height="6"
                    aria-hidden="true"></canvas>
            <input type="range" class="pm-tl-th-vol" data-track-id="${track.id}"
                   min="0" max="1.5" step="0.01" value="${track.volume ?? 1}"
                   title="Volume" aria-label="Track volume">
            <input type="range" class="pm-tl-th-pan" data-track-id="${track.id}"
                   min="-1" max="1" step="0.01" value="${track.pan ?? 0}"
                   title="Pan (L/R)" aria-label="Track pan">
            <span class="pm-tl-th-vol-val">${volPct}%</span>
          </div>
        `;
        // Wire mixer sliders (no undo — live mixer controls)
        div.querySelector('.pm-tl-th-vol').addEventListener('input', (e) => {
          const v = Number(e.target.value);
          track.volume = v;
          this._pm.markDirty();
          this._audioEngine?.setTrackVolume(track.id, v);
          const valEl = div.querySelector('.pm-tl-th-vol-val');
          if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
        });
        div.querySelector('.pm-tl-th-pan').addEventListener('input', (e) => {
          const v = Number(e.target.value);
          track.pan = v;
          this._pm.markDirty();
          this._audioEngine?.setTrackPan(track.id, v);
        });
      } else {
        div.innerHTML = controlsHtml;
      }

      // Track name edit
      const nameEl = div.querySelector('.pm-tl-th-name');
      nameEl.addEventListener('blur', () => {
        const newName = nameEl.textContent.trim() || track.name;
        if (newName !== track.name) {
          this._history.execute({
            label: 'Rename track',
            execute: () => { track.name = newName; this._pm.markDirty(); },
            undo: () => { track.name = track.name; nameEl.textContent = track.name; this._pm.markDirty(); },
          });
        }
      });
      nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

      // Header button delegation
      div.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        this._onTrackHeaderAction(track, btn.dataset.action);
      });

      this._headersEl.insertBefore(div, addWrap);
    });
  }

  _renderLanes(sortedTracks, totalW) {
    // Preserve overlay elements before clearing
    const ph       = this._lanesInner.querySelector('#pm-tl-playhead');
    const snapLine = this._lanesInner.querySelector('#pm-tl-snap-line');
    Array.from(this._lanesInner.children).forEach((el) => {
      if (el !== ph && el !== snapLine) el.remove();
    });

    // Set inner width
    this._lanesInner.style.width = `${totalW}px`;

    // Calculate total height
    let totalH = sortedTracks.reduce((s, t) => s + trackHeight(t), 0) + ADD_BTN_H + 4;
    this._lanesInner.style.height = `${Math.max(totalH, 120)}px`;

    this._laneYMap = [];
    let yOffset = 0;
    sortedTracks.forEach((track) => {
      const h = trackHeight(track);
      const col = TRACK_COLORS[track.type] ?? TRACK_COLORS.video;
      const lane = document.createElement('div');
      lane.className = 'pm-tl-lane';
      lane.dataset.trackId = track.id;
      lane.style.cssText = `top:${yOffset}px; height:${h}px; background:${col.lane};`;
      lane.style.width = '100%';

      this._laneYMap.push({ trackId: track.id, top: yOffset, bottom: yOffset + h });

      // Asset drag-drop from media library
      lane.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('application/peachmint-asset')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          lane.classList.add('pm-tl-lane-drop');
        }
      });
      lane.addEventListener('dragleave', () => lane.classList.remove('pm-tl-lane-drop'));
      lane.addEventListener('drop', (e) => {
        e.preventDefault();
        lane.classList.remove('pm-tl-lane-drop');
        const assetId = e.dataTransfer.getData('application/peachmint-asset');
        if (!assetId || !this._project) return;
        const asset = this._project.assets.find((a) => a.id === assetId);
        if (!asset) return;
        const rect = this._lanesScroll.getBoundingClientRect();
        const dropX = e.clientX - rect.left + this._scrollLeft;
        const dropTime = Math.max(0, dropX / this._pxPerSec);
        this._cmdAddClipFromAsset(track, asset, dropTime);
      });

      // Render clips
      for (const clip of track.clips) {
        const clipEl = this._buildClipEl(clip, track, h);
        lane.appendChild(clipEl);
      }

      this._lanesInner.appendChild(lane);
      yOffset += h;
    });

    // Marker vertical lines
    for (const m of (this._project?.markers ?? [])) {
      const line = document.createElement('div');
      line.className = 'pm-tl-marker-line';
      line.id = `pm-tl-ml-${m.id}`;
      line.dataset.markerId = m.id;
      line.style.transform = `translateX(${m.time * this._pxPerSec}px)`;
      line.style.borderLeftColor = m.color ?? '#f1fa8c';
      this._lanesInner.appendChild(line);
    }

    // Re-append overlays on top
    if (ph)       this._lanesInner.appendChild(ph);
    if (snapLine) this._lanesInner.appendChild(snapLine);
  }

  _buildClipEl(clip, track, laneH) {
    const col = TRACK_COLORS[track.type] ?? TRACK_COLORS.video;
    const left = clip.startTime * this._pxPerSec;
    const width = Math.max(clip.duration * this._pxPerSec, 4);
    const isSelected      = clip.id === this._selectedClipId;
    const isMultiSelected = this._selectedClipIds.has(clip.id);

    const el = document.createElement('div');
    el.className = `pm-tl-clip${isSelected ? ' selected' : ''}${isMultiSelected ? ' multi-selected' : ''}`;
    el.dataset.clipId = clip.id;
    el.dataset.trackId = track.id;
    el.style.cssText = `left:${left}px; width:${width}px; height:${laneH - 4}px;
      background:${col.bg}; --clip-hi:${col.hi}; --clip-text:${col.text};`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Clip: ${clip.id.slice(0, 8)}, ${clip.duration.toFixed(2)}s`);
    el.setAttribute('tabindex', '0');

    // Build keyframe diamond markers
    let kfHtml = '';
    if (clip.keyframes) {
      const seen = new Set();
      for (const kfs of Object.values(clip.keyframes)) {
        for (const kf of kfs) {
          const key = kf.time.toFixed(4);
          if (seen.has(key)) continue;
          seen.add(key);
          const px = (kf.time - clip.startTime) * this._pxPerSec;
          if (px >= 0 && px <= width) {
            kfHtml += `<div class="pm-tl-kf-mark" style="left:${px}px" aria-hidden="true"></div>`;
          }
        }
      }
    }

    el.innerHTML = `
      <span class="pm-tl-clip-label">${formatDuration(clip.duration)}</span>
      ${kfHtml}
      <div class="pm-tl-clip-trim-l" data-resize="left" aria-hidden="true"></div>
      <div class="pm-tl-clip-trim-r" data-resize="right" aria-hidden="true"></div>
    `;

    // Waveform canvas for audio / video clips (drawn below label via prepend)
    if (this._waveformCache && clip.assetId) {
      const asset = this._project?.assets.find((a) => a.id === clip.assetId);
      if (asset?.storageKey && (asset.type === 'video' || asset.type === 'audio')) {
        const wvCanvas = document.createElement('canvas');
        wvCanvas.className = 'pm-tl-waveform';
        wvCanvas.width  = Math.max(1, Math.ceil(width));
        wvCanvas.height = Math.max(1, laneH - 4);
        el.prepend(wvCanvas);

        const paint = (peaks) => {
          if (!peaks || !wvCanvas.isConnected) return;
          const cw = wvCanvas.width, ch = wvCanvas.height;
          const ctx2d = wvCanvas.getContext('2d');
          ctx2d.clearRect(0, 0, cw, ch);
          ctx2d.fillStyle = 'rgba(255,255,255,0.28)';
          const N        = peaks.length;
          const assetDur = asset.duration ?? 0;
          const trimIn   = clip.trimIn ?? 0;
          const speed    = clip.speed ?? 1;
          const pStart   = assetDur > 0 ? Math.max(0, Math.round(trimIn / assetDur * N)) : 0;
          const pEnd     = assetDur > 0 ? Math.min(N, Math.round((trimIn + clip.duration * speed) / assetDur * N)) : N;
          const vis      = Math.max(1, pEnd - pStart);
          const midY     = ch / 2;
          for (let i = 0; i < vis; i++) {
            const p  = peaks[Math.min(pStart + i, N - 1)] ?? 0;
            const bh = Math.max(1, p * midY * 0.88);
            ctx2d.fillRect((i / vis) * cw, midY - bh, Math.max(1, cw / vis - 0.5), bh * 2);
          }
        };

        const cached = this._waveformCache.getCached(asset.storageKey);
        if (cached) {
          paint(cached);
        } else {
          this._waveformCache.get(asset.storageKey).then(paint).catch(() => {});
        }
      }
    }

    return el;
  }

  // ─── Ruler ──────────────────────────────────────────────────────────────────

  _onResize() {
    const rect = this._el.querySelector('#pm-tl-ruler-scroll')?.getBoundingClientRect();
    if (!rect || rect.width < 1) return;
    const dpr = window.devicePixelRatio || 1;
    this._rulerCanvas.width = rect.width * dpr;
    this._rulerCanvas.height = RULER_H * dpr;
    this._rulerCanvas.style.width = `${rect.width}px`;
    this._rulerCanvas.style.height = `${RULER_H}px`;
    this._rulerCtx.scale(dpr, dpr);
    this._drawRuler();
  }

  _drawRuler() {
    const ctx = this._rulerCtx;
    const w = this._rulerCanvas.width / (window.devicePixelRatio || 1);
    const h = RULER_H;
    const scrollX = this._scrollLeft;
    const pps = this._pxPerSec;
    const fps = this._project?.canvas?.fps ?? 30;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#13131a';
    ctx.fillRect(0, 0, w, h);

    // Choose tick interval based on zoom
    const minorSec = chooseTick(pps, 'minor');
    const majorSec = chooseTick(pps, 'major');

    ctx.strokeStyle = '#44475a';
    ctx.fillStyle = '#6272a4';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';

    const startSec = scrollX / pps;
    const endSec = (scrollX + w) / pps;

    // Minor ticks
    ctx.lineWidth = 1;
    for (let s = Math.floor(startSec / minorSec) * minorSec; s <= endSec; s += minorSec) {
      const x = s * pps - scrollX;
      if (x < 0 || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, h - 6);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    // Major ticks + labels
    ctx.strokeStyle = '#6272a4';
    ctx.fillStyle = '#8be9fd';
    for (let s = Math.floor(startSec / majorSec) * majorSec; s <= endSec; s += majorSec) {
      const x = s * pps - scrollX;
      if (x < 0 || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, h - 14);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      if (x >= 4) ctx.fillText(formatTime(s), x + 3, 5);
    }

    // Current time label
    const phX = this._currentTime * pps - scrollX;
    if (phX >= 0 && phX <= w) {
      ctx.fillStyle = '#ff8c69';
      ctx.fillText(formatTimecode(this._currentTime, fps), Math.min(phX + 4, w - 80), h - 14);
    }

    // Marker flags
    const markers = this._project?.markers ?? [];
    for (const m of markers) {
      const mx = m.time * pps - scrollX;
      if (mx < -20 || mx > w + 4) continue;
      const col = m.color ?? '#f1fa8c';
      // Triangle flag
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx + 8, 0);
      ctx.lineTo(mx, 9);
      ctx.closePath();
      ctx.fill();
      // Vertical line down to ruler bottom
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(mx + 0.5, 9);
      ctx.lineTo(mx + 0.5, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Label (truncated)
      if (m.label) {
        ctx.fillStyle = col;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textBaseline = 'top';
        const maxW = 80;
        ctx.fillText(m.label, mx + 10, 1, maxW);
      }
    }

    // I/O range fill + bracket handles
    const inPt  = this._project?.inPoint  ?? null;
    const outPt = this._project?.outPoint ?? null;
    if (inPt != null || outPt != null) {
      const dur    = totalDuration(this._project);
      const rStart = inPt  ?? 0;
      const rEnd   = outPt ?? Math.max(dur, 10);
      const rx1 = Math.max(0, rStart * pps - scrollX);
      const rx2 = Math.min(w, rEnd   * pps - scrollX);
      if (rx2 > rx1) {
        ctx.fillStyle = 'rgba(139,233,253,0.1)';
        ctx.fillRect(rx1, 0, rx2 - rx1, h);
      }
      if (inPt != null) {
        const ix = Math.round(inPt * pps - scrollX);
        if (ix >= -6 && ix <= w + 2) {
          ctx.fillStyle = '#8be9fd';
          ctx.fillRect(ix,     h - 10, 2, 10); // vertical bar
          ctx.fillRect(ix,     h - 10, 6, 2);  // top arm →
          ctx.fillRect(ix,     h - 1,  6, 1);  // bottom arm →
        }
      }
      if (outPt != null) {
        const ox = Math.round(outPt * pps - scrollX);
        if (ox >= -2 && ox <= w + 6) {
          ctx.fillStyle = '#bd93f9';
          ctx.fillRect(ox - 2, h - 10, 2, 10); // vertical bar
          ctx.fillRect(ox - 6, h - 10, 6, 2);  // top arm ←
          ctx.fillRect(ox - 6, h - 1,  6, 1);  // bottom arm ←
        }
      }
    }

    // Bottom border
    ctx.strokeStyle = '#2d2d3e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
  }

  _updatePlayhead() {
    const x = this._currentTime * this._pxPerSec;
    if (this._playheadEl) {
      this._playheadEl.style.transform = `translateX(${x}px)`;
    }
    if (this._playheadRulerEl) {
      const scrollX = this._lanesScroll?.scrollLeft ?? 0;
      const visX = x - scrollX;
      this._playheadRulerEl.style.transform = `translateX(${visX}px)`;
      this._playheadRulerEl.style.opacity = visX >= 0 ? '1' : '0';
    }
    this._drawRuler();
  }

  // ─── Pointer events ──────────────────────────────────────────────────────────

  _onRulerPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const io = this._ioAtRulerX(e);
    if (io) {
      this._rulerCanvas.setPointerCapture(e.pointerId);
      const origTime = io === 'in' ? (this._project.inPoint ?? 0) : (this._project.outPoint ?? 0);
      this._drag = { type: io === 'in' ? 'inpoint' : 'outpoint', origTime, pointerId: e.pointerId };
      return;
    }
    const m = this._markerAtRulerX(e);
    if (m) {
      this._rulerCanvas.setPointerCapture(e.pointerId);
      this._drag = { type: 'marker', markerId: m.id, origMarkerTime: m.time, pointerId: e.pointerId };
      return;
    }
    this._rulerCanvas.setPointerCapture(e.pointerId);
    this._drag = { type: 'playhead', pointerId: e.pointerId };
    this._seekFromRulerEvent(e);
  }

  _seekFromRulerEvent(e) {
    const rect = this._lanesScroll.getBoundingClientRect();
    const x = e.clientX - rect.left + this._scrollLeft - HEADER_W;
    const time = Math.max(0, x / this._pxPerSec);
    this._currentTime = time;
    this._updatePlayhead();
    this._onSeek(time);
  }

  _onLanesPointerDown(e) {
    if (e.button !== 0) return;

    const clipEl = e.target.closest('.pm-tl-clip');
    const resizeHandle = e.target.closest('[data-resize]');

    if (clipEl && !resizeHandle) {
      const clipId  = clipEl.dataset.clipId;
      const trackId = clipEl.dataset.trackId;

      // Ctrl/Meta+click → multi-select toggle, no drag
      if ((e.ctrlKey || e.metaKey) && this._tool === 'pointer') {
        e.preventDefault();
        this._selectClip(clipId, trackId, true);
        return;
      }

      this._selectClip(clipId, trackId);

      // Razor tool: split clip at click position
      if (this._tool === 'razor') {
        e.preventDefault();
        const rect = this._lanesScroll.getBoundingClientRect();
        const x = e.clientX - rect.left + this._scrollLeft;
        const splitTime = Math.max(0, x / this._pxPerSec);
        this._cmdSplitClip(clipId, splitTime);
        return;
      }

      if (this._tool !== 'pointer') return;
      e.preventDefault();
      clipEl.setPointerCapture(e.pointerId);

      const clip = this._findClip(clipId);
      if (!clip) return;

      const rect    = this._lanesScroll.getBoundingClientRect();
      const startX  = e.clientX - rect.left + this._scrollLeft;
      const startY  = e.clientY - rect.top;

      // Ghost element for cross-track visual feedback
      const clipRect = clipEl.getBoundingClientRect();
      const ghost    = clipEl.cloneNode(true);
      ghost.className = 'pm-tl-clip pm-tl-clip-ghost';
      ghost.style.cssText = `
        position:fixed; left:${clipRect.left}px; top:${clipRect.top}px;
        width:${clipRect.width}px; height:${clipRect.height}px;
        opacity:0.75; z-index:1000; pointer-events:none;
      `;
      document.body.appendChild(ghost);
      clipEl.style.opacity = '0.35';

      this._drag = {
        type:           'clip',
        pointerId:      e.pointerId,
        clipId,
        trackId,
        origTrackId:    trackId,
        origStartTime:  clip.startTime,
        mouseXAtStart:  startX,
        mouseYAtStart:  startY,
        clipEl,
        ghost,
        ghostOffX:      e.clientX - clipRect.left,
        ghostOffY:      e.clientY - clipRect.top,
      };
      return;
    }

    if (resizeHandle) {
      // Trim handle
      const clipEl2 = resizeHandle.closest('.pm-tl-clip');
      const clipId = clipEl2?.dataset.clipId;
      const side = resizeHandle.dataset.resize;
      const clip = this._findClip(clipId);
      if (!clip || !clipId) return;
      e.preventDefault();
      clipEl2.setPointerCapture(e.pointerId);
      const rect = this._lanesScroll.getBoundingClientRect();
      this._drag = {
        type: 'trim',
        pointerId: e.pointerId,
        clipId,
        side,
        origStartTime: clip.startTime,
        origDuration: clip.duration,
        origTrimIn: clip.trimIn ?? 0,
        mouseXAtStart: e.clientX - rect.left + this._scrollLeft,
        clipEl: clipEl2,
      };
      return;
    }

    // Click on empty lane area → seek
    if (!clipEl) {
      const lane = e.target.closest('.pm-tl-lane');
      if (lane) {
        const rect = this._lanesScroll.getBoundingClientRect();
        const x = e.clientX - rect.left + this._scrollLeft;
        const time = Math.max(0, x / this._pxPerSec);
        this._currentTime = time;
        this._updatePlayhead();
        this._onSeek(time);
      }
    }
  }

  _onPointerMove(e) {
    if (!this._drag) return;

    if (this._drag.type === 'playhead') {
      this._seekFromRulerEvent(e);
      return;
    }

    if (this._drag.type === 'inpoint' || this._drag.type === 'outpoint') {
      const isIn  = this._drag.type === 'inpoint';
      const rect  = this._rulerCanvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const newTime = Math.max(0, (canvasX + this._scrollLeft) / this._pxPerSec);
      if (this._project) {
        if (isIn) this._project.inPoint  = newTime;
        else      this._project.outPoint = newTime;
        this._drawRuler();
      }
      return;
    }

    if (this._drag.type === 'marker') {
      const rect = this._rulerCanvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const newTime = Math.max(0, (canvasX + this._scrollLeft) / this._pxPerSec);
      const marker = (this._project?.markers ?? []).find((m) => m.id === this._drag.markerId);
      if (marker) {
        marker.time = newTime;
        this._drawRuler();
        this._updateMarkerLines();
      }
      return;
    }

    const rect = this._lanesScroll.getBoundingClientRect();
    const curX = e.clientX - rect.left + this._scrollLeft;
    const deltaX = curX - this._drag.mouseXAtStart;
    const deltaSec = deltaX / this._pxPerSec;

    if (this._drag.type === 'clip') {
      const clip = this._findClip(this._drag.clipId);
      if (!clip) return;
      let newStart = Math.max(0, this._drag.origStartTime + deltaSec);

      // Magnetic snap: try both left and right edge, pick the closer one
      if (this._snapEnabled && !e.altKey) {
        const snapTimes = this._collectSnapTimes(this._drag.clipId);
        const snapL = this._findSnap(newStart, snapTimes);
        const snapR = this._findSnap(newStart + clip.duration, snapTimes);
        if (snapL && (!snapR || snapL.dist <= snapR.dist)) {
          newStart = Math.max(0, snapL.snapped);
          this._showSnapLine(snapL.at);
        } else if (snapR) {
          newStart = Math.max(0, snapR.snapped - clip.duration);
          this._showSnapLine(snapR.at);
        } else {
          this._hideSnapLine();
        }
      } else {
        this._hideSnapLine();
      }

      this._drag.clipEl.style.left = `${newStart * this._pxPerSec}px`;
      clip._previewStartTime = newStart;
      // Move fixed-position ghost with cursor
      if (this._drag.ghost) {
        this._drag.ghost.style.left = `${e.clientX - this._drag.ghostOffX}px`;
        this._drag.ghost.style.top  = `${e.clientY - this._drag.ghostOffY}px`;
      }
      // Detect target track by cursor Y within lanes scroll area
      const curY = e.clientY - rect.top + this._lanesScroll.scrollTop;
      const hit = this._laneYMap.find((r) => curY >= r.top && curY < r.bottom);
      if (hit) this._drag.trackId = hit.trackId;
    }

    if (this._drag.type === 'trim') {
      const clip = this._findClip(this._drag.clipId);
      if (!clip) return;
      if (this._drag.side === 'right') {
        let newDur = Math.max(0.1, this._drag.origDuration + deltaSec);

        if (this._snapEnabled && !e.altKey) {
          const proposedEnd = this._drag.origStartTime + newDur;
          const snapResult = this._findSnap(proposedEnd, this._collectSnapTimes(this._drag.clipId));
          if (snapResult) {
            newDur = Math.max(0.1, snapResult.snapped - this._drag.origStartTime);
            this._showSnapLine(snapResult.at);
          } else {
            this._hideSnapLine();
          }
        } else {
          this._hideSnapLine();
        }

        this._drag.clipEl.style.width = `${newDur * this._pxPerSec}px`;
        clip._previewDuration = newDur;
        this._onSeek(clip.startTime + newDur);
      } else {
        let newStart = Math.min(this._drag.origStartTime + this._drag.origDuration - 0.1,
          Math.max(0, this._drag.origStartTime + deltaSec));

        if (this._snapEnabled && !e.altKey) {
          const snapResult = this._findSnap(newStart, this._collectSnapTimes(this._drag.clipId));
          if (snapResult) {
            newStart = Math.max(0, Math.min(this._drag.origStartTime + this._drag.origDuration - 0.1, snapResult.snapped));
            this._showSnapLine(snapResult.at);
          } else {
            this._hideSnapLine();
          }
        } else {
          this._hideSnapLine();
        }

        const newDur = this._drag.origDuration - (newStart - this._drag.origStartTime);
        this._drag.clipEl.style.left = `${newStart * this._pxPerSec}px`;
        this._drag.clipEl.style.width = `${Math.max(4, newDur * this._pxPerSec)}px`;
        clip._previewStartTime = newStart;
        clip._previewDuration = newDur;
        this._onSeek(newStart);
      }
    }
  }

  _onPointerUp(e) {
    if (!this._drag) return;

    if (this._drag.type === 'clip') {
      const { clipId, origStartTime, origTrackId } = this._drag;
      const targetTrackId = this._drag.trackId;
      const clip = this._findClip(clipId);

      // Clean up ghost + restore placeholder opacity
      this._drag.ghost?.remove();
      if (this._drag.clipEl) this._drag.clipEl.style.opacity = '';

      if (clip) {
        const newStart = clip._previewStartTime ?? origStartTime;
        delete clip._previewStartTime;
        const changedTrack = targetTrackId !== origTrackId;
        const moved = Math.abs(newStart - origStartTime) > 0.001;

        if (changedTrack) {
          // Snapshot-based command so undo is reliable across track arrays
          const cmd = this._history.snapshotCommand('Move clip', (project) => {
            const src = project.tracks.find((t) => t.id === origTrackId);
            const dst = project.tracks.find((t) => t.id === targetTrackId);
            const c   = src?.clips.find((c) => c.id === clipId);
            if (src && dst && c) {
              src.clips = src.clips.filter((x) => x.id !== clipId);
              c.startTime = newStart;
              dst.clips.push(c);
            }
          });
          this._history.execute(cmd);
          this._render();
        } else if (moved) {
          this._history.execute({
            label: 'Move clip',
            execute: () => { clip.startTime = newStart; this._pm.markDirty(); },
            undo: () => { clip.startTime = origStartTime; this._pm.markDirty(); this._render(); },
          });
          this._render();
        } else {
          // No net change — reset div in case pointer-move shifted it slightly
          if (this._drag.clipEl) {
            this._drag.clipEl.style.left = `${origStartTime * this._pxPerSec}px`;
          }
        }
      }
    }

    if (this._drag.type === 'trim') {
      const { clipId, origStartTime, origDuration, origTrimIn, side } = this._drag;
      const clip = this._findClip(clipId);
      if (clip) {
        const newStart  = clip._previewStartTime ?? origStartTime;
        const newDur    = clip._previewDuration  ?? origDuration;
        const newTrimIn = side === 'left'
          ? origTrimIn + (newStart - origStartTime) * (clip.speed ?? 1)
          : (clip.trimIn ?? 0);
        delete clip._previewStartTime;
        delete clip._previewDuration;
        if (Math.abs(newStart - origStartTime) > 0.001 || Math.abs(newDur - origDuration) > 0.001) {
          this._history.execute({
            label: 'Trim clip',
            execute: () => {
              clip.startTime = newStart; clip.duration = newDur; clip.trimIn = newTrimIn;
              this._pm.markDirty();
            },
            undo: () => {
              clip.startTime = origStartTime; clip.duration = origDuration; clip.trimIn = origTrimIn;
              this._pm.markDirty(); this._render();
            },
          });
          this._render();
        }
      }
    }

    if (this._drag.type === 'inpoint' || this._drag.type === 'outpoint') {
      const isIn    = this._drag.type === 'inpoint';
      const prop    = isIn ? 'inPoint' : 'outPoint';
      const newTime = this._project?.[prop] ?? null;
      const origTime = this._drag.origTime;
      if (this._project && newTime != null && Math.abs(newTime - origTime) > 0.001) {
        this._history.execute({
          label:   isIn ? 'Move in-point' : 'Move out-point',
          execute: () => { this._project[prop] = newTime;  this._pm.markDirty(); this._drawRuler(); },
          undo:    () => { this._project[prop] = origTime; this._pm.markDirty(); this._drawRuler(); },
        });
      }
    }

    if (this._drag.type === 'marker') {
      const marker = (this._project?.markers ?? []).find((m) => m.id === this._drag.markerId);
      if (marker) {
        const newTime  = marker.time;
        const origTime = this._drag.origMarkerTime;
        if (Math.abs(newTime - origTime) > 0.001) {
          this._history.execute({
            label: 'Move marker',
            execute: () => {
              marker.time = newTime;
              this._project.markers?.sort((a, b) => a.time - b.time);
              this._pm.markDirty(); this._drawRuler(); this._updateMarkerLines();
            },
            undo: () => {
              marker.time = origTime;
              this._project.markers?.sort((a, b) => a.time - b.time);
              this._pm.markDirty(); this._drawRuler(); this._updateMarkerLines();
            },
          });
        }
      }
    }

    this._drag = null;
    this._hideSnapLine();
  }

  // ─── Clip / track selection ──────────────────────────────────────────────────

  _selectClip(clipId, trackId, addToSelection = false) {
    if (addToSelection) {
      if (this._selectedClipIds.has(clipId)) {
        this._selectedClipIds.delete(clipId);
        this._el.querySelector(`.pm-tl-clip[data-clip-id="${clipId}"]`)?.classList.remove('multi-selected');
      } else {
        this._selectedClipIds.add(clipId);
        this._el.querySelector(`.pm-tl-clip[data-clip-id="${clipId}"]`)?.classList.add('multi-selected');
      }
      this._updateSyncBtn();
      return;
    }

    // Single select — clear any multi-selection
    this._selectedClipId = clipId;
    this._selectedClipIds.clear();
    this._updateSyncBtn();
    this._el.querySelectorAll('.pm-tl-clip.selected, .pm-tl-clip.multi-selected').forEach((el) => {
      el.classList.remove('selected', 'multi-selected');
    });
    this._el.querySelector(`.pm-tl-clip[data-clip-id="${clipId}"]`)?.classList.add('selected');

    const clip = this._findClip(clipId);
    if (clip) this._onClipSelect(clip);

    const track = this._project?.tracks.find((t) => t.id === trackId);
    if (track) this._onTrackSelect(track);
  }

  _updateSyncBtn() {
    const btn = this._el?.querySelector('#pm-tl-sync');
    if (!btn) return;
    const ok = this._selectedClipIds.size >= 2;
    btn.disabled = !ok;
    btn.style.display = ok ? '' : 'none';
  }

  // ─── Track header actions ────────────────────────────────────────────────────

  _onTrackHeaderAction(track, action) {
    if (!this._project) return;
    switch (action) {
      case 'mute':
        this._history.execute({
          label: 'Toggle mute',
          execute: () => { track.muted = !track.muted; this._pm.markDirty(); this._render(); },
          undo: () => { track.muted = !track.muted; this._pm.markDirty(); this._render(); },
        });
        break;
      case 'solo':
        this._history.execute({
          label: 'Toggle solo',
          execute: () => { track.solo = !track.solo; this._pm.markDirty(); this._render(); },
          undo: () => { track.solo = !track.solo; this._pm.markDirty(); this._render(); },
        });
        break;
      case 'lock':
        this._history.execute({
          label: 'Toggle lock',
          execute: () => { track.locked = !track.locked; this._pm.markDirty(); this._render(); },
          undo: () => { track.locked = !track.locked; this._pm.markDirty(); this._render(); },
        });
        break;
      case 'del':
        this._cmdRemoveTrack(track.id);
        break;
      case 'zup': {
        const sorted = [...this._project.tracks].sort((a, b) => a.zIndex - b.zIndex);
        const idx = sorted.findIndex((t) => t.id === track.id);
        if (idx < sorted.length - 1) this._swapZ(sorted[idx], sorted[idx + 1]);
        break;
      }
      case 'zdown': {
        const sorted = [...this._project.tracks].sort((a, b) => a.zIndex - b.zIndex);
        const idx = sorted.findIndex((t) => t.id === track.id);
        if (idx > 0) this._swapZ(sorted[idx], sorted[idx - 1]);
        break;
      }
    }
  }

  _swapZ(ta, tb) {
    const za = ta.zIndex, zb = tb.zIndex;
    this._history.execute({
      label: 'Reorder tracks',
      execute: () => { ta.zIndex = zb; tb.zIndex = za; this._pm.markDirty(); this._render(); },
      undo: () => { ta.zIndex = za; tb.zIndex = zb; this._pm.markDirty(); this._render(); },
    });
  }

  // ─── History commands ────────────────────────────────────────────────────────

  _cmdAddTrack(type) {
    if (!this._project) return;
    const maxZ = this._project.tracks.reduce((m, t) => Math.max(m, t.zIndex), -1);
    const newTrack = createTrack({ type, zIndex: maxZ + 1 });
    this._history.execute({
      label: `Add ${type} track`,
      execute: () => { this._project.tracks.push(newTrack); this._pm.markDirty(); this._render(); },
      undo: () => {
        this._project.tracks = this._project.tracks.filter((t) => t.id !== newTrack.id);
        this._pm.markDirty(); this._render();
      },
    });
  }

  _cmdRemoveTrack(trackId) {
    if (!this._project) return;
    const track = this._project.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const idx = this._project.tracks.indexOf(track);
    this._history.execute({
      label: 'Remove track',
      execute: () => {
        this._project.tracks = this._project.tracks.filter((t) => t.id !== trackId);
        this._pm.markDirty(); this._render();
      },
      undo: () => {
        this._project.tracks.splice(idx, 0, track);
        this._pm.markDirty(); this._render();
      },
    });
  }

  _cmdSplitClip(clipId, splitTime) {
    if (!this._project) return;
    const cmd = this._history.snapshotCommand('Split clip', (project) => {
      splitClip(project, clipId, splitTime);
    });
    this._history.execute(cmd);
    this._render();
  }

  _cmdAddClipFromAsset(track, asset, dropTime) {
    if (!this._project) return;
    const duration = asset.duration ?? 5;
    let newClip = null;
    this._history.execute({
      label: 'Add clip',
      execute: () => {
        newClip = addClip(this._project, track.id, { assetId: asset.id, startTime: dropTime, duration });
        this._pm.markDirty(); this._render();
      },
      undo: () => {
        if (newClip) track.clips = track.clips.filter((c) => c.id !== newClip.id);
        this._pm.markDirty(); this._render();
      },
    });
  }

  // ─── Zoom ────────────────────────────────────────────────────────────────────

  _setZoom(newPps, pivotTime, pivotScreenX) {
    const clamped = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, newPps));
    if (clamped === this._pxPerSec) return;

    // Maintain scroll position around pivot
    if (pivotTime !== undefined && pivotScreenX !== undefined) {
      const newScrollLeft = pivotTime * clamped - pivotScreenX;
      this._pxPerSec = clamped;
      this._lanesScroll.scrollLeft = Math.max(0, newScrollLeft);
    } else {
      // Zoom around current playhead
      const pivotX = this._currentTime * this._pxPerSec - this._scrollLeft;
      this._pxPerSec = clamped;
      this._lanesScroll.scrollLeft = Math.max(0, this._currentTime * clamped - pivotX);
    }

    // Update zoom label
    const zv = this._el.querySelector('#pm-tl-zv');
    if (zv) zv.textContent = `${Math.round((clamped / DEFAULT_PX_PER_SEC) * 100)}%`;

    this._render();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _findClip(clipId) {
    if (!this._project) return null;
    for (const t of this._project.tracks) {
      const c = t.clips.find((c) => c.id === clipId);
      if (c) return c;
    }
    return null;
  }

  // ─── Snap helpers ─────────────────────────────────────────────────────────────

  _collectSnapTimes(excludeClipId) {
    const times = [];
    times.push(this._currentTime);
    if (this._project) {
      for (const track of this._project.tracks) {
        for (const clip of track.clips) {
          if (clip.id === excludeClipId) continue;
          times.push(clip.startTime);
          times.push(clip.startTime + clip.duration);
        }
      }
      // Frame-aligned grid snap — only when frames are wide enough to be useful
      const fps = this._project.canvas?.fps ?? 30;
      const frameW = this._pxPerSec / fps;
      if (frameW >= 3) {
        // Add the nearest frame boundary to the proposed time as a candidate
        // (candidates for any proposed time are pre-computed at call sites via _findSnap)
        this._snapFrameInterval = 1 / fps;
      } else {
        this._snapFrameInterval = 0;
      }
    }
    return times;
  }

  /**
   * Find the closest snap candidate to proposedSec within SNAP_THRESHOLD_PX.
   * Returns { snapped, at, dist } or null if nothing within threshold.
   */
  _findSnap(proposedSec, snapTimes) {
    const proposedPx = proposedSec * this._pxPerSec;
    let best = null;
    let bestDist = SNAP_THRESHOLD_PX;

    for (const t of snapTimes) {
      const dist = Math.abs(proposedPx - t * this._pxPerSec);
      if (dist < bestDist) { bestDist = dist; best = t; }
    }

    // Frame-grid snap
    if (this._snapFrameInterval > 0) {
      const nearFrame = Math.round(proposedSec / this._snapFrameInterval) * this._snapFrameInterval;
      const dist = Math.abs(proposedPx - nearFrame * this._pxPerSec);
      if (dist < bestDist) { bestDist = dist; best = nearFrame; }
    }

    return best !== null ? { snapped: best, at: best, dist: bestDist } : null;
  }

  _showSnapLine(time) {
    const el = this._el?.querySelector('#pm-tl-snap-line');
    if (!el) return;
    el.style.transform = `translateX(${time * this._pxPerSec}px)`;
    el.style.opacity = '1';
  }

  _hideSnapLine() {
    const el = this._el?.querySelector('#pm-tl-snap-line');
    if (el) el.style.opacity = '0';
  }

  // ─── Marker helpers ──────────────────────────────────────────────────────────

  _markerAtRulerX(e) {
    const rect = this._rulerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const rulerY  = e.clientY - rect.top;
    if (rulerY > 14) return null; // only top 14px (flag zone)
    const timeAtX  = (canvasX + this._scrollLeft) / this._pxPerSec;
    const threshSec = 8 / this._pxPerSec;
    return (this._project?.markers ?? []).find((m) => Math.abs(m.time - timeAtX) < threshSec) ?? null;
  }

  _ioAtRulerX(e) {
    if (!this._project) return null;
    const rect = this._rulerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const rulerY  = e.clientY - rect.top;
    if (rulerY < RULER_H / 2) return null; // bottom half only (bracket zone)
    const timeAtX   = (canvasX + this._scrollLeft) / this._pxPerSec;
    const threshSec = 8 / this._pxPerSec;
    const { inPoint, outPoint } = this._project;
    if (inPoint  != null && Math.abs(timeAtX - inPoint)  < threshSec) return 'in';
    if (outPoint != null && Math.abs(timeAtX - outPoint) < threshSec) return 'out';
    return null;
  }

  _renderMarkerLines() {
    if (!this._lanesInner || !this._project) return;
    this._lanesInner.querySelectorAll('.pm-tl-marker-line').forEach((el) => el.remove());
    for (const m of (this._project.markers ?? [])) {
      const line = document.createElement('div');
      line.className = 'pm-tl-marker-line';
      line.id = `pm-tl-ml-${m.id}`;
      line.dataset.markerId = m.id;
      line.style.transform = `translateX(${m.time * this._pxPerSec}px)`;
      line.style.borderLeftColor = m.color ?? '#f1fa8c';
      // Insert before playhead so playhead renders on top
      const ph = this._lanesInner.querySelector('#pm-tl-playhead');
      if (ph) this._lanesInner.insertBefore(line, ph);
      else this._lanesInner.appendChild(line);
    }
  }

  _updateMarkerLines() {
    for (const m of (this._project?.markers ?? [])) {
      const el = this._lanesInner?.querySelector(`#pm-tl-ml-${m.id}`);
      if (el) el.style.transform = `translateX(${m.time * this._pxPerSec}px)`;
    }
  }

  _cmdDeleteMarker(markerId) {
    if (!this._project?.markers) return;
    const marker = this._project.markers.find((m) => m.id === markerId);
    if (!marker) return;
    this._history.execute({
      label: 'Delete marker',
      execute: () => {
        this._project.markers = this._project.markers.filter((m) => m.id !== markerId);
        this._pm.markDirty(); this._drawRuler(); this._renderMarkerLines();
      },
      undo: () => {
        if (!this._project.markers) this._project.markers = [];
        this._project.markers.push(marker);
        this._project.markers.sort((a, b) => a.time - b.time);
        this._pm.markDirty(); this._drawRuler(); this._renderMarkerLines();
      },
    });
  }

  _showMarkerRenameInput(marker) {
    const rulerScroll = this._el?.querySelector('#pm-tl-ruler-scroll');
    if (!rulerScroll) return;
    // Remove any existing rename input
    rulerScroll.querySelector('.pm-tl-marker-rename')?.remove();

    const mx = marker.time * this._pxPerSec - this._scrollLeft;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = marker.label ?? '';
    input.className = 'pm-tl-marker-rename';
    input.style.left = `${Math.max(0, mx + 10)}px`;
    input.placeholder = 'Marker name';
    input.maxLength = 40;
    rulerScroll.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newLabel = input.value.trim();
      const oldLabel = marker.label ?? '';
      input.remove();
      if (newLabel === oldLabel) return;
      this._history.execute({
        label: 'Rename marker',
        execute: () => { marker.label = newLabel; this._pm.markDirty(); this._drawRuler(); },
        undo:    () => { marker.label = oldLabel;  this._pm.markDirty(); this._drawRuler(); },
      });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.remove(); }
    });
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .pm-tl-root { display:flex; flex-direction:column; height:100%; overflow:hidden;
      background:var(--bg-panel); user-select:none; }

    /* Header row */
    .pm-tl-header-row { display:flex; height:${RULER_H}px; flex-shrink:0; border-bottom:1px solid var(--border); }
    .pm-tl-corner { width:${HEADER_W}px; flex-shrink:0; display:flex; align-items:center;
      justify-content:center; gap:4px; background:var(--bg-panel); border-right:1px solid var(--border); }
    .pm-tl-zoom-btn { background:var(--bg-hover); border:1px solid var(--border); color:var(--text-muted);
      width:22px; height:22px; border-radius:4px; font-size:0.9rem; cursor:pointer; line-height:1;
      display:flex; align-items:center; justify-content:center; }
    .pm-tl-zoom-btn:hover { border-color:var(--border-hi); color:var(--text-primary); }
    .pm-tl-zoom-val { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-dim);
      min-width:36px; text-align:center; }
    .pm-tl-ruler-scroll { flex:1; overflow:hidden; position:relative; background:#13131a; }
    .pm-tl-ruler { display:block; }
    .pm-tl-ph-head { position:absolute; top:0; bottom:0; width:2px; background:var(--accent-peach);
      pointer-events:none; transform:translateX(0); will-change:transform; }
    .pm-tl-ph-head::before { content:'▼'; position:absolute; top:0; left:-5px; font-size:10px;
      color:var(--accent-peach); }

    /* Body row */
    .pm-tl-body-row { display:flex; flex:1; min-height:0; overflow:hidden; }
    .pm-tl-headers { width:${HEADER_W}px; flex-shrink:0; overflow-y:auto; overflow-x:hidden;
      border-right:1px solid var(--border); background:var(--bg-panel); scrollbar-width:none; }
    .pm-tl-headers::-webkit-scrollbar { display:none; }
    .pm-tl-lanes-scroll { flex:1; overflow:auto; position:relative; }
    .pm-tl-lanes-inner { position:relative; min-height:100%; }

    /* Track headers */
    .pm-tl-track-header { display:flex; align-items:center; gap:4px; padding:0 6px 0 0;
      border-bottom:1px solid var(--border); box-sizing:border-box; position:relative;
      border-left:3px solid transparent; flex-shrink:0; }
    .pm-tl-track-header:hover { background:var(--bg-hover); }
    .pm-tl-th-type { width:20px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
      height:100%; font-size:0.7rem; align-self:stretch; }
    .pm-tl-th-name { flex:1; font-size:0.75rem; color:var(--text-primary); padding:4px 2px;
      border-radius:3px; outline:none; min-width:0; white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis; cursor:text; }
    .pm-tl-th-name:focus { background:var(--bg-base); white-space:normal; overflow:visible; }
    .pm-tl-th-controls { display:flex; gap:2px; flex-shrink:0; }
    .pm-tl-th-btn { background:transparent; border:none; color:var(--text-dim); font-size:0.7rem;
      width:20px; height:20px; border-radius:3px; cursor:pointer; padding:0;
      display:flex; align-items:center; justify-content:center; }
    .pm-tl-th-btn:hover { background:var(--bg-hover); color:var(--text-primary); }
    .pm-tl-th-btn.active { color:var(--accent-warn); }
    .pm-tl-th-zorder { display:flex; flex-direction:column; align-items:center; gap:0; flex-shrink:0; }
    .pm-tl-zo-btn { background:transparent; border:none; color:var(--text-dim); font-size:0.5rem;
      width:16px; height:12px; cursor:pointer; padding:0; line-height:1;
      display:flex; align-items:center; justify-content:center; }
    .pm-tl-zo-btn:hover:not(:disabled) { color:var(--accent-blue); }
    .pm-tl-zo-btn:disabled { opacity:0.2; cursor:default; }
    .pm-tl-zo-num { font-family:var(--font-mono); font-size:0.55rem; color:var(--text-dim); line-height:1; }

    /* Add track row */
    .pm-tl-add-track-wrap { display:flex; flex-direction:column; gap:3px; padding:6px 4px;
      border-top:1px solid var(--border); }
    .pm-tl-add-btn { background:transparent; border:1px dashed var(--border-hi); color:var(--text-muted);
      border-radius:4px; padding:4px 8px; font-size:0.72rem; cursor:pointer; text-align:left;
      font-family:var(--font-mono); }
    .pm-tl-add-btn:hover { border-color:var(--accent-peach); color:var(--accent-peach); }

    /* Track lanes */
    .pm-tl-lane { position:absolute; left:0; right:0; border-bottom:1px solid var(--border);
      box-sizing:border-box; }
    .pm-tl-lane:hover { brightness:110%; }

    /* Clips */
    .pm-tl-clip { position:absolute; top:2px; border-radius:4px; overflow:hidden; cursor:grab;
      box-sizing:border-box; min-width:4px; transition:box-shadow .1s;
      display:flex; align-items:center; }
    .pm-tl-clip:hover { filter:brightness(1.15); box-shadow:0 0 0 2px var(--clip-hi, #fff3); }
    .pm-tl-clip.selected { box-shadow:0 0 0 2px #fff; }
    .pm-tl-clip.dragging { cursor:grabbing; opacity:.85; z-index:10; }
    [data-tool="razor"] .pm-tl-clip { cursor:crosshair; }
    [data-tool="hand"] .pm-tl-clip { cursor:grab; }
    .pm-tl-clip-label { font-family:var(--font-mono); font-size:0.65rem; padding:0 5px;
      color:var(--clip-text, #1a1a1a); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      pointer-events:none; flex:1; }
    .pm-tl-clip-trim-l, .pm-tl-clip-trim-r { position:absolute; top:0; bottom:0; width:8px;
      cursor:ew-resize; background:rgba(0,0,0,.2); }
    .pm-tl-clip-trim-l { left:0; border-radius:4px 0 0 4px; }
    .pm-tl-clip-trim-r { right:0; border-radius:0 4px 4px 0; }
    .pm-tl-clip-trim-l:hover, .pm-tl-clip-trim-r:hover { background:rgba(0,0,0,.4); }

    /* Playhead line */
    .pm-tl-playhead { position:absolute; top:0; bottom:0; width:2px; background:var(--accent-peach);
      pointer-events:none; transform:translateX(0); will-change:transform; z-index:20; }

    /* Empty state */
    .pm-tl-empty { display:flex; align-items:center; justify-content:center; flex:1;
      color:var(--text-dim); font-size:0.8rem; font-family:var(--font-mono); padding:16px; }

    /* Keyframe diamond markers on clips */
    .pm-tl-kf-mark { position:absolute; bottom:3px; width:6px; height:6px; background:#f1fa8c;
      transform:translateX(-3px) rotate(45deg); pointer-events:none; z-index:2; }

    /* Lane drop highlight when dragging asset from media library */
    .pm-tl-lane-drop { outline:2px dashed var(--accent-peach); outline-offset:-2px;
      background-color:rgba(255,140,105,.08) !important; }

    /* Ghost clip element during cross-track drag */
    .pm-tl-clip-ghost { cursor:grabbing !important;
      box-shadow:0 4px 20px rgba(0,0,0,.6), 0 0 0 2px var(--accent-peach) !important; }

    /* Multi-select highlight (Ctrl+click) */
    .pm-tl-clip.multi-selected { box-shadow:0 0 0 2px var(--accent-purple); }
    .pm-tl-clip.multi-selected.selected { box-shadow:0 0 0 2px #fff, 0 0 0 4px var(--accent-purple); }

    /* Waveform canvas sits behind label/handles via DOM prepend + position:absolute */
    .pm-tl-waveform { position:absolute; inset:0; width:100%; height:100%;
      pointer-events:none; z-index:0; border-radius:inherit; }

    /* Sync button in timeline corner — shown only when ≥2 clips are multi-selected */
    .pm-tl-sync-btn { background:transparent; border:1px solid var(--accent-purple);
      color:var(--accent-purple); font-size:0.6rem; padding:1px 5px; border-radius:4px;
      cursor:pointer; font-family:var(--font-mono); white-space:nowrap; line-height:1.5; }
    .pm-tl-sync-btn:hover:not(:disabled) { background:var(--accent-purple); color:#fff; }
    .pm-tl-sync-btn:disabled { opacity:0.3; cursor:default; }

    /* Snap toggle button */
    .pm-tl-snap-toggle { background:transparent; border:1px solid var(--border);
      color:var(--text-dim); font-size:0.6rem; padding:1px 5px; border-radius:4px;
      cursor:pointer; font-family:var(--font-mono); white-space:nowrap; line-height:1.5; }
    .pm-tl-snap-toggle:hover { border-color:var(--accent-blue); color:var(--accent-blue); }
    .pm-tl-snap-toggle.active { border-color:var(--accent-blue); color:var(--accent-blue);
      background:rgba(139,233,253,.1); }

    /* Magnetic snap indicator line — shown during drag when snap is active */
    .pm-tl-snap-line { position:absolute; top:0; bottom:0; width:1px;
      background:var(--accent-blue,#8be9fd); pointer-events:none; opacity:0;
      transform:translateX(0); will-change:transform; z-index:18;
      transition:opacity 0.05s; }

    /* Timeline marker vertical lines in lanes */
    .pm-tl-marker-line { position:absolute; top:0; bottom:0; width:0;
      border-left:1px dashed; pointer-events:none;
      transform:translateX(0); will-change:transform; z-index:15;
      opacity:0.55; }

    /* Marker rename floating input on ruler */
    .pm-tl-marker-rename { position:absolute; top:2px; height:20px; min-width:80px; max-width:160px;
      background:#181820; border:1px solid #f1fa8c; color:#f1fa8c; border-radius:3px;
      padding:0 4px; font-family:var(--font-mono); font-size:0.7rem; outline:none; z-index:50; }

    /* Mixer track header: 2-row column layout */
    .pm-tl-track-header--mix { flex-direction:column; align-items:stretch; justify-content:center; }
    .pm-tl-th-top { display:flex; align-items:center; gap:4px; padding:0 6px 0 0; flex:1; }
    .pm-tl-th-mixer { display:flex; align-items:center; gap:3px; padding:0 4px 3px 24px; flex-shrink:0; }

    /* VU meter canvas in mixer strip */
    .pm-tl-vu-meter { height:6px; flex-shrink:0; border-radius:1px;
      background:rgba(255,255,255,0.05); align-self:center; }

    /* Vol / pan range sliders */
    .pm-tl-th-vol, .pm-tl-th-pan {
      -webkit-appearance:none; appearance:none;
      height:4px; border-radius:2px; outline:none; cursor:pointer;
      background:var(--border-hi); flex-shrink:0; }
    .pm-tl-th-vol { width:56px; }
    .pm-tl-th-pan { width:40px; }
    .pm-tl-th-vol::-webkit-slider-thumb, .pm-tl-th-pan::-webkit-slider-thumb {
      -webkit-appearance:none; width:10px; height:10px; border-radius:50%;
      background:var(--text-primary); cursor:pointer; }
    .pm-tl-th-vol::-moz-range-thumb, .pm-tl-th-pan::-moz-range-thumb {
      width:10px; height:10px; border-radius:50%; background:var(--text-primary);
      cursor:pointer; border:none; }
    .pm-tl-th-vol:hover, .pm-tl-th-pan:hover { background:var(--border); }
    .pm-tl-th-vol-val { font-family:var(--font-mono); font-size:0.55rem;
      color:var(--text-dim); min-width:22px; text-align:right; flex-shrink:0; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function trackHeight(track) {
  if (track.type === 'audio')   return AUDIO_TRACK_H;
  if (track.type === 'overlay') return OVERLAY_TRACK_H;
  return VIDEO_TRACK_H;
}

function typeIcon(type) {
  switch (type) {
    case 'video':   return '🎬';
    case 'audio':   return '🎵';
    case 'overlay': return '✨';
    default:        return '▶';
  }
}

function chooseTick(pps, type) {
  // Pick sensible tick spacing based on zoom
  const candidates = type === 'major'
    ? [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
    : [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  const minPx = type === 'major' ? 80 : 8;
  for (const c of candidates) {
    if (c * pps >= minPx) return c;
  }
  return candidates[candidates.length - 1];
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(Math.floor(s))}`;
  if (m > 0) return `${m}:${pad(Math.floor(s))}`;
  return `${s.toFixed(s < 10 ? 1 : 0)}s`;
}

function formatTimecode(secs, fps = 30) {
  const s = Math.floor(secs);
  const f = Math.floor((secs - s) * fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}:${pad(f)}`;
}

function formatDuration(secs) {
  if (secs >= 60) return `${Math.floor(secs / 60)}m${Math.floor(secs % 60)}s`;
  if (secs >= 1)  return `${secs.toFixed(1)}s`;
  return `${Math.round(secs * 1000)}ms`;
}

function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
