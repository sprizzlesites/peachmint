# PROGRESS — PeachMint Browser Video Editor

## ▶ RESUME HERE
Phase 0 · step 0.3 · implement storage layer (OPFS + IndexedDB + persist) round-trip test

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
- [ ] 0.3 Storage layer (OPFS + IndexedDB + persist) round-trip test
  - [ ] 0.3.1 src/engine/storage.js (OPFS + IndexedDB abstraction)
  - [ ] 0.3.2 src/engine/project.js (project data model, autosave stub)
  - [ ] 0.3.3 src/engine/edl.js (EDL schema, keyframe model)
  - [ ] 0.3.4 Storage round-trip smoke test visible in capability panel

### Phase 1 — Playable core (MVP / P0)
- [ ] 1.4 EDL model + multitrack timeline UI (desktop)
- [ ] 1.5 WebCodecs decode → WebGL2 compositor → preview loop (one clip)
- [ ] 1.6 Import / trim / split / reorder / z-order / opacity+transform keyframes
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
- 2026-06-25 session 1 — did: Phase 0 foundations (PROGRESS.md, ARCHITECTURE.md, index.html, manifest.json, sw.js, capabilities.js, app-shell.js, capability-panel.js, DEPENDENCIES.md, LICENSE, OSS docs) · stopped at: start of 0.3 storage layer · next: src/engine/storage.js, project.js, edl.js, storage round-trip test in capability panel
