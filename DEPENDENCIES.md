# PeachMint — Dependency Register

All CDN dependencies are pinned to exact versions.
Self-hosted mirrors live in `/vendor/` — use these if CDNs are unavailable.
When the primary CDN (cdnjs preferred) doesn't host a library, the note column says why.

---

## Phase 0 (current) — No runtime CDN deps yet

The Phase 0 scaffold is pure vanilla JS + native ES modules.
No external libraries are loaded at runtime.

---

## Planned — Phase 1 (add these as each feature is built)

| Library | Version | License | CDN (primary) | CDN URL | Notes |
|---------|---------|---------|---------------|---------|-------|
| mp4box.js | 0.5.2 | BSD-3-Clause | cdnjs | `https://cdnjs.cloudflare.com/ajax/libs/mp4box.js/0.5.2/mp4box.all.min.js` | MP4 demuxer for WebCodecs |
| mp4-muxer | 4.5.0 | MIT | jsDelivr | `https://cdn.jsdelivr.net/npm/mp4-muxer@4.5.0/build/mp4-muxer.min.js` | **cdnjs does not host** — jsDelivr fallback |
| webm-muxer | 3.2.0 | MIT | jsDelivr | `https://cdn.jsdelivr.net/npm/webm-muxer@3.2.0/build/webm-muxer.min.js` | **cdnjs does not host** — jsDelivr fallback |

## Planned — Phase 2

| Library | Version | License | CDN (primary) | Notes |
|---------|---------|---------|---------------|-------|
| MediaPipe Image Segmenter | 0.10.x | Apache-2.0 | jsDelivr / Google CDN | **cdnjs does not host**; loads from `cdn.jsdelivr.net/npm/@mediapipe/` |

## Optional (user-toggled) — Phase 2

| Library | Version | License | CDN | Notes |
|---------|---------|---------|-----|-------|
| ffmpeg.wasm | 0.12.x | LGPL/GPL (via FFmpeg) | jsDelivr | **LGPL/GPL licensed** — see NOTICE; opt-in only; requires coi-serviceworker shim on GH Pages |
| coi-serviceworker | 0.1.7 | MIT | jsDelivr | Required for ffmpeg.wasm multithreaded SharedArrayBuffer support on GH Pages |

---

## CDN preference rules

1. **cdnjs.cloudflare.com** — preferred for all libraries it hosts (stable, fast, SRI-friendly)
2. **cdn.jsdelivr.net** — fallback for libraries cdnjs doesn't host
3. **unpkg.com** — last resort only; note in this file
4. **Google CDN / first-party CDN** — only for libraries with no third-party mirror (e.g. MediaPipe)

---

## Self-hosting path

To make PeachMint work entirely offline or CDN-free:

1. Download each pinned file to `/vendor/<library-name>/`
2. Update the import URL in each source file that references the CDN URL
3. The service worker will cache from `/vendor/` on first load

The `/vendor/` directory is in `.gitignore` by default to keep the repo lean.
Add a `vendor:download` script to `package.json` (not required to run the app)
for contributor convenience.

---

## License notes

- PeachMint's own code: **MIT** (see LICENSE)
- All planned runtime deps: MIT or BSD-3-Clause, except:
  - **ffmpeg.wasm** → pulls in LGPL/GPL via FFmpeg. Kept optional and isolated.
    Must preserve its license notices. See NOTICE.
  - **MediaPipe** → Apache-2.0. Attribute in NOTICE.
- No proprietary or "non-commercial-use-only" libraries will be bundled.
