# PROGRESS — PeachMint Browser Video Editor

## ▶ RESUME HERE
Phase 2 · step 2.16 · Optional ffmpeg.wasm fallback (coi-serviceworker)

## Pending revisions (do these FIRST on next `continue`, in order)
- [ ] (none)

## Task list   — status keys: [ ] todo  [~] in progress  [x] done  [!] paused/blocked

### Phase 0 — Foundations
- [x] 0.1 ARCHITECTURE.md — written
- [x] 0.2 Buildless ES-module scaffold + PWA shell + service worker + capability check screen + DEPENDENCIES.md
  - [x] 0.2.1 index.html (app entry, PWA meta, dark UI shell)
  - [x] 0.2.2 manifest.json (PWA manifest)
  - [x] 0.2.3 sw.js (service worker, offline/cache)
  - [x] 0.2.4 src/engine/capabilities.js (feature detection module)
  - [x] 0.2.5 src/ui/capability-panel.js (system check UI)
  - [x] 0.2.6 src/ui/app-shell.js (shell router desktop/mobile)
  - [x] 0.2.7 DEPENDENCIES.md
  - [x] 0.2.8 LICENSE, NOTICE, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- [x] 0.3 Storage layer (OPFS + IndexedDB + persist) round-trip test
  - [x] 0.3.1 src/engine/storage.js (OPFS + IndexedDB abstraction)
  - [x] 0.3.2 src/engine/project.js (project data model, autosave stub)
  - [x] 0.3.3 src/engine/edl.js (EDL schema, keyframe model)
  - [x] 0.3.4 Storage round-trip smoke test in StorageLayer.selfTest() / capability panel

### Phase 1 — Playable core (MVP / P0)
- [x] 1.4 EDL model + multitrack timeline UI (desktop)
  - [x] 1.4.1 src/ui/desktop/shell.js — full desktop shell with start screen, project dialogs, keyboard shortcuts, transport
  - [x] 1.4.2 src/ui/desktop/timeline.js — multitrack timeline with ruler, playhead, clip drag, trim, track reorder (z-order)
  - [x] 1.4.3 src/ui/desktop/toolbar.js — tool selector, undo/redo, zoom, export stub
  - [x] 1.4.4 src/ui/desktop/inspector.js — clip/track properties, editable numeric props
  - [x] 1.4.5 src/ui/desktop/media-library.js — asset list, drag-to-timeline prep, import stub
  - [x] 1.4.6 app-shell.js updated to dynamically import real desktop shell
- [x] 1.5 WebCodecs decode → WebGL2 compositor → preview loop (one clip)
  - [x] 1.5.1 src/engine/compositor.js — WebGL2 pipeline (shaders, VAO, color correction, transform)
  - [x] 1.5.2 src/engine/decoder.js — ClipDecoder (HTMLVideoElement/Image, blob URL, seek-and-wait) + DecoderPool (LRU)
  - [x] 1.5.3 src/engine/preview-engine.js — RAF loop, scrub/play modes, preview:tick/ended events
  - [x] 1.5.4 shell.js — PreviewEngine wired to transport, project:dirty → timeline refresh
  - [x] 1.5.5 media-library.js — file import (picker + drag-drop), probe, OPFS write, Add to Timeline
- [x] 1.6 Import / trim / split / reorder / z-order / opacity+transform keyframes
  - [x] 1.6.1 edl.js — splitClip(), interpolate() for keyframe animation
  - [x] 1.6.2 preview-engine.js — resolveAnimatedProps() with keyframe interpolation per frame
  - [x] 1.6.3 inspector.js — keyframe add/delete UI (◆ button per property, keyframe list)
  - [x] 1.6.4 timeline.js — razor tool split, cross-track clip drag (ghost element), asset drop to lane, trimIn fix, trim-preview seek, keyframe diamond markers
  - [x] 1.6.5 shell.js — getCurrentTime wired to Inspector
- [x] 1.7 Web Audio: multi-clip, cueing, volume automation/fades
  - [x] 1.7.1 src/engine/audio-engine.js — AudioContext, AudioBufferSourceNode per clip, GainNode, buffer cache, async latency compensation, stop guard
  - [x] 1.7.2 Volume keyframe automation via AudioParam.linearRampToValueAtTime / setValueAtTime
  - [x] 1.7.3 shell.js — AudioEngine wired to play/stop/seek/project open/close
  - [x] 1.7.4 inspector.js — Volume propRow (0–2) with keyframe ◆ button
- [x] 1.8 Render targets + custom ratio + WebCodecs export (mp4-muxer)
  - [x] 1.8.1 src/engine/export-engine.js — ExportEngine (OffscreenCanvas + Compositor + DecoderPool, VideoEncoder H.264, AudioEncoder AAC, mp4-muxer ArrayBufferTarget)
  - [x] 1.8.2 toolbar.js — export button wired to onExport callback, enabled when project open
  - [x] 1.8.3 shell.js — _showExportDialog() with resolution/fps/bitrate selectors, progress bar + ETA, error display, MP4 download trigger
  - [x] 1.8.4 sw.js bumped to v6, export-engine.js added to APP_SHELL cache
- [x] 1.9 Autosave + project save/load + undo/redo
  - [x] 1.9.1 history.clear() on project open/close (prevents stale undo across projects)
  - [x] 1.9.2 Unsaved indicator: * suffix on project name via .pm-unsaved::after, wired to project:dirty/saved/autosaved
  - [x] 1.9.3 Inline project rename: double-click project name → editable input (Enter/Esc/blur commit)
  - [x] 1.9.4 Open project dialog: delete button per row with <dialog> confirmation, fix private storage access
  - [x] 1.9.5 sw.js bumped to v7
- [x] 1.10 Mobile UI shell over the same engine
  - [x] 1.10.1 src/ui/mobile/shell.js — MobileShell: header, canvas preview, transport, touch timeline (scroll/tap-seek/tap-select), bottom tab nav (Media/Clip/Export), menu sheet, project dialogs, import, undo/redo keyboard shortcuts
  - [x] 1.10.2 app-shell.js — dynamic import of mountMobileShell, removed placeholder
  - [x] 1.10.3 sw.js bumped to v8, mobile/shell.js added to APP_SHELL cache

### Phase 2 — Pro features (P1)
- [x] 2.11 Color correction + .cube/.3dl LUT import
- [x] 2.12 Chroma key + shape masks
- [x] 2.13 VFX shader library + open preset format + transitions
- [x] 2.14 Text + custom font import + cued static images
- [x] 2.15 Speed ramping + transparent WebM / GIF / PNG export
- [ ] 2.16 Optional ffmpeg.wasm fallback (coi-serviceworker)

### Phase 3 — Advanced (P2)
- [ ] 3.17 MediaPipe person/foreground segmentation → transparent bg
- [ ] 3.18 Draw-over-frame / hand-drawn animation + onion-skinning
- [ ] 3.19 Adjustment layers + experimental object tracking

## Decisions
- License: MIT
- ffmpeg.wasm: optional fallback (not default), WebCodecs primary
- Target devices: Desktop Chrome/Edge full suite; Android Chrome ~desktop; iOS Safari 16.4+ (degraded export)
- Fonts/LUTs: No bundled fonts (user-supplied); no bundled LUTs; open format for community packs

## Session log (append one entry per working session, newest at bottom)
- 2026-06-25 session 1 — did: Phase 0 complete — ARCHITECTURE.md, PROGRESS.md, index.html, manifest.json, sw.js, capabilities.js, storage.js, project.js, edl.js, history.js, app-shell.js, capability-panel.js, all OSS docs — committed + pushed · stopped at: end of Phase 0 · next: Phase 1.4 EDL model + multitrack timeline UI (desktop)
- 2026-06-25 session 2 — did: Phase 1.4 complete — shell.js (start screen, project dialogs, keyboard shortcuts, transport), timeline.js (ruler, playhead, clip drag/trim, track headers, z-order, zoom), toolbar.js, inspector.js, media-library.js, app-shell.js wired to real desktop shell · stopped at: end of 1.4 · next: Phase 1.5 WebCodecs decode → WebGL2 compositor → preview loop
- 2026-06-25 session 3 — did: Phase 1.5 complete — compositor.js (WebGL2 pipeline), decoder.js (ClipDecoder + DecoderPool), preview-engine.js (RAF loop, scrub/play modes), shell.js updated (PreviewEngine wired, project:dirty → timeline refresh, RAF-based play), media-library.js updated (full file import: picker + drag-drop, OPFS write, probe, Add to Timeline), app-shell.js async bug fixed · stopped at: end of 1.5 · next: Phase 1.6 Import / trim / split / reorder
- 2026-06-25 session 4 — did: Phase 1.6 complete — splitClip() in edl.js, resolveAnimatedProps() in preview-engine.js, inspector.js rewritten with keyframe ◆ buttons + keyframe list, timeline.js completed (razor split, cross-track ghost drag, asset-drop-to-lane, trimIn correction, trim-preview seek, keyframe diamond markers, _cmdSplitClip, _cmdAddClipFromAsset), sw.js bumped to v4 · stopped at: end of 1.6 · next: Phase 1.7 Web Audio
- 2026-06-25 session 5 — did: Phase 1.7 complete — audio-engine.js (AudioContext, AudioBufferSourceNode scheduling, GainNode volume, keyframe automation via AudioParam, buffer cache, async load + latency compensation, stop guard), inspector.js Volume propRow, shell.js AudioEngine wired (play/stop/seek/project events), sw.js bumped to v5 · stopped at: end of 1.7 · next: Phase 1.8 WebCodecs export
- 2026-06-25 session 6 — did: Phase 1.8 complete — export-engine.js (ExportEngine: OffscreenCanvas frame render, VideoEncoder H.264 AVCC, AudioEncoder AAC via OfflineAudioContext, mp4-muxer ArrayBufferTarget, abort/backpressure, keyframe interpolation), toolbar.js export button wired, shell.js _showExportDialog() (resolution/fps/bitrate UI, progress+ETA, error display, MP4 download), sw.js bumped to v6 · stopped at: end of 1.8 · next: Phase 1.9 autosave + save/load + undo/redo
- 2026-06-25 session 7 — did: Phase 1.9 complete — shell.js: history.clear() on project open/close, * unsaved indicator (project:dirty/saved/autosaved wired), inline project rename (dblclick name→input), open dialog delete per row (<dialog> confirm, _confirmDelete helper), fixed _storage private access, CSS .pm-unsaved::after + .pm-name-edit + .pm-proj-info + .pm-proj-del + .btn-danger, sw.js bumped to v7 · stopped at: end of 1.9 · next: Phase 1.10 mobile UI shell
- 2026-06-25 session 8 — did: Phase 1.10 complete — src/ui/mobile/shell.js (MobileShell: header+menu-sheet, canvas preview, touch transport, touch-scroll timeline with ruler/clips/playhead/tap-seek/clip-select, bottom tabs: Media library+import / Clip properties+delete / Export MP4 with progress, project dialogs, undo/redo keyboard shortcuts, injectStyles with full mobile CSS), app-shell.js updated to dynamically import mountMobileShell + removed placeholder, sw.js bumped to v8 · stopped at: end of Phase 1 · next: Phase 2.11 color correction + LUT
- 2026-06-25 session 9 — did: Phase 2.11 complete — src/engine/lut.js (parseCube, parse3dl, detectLUTFormat), compositor.js (FRAG shader upgraded with sampler3D u_lut + int u_lut_enabled, uploadLUT/setActiveLUT/disposeLUT, dummy 1×1×1 LUT on TEXTURE1, drawSolid explicit lutEnabled=0), preview-engine.js (LUT tex cache per assetId, _resolveLUT, setActiveLUT per clip, _clearLUTs on setProject/dispose), export-engine.js (same LUT loading with per-export lutCache map, resolveLUT helper), inspector.js (storage param, lutRow HTML, _onImportLUT/_ingestLUT/_onClearLUT/_showError, LUT CSS), shell.js (storage: this._storage → Inspector), sw.js bumped to v9 with lut.js · stopped at: end of Phase 2.11 · next: Phase 2.12 chroma key + shape masks
- 2026-06-25 session 10 — did: Phase 2.12 complete — compositor.js FRAG shader: chroma key (chroma-space distance, smoothstep alpha, u_chroma_enabled/color/threshold/smooth) + shape mask (SDF rect/ellipse, u_mask_type/center/size/feather/invert); drawClip sets all 9 new uniforms, drawSolid disables chroma+mask; inspector.js: Chroma Key section (enabled toggle, color picker, threshold/smoothness propRows) + Mask section (type select, x/y/w/h/feather propRows when active, invert toggle); _onChromaEnabledChange, _onChromaColorChange, _onMaskTypeChange, _onMaskInvertChange; hexToRgb/rgbToHex utilities; toggle/select/color-picker CSS · stopped at: end of Phase 2.12 · next: Phase 2.13 VFX shader library + transitions
- 2026-06-25 session 11 — did: Phase 2.13 complete — compositor.js: FRAG shader upgraded with 6 VFX uniforms (vignette, grain, sharpen, aberration, pixelate, time); pipeline order: pixelate→sample→aberration→sharpen→chroma→colorcorrect→LUT→vignette→grain→mask; drawClip(opacityMult=1) for transition blending, drawSolid zeros all VFX; setTime(t) method; new uniform locations in cache; edl.js: vfx defaults added to defaultClipProperties(), transitionClipsAtTime() + getTransitionOutFactor() exported; preview-engine.js: imports transitionClipsAtTime/getTransitionOutFactor, setTime() per frame, outgoing clips use getTransitionOutFactor as opacityMult, incoming clips rendered via transitionClipsAtTime with pre-roll media time; export-engine.js: same transition + setTime support; inspector.js: VFX section (5 propRows: vignette/grain/sharpen/aberration/pixelate), Transition section (type select + duration input, _onTransitionTypeChange/_onTransitionDurChange), Preset section (Save→.pmpreset download, Load→file picker apply, _onPresetSave/_onPresetLoad); setPropValue fixed to create missing path intermediates; preset CSS; sw.js bumped to v10 · stopped at: end of Phase 2.13 · next: Phase 2.14 Text + custom font import + cued static images
- 2026-06-25 session 12 — did: Phase 2.14 complete — text-renderer.js (NEW): TextRenderer renders text to HTMLCanvasElement via Canvas 2D (multi-line, bold/italic, custom font); edl.js: createAsset accepts fontFamily; preview-engine.js: TextRenderer + FontFace loading (_ensureFont, _getTextRenderer, _fontCache), text clips rendered in both active and transIn loops; export-engine.js: same TextRenderer + _ensureFont pattern for offline export, textRenderer passed to _renderFrame; inspector.js: Text section UI (textarea for content, font family input, fontSize/lineHeight propRows, color picker, align select, bold/italic toggles, _onTextPropChange), fixed 5 snapshotCommand bugs (_ingestLUT, _onClearLUT, _onMaskTypeChange, _onTransitionTypeChange, _onPresetLoad all now call history.execute(cmd)), textarea+row-col CSS; media-library.js: font file support (.ttf/.otf/.woff/.woff2 in picker+filter+probeFile, fontFamily in addAsset), T+ button → _addTextClip (creates overlay clip with text properties), assetIcon for font/lut; sw.js bumped to v11 with text-renderer.js · stopped at: end of Phase 2.14 · next: Phase 2.15 speed ramping + transparent WebM/GIF/PNG export
- 2026-06-26 session 13 — did: Phase 2.15 complete — compositor.js: init({transparent}) alpha canvas option, blendFuncSeparate for transparent mode, clear(r,g,b,a) alpha param, getPixels() readback with vertical flip; export-engine.js: export() dispatcher by format (mp4/webm/gif/png), _exportVideo() with webm-muxer + VP9 branch (WEBM_MUXER_CDN), _exportPNG() (OffscreenCanvas transparent mode + convertToBlob), _exportGIF() (gifenc library: quantize+applyPalette per frame, GIFENC_CDN), _renderFrame transparent param; inspector.js: Speed read-only → editable input (pm-speed-input, _onSpeedChange with undo, clamped 0.1–10×); shell.js: _showExportDialog() rewritten with format selector (MP4/WebM/GIF/PNG), per-format option panels (video bitrate/fps, GIF fps, PNG time+transparent checkbox), download branches on format MIME type + extension; sw.js bumped to v12 · stopped at: end of Phase 2.15 · next: Phase 2.16 ffmpeg.wasm fallback
