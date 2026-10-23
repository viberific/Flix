// App-shell cache only. API responses and video streams are never cached (auth + huge, partially-downloaded files).
// The one exception is 'flix-downloads': episodes the person chose to save on this device, answered under /_offline/ (see downloads.js).
const CACHE = 'flix-shell-v46'
const SHELL = ['/', '/app.js', '/downloads.js', '/style.css', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/vendor/hls.min.js']

self.addEventListener('install', (e) => {
  // One missing file must not stop the worker installing (addAll is all-or-nothing, and an app with no worker can't be installed).
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'flix-downloads').map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
/** A saved episode with byte ranges, which the video element needs for seeking and which the Cache API does not do by itself. */
async function offline(req) {
  const hit = await (await caches.open('flix-downloads')).match(req.url)
  if (!hit) return new Response('Not saved on this device', { status: 404 })
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '')
  if (!range) return hit
  const blob = await hit.blob(), size = blob.size
  let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
  const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(size - 1, Number(range[2]))
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { 'content-type': hit.headers.get('content-type') || 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' } })
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin === location.origin && url.pathname.startsWith('/_offline/')) { if (e.request.method === 'GET') e.respondWith(offline(e.request)); return }
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
