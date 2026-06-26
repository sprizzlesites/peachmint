/**
 * proxy-engine.js — Generate low-res preview proxies via ffmpeg.wasm (Phase 3.25)
 *
 * Creates a 480p H.264 proxy from a source video asset and stores it in OPFS/IDB.
 * Requires crossOriginIsolated = true (SharedArrayBuffer), provided by sw.js.
 *
 * Usage:
 *   const eng = new ProxyEngine({ storage });
 *   const proxyKey = await eng.generate(asset, onProgress);
 */

const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
const CORE_CDN   = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm/ffmpeg-core.js';
const CORE_WASM  = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.9/dist/esm/ffmpeg-core.wasm';

export class ProxyEngine {
  /** @param {{ storage: import('./storage.js').StorageLayer }} opts */
  constructor({ storage }) {
    this._storage = storage;
    this._ff      = null;
  }

  /** True if ffmpeg.wasm can run in this environment. */
  static get isAvailable() {
    return (
      typeof SharedArrayBuffer !== 'undefined' &&
      (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated)
    );
  }

  /**
   * Transcode a video asset to a 480p H.264 preview proxy.
   * @param {object} asset — must have .storageKey, .id, .name
   * @param {(progress: number) => void} onProgress — 0 → 1
   * @returns {Promise<string>} storageKey of the generated proxy file
   */
  async generate(asset, onProgress = () => {}) {
    if (!ProxyEngine.isAvailable) {
      throw new Error(
        'Proxy generation requires SharedArrayBuffer (Cross-Origin Isolation). Reload and try again.'
      );
    }

    const ff = await this._loadFFmpeg();

    const inName  = 'proxy_src.mp4';
    const outName = 'proxy_out.mp4';

    const srcBuf = await this._storage.readMedia(asset.storageKey);
    if (!srcBuf) throw new Error('Could not read source media for proxy generation.');

    const srcBytes = srcBuf instanceof Uint8Array ? srcBuf : new Uint8Array(
      srcBuf instanceof ArrayBuffer ? srcBuf : srcBuf.buffer.slice(srcBuf.byteOffset, srcBuf.byteOffset + srcBuf.byteLength)
    );
    await ff.writeFile(inName, srcBytes);

    // Track encode progress via ffmpeg log output
    let totalDur = 0;
    const logHandler = ({ message }) => {
      const mDur  = message.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (mDur)  totalDur = +mDur[1] * 3600 + +mDur[2] * 60 + parseFloat(mDur[3]);
      const mTime = message.match(/time=(\d+):(\d+):([\d.]+)/);
      if (mTime && totalDur > 0) {
        const cur = +mTime[1] * 3600 + +mTime[2] * 60 + parseFloat(mTime[3]);
        onProgress(Math.min(0.99, cur / totalDur));
      }
    };
    ff.on('log', logHandler);

    try {
      await ff.exec([
        '-i', inName,
        '-vf', 'scale=854:480:force_original_aspect_ratio=decrease',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        outName,
      ]);
    } finally {
      ff.off('log', logHandler);
    }

    const outBytes = await ff.readFile(outName);
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});

    const outBuf   = outBytes instanceof Uint8Array ? outBytes.buffer : outBytes;
    const proxyKey = await this._storage.writeMedia(`${asset.name ?? asset.id}_proxy.mp4`, outBuf);
    onProgress(1);
    return proxyKey;
  }

  async _loadFFmpeg() {
    if (this._ff) return this._ff;
    const { FFmpeg } = await import(FFMPEG_CDN);
    const ff = new FFmpeg();
    await ff.load({ coreURL: CORE_CDN, wasmURL: CORE_WASM });
    this._ff = ff;
    return ff;
  }
}
