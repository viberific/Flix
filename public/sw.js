// App-shell cache only. API responses and video streams are never cached (auth + huge, partially-downloaded files).
const CACHE = 'flix-shell-v8'
const SHELL = ['/', '/app.js', '/style.css', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/vendor/hls.min.js']

self.addEventListener('install', (e) => {
  // One missing file must not stop the worker installing (addAll is all-or-nothing, and an app with no worker can't be installed).
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  // network-first so updates show up; fall back to cache when offline
  e.respondWith(
    fetch(e.request).then((res) => {
      // Only keep Flix's own answer. A redirected response means Umbrel's sign-in page
      // came back instead of Flix, and caching that would serve the login page as the app.
      const clean = res.ok && !res.redirected && res.type === 'basic' && new URL(res.url).pathname === url.pathname
      if (clean) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)) }
      return res
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  )
})
