/**
 * audio-engine.js — Web Audio playback engine
 *
 * Audio graph:
 *   source → clip_gain → track_gain → track_pan → track_analyser
 *                                                         ↓
 *                                              master_gain → master_analyser → destination
 *
 * Per-clip gain carries keyframe volume automation.
 * Per-track gain + pan carries the mixer fader/pan controls.
 * Master gain carries the master volume slider.
 * AnalyserNodes on each track + master feed the VU meters.
 */

export class AudioEngine {
  /** @param {{ storage: import('./storage.js').StorageLayer }} opts */
  constructor({ storage }) {
    this._storage       = storage;
    this._ctx           = null;
    this._project       = null;
    this._sources       = [];        // { source: AudioBufferSourceNode, gain: GainNode }[]
    this._buffers       = new Map(); // assetId → AudioBuffer (decoded, cached)
    this._playing       = false;
    this._stopped       = false;
    this._wallStart     = 0;
    this._fromTime      = 0;
    // Master bus
    this._masterGain     = null;
    this._masterAnalyser = null;
    // Per-track nodes  Map<trackId, {gain, pan, analyser}>
    this._trackNodes     = new Map();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this._ctx) return;
    try {
      this._ctx = new AudioContext();
      this._buildMasterBus();
    } catch {
      // Will retry lazily in play() after a user gesture if blocked by browser policy
    }
  }

  dispose() {
    this.stop();
    this._disconnectTrackNodes();
    this._trackNodes.clear();
    this._masterGain     = null;
    this._masterAnalyser = null;
    this._ctx?.close().catch(() => {});
    this._ctx = null;
    this._buffers.clear();
  }

  setProject(project) {
    this._project = project;
    this._buffers.clear();
    this._disconnectTrackNodes();
    this._trackNodes.clear(); // recreated on next play()
  }

  get isPlaying() { return this._playing; }

  // ─── Mixer API ────────────────────────────────────────────────────────────

  setMasterVolume(v) {
    if (this._masterGain) this._masterGain.gain.value = Math.max(0, v);
  }

  setTrackVolume(trackId, v) {
    const node = this._trackNodes.get(trackId);
    if (node) node.gain.gain.value = Math.max(0, v);
  }

  setTrackPan(trackId, v) {
    const node = this._trackNodes.get(trackId);
    if (node) node.pan.pan.value = Math.max(-1, Math.min(1, v));
  }

  getMasterAnalyser() { return this._masterAnalyser; }
  getTrackAnalyser(trackId) { return this._trackNodes.get(trackId)?.analyser ?? null; }

  // ─── Playback ──────────────────────────────────────────────────────────────

  /**
   * Start playing audio from the given project time.
   * @param {number} fromTime — project time in seconds
   */
  async play(fromTime) {
    if (!this._project || this._playing) return;

    if (!this._ctx) {
      try { this._ctx = new AudioContext(); } catch { return; }
    }
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume().catch(() => {});
    }
    if (!this._masterGain) this._buildMasterBus();
    this._ensureTrackNodes(this._project.tracks);

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

  // ─── Internal: audio graph ─────────────────────────────────────────────────

  _buildMasterBus() {
    if (!this._ctx || this._masterGain) return;
    this._masterAnalyser = this._ctx.createAnalyser();
    this._masterAnalyser.fftSize = 256;
    this._masterGain = this._ctx.createGain();
    this._masterGain.gain.value = 1.0;
    this._masterGain.connect(this._masterAnalyser);
    this._masterAnalyser.connect(this._ctx.destination);
  }

  _ensureTrackNodes(tracks) {
    if (!this._ctx || !this._masterGain) return;
    const ids = new Set(tracks.map((t) => t.id));
    // Remove stale nodes for tracks that no longer exist
    for (const id of this._trackNodes.keys()) {
      if (!ids.has(id)) {
        const n = this._trackNodes.get(id);
        try { n.gain.disconnect(); n.pan.disconnect(); n.analyser.disconnect(); } catch {}
        this._trackNodes.delete(id);
      }
    }
    for (const track of tracks) {
      if (track.type === 'overlay') continue; // overlay tracks carry no audio
      if (!this._trackNodes.has(track.id)) {
        const gain    = this._ctx.createGain();
        gain.gain.value = Math.max(0, track.volume ?? 1);
        const pan     = this._ctx.createStereoPanner();
        pan.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));
        const analyser = this._ctx.createAnalyser();
        analyser.fftSize = 256;
        gain.connect(pan);
        pan.connect(analyser);
        analyser.connect(this._masterGain);
        this._trackNodes.set(track.id, { gain, pan, analyser });
      } else {
        // Sync values that may have changed while paused
        const node = this._trackNodes.get(track.id);
        node.gain.gain.value = Math.max(0, track.volume ?? 1);
        node.pan.pan.value   = Math.max(-1, Math.min(1, track.pan ?? 0));
      }
    }
  }

  _disconnectTrackNodes() {
    for (const n of this._trackNodes.values()) {
      try { n.gain.disconnect(); n.pan.disconnect(); n.analyser.disconnect(); } catch {}
    }
  }

  // ─── Internal: scheduling ──────────────────────────────────────────────────

  async _scheduleAll(fromTime) {
    if (!this._project) return;

    for (const track of this._project.tracks) {
      if (this._stopped) return;
      if (track.muted) continue;
      if (track.type === 'overlay') continue;

      for (const clip of track.clips) {
        if (this._stopped) return;
        if (clip.startTime + clip.duration <= fromTime) continue;

        const asset = this._project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.storageKey || (asset.type !== 'audio' && asset.type !== 'video')) continue;

        await this._scheduleClip(clip, asset, fromTime, track.id).catch(() => {});
      }
    }
  }

  async _scheduleClip(clip, asset, fromTime, trackId) {
    if (this._stopped) return;

    const buf = await this._getBuffer(asset);
    if (!buf || this._stopped) return;

    const speed     = clip.speed  ?? 1;
    const trimIn    = clip.trimIn ?? 0;
    const clipStart = clip.startTime;
    const clipEnd   = clip.startTime + clip.duration;

    const projOffsetInClip  = Math.max(0, fromTime - clipStart);
    const sourceOffsetBase  = trimIn + projOffsetInClip * speed;
    const delaySeconds      = Math.max(0, clipStart - fromTime);
    const ctxScheduledStart = this._wallStart + delaySeconds;

    const now = this._ctx.currentTime;
    let ctxStart     = ctxScheduledStart;
    let sourceOffset = sourceOffsetBase;

    if (ctxScheduledStart < now) {
      const slippedWallSecs = now - ctxScheduledStart;
      sourceOffset += slippedWallSecs * speed;
      ctxStart = now + 0.015; // ~1 frame lookahead to avoid underrun
    }

    const projPlayFrom   = Math.max(fromTime + (ctxStart - ctxScheduledStart), clipStart);
    const projRemaining  = clipEnd - projPlayFrom;
    const sourceDuration = projRemaining * speed;
    if (sourceDuration <= 0 || sourceOffset >= buf.duration) return;

    const source = this._ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = speed;

    // Clip-level gain carries keyframe volume automation
    const gainNode = this._ctx.createGain();
    source.connect(gainNode);

    // Route through track node → master bus (fallback: direct to master/destination)
    const trackNode = this._trackNodes.get(trackId);
    gainNode.connect(trackNode ? trackNode.gain : (this._masterGain ?? this._ctx.destination));

    this._scheduleGain(gainNode, clip, Math.max(fromTime, clipStart), ctxStart, clipEnd);

    source.start(
      ctxStart,
      sourceOffset,
      Math.min(sourceDuration, buf.duration - sourceOffset),
    );

    this._sources.push({ source, gain: gainNode });
  }

  /**
   * Schedule GainNode.gain automation for clip volume keyframes.
   */
  _scheduleGain(gainNode, clip, projStart, ctxStart, clipEnd) {
    const baseVol = clip.properties?.volume ?? 1;
    const kfs     = clip.keyframes?.volume ?? [];
    const toCtx   = (pt) => ctxStart + (pt - projStart);

    if (kfs.length === 0) {
      gainNode.gain.setValueAtTime(baseVol, ctxStart);
      return;
    }

    const initVal = _lerpKfs(kfs, projStart, baseVol);
    gainNode.gain.setValueAtTime(initVal, ctxStart);

    let prevVal = initVal;
    for (const kf of kfs) {
      if (kf.time < projStart) continue;
      if (kf.time > clipEnd)   break;

      const ctxT = toCtx(kf.time);
      if (kf.easing === 'hold') {
        gainNode.gain.setValueAtTime(prevVal, ctxT - 0.001);
        gainNode.gain.setValueAtTime(kf.value, ctxT);
      } else {
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
