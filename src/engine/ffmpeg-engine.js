/**
 * ffmpeg-engine.js — ffmpeg.wasm fallback encoder (Phase 2.16)
 *
 * Used when WebCodecs VideoEncoder is unavailable (Firefox, older Safari).
 * Requires crossOriginIsolated = true for SharedArrayBuffer, which is provided
 * by the sw.js COOP/COEP header patch.
 *
 * Same export() API as ExportEngine:
 *   const eng = new FFmpegEngine({ storage });
 *   const buf = await eng.export(project, settings, onProgress);
 *
 * Supports formats: 'mp4' (H.264/libx264) and 'webm' (VP8/libvpx).
 * Audio: omitted (OfflineAudioContext → WAV → ffmpeg audio track, deferred).
 *
 * LGPL isolation: @ffmpeg/ffmpeg and @ffmpeg/core are loaded lazily from CDN
 * and never bundled into app assets.
 */

import { Compositor }          from './compositor.js';
import { DecoderPool }         from './decoder.js';
import { TextRenderer }        from './text-renderer.js';
import { clipsAtTime, totalDuration, transitionClipsAtTime, getTransitionOutFactor } from './edl.js';
import { parseCube, parse3dl } from './lut.js';

const FFMPEG_CDN  = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
const CORE_CDN    = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm/ffmpeg-core.js';
const CORE_WASM   = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm/ffmpeg-core.wasm';

export class FFmpegEngine {
  /** @param {{ storage: import('./storage.js').StorageLayer }} opts */
  constructor({ storage }) {
    this._storage   = storage;
    this._aborted   = false;
    this._ff        = null;
    this._fontCache = new Map();
  }

  /** True if SharedArrayBuffer is available (cross-origin isolation is active). */
  static get isAvailable() {
    return typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated);
  }

  /** Cancel an in-progress export. Terminates the ffmpeg worker. */
  abort() {
    this._aborted = true;
    try { this._ff?.terminate(); } catch { /* ignore */ }
    this._ff = null;
  }

  // ─── Lazy ffmpeg loader ──────────────────────────────────────────────────────

  async _loadFFmpeg(onLog) {
    if (this._ff) return this._ff;
    const { FFmpeg } = await import(FFMPEG_CDN);
    const ff = new FFmpeg();
    if (onLog) ff.on('log', ({ message }) => onLog(message));
    await ff.load({ coreURL: CORE_CDN, wasmURL: CORE_WASM });
    this._ff = ff;
    return ff;
  }

  // ─── Main export ─────────────────────────────────────────────────────────────

  /**
   * Render every frame with the WebGL compositor, encode via ffmpeg.wasm.
   *
   * @param {object}   project
   * @param {{ format, width, height, fps, videoBitrate }} settings
   * @param {(progress: number) => void} onProgress — 0 → 1
   * @returns {Promise<ArrayBuffer>}
   */
  async export(project, settings, onProgress = () => {}) {
    if (!FFmpegEngine.isAvailable) {
      throw new Error(
        'ffmpeg.wasm requires SharedArrayBuffer, which needs Cross-Origin Isolation. ' +
        'Try reloading the page; the PeachMint service worker enables this automatically.'
      );
    }
    this._aborted = false;

    const {
      width        = project.canvas.width,
      height       = project.canvas.height,
      fps          = project.canvas.fps ?? 30,
      videoBitrate = 8_000_000,
      format       = 'mp4',
    } = settings;

    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is not available in this browser.');
    }

    const ff = await this._loadFFmpeg();
    if (this._aborted) throw new Error('Export cancelled');

    const offscreen    = new OffscreenCanvas(width, height);
    const compositor   = new Compositor(offscreen);
    compositor.init();
    const decoders     = new DecoderPool(this._storage);
    const lutCache     = new Map();
    const textRenderer = new TextRenderer();
    this._fontCache.clear();

    // 2D canvas for WebGL → PNG conversion (avoids preserveDrawingBuffer issues)
    const tmpCanvas = new OffscreenCanvas(width, height);
    const tmp2d     = tmpCanvas.getContext('2d');

    const duration    = Math.max(totalDuration(project), 0.01);
    const frameDur    = 1 / fps;
    const totalFrames = Math.ceil(duration * fps);
    const RENDER_WEIGHT = 0.75; // 75% progress for frame rendering

    let framesWritten = 0;
    try {
      // Phase 1: render frames and write to ffmpeg VFS
      for (let i = 0; i < totalFrames; i++) {
        if (this._aborted) throw new Error('Export cancelled');
        const time = i * frameDur;
        await this._renderFrame(compositor, decoders, project, time, lutCache, textRenderer);

        // Transfer WebGL framebuffer to ImageBitmap, then draw to 2D canvas for PNG
        const bitmap = offscreen.transferToImageBitmap();
        tmp2d.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await tmpCanvas.convertToBlob({ type: 'image/png' });
        const pngData = new Uint8Array(await pngBlob.arrayBuffer());

        const name = `frame${String(i).padStart(5, '0')}.png`;
        await ff.writeFile(name, pngData);
        framesWritten++;
        onProgress(((i + 1) / totalFrames) * RENDER_WEIGHT);
      }

      if (this._aborted) throw new Error('Export cancelled');

      // Phase 2: encode with ffmpeg
      onProgress(RENDER_WEIGHT);
      const isWebM  = format === 'webm';
      const outFile = isWebM ? 'out.webm' : 'out.mp4';
      const codec   = isWebM ? 'libvpx'   : 'libx264';
      const bitrateK = Math.round(videoBitrate / 1000);

      const ffArgs = [
        '-framerate', String(fps),
        '-i', 'frame%05d.png',
        '-c:v', codec,
        '-b:v', `${bitrateK}k`,
        ...(isWebM ? ['-auto-alt-ref', '0'] : ['-pix_fmt', 'yuv420p', '-preset', 'fast', '-movflags', '+faststart']),
        outFile,
      ];

      const ret = await ff.exec(ffArgs);
      if (ret !== 0) throw new Error(`ffmpeg exited with code ${ret}`);
      if (this._aborted) throw new Error('Export cancelled');

      // Phase 3: read output
      const outData = await ff.readFile(outFile);
      onProgress(1);
      return outData.buffer;

    } finally {
      compositor.dispose();
      decoders.dispose();
      // Clean up VFS to free memory
      for (let i = 0; i < framesWritten; i++) {
        try { await ff.deleteFile(`frame${String(i).padStart(5, '0')}.png`); } catch { /* ignore */ }
      }
      try { await ff.deleteFile('out.mp4'); } catch { /* ignore */ }
      try { await ff.deleteFile('out.webm'); } catch { /* ignore */ }
    }
  }

  // ─── Frame rendering (mirrors ExportEngine._renderFrame) ────────────────────

  async _renderFrame(compositor, decoders, project, time, lutCache, textRenderer) {
    const bg = project.canvas?.background;
    compositor.clear(bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0);
    compositor.setTime(time);

    const cw = project.canvas.width;
    const ch = project.canvas.height;

    const active = clipsAtTime(project, time);
    for (const { clip, track } of active) {
      if (track.type === 'audio') continue;
      const outFactor = getTransitionOutFactor(clip, time);

      if (!clip.assetId) {
        if (clip.properties.text && textRenderer) {
          const props = resolveProps(clip, time);
          await this._ensureFont(props.text?.fontFamily, project);
          const tex = textRenderer.render(props.text, cw, ch);
          compositor.setActiveLUT(null);
          compositor.drawClip(tex, props, cw, ch, outFactor ?? 1);
        }
        continue;
      }

      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset?.storageKey) { compositor.drawSolid([0.15, 0.04, 0.04, 1]); continue; }

      const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);
      try {
        const dec = await decoders.getDecoder(asset);
        await dec.seekTo(clipTime);
        const src = dec.getSource();
        if (src) {
          const props  = resolveProps(clip, time);
          const lutTex = await resolveLUT(props.color?.lut, project, compositor, this._storage, lutCache);
          compositor.setActiveLUT(lutTex);
          compositor.drawClip(src, props, dec.naturalWidth, dec.naturalHeight, outFactor ?? 1);
        }
      } catch {
        compositor.drawSolid([0.2, 0.05, 0.05, 1]);
      }
    }

    const transIn = transitionClipsAtTime(project, time);
    for (const { clip, track, factor, trStart } of transIn) {
      if (track.type === 'audio') continue;

      if (!clip.assetId) {
        if (clip.properties.text && textRenderer) {
          const props = resolveProps(clip, time);
          await this._ensureFont(props.text?.fontFamily, project);
          const tex = textRenderer.render(props.text, cw, ch);
          compositor.setActiveLUT(null);
          compositor.drawClip(tex, props, cw, ch, factor);
        }
        continue;
      }

      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset?.storageKey) continue;
      const clipMediaTime = (clip.trimIn ?? 0) + (time - trStart) * (clip.speed ?? 1);
      try {
        const dec = await decoders.getDecoder(asset);
        await dec.seekTo(clipMediaTime);
        const src = dec.getSource();
        if (src) {
          const props  = resolveProps(clip, time);
          const lutTex = await resolveLUT(props.color?.lut, project, compositor, this._storage, lutCache);
          compositor.setActiveLUT(lutTex);
          compositor.drawClip(src, props, dec.naturalWidth, dec.naturalHeight, factor);
        }
      } catch { /* skip */ }
    }
  }

  async _ensureFont(fontFamily, project) {
    const SYSTEM = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
    if (!fontFamily || SYSTEM.includes(fontFamily)) return;
    if (this._fontCache.has(fontFamily)) return;
    const asset = project.assets.find((a) => a.type === 'font' && a.fontFamily === fontFamily);
    if (!asset?.storageKey) { this._fontCache.set(fontFamily, false); return; }
    try {
      const ab  = await this._storage.readMedia(asset.storageKey);
      if (!ab) throw new Error('Font data not found');
      const buf  = ab instanceof ArrayBuffer ? ab : ab.buffer;
      const face = new FontFace(fontFamily, buf);
      await face.load();
      document.fonts.add(face);
      this._fontCache.set(fontFamily, true);
    } catch {
      this._fontCache.set(fontFamily, false);
    }
  }
}

// ─── Helpers (mirrors export-engine.js) ──────────────────────────────────────

function resolveProps(clip, time) {
  if (!clip.keyframes || Object.keys(clip.keyframes).length === 0) return clip.properties;
  const props = JSON.parse(JSON.stringify(clip.properties));
  for (const [path, kfs] of Object.entries(clip.keyframes)) {
    if (!kfs.length) continue;
    const v = lerpKfs(kfs, time);
    if (v !== undefined) setPropPath(props, path, v);
  }
  return props;
}

function lerpKfs(kfs, t) {
  if (!kfs.length) return undefined;
  if (t <= kfs[0].time)              return kfs[0].value;
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (t >= kfs[i].time && t <= kfs[i + 1].time) {
      const frac = (t - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
      const a = kfs[i].value, b = kfs[i + 1].value;
      return typeof a === 'number' ? a + (b - a) * frac : a;
    }
  }
}

function setPropPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => { if (o[k] == null) o[k] = {}; return o[k]; }, obj)[last] = val;
}

async function resolveLUT(assetId, project, compositor, storage, cache) {
  if (!assetId) return null;
  if (cache.has(assetId)) return cache.get(assetId);
  const asset = project.assets.find((a) => a.id === assetId && a.type === 'lut');
  if (!asset?.storageKey) return null;
  try {
    const ab     = await storage.readMedia(asset.storageKey);
    if (!ab) return null;
    const text   = new TextDecoder().decode(ab instanceof ArrayBuffer ? ab : ab.buffer);
    const parsed = asset.lutFormat === '3dl' ? parse3dl(text) : parseCube(text);
    const tex    = compositor.uploadLUT(parsed.data, parsed.size);
    cache.set(assetId, tex);
    return tex;
  } catch { cache.set(assetId, null); return null; }
}
