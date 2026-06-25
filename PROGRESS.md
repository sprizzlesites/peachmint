# PROGRESS — PeachMint Browser Video Editor

## ▶ RESUME HERE
Phase 1 · step 1.7 · Web Audio: multi-clip cueing, volume automation/fades

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
- [ ] 1.7 Web Audio: multi-clip, cueing, volume automation/fades
- [ ] 1.8 Render targets + custom ratio + WebCodecs export (mp4-muxer)
- [ ] 1.9 Autosave + project save/load + undo/redo
- [ ] 1.10 Mobile UI shell over the same engine

### Phase 2 — Pro features (P1)
- [ ] 2.11 Color correction + .cube/.3dl LUT import
- [ ] 2.12 Chroma key + shape masks
- [ ] 2.13 VFX shader library + open preset format + transitions
- [ ] 2.14 Text + custom font import + cued static images
- [ ] 2.15 Speed ramping + transparent WebM / GIF / PNG export
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
