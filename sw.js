/* PaceKeeper service worker — full offline. You lose signal on a long run;
   the app must not care. The voice pack is inlined in voices.js, so the whole
   app is nine files. */
const CACHE = 'pacekeeper-v4';
const ASSETS = ["./","index.html","engine.js","voices.js","app.js","manifest.json",
                "icon-180.png","icon-192.png","icon-512.png"];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(a => c.add(a).catch(() => console.warn('skip', a))))));
});

// claim clients immediately so a new version can't be paired with old cached files
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match('index.html'))));
});
