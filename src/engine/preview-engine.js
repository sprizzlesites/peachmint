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

import { Compositor }           from './compositor.js';
import { DecoderPool }          from './decoder.js';
import { clipsAtTime, totalDuration } from './edl.js';

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

    this._rendering = false; // guard against concurrent _renderFrame calls
    this._ready     = false;
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
    this._decoders?.dispose();
    this._compositor.dispose();
    this._ready = false;
  }

  // ─── Project ──────────────────────────────────────────────────────────────────

  /**
   * Bind a project to render. Updates canvas pixel dimensions to match canvas settings.
   * Pass null to clear and go dark.
   * @param {object|null} project
   */
  setProject(project) {
    this._project = project;
    if (project) {
      const { width, height } = project.canvas;
      if (this._canvas.width  !== width)  this._canvas.width  = width;
      if (this._canvas.height !== height) this._canvas.height = height;
    }
    if (this._compositor.isReady) this._compositor.clear(0, 0, 0);
  }

  // ─── Scrub ────────────────────────────────────────────────────────────────────

  /**
   * Render a single frame at the given time. Fire-and-forget; caller need not await.
   * @param {number} time — seconds
   */
  async seekTo(time) {
    if (!this._ready) return;
    this._currentTime = Math.max(0, time);
    await this._renderFrame(this._currentTime);
  }

  // ─── Playback ─────────────────────────────────────────────────────────────────

  /**
   * Start the RAF-based playback loop from the given time.
   * @param {number} [fromTime]
   */
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

  get isPlaying()    { return this._playing; }
  get currentTime()  { return this._currentTime; }
  get isReady()      { return this._ready; }

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
    this._renderFrame(t).catch(() => {}); // async; errors silently skipped
    this._scheduleRaf();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────────

  async _renderFrame(time) {
    if (!this._project || !this._compositor.isReady) return;
    if (this._rendering) return; // skip if a previous frame is still decoding
    this._rendering = true;

    try {
      const bg = this._project.canvas?.background;
      this._compositor.clear(bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0);

      const active = clipsAtTime(this._project, time);
      for (const { clip, track } of active) {
        if (track.type === 'audio') continue; // Web Audio handles audio (Phase 1.7)

        const asset = this._project.assets.find((a) => a.id === clip.assetId);
        if (!asset || !asset.storageKey) {
          // Clip with no backing asset → dark-red placeholder
          this._compositor.drawSolid([0.15, 0.04, 0.04, 1]);
          continue;
        }

        // Map project-time → media-time for this clip
        const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);

        try {
          const dec = await this._decoders.getDecoder(asset);
          await dec.seekTo(clipTime);
          const src = dec.getSource();
          if (src) {
            this._compositor.drawClip(src, clip.properties, dec.naturalWidth, dec.naturalHeight);
          }
        } catch (err) {
          // Decoder failure → dark-red placeholder, don't crash the frame
          this._compositor.drawSolid([0.2, 0.05, 0.05, 1]);
        }
      }
    } finally {
      this._rendering = false;
    }
  }

  _totalDuration() {
    if (!this._project) return 10;
    return Math.max(totalDuration(this._project), 10);
  }
}
