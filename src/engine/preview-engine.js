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
import { clipsAtTime, totalDuration, interpolate, transitionClipsAtTime, getTransitionOutFactor, getDrawFrameIdx } from './edl.js';
import { parseCube, parse3dl }                   from './lut.js';
import { TextRenderer }                          from './text-renderer.js';
import { DrawRenderer }                          from './draw-renderer.js';
import { findActiveCue, renderCaptionToCanvas }  from './captions.js';

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
    this._fontCache   = new Map(); // fontFamily → true/false (loaded/failed)
    this._textRenderer = null;
    this._segEngine    = null;
    this._drawRenderer = null;
  }

  _getTextRenderer() {
    if (!this._textRenderer) this._textRenderer = new TextRenderer();
    return this._textRenderer;
  }

  _getDrawRenderer() {
    if (!this._drawRenderer) this._drawRenderer = new DrawRenderer();
    return this._drawRenderer;
  }

  async _ensureSegEngine() {
    if (this._segEngine) return this._segEngine;
    const { SegmentationEngine } = await import('./segmentation.js');
    this._segEngine = new SegmentationEngine();
    return this._segEngine;
  }

  async _ensureFont(fontFamily) {
    const SYSTEM = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
    if (!fontFamily || SYSTEM.includes(fontFamily)) return;
    if (this._fontCache.has(fontFamily)) return;
    const asset = this._project?.assets.find((a) => a.type === 'font' && a.fontFamily === fontFamily);
    if (!asset?.storageKey) { this._fontCache.set(fontFamily, false); return; }
    try {
      const ab  = await this._storage.readMedia(asset.storageKey);
      if (!ab) throw new Error('Font data not found');
      const buf  = ab instanceof ArrayBuffer ? ab : ab.buffer;
      const face = new FontFace(fontFamily, buf);
      await face.load();
      document.fonts.add(face);
      this._fontCache.set(fontFamily, true);
    } catch (e) {
      console.warn('Font load failed:', fontFamily, e);
      this._fontCache.set(fontFamily, false);
    }
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
    this._fontCache.clear();
    this._textRenderer?.dispose();
    this._textRenderer = null;
    this._segEngine?.dispose();
    this._segEngine = null;
    this._drawRenderer?.dispose();
    this._drawRenderer = null;
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
    const outPt   = this._project?.outPoint ?? null;
    const total   = outPt != null ? Math.min(outPt, this._totalDuration()) : this._totalDuration();

    if (t >= total) {
      this._playing     = false;
      this._currentTime = outPt != null ? outPt : 0;
      this._rafId       = null;
      this.dispatchEvent(new CustomEvent('preview:ended'));
      this._renderFrame(this._currentTime).catch(() => {});
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
      const cw = this._project.canvas.width;
      const ch = this._project.canvas.height;

      // Phase 1: Collect all draw operations asynchronously.
      // The canvas keeps showing the previous frame during all awaits — no black flash.
      const ops = [];

      const _pushClip = (src, props, w, h, alpha, lut, seg) =>
        ops.push({ kind: 'clip', src, props, w, h, alpha, lut, seg });
      const _pushSolid = (color) => ops.push({ kind: 'solid', color });
      const _pushAdj   = (props, lut) => ops.push({ kind: 'adj', props, lut });

      const active = clipsAtTime(this._project, time);
      for (const { clip, track } of active) {
        if (track.type === 'audio') continue;
        const outFactor = getTransitionOutFactor(clip, time) ?? 1;

        if (!clip.assetId) {
          if (clip.properties.text) {
            const props = resolveAnimatedProps(clip, time);
            await this._ensureFont(props.text?.fontFamily);
            const tex = this._getTextRenderer().render(props.text, cw, ch);
            _pushClip(tex, props, cw, ch, outFactor, null, null);
          } else if (clip.properties.drawing) {
            const drawing = clip.properties.drawing;
            const frameIdx = getDrawFrameIdx(clip, time);
            const strokes = drawing.frames?.[frameIdx]?.strokes;
            if (strokes?.length) {
              const props = resolveAnimatedProps(clip, time);
              const canvas = this._getDrawRenderer().renderFrame(strokes, cw, ch);
              _pushClip(canvas, props, cw, ch, outFactor, null, null);
            }
          } else if (clip.properties.adjustment) {
            const props = resolveAnimatedProps(clip, time);
            const lutTex = await this._resolveLUT(props.color?.lut);
            _pushAdj(props, lutTex);
          }
          continue;
        }

        const asset = this._project.assets.find((a) => a.id === clip.assetId);

        if (asset?.type === 'caption') {
          const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);
          const cue = findActiveCue(asset.captions ?? [], clipTime);
          if (cue) {
            const props = resolveAnimatedProps(clip, time);
            const capCanvas = renderCaptionToCanvas(cue.text, props.caption ?? {}, cw, ch);
            _pushClip(capCanvas, props, cw, ch, outFactor, null, null);
          }
          continue;
        }

        if (!asset || !asset.storageKey) {
          _pushSolid([0.15, 0.04, 0.04, 1]);
          continue;
        }

        const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);
        try {
          const dec = await this._decoders.getDecoder(this._proxyAsset(asset));
          await dec.seekTo(clipTime);
          const src = dec.getSource();
          if (src) {
            const props = resolveAnimatedProps(clip, time);
            const lutTex = await this._resolveLUT(props.color?.lut);
            let seg = null;
            if (props.seg?.enabled) {
              const segEng = await this._ensureSegEngine();
              const segResult = await segEng.segment(src);
              if (segResult) seg = { mask: segResult.mask, w: segResult.width, h: segResult.height };
            }
            _pushClip(src, props, dec.naturalWidth, dec.naturalHeight, outFactor, lutTex, seg);
          }
        } catch {
          _pushSolid([0.2, 0.05, 0.05, 1]);
        }
      }

      // Transition clips (fade-in dissolve)
      const transIn = transitionClipsAtTime(this._project, time);
      for (const { clip, track, factor, trStart } of transIn) {
        if (track.type === 'audio') continue;

        if (!clip.assetId) {
          if (clip.properties.text) {
            const props = resolveAnimatedProps(clip, time);
            await this._ensureFont(props.text?.fontFamily);
            const tex = this._getTextRenderer().render(props.text, cw, ch);
            _pushClip(tex, props, cw, ch, factor, null, null);
          } else if (clip.properties.drawing) {
            const drawing = clip.properties.drawing;
            const frameIdx = getDrawFrameIdx(clip, time);
            const strokes = drawing.frames?.[frameIdx]?.strokes;
            if (strokes?.length) {
              const props = resolveAnimatedProps(clip, time);
              const canvas = this._getDrawRenderer().renderFrame(strokes, cw, ch);
              _pushClip(canvas, props, cw, ch, factor, null, null);
            }
          }
          continue;
        }

        const asset = this._project.assets.find((a) => a.id === clip.assetId);
        if (asset?.type === 'caption') {
          const clipTime = (clip.trimIn ?? 0) + (time - trStart) * (clip.speed ?? 1);
          const cue = findActiveCue(asset.captions ?? [], clipTime);
          if (cue) {
            const props = resolveAnimatedProps(clip, time);
            const capCanvas = renderCaptionToCanvas(cue.text, props.caption ?? {}, cw, ch);
            _pushClip(capCanvas, props, cw, ch, factor, null, null);
          }
          continue;
        }
        if (!asset?.storageKey) continue;
        const clipMediaTime = (clip.trimIn ?? 0) + (time - trStart) * (clip.speed ?? 1);
        try {
          const dec = await this._decoders.getDecoder(this._proxyAsset(asset));
          await dec.seekTo(clipMediaTime);
          const src = dec.getSource();
          if (src) {
            const props = resolveAnimatedProps(clip, time);
            const lutTex = await this._resolveLUT(props.color?.lut);
            let seg = null;
            if (props.seg?.enabled) {
              const segEng = await this._ensureSegEngine();
              const segResult = await segEng.segment(src);
              if (segResult) seg = { mask: segResult.mask, w: segResult.width, h: segResult.height };
            }
            _pushClip(src, props, dec.naturalWidth, dec.naturalHeight, factor, lutTex, seg);
          }
        } catch { /* skip transition clip on error */ }
      }

      // Phase 2: Atomically clear + draw all collected ops (synchronous — no black flash).
      const bg = this._project.canvas?.background;
      this._compositor.clear(bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0);
      this._compositor.setTime(time);

      for (const op of ops) {
        if (op.kind === 'solid') {
          this._compositor.setActiveLUT(null);
          this._compositor.clearSegmentationMask();
          this._compositor.drawSolid(op.color);
        } else if (op.kind === 'adj') {
          this._compositor.setActiveLUT(op.lut);
          this._compositor.applyAdjustment(op.props, cw, ch);
        } else {
          this._compositor.setActiveLUT(op.lut ?? null);
          if (op.seg) this._compositor.setSegmentationMask(op.seg.mask, op.seg.w, op.seg.h);
          else this._compositor.clearSegmentationMask();
          this._compositor.drawClip(op.src, op.props, op.w, op.h, op.alpha);
        }
      }
    } finally {
      this._rendering = false;
    }
  }

  _proxyAsset(asset) {
    if (asset?.proxyKey) return { ...asset, storageKey: asset.proxyKey, id: asset.id + '__proxy' };
    return asset;
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
