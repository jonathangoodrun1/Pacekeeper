/* PaceKeeper service worker — full offline.
   The app is a single index.html now; only the voice pack and icons sit beside it. */
const CACHE = 'pacekeeper-v6';
const ASSETS = ["./","index.html","voices.js","manifest.json",
                "icon-180.png","icon-192.png","icon-512.png"];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(a => c.add(a).catch(() => console.warn('skip', a))))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network-first for the app shell so a new version lands without a cache dance;
  // cache-first for the voice pack, which is large and never changes.
  const isShell = /index\.html$|\/$/.test(new URL(e.request.url).pathname);
  if (isShell) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  })));
});
