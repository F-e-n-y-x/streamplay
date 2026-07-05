/* StreamPlay service worker — conservative by design.
 *
 * Goals: make the app installable + usable offline for the shell, WITHOUT ever
 * serving stale app code or interfering with the dynamic API.
 *
 * Rules:
 *   - /api/** and non-GET → never touched (SSE, proxy, torrent, sources all pass through).
 *   - Content-hashed assets (/assets/*) → cache-first (safe: a new build = new filenames).
 *   - Navigations → network-first, falling back to the cached shell when offline.
 *   - skipWaiting + clients.claim so a new SW/version activates immediately (no stale trap).
 */
const VERSION = 'streamplay-v1';
const SHELL = '/index.html';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(['/', SHELL, '/manifest.webmanifest', '/icon.svg']).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // don't touch cross-origin
  if (url.pathname.startsWith('/api/')) return;             // never cache the API (SSE/proxy/torrent)

  // Navigations: always try the network first (so a rebuild is picked up); fall back
  // to the cached shell when offline so the SPA still boots.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(SHELL)));
    return;
  }

  // Content-hashed build assets: cache-first (immutable — new build has new names).
  if (/\/assets\/.+\.[0-9a-zA-Z_-]{6,}\.(js|css|woff2?|png|svg|jpg|jpeg|webp)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }
  // Everything else (icon, manifest, fonts): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
