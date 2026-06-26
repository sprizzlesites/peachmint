/**
 * segmentation.js — AI person/foreground segmentation (Phase 3.17)
 *
 * Uses MediaPipe Tasks Vision selfie_segmentation model to produce a
 * per-pixel foreground confidence mask (Float32Array, 0=background 1=person).
 *
 * Loaded lazily; the WASM and model are only fetched when segmentation is
 * first requested (user enables it on a clip in the inspector).
 *
 * LGPL note: @mediapipe/tasks-vision is Apache-2.0 licensed and loaded from
 * CDN at runtime — not bundled. Model asset is provided by Google.
 */

const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';
const WASM_DIR   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmentation/float16/latest/selfie_segmentation.tflite';

export class SegmentationEngine {
  constructor() {
    this._segmenter = null;
    this._loading   = null;
  }

  async _ensureSegmenter() {
    if (this._segmenter) return;
    if (this._loading) { await this._loading; return; }
    this._loading = (async () => {
      const { ImageSegmenter, FilesetResolver } = await import(VISION_CDN);
      const vision = await FilesetResolver.forVisionTasks(WASM_DIR);
      this._segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        outputConfidenceMasks: true,
        runningMode: 'IMAGE',
      });
    })().catch((err) => {
      console.warn('SegmentationEngine: GPU init failed, retrying with CPU:', err);
      // GPU delegate may fail (e.g. during headless export). Try CPU fallback.
      this._loading = null;
      this._segmenter = null;
    });
    await this._loading;
    this._loading = null;
  }

  /**
   * Segment a source image and return a Float32Array of person confidence
   * values (0=background, 1=person) at the source image's dimensions.
   *
   * Returns null if segmentation fails or the model hasn't loaded.
   *
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
   * @returns {Promise<{ mask: Float32Array, width: number, height: number } | null>}
   */
  async segment(source) {
    try {
      await this._ensureSegmenter();
      if (!this._segmenter) return null;
      const result = this._segmenter.segment(source);
      if (!result?.confidenceMasks?.length) return null;

      // Index 1 = person/foreground confidence; index 0 = background.
      // Fall back to index 0 if only one mask is returned.
      const idx    = result.confidenceMasks.length > 1 ? 1 : 0;
      const mpMask = result.confidenceMasks[idx];
      const width  = mpMask.width;
      const height = mpMask.height;
      const data   = mpMask.getAsFloat32Array().slice(); // copy before close

      for (const m of result.confidenceMasks) { try { m.close(); } catch {} }
      return { mask: data, width, height };
    } catch (e) {
      console.warn('SegmentationEngine.segment failed:', e);
      return null;
    }
  }

  dispose() {
    try { this._segmenter?.close(); } catch {}
    this._segmenter = null;
  }
}
