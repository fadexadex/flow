// Godot Web Editor MCP - High Performance Cache Service Worker
const CACHE_NAME = 'godot-web-mcp-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/godot.editor.js',
  '/mcp_bridge.js',
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

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        // Cache large Godot binaries (wasm, pck) for instant sub-second reloads
        if (event.request.url.endsWith('.wasm') || event.request.url.endsWith('.pck')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return networkResponse;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'claim') {
    self.clients.claim();
  }
});
