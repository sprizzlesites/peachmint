/**
 * waveform.js — Async waveform analysis and peak cache
 *
 * Uses OfflineAudioContext.decodeAudioData to decode any browser-supported
 * audio/video file, then computes normalized RMS peaks for display and
 * audio-peak-based clip alignment ("multi-cam sync").
 *
 * API:
 *   cache.get(storageKey)           → Promise<Float32Array|null>
 *   cache.getCached(storageKey)     → Float32Array|null (sync, null if not yet ready)
 *   cache.peakFileTime(key, dur)    → number|null  — file time of loudest peak
 *   cache.invalidate(storageKey)    → void
 */

const NUM_PEAKS = 400;

export class WaveformCache {
  constructor(storage) {
    this._storage = storage;
    this._cache   = new Map();   // storageKey → Float32Array | null
    this._pending = new Map();   // storageKey → Promise<Float32Array|null>
  }

  async get(storageKey) {
    if (this._cache.has(storageKey)) return this._cache.get(storageKey);
    if (this._pending.has(storageKey)) return this._pending.get(storageKey);
    const p = this._compute(storageKey)
      .then((peaks) => { this._cache.set(storageKey, peaks); this._pending.delete(storageKey); return peaks; })
      .catch(() => { this._cache.set(storageKey, null); this._pending.delete(storageKey); return null; });
    this._pending.set(storageKey, p);
    return p;
  }

  getCached(storageKey) {
    return this._cache.has(storageKey) ? (this._cache.get(storageKey) ?? null) : null;
  }

  peakFileTime(storageKey, fileDuration) {
    const peaks = this._cache.get(storageKey);
    if (!peaks || peaks.length === 0 || !fileDuration) return null;
    let maxIdx = 0;
    for (let i = 1; i < peaks.length; i++) {
      if (peaks[i] > peaks[maxIdx]) maxIdx = i;
    }
    return (maxIdx / peaks.length) * fileDuration;
  }

  invalidate(storageKey) {
    this._cache.delete(storageKey);
    this._pending.delete(storageKey);
  }

  async _compute(storageKey) {
    const ab = await this._storage.readMedia(storageKey);
    if (!ab) throw new Error('no media data');
    const actx   = new OfflineAudioContext(1, 44100, 44100);
    const decoded = await actx.decodeAudioData(ab);
    const data    = decoded.getChannelData(0);
    const block   = Math.max(1, Math.floor(data.length / NUM_PEAKS));
    const peaks   = new Float32Array(NUM_PEAKS);
    let maxPeak   = 0;
    for (let i = 0; i < NUM_PEAKS; i++) {
      const s = i * block;
      const e = Math.min(s + block, data.length);
      let sum = 0;
      for (let j = s; j < e; j++) sum += data[j] * data[j];
      peaks[i] = Math.sqrt(sum / Math.max(1, e - s));
      if (peaks[i] > maxPeak) maxPeak = peaks[i];
    }
    if (maxPeak > 0) for (let i = 0; i < NUM_PEAKS; i++) peaks[i] /= maxPeak;
    return peaks;
  }
}
