self.addEventListener('install', function (e) {
    self.skipWaiting();
});

self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (e) {
    e.respondWith((async function () {
      return fetch(e.request);
    })());
});
