// Keeps the app (and the speech engine code) working offline.
const SHELL = 'vi-shell-0.1.0';
const LIBS = 'vi-libs-1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'worker.js', 'vendor/qrcode.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('vi-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // uploads go straight to the network
  const url = new URL(req.url);

  // Speech engine code from the CDN: cache forever (versions are pinned).
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(LIBS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App files: network first (so updates arrive), cache when offline.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        const c = await caches.open(SHELL);
        return (await c.match(req, { ignoreSearch: true })) || (await c.match('./')) || Response.error();
      }
    })());
  }
  // Model files from Hugging Face are cached by the speech library itself.
});
