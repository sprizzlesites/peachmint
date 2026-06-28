/**
 * decoder.js — Per-asset media decoder for the preview pipeline
 *
 * ClipDecoder wraps a single asset's media file (video or image) in a
 * browser-native element, handles blob URL lifecycle, and provides
 * seek-and-wait semantics for frame-accurate reads.
 *
 * Primary path: HTMLVideoElement — GPU-accelerated decode, broad compat.
 * Future path: VideoDecoder (WebCodecs) for true frame-level access.
 *
 * DecoderPool manages a bounded set of ClipDecoders (one per assetId)
 * with LRU eviction so we don't accumulate unlimited blob URLs.
 */

// ─── ClipDecoder ──────────────────────────────────────────────────────────────

export class ClipDecoder {
  constructor(storageLayer) {
    this._storage = storageLayer;
    this._blobUrl = null;
    this._videoEl = null;
    this._imageEl = null;
    this._assetId = null;
    this._assetType = null;
    this._ready = false;
  }

  /**
   * Load media for a given asset from storage into a browser-native element.
   * Safe to call multiple times: no-op if the same assetId is already loaded.
   * @param {object} asset — EDL asset (id, storageKey, mimeType, type)
   */
  async load(asset) {
    if (this._assetId === asset.id && this._ready) return;
    this.dispose();

    this._assetId = asset.id;
    this._assetType = asset.type; // 'video' | 'image'

    const buf = await this._storage.readMedia(asset.storageKey);
    if (!buf) throw new Error(`Media not found in storage: ${asset.storageKey}`);

    const blob = new Blob([buf], { type: asset.mimeType || 'video/mp4' });
    this._blobUrl = URL.createObjectURL(blob);

    if (asset.type === 'image') {
      await this._loadImage();
    } else {
      await this._loadVideo();
    }

    this._ready = true;
  }

  async _loadVideo() {
    const vid = document.createElement('video');
    vid.src = this._blobUrl;
    vid.preload = 'auto';
    vid.muted = true;   // muted by default; unmuted in startPlay()
    vid.volume = 1;
    vid.playsInline = true;
    vid.crossOrigin = 'anonymous';
    // Must be in the DOM for GPU decode to work, but invisible
    Object.assign(vid.style, {
      position: 'absolute', width: '1px', height: '1px',
      opacity: '0', pointerEvents: 'none', top: '-2px', left: '-2px',
    });
    document.body.appendChild(vid);

    await new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(`Video decode error (code ${vid.error?.code})`)); };
      const cleanup = () => { vid.removeEventListener('loadedmetadata', onMeta); vid.removeEventListener('error', onErr); };
      vid.addEventListener('loadedmetadata', onMeta, { once: true });
      vid.addEventListener('error', onErr, { once: true });
      vid.load();
    });

    // iOS Safari does not decode any pixel data until play() is called, even with
    // preload='auto'. A muted play+pause primes the first frame so texImage2D works.
    try { await vid.play(); vid.pause(); vid.currentTime = 0; } catch {}

    this._videoEl = vid;
  }

  async _loadImage() {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = this._blobUrl;

    await new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', () => reject(new Error('Image load error')), { once: true });
    });

    this._imageEl = img;
  }

  /**
   * Seek the video element to a media-local time in seconds.
   * Returns after the browser confirms the seek. No-op for images.
   * No-op when the video is already playing (native playback in progress).
   * @param {number} time — media time in seconds
   */
  async seekTo(time) {
    if (!this._ready || !this._videoEl) return; // images: no-op
    const vid = this._videoEl;
    // During native playback, don't interrupt with explicit seeks.
    if (!vid.paused) return;
    // Skip if we already have frame data at the right position.
    if (vid.readyState >= 2 && Math.abs(vid.currentTime - time) < 1 / 1200) return;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const cleanup = () => {
        vid.removeEventListener('seeked', done);
        vid.removeEventListener('error', done);
      };
      vid.addEventListener('seeked', done, { once: true });
      vid.addEventListener('error', done, { once: true });
      vid.currentTime = Math.max(0, time);
      // Mobile Safari sometimes never fires 'seeked'; fall through after 400 ms.
      setTimeout(done, 400);
    });
  }

  /**
   * Start native video playback (used by preview engine during play mode).
   * Unmutes the video so its audio plays through the device speaker.
   * @param {number} time — media-local start time in seconds
   * @param {number} speed — playback rate
   * @param {number} volume — 0–1
   */
  async startPlay(time, speed = 1, volume = 1) {
    if (!this._videoEl) return;
    const vid = this._videoEl;
    vid.muted = false;
    vid.volume = Math.max(0, Math.min(1, volume));
    vid.playbackRate = Math.max(0.1, speed);
    if (Math.abs(vid.currentTime - time) > 0.1) vid.currentTime = Math.max(0, time);
    try { await vid.play(); } catch {}
  }

  /** Pause native playback and mute (returns to scrub mode). */
  stopPlay() {
    if (!this._videoEl) return;
    this._videoEl.pause();
    this._videoEl.muted = true;
  }

  get isVideoPlaying() { return this._videoEl ? !this._videoEl.paused : false; }

  /** Returns an element usable as a WebGL texture source, or null if not ready. */
  getSource() {
    if (!this._ready) return null;
    if (this._videoEl) {
      // Only return the video element when it has actual pixel data decoded.
      return this._videoEl.readyState >= 2 ? this._videoEl : null;
    }
    return this._imageEl ?? null;
  }

  get naturalWidth()  { return this._videoEl?.videoWidth ?? this._imageEl?.naturalWidth  ?? 0; }
  get naturalHeight() { return this._videoEl?.videoHeight ?? this._imageEl?.naturalHeight ?? 0; }
  get isReady()       { return this._ready; }

  dispose() {
    this._ready = false;
    if (this._videoEl) {
      this._videoEl.src = '';
      this._videoEl.remove();
      this._videoEl = null;
    }
    this._imageEl = null; // images aren't in the DOM
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    this._assetId = null;
    this._assetType = null;
  }
}

// ─── DecoderPool ──────────────────────────────────────────────────────────────

/**
 * Manages a bounded pool of ClipDecoders keyed by assetId.
 * Reuses existing decoders across renders; evicts the LRU entry when full.
 */
export class DecoderPool {
  constructor(storageLayer, maxSize = 8) {
    this._storage = storageLayer;
    this._maxSize = maxSize;
    this._pool = new Map(); // assetId → { decoder: ClipDecoder, lastUsed: number }
  }

  /**
   * Get (or create and load) a ClipDecoder for the given asset.
   * @param {object} asset
   * @returns {Promise<ClipDecoder>}
   */
  async getDecoder(asset) {
    const entry = this._pool.get(asset.id);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.decoder;
    }

    // Evict the least-recently-used entry if the pool is full
    if (this._pool.size >= this._maxSize) {
      let lruId = null, lruTs = Infinity;
      for (const [id, e] of this._pool) {
        if (e.lastUsed < lruTs) { lruTs = e.lastUsed; lruId = id; }
      }
      if (lruId) {
        this._pool.get(lruId).decoder.dispose();
        this._pool.delete(lruId);
      }
    }

    const decoder = new ClipDecoder(this._storage);
    await decoder.load(asset);
    this._pool.set(asset.id, { decoder, lastUsed: Date.now() });
    return decoder;
  }

  /** Pause all playing video decoders (call on preview stop or seek). */
  stopAllPlay() {
    for (const { decoder } of this._pool.values()) decoder.stopPlay();
  }

  dispose() {
    for (const { decoder } of this._pool.values()) decoder.dispose();
    this._pool.clear();
  }
}
