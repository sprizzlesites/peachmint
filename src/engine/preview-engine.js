/**
 * preview-engine.js — Preview render coordinator (Phase 1.5)
 *
 * Ties together DecoderPool and Compositor to produce live video frames
 * on the preview canvas. Supports two modes:
 *
 *   Scrub — seekTo(time): renders one frame synchronously per call.
 *   Play  — play(fromTime): drives a requestAnimationFrame loop that
 *            advances time and renders each frame; emits events for UI.
 *
 * Events emitted (as CustomEvents on the PreviewEngine itself):
 *   preview:tick   detail: { time }  — fired each RAF frame during play
 *   preview:ended                    — fired when playback reaches the end
 */

import { Compositor }                            from './compositor.js';
import { DecoderPool }                           from './decoder.js';
import { clipsAtTime, totalDuration, interpolate } from './edl.js';
import { parseCube, parse3dl }                   from './lut.js';

export class PreviewEngine extends EventTarget {
  /**
   * @param {{ canvas: HTMLCanvasElement, storage: StorageLayer }} opts
   */
  constructor({ canvas, storage }) {
    super();
    this._canvas     = canvas;
    this._storage    = storage;
    this._compositor = new Compositor(canvas);
    this._decoders   = null;
    this._project    = null;

    this._playing       = false;
    this._rafId         = null;
    this._playStartWall = 0;
    this._playStartTime = 0;
    this._currentTime   = 0;

    this._rendering  = false;
    this._ready      = false;
    this._lutTexCache = new Map(); // assetId → WebGLTexture
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  init() {
    this._compositor.init();
    this._decoders = new DecoderPool(this._storage);
    this._ready = true;
    this._compositor.clear(0, 0, 0);
  }

  dispose() {
    this.stop();
    this._clearLUTs();
    this._decoders?.dispose();
    this._compositor.dispose();
    this._ready = false;
  }

  _clearLUTs() {
    for (const tex of this._lutTexCache.values()) this._compositor.disposeLUT(tex);
    this._lutTexCache.clear();
  }

  // ─── Project ──────────────────────────────────────────────────────────────────

  setProject(project) {
    this._clearLUTs();
    this._project = project;
    if (project) {
      const { width, height } = project.canvas;
      if (this._canvas.width  !== width)  this._canvas.width  = width;
      if (this._canvas.height !== height) this._canvas.height = height;
    }
    if (this._compositor.isReady) this._compositor.clear(0, 0, 0);
  }

  // ─── Scrub ────────────────────────────────────────────────────────────────────

  async seekTo(time) {
    if (!this._ready) return;
    this._currentTime = Math.max(0, time);
    await this._renderFrame(this._currentTime);
  }

  // ─── Playback ─────────────────────────────────────────────────────────────────

  play(fromTime) {
    if (!this._ready || this._playing) return;
    this._playing       = true;
    this._playStartTime = fromTime ?? this._currentTime;
    this._playStartWall = performance.now();
    this._scheduleRaf();
  }

  stop() {
    this._playing = false;
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  get isPlaying()   { return this._playing; }
  get currentTime() { return this._currentTime; }
  get isReady()     { return this._ready; }

  // ─── RAF loop ─────────────────────────────────────────────────────────────────

  _scheduleRaf() {
    this._rafId = requestAnimationFrame(() => this._rafTick());
  }

  _rafTick() {
    if (!this._playing) return;

    const elapsed = (performance.now() - this._playStartWall) / 1000;
    const t       = this._playStartTime + elapsed;
    const total   = this._totalDuration();

    if (t >= total) {
      this._playing     = false;
      this._currentTime = 0;
      this._rafId       = null;
      this.dispatchEvent(new CustomEvent('preview:ended'));
      this._renderFrame(0).catch(() => {});
      return;
    }

    this._currentTime = t;
    this.dispatchEvent(new CustomEvent('preview:tick', { detail: { time: t } }));
    this._renderFrame(t).catch(() => {});
    this._scheduleRaf();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────────

  async _renderFrame(time) {
    if (!this._project || !this._compositor.isReady) return;
    if (this._rendering) return;
    this._rendering = true;

    try {
      const bg = this._project.canvas?.background;
      this._compositor.clear(bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0);

      const active = clipsAtTime(this._project, time);
      for (const { clip, track } of active) {
        if (track.type === 'audio') continue;

        const asset = this._project.assets.find((a) => a.id === clip.assetId);
        if (!asset || !asset.storageKey) {
          this._compositor.setActiveLUT(null);
          this._compositor.drawSolid([0.15, 0.04, 0.04, 1]);
          continue;
        }

        const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);

        try {
          const dec = await this._decoders.getDecoder(asset);
          await dec.seekTo(clipTime);
          const src = dec.getSource();
          if (src) {
            const props = resolveAnimatedProps(clip, time);
            const lutTex = await this._resolveLUT(props.color?.lut);
            this._compositor.setActiveLUT(lutTex);
            this._compositor.drawClip(src, props, dec.naturalWidth, dec.naturalHeight);
          }
        } catch {
          this._compositor.setActiveLUT(null);
          this._compositor.drawSolid([0.2, 0.05, 0.05, 1]);
        }
      }
    } finally {
      this._rendering = false;
    }
  }

  async _resolveLUT(assetId) {
    if (!assetId || !this._project) return null;
    if (this._lutTexCache.has(assetId)) return this._lutTexCache.get(assetId);
    const asset = this._project.assets.find((a) => a.id === assetId && a.type === 'lut');
    if (!asset?.storageKey) return null;
    try {
      const ab   = await this._storage.readMedia(asset.storageKey);
      if (!ab) return null;
      const text   = new TextDecoder().decode(ab instanceof ArrayBuffer ? ab : ab.buffer);
      const parsed = asset.lutFormat === '3dl' ? parse3dl(text) : parseCube(text);
      const tex    = this._compositor.uploadLUT(parsed.data, parsed.size);
      this._lutTexCache.set(assetId, tex);
      return tex;
    } catch (e) {
      console.warn('LUT load failed:', e);
      this._lutTexCache.set(assetId, null); // cache failure to avoid repeated attempts
      return null;
    }
  }

  _totalDuration() {
    if (!this._project) return 10;
    return Math.max(totalDuration(this._project), 10);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return clip.properties with any keyframed paths resolved at projectTime.
 * Returns the static properties object directly when no keyframes are set
 * (avoids the JSON clone overhead on every frame for non-animated clips).
 */
function resolveAnimatedProps(clip, projectTime) {
  if (!clip.keyframes || Object.keys(clip.keyframes).length === 0) return clip.properties;
  const props = JSON.parse(JSON.stringify(clip.properties));
  for (const path of Object.keys(clip.keyframes)) {
    const v = interpolate(clip, path, projectTime);
    if (v !== undefined) setPropPath(props, path, v);
  }
  return props;
}

function setPropPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => { if (o[k] == null) o[k] = {}; return o[k]; }, obj)[last] = val;
}
