// PeachMint Service Worker — app-shell cache + offline strategy
// Strategy: cache-first for app shell assets; network-first for CDN deps
// Also patches same-origin responses with COOP/COEP headers so that
// crossOriginIsolated = true, enabling SharedArrayBuffer for ffmpeg.wasm.

const CACHE_NAME = 'peachmint-v14';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/src/ui/app-shell.js',
  '/src/ui/capability-panel.js',
  '/src/engine/capabilities.js',
  '/src/engine/storage.js',
  '/src/engine/project.js',
  '/src/engine/edl.js',
  '/src/engine/history.js',
  '/src/ui/desktop/shell.js',
  '/src/ui/desktop/timeline.js',
  '/src/ui/desktop/toolbar.js',
  '/src/ui/desktop/inspector.js',
  '/src/ui/desktop/media-library.js',
  '/src/engine/compositor.js',
  '/src/engine/decoder.js',
  '/src/engine/preview-engine.js',
  '/src/engine/audio-engine.js',
  '/src/engine/export-engine.js',
  '/src/engine/lut.js',
  '/src/engine/text-renderer.js',
  '/src/engine/ffmpeg-engine.js',
  '/src/ui/mobile/shell.js',
  '/src/engine/segmentation.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Wrap a same-origin Response with Cross-Origin Isolation headers so that
// window.crossOriginIsolated becomes true and SharedArrayBuffer is available.
function addCOIHeaders(resp) {
  if (!resp || resp.type === 'opaque' || resp.type === 'error') return resp;
  try {
    const h = new Headers(resp.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch {
    return resp;
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle GET requests from same origin or pinned CDN libs
  if (request.method !== 'GET') return;

  // App shell: cache-first + add COI headers to enable SharedArrayBuffer
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return addCOIHeaders(cached);
        try {
          const resp = await fetch(request);
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return addCOIHeaders(resp);
        } catch {
          // Offline fallback: serve index.html for navigation requests
          if (request.mode === 'navigate') return addCOIHeaders(await caches.match('/index.html'));
        }
      })
    );
    return;
  }

  // CDN deps: network-first with cache fallback
  if (
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'unpkg.com'
  ) {
    e.respondWith(
      fetch(request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
        }
        return resp;
      }).catch(() => caches.match(request))
    );
  }
});
