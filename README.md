# 🍑🌿 PeachMint

**Free, open-source, fully client-side browser video editor.**

A mobile-first answer to Adobe Premiere / After Effects, hosted as static files.
Everything runs on your device. **No backend. No uploads. No accounts. No telemetry.**
Your media never leaves your browser.

---

## Features (in progress — see PROGRESS.md)

- Multitrack timeline with unlimited video/audio/overlay tracks
- Frame-accurate WebCodecs decode + WebGL2 compositing
- Keyframable properties: position, scale, rotation, opacity, effects, volume
- Color correction + LUT import (`.cube` / `.3dl`)
- Chroma key, shape masks, VFX shader effects
- Web Audio mixing: multi-clip, volume automation, fades
- Export: H.264 MP4, VP9/AV1 WebM, transparent WebM, animated GIF, PNG
- Platform presets: YouTube 16:9, Shorts/TikTok/Reels 9:16, Square 1:1, custom
- Desktop UI (multi-panel) + Mobile UI (touch-first) over one shared engine
- Installable PWA — works fully offline after first load
- Continuous autosave + crash recovery

---

## Running locally

No build step. No `npm install`. Just serve the files:

```bash
python -m http.server 8080
# open http://localhost:8080
```

Or use any static file server.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module map, engine API,
data model, storage plan, and rendering pipeline.

## Dependencies

See [DEPENDENCIES.md](DEPENDENCIES.md) for all third-party libraries,
their CDN URLs, licenses, and self-hosting instructions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
Third-party license notices in [NOTICE](NOTICE).

---

> **Status:** Phase 0 — Foundations complete. Phase 1 (playable core) in progress.
> See [PROGRESS.md](PROGRESS.md) for the current build status.
