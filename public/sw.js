// App-shell cache only. API responses and video streams are never cached (auth + huge, partially-downloaded files).
const CACHE = 'flix-shell-v1'
const SHELL = ['/', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest', '/vendor/hls.min.js']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
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
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)) }
      return res
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  )
})
