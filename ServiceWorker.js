const cacheName = "DefaultCompany-Imagine WebAR-0.1.0" + "-voicefix11-long";
const contentToCache = [
    "Build/.deploy-WebAR_Test.loader.js",
    "Build/.deploy-WebAR_Test.framework.js.unityweb",
    "Build/.deploy-WebAR_Test.data.unityweb",
    "Build/.deploy-WebAR_Test.wasm.unityweb",
    "TemplateData/style.css"

];

self.addEventListener('install', function (e) {
    console.log('[Service Worker] Install');
    self.skipWaiting();
    
    e.waitUntil((async function () {
      const cache = await caches.open(cacheName);
      console.log('[Service Worker] Caching all: app shell and content');
      await cache.addAll(contentToCache);
    })());
});

self.addEventListener('activate', function (e) {
    e.waitUntil((async function () {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => key === cacheName ? Promise.resolve() : caches.delete(key)));
      await self.clients.claim();
    })());
});

self.addEventListener('fetch', function (e) {
    e.respondWith((async function () {
      const url = new URL(e.request.url);
      const cacheable = contentToCache.some((path) => url.pathname.endsWith(path));
      if (!cacheable) {
        return fetch(e.request);
      }

      let response = await caches.match(e.request);
      console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
      if (response) { return response; }

      response = await fetch(e.request);
      const cache = await caches.open(cacheName);
      console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
      cache.put(e.request, response.clone());
      return response;
    })());
});
