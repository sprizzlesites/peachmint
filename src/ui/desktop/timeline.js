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
  createTrack, totalDuration, splitClip,
} from '../../engine/edl.js';

// ─── Layout constants ─────────────────────────────────────────────────────────

const HEADER_W = 180;        // px — width of track header column
const RULER_H  = 28;         // px — height of time ruler
const VIDEO_TRACK_H = 56;    // px — height of video/overlay track lanes
const AUDIO_TRACK_H = 40;    // px — height of audio track lanes
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
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  setProject(project) {
    this._project = project;
    if (!this._mounted) this._mount();
    this._render();
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
              <!-- lane divs + playhead line -->
              <div class="pm-tl-playhead" id="pm-tl-playhead" aria-hidden="true"></div>
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

    // Ruler click/drag → seek
    this._rulerCanvas.addEventListener('pointerdown', (e) => this._onRulerPointerDown(e));

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
      const div = document.createElement('div');
      div.className = 'pm-tl-track-header';
      div.dataset.trackId = track.id;
      div.style.height = `${h}px`;
      div.style.borderLeftColor = col.bg;
      div.innerHTML = `
        <div class="pm-tl-th-type" style="background:${col.bg};color:${col.text}" aria-hidden="true">
          ${typeIcon(track.type)}
        </div>
        <div class="pm-tl-th-name" contenteditable="true" spellcheck="false"
             aria-label="Track name"
             title="Double-click to rename">${escHtml(track.name)}</div>
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
    // Clear previous lanes
    Array.from(this._lanesInner.children).forEach((el) => {
      if (!el.id?.includes('playhead')) el.remove();
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

    // Keep playhead on top
    const ph = this._el.querySelector('#pm-tl-playhead');
    if (ph) this._lanesInner.appendChild(ph);
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

    const rect = this._lanesScroll.getBoundingClientRect();
    const curX = e.clientX - rect.left + this._scrollLeft;
    const deltaX = curX - this._drag.mouseXAtStart;
    const deltaSec = deltaX / this._pxPerSec;

    if (this._drag.type === 'clip') {
      const clip = this._findClip(this._drag.clipId);
      if (!clip) return;
      const newStart = Math.max(0, this._drag.origStartTime + deltaSec);
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
        const newDur = Math.max(0.1, this._drag.origDuration + deltaSec);
        this._drag.clipEl.style.width = `${newDur * this._pxPerSec}px`;
        clip._previewDuration = newDur;
        this._onSeek(clip.startTime + newDur);
      } else {
        const newStart = Math.min(this._drag.origStartTime + this._drag.origDuration - 0.1,
          Math.max(0, this._drag.origStartTime + deltaSec));
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

    this._drag = null;
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
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function trackHeight(track) {
  return track.type === 'audio' ? AUDIO_TRACK_H : VIDEO_TRACK_H;
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
