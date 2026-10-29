const CACHE = 'vibechic-templates-v16';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './shared.js',
  './crypto.js',
  './device-cloud.js',
  './team-share.js',
  './pull-refresh.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
  './icons/logo-128.png'
];

self.addEventListener('install', (e) => {
  // Cache new assets but do NOT auto-activate — wait for user tap / pull-to-refresh
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e && e.data && (e.data === 'SKIP_WAITING' || e.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (
    url.pathname.endsWith('templates.json') ||
    url.pathname.endsWith('crypto-meta.json') ||
    url.pathname.includes('/images/') ||
    url.pathname.includes('/public/') ||
    url.hostname.includes('github') ||
    url.hostname.endsWith('workers.dev')
  ) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
