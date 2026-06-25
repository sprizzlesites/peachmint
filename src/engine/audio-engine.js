/**
 * audio-engine.js — Web Audio playback engine (Phase 1.7)
 *
 * Plays audio-track clips in sync with the RAF-based PreviewEngine by
 * scheduling AudioBufferSourceNodes at precise AudioContext times.
 *
 * Volume keyframe automation is mapped to the Web Audio AudioParam timeline:
 *   linear/ease/bezier → linearRampToValueAtTime
 *   hold               → setValueAtTime (step)
 *
 * Async buffer loads are guarded by a _stopped flag so that stop() called
 * during an in-progress play() cancels any pending schedules.
 */

export class AudioEngine {
  /** @param {{ storage: import('./storage.js').StorageLayer }} opts */
  constructor({ storage }) {
    this._storage   = storage;
    this._ctx       = null;
    this._project   = null;
    this._sources   = [];       // { source: AudioBufferSourceNode, gain: GainNode }[]
    this._buffers   = new Map(); // assetId → AudioBuffer (decoded, cached)
    this._playing   = false;
    this._stopped   = false;    // guard: set true by stop(), aborts async scheduling
    this._wallStart = 0;        // AudioContext.currentTime at the moment play() began
    this._fromTime  = 0;        // project time we started playing from
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this._ctx) return;
    try {
      this._ctx = new AudioContext();
    } catch {
      // Will retry lazily in play() after a user gesture if blocked by browser policy
    }
  }

  dispose() {
    this.stop();
    this._ctx?.close().catch(() => {});
    this._ctx = null;
    this._buffers.clear();
  }

  setProject(project) {
    this._project = project;
    // Flush buffer cache so stale buffers from a previous project don't linger
    this._buffers.clear();
  }

  get isPlaying() { return this._playing; }

  // ─── Playback ──────────────────────────────────────────────────────────────

  /**
   * Start playing audio from the given project time.
   * Async because it may need to decode audio buffers from OPFS.
   * @param {number} fromTime — project time in seconds
   */
  async play(fromTime) {
    if (!this._project || this._playing) return;

    // Lazy AudioContext creation for browsers requiring a user gesture
    if (!this._ctx) {
      try { this._ctx = new AudioContext(); } catch { return; }
    }
    // Safari/iOS auto-suspend; resume before scheduling
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume().catch(() => {});
    }

    this._playing   = true;
    this._stopped   = false;
    this._fromTime  = fromTime;
    this._wallStart = this._ctx.currentTime;

    await this._scheduleAll(fromTime);
  }

  /** Stop all playing audio immediately. */
  stop() {
    this._playing = false;
    this._stopped = true;
    this._stopAll();
  }

  // ─── Internal: scheduling ──────────────────────────────────────────────────

  async _scheduleAll(fromTime) {
    if (!this._project) return;

    for (const track of this._project.tracks) {
      if (this._stopped) return;
      if (track.muted) continue;
      if (track.type !== 'audio') continue; // video audio extraction: Phase 2+

      for (const clip of track.clips) {
        if (this._stopped) return;
        if (clip.startTime + clip.duration <= fromTime) continue; // entirely in the past

        const asset = this._project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.storageKey || asset.type !== 'audio') continue;

        await this._scheduleClip(clip, asset, fromTime).catch(() => {});
      }
    }
  }

  async _scheduleClip(clip, asset, fromTime) {
    if (this._stopped) return;

    const buf = await this._getBuffer(asset);
    if (!buf || this._stopped) return;

    const speed     = clip.speed  ?? 1;
    const trimIn    = clip.trimIn ?? 0;
    const clipStart = clip.startTime;
    const clipEnd   = clip.startTime + clip.duration;

    // Where in the source buffer playback begins
    const projOffsetInClip = Math.max(0, fromTime - clipStart);
    const sourceOffsetBase = trimIn + projOffsetInClip * speed;

    // When (in AudioContext wall time) this clip should start
    const delaySeconds      = Math.max(0, clipStart - fromTime);
    const ctxScheduledStart = this._wallStart + delaySeconds;

    // Compensate for async buffer-load latency: if the scheduled start
    // is now in the past, advance the source offset to catch up.
    const now = this._ctx.currentTime;
    let ctxStart     = ctxScheduledStart;
    let sourceOffset = sourceOffsetBase;

    if (ctxScheduledStart < now) {
      const slippedWallSecs = now - ctxScheduledStart;
      sourceOffset += slippedWallSecs * speed;
      ctxStart = now + 0.015; // ~1 frame lookahead
    }

    // Remaining project duration to play
    const projPlayFrom   = Math.max(fromTime + (ctxStart - ctxScheduledStart), clipStart);
    const projRemaining  = clipEnd - projPlayFrom;
    const sourceDuration = projRemaining * speed;
    if (sourceDuration <= 0 || sourceOffset >= buf.duration) return;

    // Build audio graph: source → gain → destination
    const source = this._ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = speed;

    const gainNode = this._ctx.createGain();
    source.connect(gainNode);
    gainNode.connect(this._ctx.destination);

    // Schedule volume / keyframe automation on the GainNode
    this._scheduleGain(gainNode, clip, Math.max(fromTime, clipStart), ctxStart, clipEnd);

    source.start(
      ctxStart,
      sourceOffset,
      Math.min(sourceDuration, buf.duration - sourceOffset),
    );

    this._sources.push({ source, gain: gainNode });
  }

  /**
   * Schedule GainNode.gain automation to match clip volume keyframes.
   *
   * @param {GainNode} gainNode
   * @param {object}   clip
   * @param {number}   projStart   — project time at which audio actually starts (≥ clip.startTime)
   * @param {number}   ctxStart    — AudioContext time corresponding to projStart
   * @param {number}   clipEnd     — project time at which the clip ends
   */
  _scheduleGain(gainNode, clip, projStart, ctxStart, clipEnd) {
    const baseVol = clip.properties?.volume ?? 1;
    const kfs     = clip.keyframes?.volume ?? [];

    // Project time → AudioContext time
    const toCtx = (pt) => ctxStart + (pt - projStart);

    if (kfs.length === 0) {
      gainNode.gain.setValueAtTime(baseVol, ctxStart);
      return;
    }

    // Set initial gain at the exact start moment
    const initVal = _lerpKfs(kfs, projStart, baseVol);
    gainNode.gain.setValueAtTime(initVal, ctxStart);

    let prevVal = initVal;
    for (const kf of kfs) {
      if (kf.time < projStart) continue;
      if (kf.time > clipEnd)   break;

      const ctxT = toCtx(kf.time);

      if (kf.easing === 'hold') {
        // Step: hold prevVal until just before this keyframe, then snap
        gainNode.gain.setValueAtTime(prevVal, ctxT - 0.001);
        gainNode.gain.setValueAtTime(kf.value, ctxT);
      } else {
        // Linear ramp (close enough for ease/bezier in an audio context)
        gainNode.gain.linearRampToValueAtTime(kf.value, ctxT);
      }

      prevVal = kf.value;
    }
  }

  _stopAll() {
    for (const { source } of this._sources) {
      try { source.stop(0); } catch {}
    }
    this._sources = [];
  }

  /** Load and cache a decoded AudioBuffer for the given asset. */
  async _getBuffer(asset) {
    if (this._buffers.has(asset.id)) return this._buffers.get(asset.id);
    try {
      const ab = await this._storage.readMedia(asset.storageKey);
      if (!ab || this._stopped) return null;
      // decodeAudioData neuters the input ArrayBuffer; pass a copy to be safe
      const decoded = await this._ctx.decodeAudioData(
        ab instanceof ArrayBuffer ? ab.slice(0) : ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength),
      );
      this._buffers.set(asset.id, decoded);
      return decoded;
    } catch {
      return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Linear interpolation through a sorted keyframe array at time t.
 * Returns fallback when no keyframes exist.
 */
function _lerpKfs(kfs, t, fallback) {
  if (!kfs.length) return fallback;
  if (t <= kfs[0].time)              return kfs[0].value;
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (t >= kfs[i].time && t <= kfs[i + 1].time) {
      const frac = (t - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
      const a = kfs[i].value, b = kfs[i + 1].value;
      return typeof a === 'number' ? a + (b - a) * frac : a;
    }
  }
  return fallback;
}
