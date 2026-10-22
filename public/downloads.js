/**
 * Episodes saved on this device for watching without a connection (1080p at most; the server makes the file).
 * Everything lives in Cache Storage under /_offline/..., which the service worker answers (with byte ranges) even when the server
 * can't be reached. An episode appears in the list only once all of it is saved, so a half-finished download never shows up.
 */
const CACHE = 'flix-downloads'
const P = '/_offline/'
export const idOf = (seriesId, season, label) => `${seriesId}-${season ?? 'x'}-${String(label).replace(/[^A-Za-z0-9]+/g, '_')}`
export const videoUrl = (id) => `${P}video/${id}`
export const imgUrl = (id) => `${P}img/${id}`
const metaUrl = (id) => `${P}meta/${id}`

const open = () => caches.open(CACHE)
export const supported = () => 'caches' in self && 'serviceWorker' in navigator

export async function list() {
  if (!supported()) return []
  try {
    const c = await open()
    const keys = (await c.keys()).filter((r) => new URL(r.url).pathname.startsWith(P + 'meta/'))
    const all = await Promise.all(keys.map((k) => c.match(k).then((r) => r?.json()).catch(() => null)))
    return all.filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)
  } catch { return [] }
}
export async function get(id) { try { return await (await (await open()).match(metaUrl(id)))?.json() } catch { return null } }
async function putMeta(c, m) { await c.put(metaUrl(m.id), new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } })) }

export async function remove(id) {
  const c = await open()
  for (const k of await c.keys()) if (new URL(k.url).pathname.slice(P.length).split('/')[1] === id) await c.delete(k)
}

/** Position / watched state for an episode that is watched offline; `pending` is sent to the server the next time it can be reached. */
export async function saveProgress(id, position, duration, ended) {
  const c = await open(), m = await get(id)
  if (!m) return
  m.position = ended ? 0 : position; m.duration = duration || m.duration; m.watched = m.watched || !!ended
  m.pending = { position, duration: duration || m.duration, ended: !!ended || !!m.pending?.ended }
  await putMeta(c, m)
}
/** Tell the server about anything watched while offline. `send(m)` posts one episode; failures stay queued. */
export async function syncPending(send) {
  for (const m of await list()) {
    if (!m.pending) continue
    try { await send(m); const c = await open(), cur = await get(m.id); if (cur) { delete cur.pending; await putMeta(c, cur) } } catch { /* try again later */ }
  }
}

export async function usage() { try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null } catch { return null } }

/** Downloads in progress, by id: { text, pct, error }. Views listen for `flix-dl` on window. */
export const active = new Map()
// Anything queued up wanting to know when one download has finished: the season button uses this to start the next episode
const waiters = new Map()
const settle = (id, ok) => { const w = waiters.get(id); if (w) { waiters.delete(id); w(ok) } }
export const whenDone = (id) => new Promise((res) => { if (!active.has(id)) return res(false); waiters.set(id, res) })
const tick = (id, st, name) => {
  if (st) { active.set(id, { name: name ?? active.get(id)?.name, ...st }); if (st.error) settle(id, false) }
  else { active.delete(id); settle(id, true) }
  window.dispatchEvent(new Event('flix-dl'))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Flix answered ${r.status}`); return d }

/**
 * Save one episode. `watch` asks the server to pick the source and start it (what pressing Play does); then we wait for the server to
 * have the whole file, ask it for a ≤1080p MP4, and stream that into Cache Storage.
 */
export function start(ep, watch) {
  const id = idOf(ep.seriesId, ep.season, ep.label), name = [ep.seriesName, ep.label].filter(Boolean).join(' · ')
  if (active.has(id)) return id
  tick(id, { text: 'Asking the server…', pct: 0 }, name)
  ;(async () => {
    const c = await open(), made = []
    const put = async (url, res) => { made.push(url); await c.put(url, res) }
    try {
      navigator.storage?.persist?.().catch(() => {})
      const play = await watch()
      const base = `/api/stream/${play.torrentId}/${play.fileIndex}`
      // 1. wait until the server has the whole episode and has made the 1080p copy
      for (;;) {
        const s = await fetch(base + '/offline', { cache: 'no-store' }).then(json)
        if (s.state === 'ready') break
        if (s.state === 'error') throw new Error(s.message)
        tick(id, s.state === 'waiting'
          ? { text: `Downloading on the server… ${Math.round(s.progress * 100)}%`, pct: 0 }
          : { text: `Preparing a 1080p copy… ${Math.round(s.progress * 100)}%`, pct: 0 })
        await sleep(2000)
      }
      // 2. the file itself, written to storage as it arrives
      const res = await fetch(base + '/offline/file', { cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error('The server could not send the video.')
      const total = Number(res.headers.get('content-length')) || 0
      let got = 0
      const counter = new TransformStream({ transform(chunk, ctl) { got += chunk.byteLength; tick(id, { text: `Saving to this device… ${total ? Math.round((got / total) * 100) + '%' : (got / 1048576).toFixed(0) + ' MB'}`, pct: total ? got / total : 0 }); ctl.enqueue(chunk) } })
      await put(videoUrl(id), new Response(res.body.pipeThrough(counter), { headers: { 'content-type': res.headers.get('content-type') || 'video/mp4', 'content-length': String(total || '') } }))
      if (total && got !== total) throw new Error('The download was cut off.')
      // 3. the small things: poster, subtitles
      tick(id, { text: 'Finishing…', pct: 1 })
      const info = await fetch(base + '/info', { cache: 'no-store' }).then(json).catch(() => null)
      const subs = []
      for (const s of info?.subs ?? []) {
        try {
          const r = await fetch(s.url, { cache: 'no-store' })
          if (!r.ok) continue
          const url = `${P}sub/${id}/${subs.length}.vtt`
          await put(url, new Response(await r.blob(), { headers: { 'content-type': 'text/vtt; charset=utf-8' } }))
          subs.push({ lang: s.lang, label: s.label, forced: s.forced, default: s.default, url })
        } catch { /* a missing subtitle is not worth failing for */ }
      }
      const poster = await fetch(`/api/art/${ep.seriesId}/poster`).catch(() => null)
      if (poster?.ok) await put(imgUrl(id), poster)
      // What was written, as counted on the way in. Reading the saved video back as a blob just to ask its size pulled a
      // gigabyte or more into memory, which a television's WebView may not have.
      const size = got
      await putMeta(c, { id, seriesId: ep.seriesId, season: ep.season, label: ep.label, seriesName: play.seriesName || ep.seriesName, episodeTitle: play.episodeTitle || ep.title || null,
        torrentId: play.torrentId, fileIndex: play.fileIndex, duration: info?.duration ?? null, size, subs, position: 0, savedAt: Date.now() })
      tick(id, null)
    } catch (e) {
      for (const u of made) await c.delete(u).catch(() => {})
      const full = e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '')
      tick(id, { text: full ? 'This device is out of space.' : e.message || 'The download failed.', error: true, pct: 0 })
      setTimeout(() => { if (active.get(id)?.error) tick(id, null) }, 8000)
    }
  })()
  return id
}
