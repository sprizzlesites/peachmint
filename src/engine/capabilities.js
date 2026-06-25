/**
 * capabilities.js — Feature detection for PeachMint
 * Returns a structured capability map used by the UI to gate features
 * and explain to users what's available on their device.
 *
 * All checks are async (some require a canvas, worker ping, etc.).
 * Call detect() once at startup; cache the result.
 */

export const TIER = {
  FULL: 'full',       // Desktop Chrome/Edge: everything works
  NEAR_FULL: 'near-full', // Android Chrome: ~full, proxy res capped
  PARTIAL: 'partial', // Firefox: no WC encoder
  LIMITED: 'limited', // iOS Safari 17+: decoder only
  MINIMAL: 'minimal', // Older/unsupported: video element capture only
};

/**
 * @typedef {Object} Capabilities
 * @property {boolean} webCodecsDecode
 * @property {boolean} webCodesEncode
 * @property {boolean} webgl2
 * @property {boolean} webgpu
 * @property {boolean} offscreenCanvas
 * @property {boolean} workers
 * @property {boolean} opfs
 * @property {boolean} indexeddb
 * @property {boolean} audioContext
 * @property {boolean} serviceWorker
 * @property {boolean} sharedArrayBuffer
 * @property {boolean} persistStorage
 * @property {string}  tier
 * @property {string}  tierLabel
 * @property {string[]} warnings
 */

let _cached = null;

/** Run all capability checks and return a Capabilities object. Cached after first call. */
export async function detect() {
  if (_cached) return _cached;

  const warnings = [];

  // --- WebCodecs ---
  const webCodecsDecode = typeof VideoDecoder !== 'undefined';
  let webCodesEncode = typeof VideoEncoder !== 'undefined';
  if (webCodesEncode) {
    // Some browsers expose the constructor but no hardware encode support
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width: 1280,
        height: 720,
        bitrate: 5_000_000,
        framerate: 30,
      });
      webCodesEncode = support.supported === true;
    } catch {
      webCodesEncode = false;
    }
  }
  if (!webCodecsDecode) warnings.push('WebCodecs not available — using <video> fallback for playback.');
  if (!webCodesEncode) warnings.push('WebCodecs encode not available — export may be limited on this device.');

  // --- WebGL2 ---
  let webgl2 = false;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    webgl2 = !!canvas.getContext('webgl2');
  } catch {
    try {
      const el = document.createElement('canvas');
      webgl2 = !!el.getContext('webgl2');
    } catch { /* ignore */ }
  }
  if (!webgl2) warnings.push('WebGL2 not available — compositing and effects will be limited.');

  // --- WebGPU (optional) ---
  let webgpu = false;
  try {
    webgpu = 'gpu' in navigator && !!(await navigator.gpu?.requestAdapter());
  } catch { /* ignore */ }

  // --- OffscreenCanvas ---
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';

  // --- Web Workers ---
  const workers = typeof Worker !== 'undefined';
  if (!workers) warnings.push('Web Workers not available — performance will be degraded.');

  // --- OPFS ---
  let opfs = false;
  try {
    const root = await navigator.storage.getDirectory();
    opfs = !!root;
  } catch { /* not available */ }
  if (!opfs) warnings.push('Origin Private File System not available — using IndexedDB for media storage (slower).');

  // --- IndexedDB ---
  let indexeddb = false;
  try {
    indexeddb = typeof indexedDB !== 'undefined' && !!indexedDB;
  } catch { /* ignore */ }
  if (!indexeddb) warnings.push('IndexedDB not available — project save/load may not work.');

  // --- AudioContext ---
  const audioContext = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  if (!audioContext) warnings.push('Web Audio API not available — audio playback disabled.');

  // --- Service Worker ---
  const serviceWorker = 'serviceWorker' in navigator;
  if (!serviceWorker) warnings.push('Service Workers not supported — app will not work offline.');

  // --- SharedArrayBuffer (for optional ffmpeg.wasm multithreaded) ---
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

  // --- Storage persistence ---
  let persistStorage = false;
  try {
    persistStorage = await navigator.storage.persisted();
  } catch { /* ignore */ }

  // --- Derive tier ---
  const tier = deriveTier({ webCodecsDecode, webCodesEncode, webgl2, opfs, offscreenCanvas });
  const tierLabel = tierDescription(tier);

  _cached = {
    webCodecsDecode,
    webCodesEncode,
    webgl2,
    webgpu,
    offscreenCanvas,
    workers,
    opfs,
    indexeddb,
    audioContext,
    serviceWorker,
    sharedArrayBuffer,
    persistStorage,
    tier,
    tierLabel,
    warnings,
  };

  return _cached;
}

/** Force re-detection (e.g. after permission change). */
export function resetCache() {
  _cached = null;
}

function deriveTier({ webCodecsDecode, webCodesEncode, webgl2, opfs, offscreenCanvas }) {
  if (webCodecsDecode && webCodesEncode && webgl2 && opfs && offscreenCanvas) {
    // Could be Full or Near-Full — caller can check UA/device class separately
    return TIER.FULL;
  }
  if (webCodecsDecode && webgl2) {
    if (!webCodesEncode) return TIER.PARTIAL;
    return TIER.NEAR_FULL;
  }
  if (webCodecsDecode && !webCodesEncode) return TIER.LIMITED;
  return TIER.MINIMAL;
}

function tierDescription(tier) {
  switch (tier) {
    case TIER.FULL:      return 'Full — all features available';
    case TIER.NEAR_FULL: return 'Near-Full — hardware-limited resolution';
    case TIER.PARTIAL:   return 'Partial — export via alternative path';
    case TIER.LIMITED:   return 'Limited — preview only, export needs desktop/Android';
    case TIER.MINIMAL:   return 'Minimal — basic preview only';
    default:             return 'Unknown';
  }
}
