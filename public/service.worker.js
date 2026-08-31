// Godot Web Editor MCP - cache large immutable assets without pinning the UI
// shell or WebMCP bridge to an obsolete deployment.
const CACHE_NAME = 'godot-web-mcp-v2';
const PRECACHE_URLS = [
  '/inter-regular.woff2',
  '/inter-bold.woff2',
  '/logo.svg',
  '/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching core editor shell');
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[ServiceWorker] Purging legacy cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Pass through WebSocket upgrades and API calls
  if (event.request.url.includes('/mcp') || event.request.url.includes('/api/')) {
    return;
  }

  const url = new URL(event.request.url);
  const immutableRuntimeAsset = url.pathname.endsWith('.wasm') || url.pathname.endsWith('.pck');
  if (immutableRuntimeAsset) {
    event.respondWith(caches.match(event.request).then((cachedResponse) => cachedResponse || fetch(event.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
      }
      return networkResponse;
    })));
    return;
  }

  // HTML and JavaScript are deployment-coherent control surfaces. Always ask
  // the network first; fall back only for explicitly pre-cached static assets.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('message', (event) => {
  if (event.data === 'claim') {
    self.clients.claim();
  }
});
