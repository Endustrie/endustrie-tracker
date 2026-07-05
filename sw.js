/* Cache-first app shell. The version string is replaced at build time so every
   deploy invalidates the old cache. User data never passes through here —
   sync calls go straight to the network. */
const VERSION = 'mr7bhcgx';
const CACHE = 'endustrie-' + VERSION;

self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // sync etc. hit the network
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const resp = await fetch(e.request);
      if (resp.ok) (await caches.open(CACHE)).put(e.request, resp.clone());
      return resp;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});
