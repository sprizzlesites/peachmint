/**
 * export-engine.js — WebCodecs + mp4-muxer offline export (Phase 1.8)
 *
 * Renders every video frame through the compositor onto an OffscreenCanvas,
 * encodes them with VideoEncoder (H.264/AVC), optionally renders + encodes
 * audio from audio-track clips via OfflineAudioContext + AudioEncoder (AAC),
 * and muxes everything into an MP4 ArrayBuffer using mp4-muxer.
 *
 * Usage:
 *   const eng = new ExportEngine({ storage });
 *   const buf = await eng.export(project, settings, onProgress);
 *   // buf is an ArrayBuffer — save/download as .mp4
 */

import { Compositor }              from './compositor.js';
import { DecoderPool }             from './decoder.js';
import { clipsAtTime, totalDuration, transitionClipsAtTime, getTransitionOutFactor } from './edl.js';
import { parseCube, parse3dl }     from './lut.js';
import { TextRenderer }              from './text-renderer.js';

const MP4_MUXER_CDN = 'https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.5/+esm';

export class ExportEngine {
  /** @param {{ storage: import('./storage.js').StorageLayer }} opts */
  constructor({ storage }) {
    this._storage   = storage;
    this._aborted   = false;
    this._fontCache = new Map();
  }

  /** Cancel an in-progress export at the next frame boundary. */
  abort() { this._aborted = true; }

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

  // ─── Main export ─────────────────────────────────────────────────────────────

  /**
   * Render and encode the project to an MP4 ArrayBuffer.
   *
   * @param {object}   project
   * @param {{ width, height, fps, videoBitrate, audioBitrate, includeAudio }} settings
   * @param {(progress: number) => void} onProgress — 0 → 1
   * @returns {Promise<ArrayBuffer>}
   */
  async export(project, settings, onProgress = () => {}) {
    this._aborted = false;

    const {
      width        = project.canvas.width,
      height       = project.canvas.height,
      fps          = project.canvas.fps ?? 30,
      videoBitrate = 8_000_000,
      audioBitrate = 128_000,
      includeAudio = true,
    } = settings;

    // ── Feature detection ───────────────────────────────────────────────────
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder is not available in this browser. Try Chrome 94+ or Edge 94+.');
    }
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is not available in this browser.');
    }

    // ── Load mp4-muxer (lazy CDN import — only during export) ───────────────
    const { Muxer, ArrayBufferTarget } = await import(MP4_MUXER_CDN);
    if (this._aborted) throw new Error('Export cancelled');

    // ── Decide whether to include audio ─────────────────────────────────────
    const hasAudioTracks = includeAudio &&
      project.tracks.some((t) => t.type === 'audio' && !t.muted && t.clips.length > 0);

    // ── Set up muxer ────────────────────────────────────────────────────────
    const target     = new ArrayBufferTarget();
    const muxerOpts  = {
      target,
      video:     { codec: 'avc', width, height },
      fastStart: 'in-memory', // puts moov at file start; fine for up to ~8 GB in RAM
    };
    if (hasAudioTracks) {
      muxerOpts.audio = { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 };
    }
    const muxer = new Muxer(muxerOpts);

    // ── Set up VideoEncoder ─────────────────────────────────────────────────
    let videoError = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error:  (e) => { videoError = e; },
    });
    await videoEncoder.configure({
      codec:     'avc1.4d0028',  // H.264 Main Level 4.0
      width,
      height,
      bitrate:   videoBitrate,
      framerate: fps,
      avc:       { format: 'avc' }, // AVCC format (required by mp4-muxer)
    });

    // ── Set up AudioEncoder (optional) ──────────────────────────────────────
    let audioEncoder = null;
    if (hasAudioTracks && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error:  () => {},
      });
      await audioEncoder.configure({
        codec:            'mp4a.40.2', // AAC-LC
        numberOfChannels: 2,
        sampleRate:       44100,
        bitrate:          audioBitrate,
      });
    }

    // ── Compositor + decoder pool ────────────────────────────────────────────
    const offscreen  = new OffscreenCanvas(width, height);
    const compositor = new Compositor(offscreen);
    compositor.init();
    const decoders  = new DecoderPool(this._storage);
    const lutCache     = new Map(); // assetId → WebGLTexture (owned by compositor)
    const textRenderer = new TextRenderer();
    this._fontCache.clear();

    const duration      = Math.max(totalDuration(project), 0.01);
    const frameDuration = 1 / fps;
    const totalFrames   = Math.ceil(duration * fps);
    const KEY_INTERVAL  = fps * 2; // keyframe every 2 s
    const videoWeight   = hasAudioTracks ? 0.8 : 1.0;

    try {
      // ── Phase 1: encode video frames ──────────────────────────────────────
      for (let i = 0; i < totalFrames; i++) {
        if (this._aborted) throw new Error('Export cancelled');
        if (videoError)    throw videoError;

        const time = i * frameDuration;
        await this._renderFrame(compositor, decoders, project, time, lutCache, textRenderer);

        const bitmap = offscreen.transferToImageBitmap();
        const frame  = new VideoFrame(bitmap, {
          timestamp: Math.round(time * 1_000_000),           // µs
          duration:  Math.round(frameDuration * 1_000_000),  // µs
        });
        bitmap.close();

        videoEncoder.encode(frame, { keyFrame: i % KEY_INTERVAL === 0 });
        frame.close();

        // Backpressure: flush when the encode queue is deep
        if (videoEncoder.encodeQueueSize > 8) await videoEncoder.flush();

        onProgress(((i + 1) / totalFrames) * videoWeight);
      }

      await videoEncoder.flush();

      // ── Phase 2: encode audio (if applicable) ─────────────────────────────
      if (audioEncoder) {
        await this._encodeAudio(project, audioEncoder, duration, (p) => {
          onProgress(videoWeight + p * (1 - videoWeight));
        });
        await audioEncoder.flush();
      }

      // ── Finalize mux ──────────────────────────────────────────────────────
      muxer.finalize();

    } finally {
      // LUT textures are owned by compositor; dispose it first to release GL objects
      compositor.dispose();
      decoders.dispose();
    }

    if (this._aborted) throw new Error('Export cancelled');
    return target.buffer;
  }

  // ─── Video frame rendering ────────────────────────────────────────────────────

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
      if (!asset?.storageKey) {
        compositor.setActiveLUT(null);
        compositor.drawSolid([0.15, 0.04, 0.04, 1]);
        continue;
      }

      const clipTime = (time - clip.startTime) * (clip.speed ?? 1) + (clip.trimIn ?? 0);
      try {
        const dec = await decoders.getDecoder(asset);
        await dec.seekTo(clipTime);
        const src = dec.getSource();
        if (src) {
          const props  = resolveProps(clip, time);
          const lutTex = lutCache
            ? await resolveLUT(props.color?.lut, project, compositor, this._storage, lutCache)
            : null;
          compositor.setActiveLUT(lutTex);
          compositor.drawClip(src, props, dec.naturalWidth, dec.naturalHeight, outFactor ?? 1);
        }
      } catch {
        compositor.setActiveLUT(null);
        compositor.drawSolid([0.2, 0.05, 0.05, 1]);
      }
    }

    // Render clips fading in via cross-dissolve
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
          const lutTex = lutCache
            ? await resolveLUT(props.color?.lut, project, compositor, this._storage, lutCache)
            : null;
          compositor.setActiveLUT(lutTex);
          compositor.drawClip(src, props, dec.naturalWidth, dec.naturalHeight, factor);
        }
      } catch {}
    }
  }

  // ─── Audio rendering + encoding ───────────────────────────────────────────────

  async _encodeAudio(project, audioEncoder, totalSecs, onProgress) {
    const sampleRate = 44100;
    const channels   = 2;
    const length     = Math.ceil(sampleRate * totalSecs);

    // Offline render of the full audio mix
    const offCtx = new OfflineAudioContext(channels, length, sampleRate);

    for (const track of project.tracks) {
      if (track.muted || track.type !== 'audio') continue;
      for (const clip of track.clips) {
        if (this._aborted) return;
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.storageKey || asset.type !== 'audio') continue;

        try {
          const ab  = await this._storage.readMedia(asset.storageKey);
          if (!ab) continue;
          const raw = ab instanceof ArrayBuffer ? ab : ab.buffer;
          const buf = await offCtx.decodeAudioData(raw.slice(0));

          const src = offCtx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = clip.speed ?? 1;

          const gain = offCtx.createGain();
          gain.gain.setValueAtTime(clip.properties?.volume ?? 1, 0);

          // Basic volume keyframe support in offline context
          const kfs = clip.keyframes?.volume ?? [];
          for (const kf of kfs) {
            if (kf.easing === 'hold') {
              gain.gain.setValueAtTime(kf.value, kf.time);
            } else {
              gain.gain.linearRampToValueAtTime(kf.value, kf.time);
            }
          }

          src.connect(gain);
          gain.connect(offCtx.destination);

          const trimIn = clip.trimIn ?? 0;
          const srcDur = clip.duration * (clip.speed ?? 1);
          src.start(clip.startTime, trimIn, srcDur);
        } catch {}
      }
    }

    const rendered = await offCtx.startRendering();
    if (this._aborted) return;

    onProgress(0.5); // signal that offline render is done

    // Encode rendered PCM in chunks
    const CHUNK = 1024;
    const ch0 = rendered.getChannelData(0);
    const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;

    for (let offset = 0; offset < rendered.length; offset += CHUNK) {
      if (this._aborted) return;
      const frameCount = Math.min(CHUNK, rendered.length - offset);

      // f32-planar layout: all ch0 samples then all ch1 samples
      const data = new Float32Array(frameCount * 2);
      data.set(ch0.subarray(offset, offset + frameCount), 0);
      data.set(ch1.subarray(offset, offset + frameCount), frameCount);

      const audioData = new AudioData({
        format:           'f32-planar',
        sampleRate,
        numberOfFrames:   frameCount,
        numberOfChannels: 2,
        timestamp:        Math.round((offset / sampleRate) * 1_000_000), // µs
        data:             data.buffer,
      });
      audioEncoder.encode(audioData);
      audioData.close();

      if (audioEncoder.encodeQueueSize > 20) await audioEncoder.flush();

      onProgress(0.5 + ((offset + frameCount) / rendered.length) * 0.5);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveLUT(assetId, project, compositor, storage, cache) {
  if (!assetId) return null;
  if (cache.has(assetId)) return cache.get(assetId);
  const asset = project.assets.find((a) => a.id === assetId && a.type === 'lut');
  if (!asset?.storageKey) return null;
  try {
    const ab   = await storage.readMedia(asset.storageKey);
    if (!ab) return null;
    const text   = new TextDecoder().decode(ab instanceof ArrayBuffer ? ab : ab.buffer);
    const parsed = asset.lutFormat === '3dl' ? parse3dl(text) : parseCube(text);
    const tex    = compositor.uploadLUT(parsed.data, parsed.size);
    cache.set(assetId, tex);
    return tex;
  } catch { cache.set(assetId, null); return null; }
}

/** Resolve clip properties at a given project time, applying keyframe interpolation. */
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
