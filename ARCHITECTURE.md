# PeachMint — Architecture Reference

> A free, open-source, fully client-side browser video editor.
> Mobile-first. No backend, no uploads, no accounts, no telemetry.

---

## Module Map

```
peachmint/
├── index.html                  # App entry; registers SW; bootstraps app-shell
├── manifest.json               # PWA manifest (icons, colors, display)
├── sw.js                       # Service worker — app-shell cache + offline strategy
│
├── src/
│   ├── engine/                 # Headless core — ZERO DOM/UI dependencies
│   │   ├── capabilities.js     # Feature detection (WebCodecs, WebGL2, OPFS, …)
│   │   ├── storage.js          # OPFS + IndexedDB abstraction; persist() request
│   │   ├── project.js          # Project lifecycle: new/open/save/autosave/migrate
│   │   ├── edl.js              # EDL schema + helpers (tracks, clips, keyframes)
│   │   ├── compositor.js       # WebGL2 render graph; OffscreenCanvas in worker
│   │   ├── decoder.js          # WebCodecs VideoDecoder / AudioDecoder wrappers
│   │   ├── encoder.js          # WebCodecs VideoEncoder + mp4-muxer / webm-muxer
│   │   ├── audio.js            # Web Audio API graph: mixing, cueing, automation
│   │   ├── proxy.js            # Proxy-media generation (downscale for scrubbing)
│   │   ├── history.js          # Undo/redo command stack
│   │   └── export.js           # Export pipeline: render graph → encode → mux
│   │
│   ├── ui/
│   │   ├── app-shell.js        # Bootstraps, detects device, routes desktop/mobile
│   │   ├── capability-panel.js # System-check overlay (shown on first load)
│   │   ├── desktop/            # Desktop UI shell (Phase 1.4)
│   │   │   ├── shell.js
│   │   │   ├── timeline.js
│   │   │   ├── preview.js
│   │   │   ├── inspector.js
│   │   │   └── toolbar.js
│   │   ├── mobile/             # Mobile UI shell (Phase 1.10)
│   │   │   ├── shell.js
│   │   │   ├── timeline-mobile.js
│   │   │   └── bottom-sheet.js
│   │   └── shared/             # Cross-shell components
│   │       ├── dialog.js       # <dialog>-based modal (no alert/confirm/prompt)
│   │       ├── keyframe-editor.js
│   │       └── export-panel.js
│   │
│   └── workers/
│       ├── decode.worker.js    # Decode loop (WebCodecs) — offloaded from main thread
│       ├── encode.worker.js    # Encode + mux loop
│       └── compositor.worker.js # WebGL2 composite in OffscreenCanvas
│
└── vendor/                     # Self-hosted CDN mirrors (see DEPENDENCIES.md)
```

---

## Engine API (headless, consumed by both UI shells)

### `capabilities.js`
```js
import { detect } from './capabilities.js';
const caps = await detect();
// caps.webcodecs, caps.webgl2, caps.webgpu, caps.opfs, caps.indexeddb,
// caps.audioContext, caps.serviceWorker, caps.offscreenCanvas,
// caps.sharedArrayBuffer, caps.workers
```

### `storage.js`
```js
import { StorageLayer } from './storage.js';
const store = new StorageLayer();
await store.init();   // requests persist(), detects OPFS vs IndexedDB

// Media blobs (large — OPFS preferred)
const id = await store.writeMedia(name, arrayBuffer);
const buf = await store.readMedia(id);
await store.deleteMedia(id);

// Project state (small — IndexedDB)
await store.saveProject(projectJSON);
const projectJSON = await store.loadProject(id);
await store.deleteProject(id);
await store.listProjects();

// Quota
const { usage, quota } = await store.getQuota();
```

### `edl.js`  — Edit Decision List schema
```js
// Project root
{
  id: string,             // uuid
  name: string,
  version: 1,             // schema version for migrations
  createdAt: ISO8601,
  updatedAt: ISO8601,
  canvas: { width, height, fps, aspectRatio },
  tracks: Track[],
  assets: Asset[],        // media asset registry
}

// Track
{
  id, type: 'video'|'audio'|'overlay',
  name, muted, solo, locked,
  zIndex: number,         // render order (user-controlled)
  clips: Clip[],
}

// Clip
{
  id, assetId,
  startTime: number,      // seconds on timeline
  duration: number,
  trimIn: number,         // asset offset start
  trimOut: number,        // asset offset end
  speed: number,          // 1.0 = normal
  properties: { ... },    // opacity, transform, color, etc.
  keyframes: { [propPath]: Keyframe[] },
}

// Keyframe
{ time: number, value: any, easing: 'linear'|'ease'|'hold'|'bezier', handles?: [...] }

// Asset
{ id, name, type: 'video'|'audio'|'image', mimeType, opfsHandle|idbKey, width?, height?, duration? }
```

### `compositor.js`  — WebGL2 render graph
- Accepts a list of `Clip[]` sorted by `zIndex`, a `currentTime`, and a target `canvas`/`OffscreenCanvas`
- Each clip: decode frame via `decoder.js`, upload to WebGL2 texture, apply per-clip shader chain
- Shader chain: transform → opacity → blend mode → color correction → LUT → VFX
- Output to canvas; kept in a worker via `compositor.worker.js` using `OffscreenCanvas.transferControlToOffscreen()`

### `decoder.js`  — WebCodecs decode
- Wraps `VideoDecoder` + `AudioDecoder`
- Demux via mp4box.js (MP4) / matroska-demuxer (WebM)
- Produces `VideoFrame` objects fed to compositor; `AudioData` fed to audio engine
- Falls back to `<video>` element capture for unsupported codecs

### `audio.js`  — Web Audio graph
- `AudioContext` with sub-graphs per clip: `AudioBufferSourceNode → GainNode → MasterGain → destination`
- Scheduling: each clip scheduled by `source.start(contextTime)` with pre-buffered `AudioBuffer`
- Volume automation: `GainNode.gain.setValueCurveAtTime()` for fades
- Meters: `AnalyserNode` per track

### `history.js`  — Undo/redo
- Command pattern: each operation is `{ do(), undo() }` 
- Stack cap: 100 entries; snapshots EDL JSON for complex ops

---

## Data Flow

```
[Media File Import]
      │
      ▼
[decoder.js: demux+decode → VideoFrame/AudioData]
      │
      ├─► [proxy.js: downscale → OPFS proxy media]     (for timeline scrubbing)
      │
      └─► [storage.js: original → OPFS]                (for full-res export)

[Playback / Preview]
      │
      ▼
[compositor.worker.js: receive currentTime]
      │
[decoder.js: seek → VideoFrame]
      │
[WebGL2 pipeline: upload texture → shader chain → canvas]
      │
[Web Audio: schedule AudioBufferSourceNode at currentTime]

[Export]
      │
      ▼
[encoder.worker.js: full-res decode → WebGL2 composite → VideoEncoder → mp4-muxer]
      │
[Blob → download anchor]
```

---

## Storage Plan

| Data type            | Backend                    | Reason |
|----------------------|----------------------------|--------|
| Media blobs (large)  | OPFS (preferred)           | Fast binary I/O, worker-accessible |
| Project JSON / EDL   | IndexedDB                  | Structured queries, OPFS not suited |
| App shell / SW cache | Cache API via Service Worker | Offline first load |
| Tiny UI prefs        | localStorage               | Trivial, synchronous |
| OPFS unavailable     | IndexedDB fallback (chunked ArrayBuffer) | Android/iOS compat |

**Eviction resistance:** `navigator.storage.persist()` called at init. Estimated quota surfaced in a persistent status bar.

---

## Capability Tiers

| Tier   | Browser            | Capabilities |
|--------|--------------------|-------------|
| Full   | Chrome/Edge 120+   | WebCodecs enc+dec, WebGL2, WebGPU, OPFS, workers, OffscreenCanvas |
| Near-full | Android Chrome  | Same as Full; proxy resolution capped by device class |
| Partial | Firefox 120+      | No WebCodecs encoder (P0 export degraded) |
| Limited | iOS Safari 17+   | WebCodecs decoder only; export needs fallback; reduced proxy res |
| Minimal | Older browsers   | No WebCodecs; preview via `<video>` capture; no hardware export |

---

## PWA / Offline Strategy

- **App shell** (HTML/CSS/JS) cached via `sw.js` on install
- **Media** stored in OPFS/IDB — survives tab close
- `manifest.json`: `display: standalone`, theme peach-mint dark
- `navigator.storage.persist()` guards against eviction
- On reload: project auto-loaded from IndexedDB, media refs resolved from OPFS

---

## Rendering Pipeline (WebGL2)

Each frame render:
1. Clear `OffscreenCanvas`
2. For each visible clip (sorted by `zIndex` ascending):
   a. Seek `VideoDecoder` to `currentTime` → `VideoFrame`
   b. Upload `VideoFrame` to `WebGL2Texture` via `texImage2D`
   c. Apply shader chain (bound as uniforms): transform mat3 · opacity · blend mode · color correction · LUT 3D texture
   d. Draw fullscreen quad with clip's fragment shader
3. Present (transfer bitmap to main-thread canvas)

Shader chain is composited with porter-duff over each clip into the accumulation buffer.

---

## Two-UI Shell Strategy

```
index.html
  └── app-shell.js
        ├── detect: viewport < 768px OR touch-primary → mobile UI
        └── detect: viewport ≥ 768px OR pointer-fine → desktop UI
             [user can override with a toggle]

Desktop shell (src/ui/desktop/)          Mobile shell (src/ui/mobile/)
  Multi-panel layout                       Vertical, touch-first
  Resizable panels (CSS grid)              Bottom-sheet property editors
  Full keyboard shortcuts                  Large hit targets
  Precise scrubbing                        Gesture scrubbing / pinch-zoom
  Dockable inspector                       Collapsible track lanes

Both shells import the same engine API — no engine code in UI files.
```

---

## Deviation Log

_Any deviation from Section 2 of the build prompt is documented here._

- (none yet)
