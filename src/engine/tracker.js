/**
 * tracker.js — Experimental 2-D object tracker (Phase 3.19)
 *
 * Uses Canvas 2D getImageData + sum-of-squared-differences (SSD) template
 * matching to follow a user-picked point across video frames.
 *
 * Output: array of { time, x, y } keyframes where x/y are canvas pixel offsets
 * from centre (matching the clip transform.x / transform.y coordinate system).
 *
 * Limitations:
 *   • No GPU — pure JS pixel loops. Works acceptably at TRACK_SCALE=0.25 for
 *     clips up to ~1080p; expect a few seconds per minute of footage.
 *   • Template is updated each frame (appearance model), which handles slow
 *     lighting changes but can drift on fast motion or occlusion.
 *   • Straight SSD, no sub-pixel precision, no pyramid.
 */

export class TrackingEngine {
  /**
   * Track a point in a video clip across project time.
   *
   * @param {object}   clip       — EDL clip (must have assetId + startTime/duration/speed/trimIn)
   * @param {object}   project    — full project (for canvas dimensions + assets list)
   * @param {object}   storage    — StorageLayer
   * @param {number}   anchorNX   — normalised [0-1] x position in clip frame
   * @param {number}   anchorNY   — normalised [0-1] y position in clip frame
   * @param {(ratio: number) => void} onProgress
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{time:number, x:number, y:number}>>}
   */
  async track(clip, project, storage, anchorNX, anchorNY, onProgress = () => {}, signal = null) {
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (!asset?.storageKey) throw new Error('Asset not found');

    const ab = await storage.readMedia(asset.storageKey);
    if (!ab) throw new Error('Could not read asset data');

    const buf  = ab instanceof ArrayBuffer ? ab : ab.buffer;
    const blob = new Blob([buf], { type: asset.mimeType ?? 'video/mp4' });
    const url  = URL.createObjectURL(blob);

    try {
      return await this._trackUrl(url, clip, project, anchorNX, anchorNY, onProgress, signal);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async _trackUrl(url, clip, project, anchorNX, anchorNY, onProgress, signal) {
    const TRACK_FPS   = Math.min(project.canvas?.fps ?? 30, 10); // max 10 fps to keep it fast
    const TRACK_SCALE = 0.25;    // work at 25% native resolution
    const PATCH_SIZE  = 32;      // template patch side length (scaled pixels)
    const SEARCH_R    = 64;      // search half-window (scaled pixels)

    const cw = project.canvas.width;
    const ch = project.canvas.height;

    // Load video metadata
    const video = document.createElement('video');
    video.muted    = true;
    video.preload  = 'auto';
    video.src      = url;
    await new Promise((res, rej) => {
      video.addEventListener('loadedmetadata', res, { once: true });
      video.addEventListener('error', (e) => rej(new Error('Video load failed: ' + (e.message ?? 'unknown'))), { once: true });
    });

    if (signal?.aborted) throw new Error('Tracking cancelled');

    const vw = Math.max(1, video.videoWidth  || cw);
    const vh = Math.max(1, video.videoHeight || ch);

    // Scaled working canvas
    const sw = Math.max(32, Math.round(vw * TRACK_SCALE));
    const sh = Math.max(32, Math.round(vh * TRACK_SCALE));
    const canvas = document.createElement('canvas');
    canvas.width  = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const keyframes = [];
    const dt        = 1 / TRACK_FPS;
    const totalSteps = Math.max(1, Math.ceil(clip.duration * TRACK_FPS));
    let step = 0;

    let template = null;
    let lastNX   = anchorNX;
    let lastNY   = anchorNY;

    for (let t = 0; t < clip.duration; t += dt) {
      if (signal?.aborted) throw new Error('Tracking cancelled');

      const projectTime  = clip.startTime + t;
      const clipMediaTime = (clip.trimIn ?? 0) + t * (clip.speed ?? 1);

      await seekVideo(video, clipMediaTime);
      if (signal?.aborted) throw new Error('Tracking cancelled');

      ctx.drawImage(video, 0, 0, sw, sh);
      const imageData = ctx.getImageData(0, 0, sw, sh);
      const gray      = toGrayscale(imageData.data, sw, sh);

      if (!template) {
        // First frame: anchor defines the initial template
        const px = Math.round(anchorNX * sw);
        const py = Math.round(anchorNY * sh);
        template = extractPatch(gray, sw, sh, px, py, PATCH_SIZE);
        lastNX   = anchorNX;
        lastNY   = anchorNY;
      } else {
        // Subsequent frames: search for best SSD match near last position
        const cx = Math.round(lastNX * sw);
        const cy = Math.round(lastNY * sh);
        const [bx, by] = ssdSearch(gray, sw, sh, template, PATCH_SIZE, cx, cy, SEARCH_R);
        lastNX   = bx / sw;
        lastNY   = by / sh;
        // Update template so tracker adapts to appearance changes
        template = extractPatch(gray, sw, sh, bx, by, PATCH_SIZE);
      }

      // Convert to canvas-pixel offset from centre (matches transform.x/y)
      keyframes.push({
        time: projectTime,
        x:    (lastNX - 0.5) * cw,
        y:    (lastNY - 0.5) * ch,
      });

      step++;
      onProgress(step / totalSteps);
    }

    return keyframes;
  }
}

// ─── SSD template matching ────────────────────────────────────────────────────

function toGrayscale(data, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const b4 = i * 4;
    gray[i] = (77 * data[b4] + 150 * data[b4 + 1] + 29 * data[b4 + 2]) >> 8;
  }
  return gray;
}

function extractPatch(gray, w, h, cx, cy, size) {
  const half  = size >> 1;
  const patch = new Int16Array(size * size);
  let pi = 0;
  for (let dy = -half; dy < half; dy++) {
    for (let dx = -half; dx < half; dx++) {
      const sx = Math.max(0, Math.min(w - 1, cx + dx));
      const sy = Math.max(0, Math.min(h - 1, cy + dy));
      patch[pi++] = gray[sy * w + sx];
    }
  }
  return patch;
}

function ssdSearch(gray, w, h, template, patchSize, cx, cy, searchRadius) {
  const half   = patchSize >> 1;
  let bestX    = cx, bestY = cy, bestSSD = Infinity;

  const x0 = Math.max(half, cx - searchRadius);
  const x1 = Math.min(w - half - 1, cx + searchRadius);
  const y0 = Math.max(half, cy - searchRadius);
  const y1 = Math.min(h - half - 1, cy + searchRadius);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let ssd = 0;
      let pi  = 0;
      outer: for (let dy = -half; dy < half; dy++) {
        const rowBase = (y + dy) * w + x - half;
        for (let dx = -half; dx < half; dx++) {
          const diff = gray[rowBase + dx] - template[pi++];
          ssd += diff * diff;
          if (ssd >= bestSSD) break outer;
        }
      }
      if (ssd < bestSSD) { bestSSD = ssd; bestX = x; bestY = y; }
    }
  }

  return [bestX, bestY];
}

// ─── Seek helper ─────────────────────────────────────────────────────────────

function seekVideo(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.002) { resolve(); return; }
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}
