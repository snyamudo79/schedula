/* ==========================================================================
   Schedula service worker — makes the app work fully offline.
   - App shell is precached on install (bump VERSION whenever you ship changes).
   - Same-origin files: cache-first, so the app opens instantly with no network.
   - Google Fonts: stale-while-revalidate (cached after the first online visit;
     offline without them, the app falls back to system fonts).
   - Firebase SDK (accounts/sync): cache-first, so sync code loads offline too.
     Firebase's own network calls (sign-in, database) are never intercepted.
   ========================================================================== */
const VERSION = 'v10';
const SHELL_CACHE = `schedula-shell-${VERSION}`;
const FONT_CACHE = 'schedula-fonts';
const LIB_CACHE = 'schedula-lib'; // Firebase SDK (versioned URLs, safe to cache forever)
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './quotes.js',
  './firebase-config.js',
  './sync.js',
  './manifest.webmanifest',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  // `cache: 'reload'` bypasses the HTTP cache so a new version never precaches stale files.
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
  );
  // Don't skipWaiting here: the page asks the user before swapping versions.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('schedula-shell-') && k !== SHELL_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App navigations (the app's own URL, with any #view or ?query) → the cached shell.
  // Other pages in scope fall through to the network like normal.
  const scopePath = new URL(self.registration.scope).pathname;
  const isAppUrl = url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
  if (req.mode === 'navigate' && url.origin === self.location.origin && isAppUrl) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match('./index.html');
      if (hit) return hit;
      try { return await fetch(req); } catch (e) { return new Response('Schedula is offline and not cached yet. Open it once while online.', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
    return;
  }

  if (req.mode === 'navigate') return; // non-app pages: plain network

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req);
      const fresh = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { event.waitUntil(fresh); return hit; }
      const res = await fresh;
      return res || new Response('', { status: 504 });
    })());
  }
});
