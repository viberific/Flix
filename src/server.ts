import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { createUser, login, logout, requireAdmin, requireUser, setSessionCookie, userCount, userFor } from './auth.ts'
import { qb } from './qb.ts'
import { searchBtn, syncLatest, syncSeries } from './catalog.ts'
import { RateLimitError } from './btn/client.ts'
import { bufferStatus, fileInfo, readRange, startPlayback, StreamTimeout } from './streaming.ts'
import { cleanHlsCache, ensureHls, jobDir, probe, touchHls } from './transcode.ts'
import { buildEpisodes, continueWatching } from './episodes.ts'
import { removeDownload, seedStatus, startSweeper, whyKept } from './retention.ts'
import { qb as engine } from './qb.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err: any, _req, reply) => {
  const status = err instanceof RateLimitError ? 429 : err.statusCode ?? 500
  if (status >= 500) app.log.error(err)
  reply.code(status).send({ error: err.message })
})

await app.register(fastifyStatic, { root: join(root, 'public') })
await app.register(fastifyStatic, { root: join(root, 'node_modules/hls.js/dist'), prefix: '/vendor/', decorateReply: false })

// ---- auth -----------------------------------------------------------------
app.get('/api/me', async (req) => ({ user: userFor(req), needsSetup: userCount() === 0 }))

app.post('/api/login', async (req, reply) => {
  const { name, password } = req.body as any
  const token = login(String(name ?? ''), String(password ?? ''))
  if (!token) return reply.code(401).send({ error: 'Wrong username or password' })
  setSessionCookie(reply, token)
  return { user: userFor({ headers: { cookie: `flix_session=${token}` } } as any) }
})
app.post('/api/logout', async (req, reply) => { logout(req); setSessionCookie(reply, null); return { ok: true } })

app.post('/api/signup', async (req, reply) => {
  const first = userCount() === 0
  if (!first && !config.allowSignup) return reply.code(403).send({ error: 'Signups are closed; ask an admin to create your account' })
  const { name, password } = req.body as any
  createUser(String(name ?? ''), String(password ?? ''), first) // first user becomes admin
  const token = login(name, password)!
  setSessionCookie(reply, token)
  return { ok: true }
})

// ---- catalog ----------------------------------------------------------------
const auth = { preHandler: requireUser }
const seriesCols = `series_id AS id, series AS name, MAX(series_poster) AS poster, MAX(series_banner) AS banner,
  COUNT(*) AS releases, MAX(time) AS latest`

app.get('/api/series', auth, async (req) => {
  const { q } = req.query as { q?: string }
  if (q && q.trim().length >= 2) await searchBtn(q.trim()).catch((e) => { if (!(e instanceof RateLimitError)) app.log.warn(e.message) })
  const rows = q
    ? db.prepare(`SELECT ${seriesCols} FROM releases WHERE series LIKE ? GROUP BY series_id ORDER BY latest DESC LIMIT 100`).all(`%${q}%`)
    : db.prepare(`SELECT ${seriesCols} FROM releases GROUP BY series_id ORDER BY latest DESC LIMIT 100`).all()
  return { series: rows }
})

app.get('/api/series/:id', auth, async (req) => {
  const id = Number((req.params as any).id)
  await syncSeries(id).catch((e) => app.log.warn(`series sync failed: ${e.message}`))
  const info = db.prepare(`SELECT ${seriesCols}, MAX(genres) AS genres, MAX(youtube_trailer) AS trailer FROM releases WHERE series_id = ? GROUP BY series_id`).get(id) as any
  if (!info) throw Object.assign(new Error('Series not found'), { statusCode: 404 })
  // Only episodes are exposed: sources are chosen server-side, and torrent_link (passkey!) never leaves the server.
  return { series: info, episodes: buildEpisodes(id, req.user!.id) }
})

app.get('/api/continue', auth, async (req) => ({ items: continueWatching(req.user!.id) }))

// ---- playback ---------------------------------------------------------------
app.post('/api/play', auth, async (req) => {
  const { torrentId, fileIndex } = req.body as any
  return startPlayback(req.user!.id, Number(torrentId), fileIndex === undefined ? undefined : Number(fileIndex))
})

/** The one-tap path: pick the best source (1080p, else 4K) and start playing. */
app.post('/api/watch', auth, async (req) => {
  const { seriesId, season, label } = req.body as any
  const eps = buildEpisodes(Number(seriesId), req.user!.id)
  const i = eps.findIndex((e) => e.season === (season ?? null) && e.label === label)
  if (i < 0) throw Object.assign(new Error('That episode is not available'), { statusCode: 404 })
  const ep = eps[i]
  if (!ep.available) throw Object.assign(new Error('Nobody is sharing this episode right now. Please try again later.'), { statusCode: 503 })
  const play = await startPlayback(req.user!.id, ep.torrentId, undefined, { episodeLabel: ep.isPack ? undefined : ep.label })
  const next = eps.slice(i + 1).find((e) => e.available)
  return { ...play, quality: ep.quality, title: ep.label, next: next ? { season: next.season, label: next.label } : null }
})

app.get('/api/stream/:t/:f/status', auth, async (req) => {
  const { t, f } = req.params as any
  return (await bufferStatus(+t, +f)) ?? { error: 'not ready' }
})

app.get('/api/stream/:t/:f/info', auth, async (req) => {
  const { t, f } = req.params as any
  const p = await probe(+t, +f)
  const base = `/api/stream/${t}/${f}`
  return { mode: p.direct ? 'direct' : 'hls', url: p.direct ? `${base}/raw` : `${base}/hls/index.m3u8`, duration: p.duration, probe: p }
})

const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' }

app.get('/api/stream/:t/:f/raw', { preHandler: requireUser }, async (req, reply) => {
  const { t, f } = req.params as any
  const fi = await fileInfo(+t, +f)
  if (!fi) return reply.code(404).send({ error: 'Not downloading' })
  const size = fi.file.size
  const ext = fi.file.name.split('.').pop()!.toLowerCase()
  let start = 0, end = size - 1
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (m) {
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])) } else {
      start = Number(m[1] || 0)
      if (m[2]) end = Math.min(size - 1, Number(m[2]))
    }
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send()
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`)
  }
  reply.header('accept-ranges', 'bytes').header('content-length', end - start + 1).type(MIME[ext] ?? 'application/octet-stream')
  const ac = new AbortController()
  req.raw.on('close', () => ac.abort())
  const stream = readRange(fi.rel.info_hash, fi.layout.savePath, fi.file, start, end, ac.signal)
  stream.on('error', (e) => { if (!ac.signal.aborted) app.log.warn(`stream ${t}/${f}: ${e.message}`); reply.raw.destroy() })
  return reply.send(stream)
})

app.get('/api/stream/:t/:f/hls/:file', auth, async (req, reply) => {
  const { t, f, file } = req.params as any
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(file)) return reply.code(400).send({ error: 'bad file' })
  if (file === 'index.m3u8' || !touchHls(+t, +f)) {
    const p = await probe(+t, +f)
    try { await ensureHls(+t, +f, p) } catch (e: any) { return reply.code(503).send({ error: e.message }) }
  }
  const path = join(jobDir(+t, +f), file)
  if (!existsSync(path)) return reply.code(404).send({ error: 'segment not ready' })
  return reply.type(file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t').header('cache-control', 'no-store').send(createReadStream(path))
})

// ---- watch state ------------------------------------------------------------
app.post('/api/progress', auth, async (req) => {
  const { torrentId, fileIndex, position, duration } = req.body as any
  const frac = duration > 0 ? position / duration : 0
  const done = frac >= config.watchedThreshold
  db.prepare(`UPDATE interests SET position=?, duration=?, updated_at=?, watched_at = CASE WHEN ? THEN COALESCE(watched_at, ?) ELSE watched_at END
    WHERE user_id=? AND torrent_id=? AND file_index=?`).run(position, duration, now(), done ? 1 : 0, now(), req.user!.id, torrentId, fileIndex)
  return { watched: done }
})
app.post('/api/watched', auth, async (req) => {
  const { torrentId, fileIndex, watched } = req.body as any
  db.prepare(`UPDATE interests SET watched_at=?, updated_at=? WHERE user_id=? AND torrent_id=? AND file_index=?`)
    .run(watched ? now() : null, now(), req.user!.id, torrentId, fileIndex)
  return { ok: true }
})
/** "I don't need this any more" - stop holding the file for me without marking it watched. */
app.post('/api/release', auth, async (req) => {
  const { torrentId, fileIndex } = req.body as any
  db.prepare(`UPDATE interests SET released_at=?, updated_at=? WHERE user_id=? AND torrent_id=? AND file_index=?`)
    .run(now(), now(), req.user!.id, torrentId, fileIndex)
  return { ok: true }
})

// ---- admin ------------------------------------------------------------------
const admin = { preHandler: requireAdmin }
app.get('/api/admin/downloads', admin, async () => {
  const rows = db.prepare(`SELECT d.torrent_id, d.info_hash, d.state, d.added_at, d.removed_at, d.remove_reason, r.series, r.group_name, r.resolution
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id ORDER BY d.added_at DESC LIMIT 200`).all() as any[]
  const out = []
  for (const d of rows) {
    if (d.state !== 'active') { out.push(d); continue }
    const t = await engine.info(d.info_hash)
    if (!t) { out.push({ ...d, missing: true }); continue }
    const k = whyKept(t, d.torrent_id)
    out.push({ ...d, progress: t.progress, size: t.total_size, uploaded: t.uploaded, dlspeed: t.dlspeed, upspeed: t.upspeed, seeds: t.num_seeds,
      ratio: k.seed.ratio, seedHours: k.seed.hours, deletable: k.deletable, reasons: k.reasons })
  }
  return { requirements: config.seed, downloads: out }
})
app.delete('/api/admin/downloads/:id', admin, async (req) => {
  const id = Number((req.params as any).id)
  const d = db.prepare(`SELECT info_hash FROM downloads WHERE torrent_id=? AND state='active'`).get(id) as any
  if (!d) throw Object.assign(new Error('Not an active download'), { statusCode: 404 })
  // The seeding requirement cannot be overridden: only allow removal once it is met (or nothing was ever downloaded).
  const t = await engine.info(d.info_hash)
  if (t && t.downloaded > 0 && !seedStatus(t).met)
    throw Object.assign(new Error('BTN seeding requirement (130 h or 1:1) not met yet; refusing to remove'), { statusCode: 409 })
  await removeDownload(id, d.info_hash, 'removed by admin')
  return { ok: true }
})
app.get('/api/admin/users', admin, async () => ({ users: db.prepare('SELECT id, name, is_admin, created_at FROM users').all() }))
app.post('/api/admin/users', admin, async (req) => {
  const { name, password, isAdmin } = req.body as any
  return createUser(String(name ?? ''), String(password ?? ''), !!isAdmin)
})

// ---- boot -------------------------------------------------------------------
cleanHlsCache()
const runSweep = startSweeper()

export async function start() {
  try {
    await qb.setup()
    app.log.info(`qBittorrent ${await qb.version()} connected`)
  } catch (e: any) {
    app.log.error(`Cannot reach qBittorrent at ${config.qb.url}: ${e.message}. Playback will fail until it is available.`)
  }
  await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' })
  if (config.btn.apiKey) {
    syncLatest().catch((e) => app.log.warn(`initial BTN sync failed: ${e.message}`))
    setInterval(() => syncLatest().catch((e) => app.log.warn(`BTN sync failed: ${e.message}`)), 30 * 60_000).unref()
  } else app.log.warn('BTN_API_KEY not set: the catalog will stay empty')
  void runSweep
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) await start()
