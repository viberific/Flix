import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { createInvite, createUser, hashPassword, login, logout, newSession, redeemInvite, requireAdmin, requireUser, sessionUser, setSessionCookie, tvToken, userCount, userFor, userForTvToken } from './auth.ts'
import { RATINGS, META_JOIN, canViewSeries, cleanAllowed, getRating, isRating, parseAllowed, queueRating, ratingClause, setRating } from './ratings.ts'
import { qb } from './qb.ts'
import { searchBtn, startCrawler, syncLatest, syncSeries } from './catalog.ts'
import { IpNotAuthorizedError, RateLimitError, btnCall } from './btn/client.ts'
import { btnKeyStatus, clearQb, qbStatus, setBtnApiKey, setQb, setTmdbApiKey, tmdbKeyStatus } from './settings.ts'
import { bufferStatus, fileInfo, readRange, startPlayback, StreamTimeout } from './streaming.ts'
import { cleanHlsCache, ensureHls, jobDir, probe, subtitleVtt, touchHls } from './transcode.ts'
import { artPathSql, getArt } from './art.ts'
import { buildEpisodes, continueWatching } from './episodes.ts'
import { listable, seasonsOf, unsyncedCount } from './seasons.ts'
import { ensurePackFiles } from './packs.ts'
import { diskInfo, health, lastBackup, startBackups } from './health.ts'
import { removeDownload, seedStatus, startSweeper, whyKept } from './retention.ts'
import { qb as engine } from './qb.ts'
import { getDetails, queueDetails, youtubeId } from './details.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err: any, _req, reply) => {
  const status = err instanceof RateLimitError ? 429 : err instanceof IpNotAuthorizedError ? 403 : err.statusCode ?? 500
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
/** A second session for this person, kept by the browser so "Who's watching?" can switch back to them without a password. */
app.post('/api/device-token', { preHandler: requireUser }, async (req) => ({ token: newSession(req.user!.id) }))
app.post('/api/switch', async (req, reply) => {
  const token = String((req.body as any)?.token ?? '')
  if (!sessionUser(token)) return reply.code(401).send({ error: 'That profile needs to sign in again' })
  setSessionCookie(reply, token)
  return { user: userFor({ headers: { cookie: `flix_session=${token}` } } as any) }
})
/** Open a sign-in link from the admin: signs this device in as that person, once. */
app.post('/api/join', async (req, reply) => {
  const r = redeemInvite(String((req.body as any)?.token ?? ''))
  if (!r) return reply.code(410).send({ error: 'This sign-in link has already been used or has expired. Ask for a new one.' })
  setSessionCookie(reply, r.session)
  return { user: userFor({ headers: { cookie: `flix_session=${r.session}` } } as any), token: r.session }
})
app.post('/api/logout', async (req, reply) => { logout(req); setSessionCookie(reply, null); return { ok: true } })

app.post('/api/signup', async (req, reply) => {
  // Public signup exists only to create the very first account (the admin). Everyone else is added by an admin.
  if (userCount() > 0) return reply.code(403).send({ error: 'Accounts are created by the admin. Ask them to add you.' })
  const { name, password } = req.body as any
  createUser(String(name ?? ''), String(password ?? ''), true)
  const token = login(name, password)!
  setSessionCookie(reply, token)
  return { ok: true }
})

// ---- catalog ----------------------------------------------------------------
const auth = { preHandler: requireUser }
const seriesCols = `series_id AS id, series AS name, ${artPathSql('series_poster', 'poster', 'poster')}, ${artPathSql('series_banner', 'banner', 'banner')},
  COUNT(*) AS releases, MAX(time) AS latest`

const notFound = (m = 'Series not found') => Object.assign(new Error(m), { statusCode: 404 })

/** Only shows whose first season is complete are listed; see seasons.ts. */
const isListed = (r: { id: number }) => listable().has(r.id)

/** Read a show's whole catalog from BTN if we have not yet (a show is not listed until then). Failures just leave it unlisted. */
const ensureSynced = (id: number) => syncSeries(id).catch((e) => { if (!(e instanceof RateLimitError)) app.log.warn(`series sync failed: ${e.message}`) })

app.get('/api/series', auth, async (req) => {
  const { q } = req.query as { q?: string }
  const f = ratingClause(req.user)
  const query = () => db.prepare(`SELECT ${seriesCols}, MAX(COALESCE(m.m_rating, 'Unrated')) AS rating FROM releases ${META_JOIN}releases.series_id
      WHERE ${f.sql}${q ? ' AND series LIKE ?' : ''} GROUP BY series_id ORDER BY latest DESC LIMIT 400`).all(...f.params, ...(q ? [`%${q}%`] : [])) as any[]
  if (q && q.trim().length >= 2) {
    await searchBtn(q.trim()).catch((e) => { if (!(e instanceof RateLimitError)) app.log.warn(e.message) })
    // A search only brings back some of a show's releases; read the rest of the top few matches so their seasons can be judged.
    const unsynced = query().filter((r) => !db.prepare('SELECT 1 FROM series_sync WHERE series_id = ?').get(r.id)).slice(0, 5)
    await Promise.all(unsynced.map((r) => ensureSynced(r.id)))
  }
  const rows = query().filter(isListed).slice(0, 100)
  rows.filter((r) => r.rating === 'Unrated').forEach((r) => queueRating(r.id))
  return { series: rows }
})

app.get('/api/series/:id', auth, async (req) => {
  const id = Number((req.params as any).id)
  if (!canViewSeries(req.user, id)) throw notFound()
  const have = (db.prepare('SELECT COUNT(*) AS n FROM releases WHERE series_id = ?').get(id) as any).n
  const synced = db.prepare('SELECT 1 FROM series_sync WHERE series_id = ?').get(id)
  // The page must not wait on BTN once we know the show: sync inline only when it has never been read in full, otherwise refresh in the background.
  const sync = ensureSynced(id)
  if (!have || !synced) await sync
  if (!seasonsOf(id)) throw notFound('This show is not available yet')
  await ensurePackFiles(id)
  const info = db.prepare(`SELECT ${seriesCols}, MAX(genres) AS genres, MAX(youtube_trailer) AS trailer FROM releases WHERE series_id = ? GROUP BY series_id`).get(id) as any
  if (!info) throw notFound()
  // First visit: give the lookup a moment so the trailer is already there; otherwise it finishes in the background.
  const looking = queueDetails(id)
  if (!getDetails(id)) await Promise.race([looking, new Promise((r) => setTimeout(r, 4000))])
  const d = getDetails(id)
  let genres: string[] = []
  try { genres = JSON.parse(info.genres ?? '[]') } catch { /* none */ }
  const { trailer, ...rest } = info
  const trailerId = youtubeId(trailer) ?? youtubeId(d?.trailer)
  // Only episodes are exposed: sources are chosen server-side, and torrent_link (passkey!) never leaves the server.
  return {
    series: { ...rest, genres, inList: !!db.prepare('SELECT 1 FROM my_list WHERE user_id = ? AND series_id = ?').get(req.user!.id, id), year: d?.year ?? null, overview: d?.overview ?? null, cast: d?.cast ?? [], trailerId, trailerThumb: trailerId ? `/api/art/${id}/trailer` : null, ...getRating(id) },
    episodes: buildEpisodes(id, req.user!.id),
  }
})

const NEW_DAYS = 7
const genresOf = (r: any): string[] => { try { return (JSON.parse(r.genres ?? '[]') as any[]).map((x) => String(x).trim()).filter(Boolean) } catch { return [] } }

/** Netflix-style home: My List, "Because you watched", a "New" row, then one row per genre; every row is newest first. */
app.get('/api/home', auth, async (req) => {
  const f = ratingClause(req.user)
  const rows = (db.prepare(`SELECT ${seriesCols}, MAX(genres) AS genres, MAX(COALESCE(m.m_rating, 'Unrated')) AS rating FROM releases ${META_JOIN}releases.series_id
      WHERE ${f.sql} GROUP BY series_id ORDER BY latest DESC`).all(...f.params) as any[]).filter(isListed).slice(0, 400)
  rows.filter((r) => r.rating === 'Unrated').forEach((r) => queueRating(r.id))
  const byGenre = new Map<string, any[]>()
  for (const r of rows) for (const g of new Set(genresOf(r))) {
    if (!byGenre.has(g)) byGenre.set(g, [])
    byGenre.get(g)!.push(r)
  }
  const fresh = now() - NEW_DAYS * 86400
  const clean = ({ genres, ...r }: any) => ({ ...r, isNew: r.latest > fresh })
  const sections = [...byGenre.entries()].filter(([, l]) => l.length >= 2 || byGenre.size < 4)
    .sort((a, b) => b[1][0].latest - a[1][0].latest || b[1].length - a[1].length).slice(0, 14)
    .map(([genre, l]) => ({ title: genre, series: l.slice(0, 30).map(clean) }))

  const uid = req.user!.id
  const listed = new Set((db.prepare('SELECT series_id FROM my_list WHERE user_id = ? ORDER BY added_at DESC').all(uid) as any[]).map((r) => r.series_id))
  const myList = [...listed].map((id) => rows.find((r) => r.id === id)).filter(Boolean).map(clean)

  // "Because you watched X": other shows sharing X's genres that this person has not started.
  let because: { name: string; series: any[] } | null = null
  const last = db.prepare('SELECT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? ORDER BY i.updated_at DESC LIMIT 1').get(uid) as any
  const base = last && rows.find((r) => r.id === last.id)
  if (base) {
    const mine = new Set(genresOf(base))
    const touched = new Set((db.prepare('SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ?').all(uid) as any[]).map((r) => r.id))
    const rec = rows.filter((r) => !touched.has(r.id)).map((r) => ({ r, score: genresOf(r).filter((g) => mine.has(g)).length })).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.latest - a.r.latest).slice(0, 20).map((x) => clean(x.r))
    if (rec.length >= 2) because = { name: base.name, series: rec }
  }
  return { new: rows.slice(0, 30).map(clean), sections, checking: unsyncedCount(), myList, because }
})

/** Add or remove a show from the viewer's own list. */
app.post('/api/mylist', auth, async (req) => {
  const { seriesId, on } = req.body as any
  const id = Number(seriesId)
  if (!Number.isInteger(id) || !canViewSeries(req.user, id) || !seasonsOf(id)) throw notFound()
  if (on) db.prepare('INSERT OR IGNORE INTO my_list VALUES (?,?,?)').run(req.user!.id, id, now())
  else db.prepare('DELETE FROM my_list WHERE user_id = ? AND series_id = ?').run(req.user!.id, id)
  return { inList: !!on }
})

app.get('/api/continue', auth, async (req) => ({ items: continueWatching(req.user!) }))

/** Rating guard for every route that names a torrent: a restricted user cannot reach a blocked show's streams. */
const torrentGuard = async (req: any, reply: any) => {
  if (!req.user) return // our own ffmpeg (internal key)
  const t = Number(req.params?.t ?? req.body?.torrentId)
  const sid = (db.prepare('SELECT series_id FROM releases WHERE torrent_id = ?').get(t) as any)?.series_id
  if (sid !== undefined && !canViewSeries(req.user, sid)) return reply.code(404).send({ error: 'Not found' })
}
const guarded = { preHandler: [requireUser, torrentGuard] }

/** Artwork is served from our own cache; the browser never talks to BTN's image host. */
app.get('/api/art/:id/:kind', auth, async (req, reply) => {
  const { id, kind } = req.params as any
  if (!canViewSeries(req.user, Number(id))) return reply.code(404).send({ error: 'no artwork' })
  if (kind !== 'poster' && kind !== 'banner' && kind !== 'trailer') return reply.code(404).send({ error: 'unknown artwork' })
  const art = await getArt(Number(id), kind)
  if (!art) return reply.code(404).send({ error: 'no artwork' })
  return reply.type(art.type).header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff').send(createReadStream(art.path))
})

// ---- playback ---------------------------------------------------------------
app.post('/api/play', guarded, async (req) => {
  const { torrentId, fileIndex } = req.body as any
  return startPlayback(req.user!.id, Number(torrentId), fileIndex === undefined ? undefined : Number(fileIndex))
})

const cleanIds = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10) : [])

/** The one-tap path: pick the best source (1080p, else 4K) and start playing. `avoid` = sources that already failed for this viewer. */
app.post('/api/watch', auth, async (req) => {
  const { seriesId, season, label } = req.body as any
  const avoid = new Set(cleanIds((req.body as any).avoid))
  if (!canViewSeries(req.user, Number(seriesId))) throw notFound('That show is not available')
  if (avoid.size) { // the viewer was moved to another source: stop holding the one that did not work
    db.prepare(`UPDATE interests SET released_at = ? WHERE user_id = ? AND watched_at IS NULL AND torrent_id IN (${[...avoid].map(() => '?').join(',')})`).run(now(), req.user!.id, ...avoid)
  }
  await ensurePackFiles(Number(seriesId), avoid)
  const eps = buildEpisodes(Number(seriesId), req.user!.id, avoid)
  const i = eps.findIndex((e) => e.season === (season ?? null) && e.label === label)
  if (i < 0) throw Object.assign(new Error(avoid.size ? 'There is no other source for this episode.' : 'That episode is not available'), { statusCode: 404 })
  const ep = eps[i]
  if (!ep.available) throw Object.assign(new Error('Nobody is sharing this episode right now. Please try again later.'), { statusCode: 503 })
  const play = await startPlayback(req.user!.id, ep.torrentId, undefined, { episodeLabel: ep.isPack && ep.episode === null ? undefined : ep.label })
  const next = eps.slice(i + 1).find((e) => e.available)
  const seriesName = (db.prepare('SELECT series FROM releases WHERE series_id = ? LIMIT 1').get(Number(seriesId)) as any)?.series
  return { ...play, seriesName, quality: ep.quality, title: ep.label, next: next ? { season: next.season, label: next.label } : null }
})

const prefetched = new Map<string, number>()
/** While one episode plays, start fetching the next so "Up next" is instant. Quiet by design: failures are ignored. */
app.post('/api/prefetch', auth, async (req) => {
  const { seriesId, season, label } = req.body as any
  if (!canViewSeries(req.user, Number(seriesId))) return { ok: false }
  const eps = buildEpisodes(Number(seriesId), req.user!.id)
  const i = eps.findIndex((e) => e.season === (season ?? null) && e.label === label)
  const next = i < 0 ? undefined : eps.slice(i + 1).find((e) => e.available)
  if (!next) return { ok: false }
  const key = `${req.user!.id}:${next.torrentId}:${next.label}`
  if ((prefetched.get(key) ?? 0) > Date.now() - 600_000) return { ok: true }
  prefetched.set(key, Date.now())
  startPlayback(req.user!.id, next.torrentId, undefined, { episodeLabel: next.isPack && next.episode === null ? undefined : next.label }).catch((e) => app.log.info(`prefetch skipped: ${e.message}`))
  return { ok: true }
})

app.get('/api/stream/:t/:f/status', guarded, async (req) => {
  const { t, f } = req.params as any
  return (await bufferStatus(+t, +f)) ?? { error: 'not ready' }
})

const audioIdx = (v: unknown) => { const n = Number(v ?? 0); return Number.isInteger(n) && n >= 0 && n < 32 ? n : 0 }

app.get('/api/stream/:t/:f/info', guarded, async (req) => {
  const { t, f } = req.params as any
  const a = audioIdx((req.query as any).a)
  const p = await probe(+t, +f)
  const direct = p.direct && a === 0 // another audio track needs the transcode path (raw bytes can't switch tracks)
  const path = direct ? 'raw' : a ? `hls-a/${a}/index.m3u8` : 'hls/index.m3u8'
  const base = `/api/stream/${t}/${f}`
  // A TV or cast device has no cookie, so it gets a link with a signed token in the path instead.
  const tv = `/api/tv/${tvToken(req.user!.id)}/${t}/${f}/${path}`
  return {
    mode: direct ? 'direct' : 'hls', url: `${base}/${path}`, tvUrl: tv, duration: p.duration, audioIndex: a, hdr: p.hdr,
    audio: p.audio, chapters: p.chapters,
    subs: p.subs.map((s) => ({ n: s.n, lang: s.lang, label: s.label, forced: s.forced, default: s.default, url: `${base}/subs/${s.n}.vtt` })),
  }
})

/** An embedded text subtitle as WebVTT. While the file is still arriving it covers what has arrived; x-flix-complete says when to stop asking. */
app.get('/api/stream/:t/:f/subs/:file', guarded, async (req, reply) => {
  const { t, f, file } = req.params as any
  const m = /^(\d{1,2})\.vtt$/.exec(file)
  if (!m) return reply.code(404).send({ error: 'no such subtitle' })
  const p = await probe(+t, +f)
  const fi = await fileInfo(+t, +f)
  if (!fi || !p.subs.some((s) => s.n === +m[1])) return reply.code(404).send({ error: 'no such subtitle' })
  const { vtt, complete } = await subtitleVtt(+t, +f, +m[1], fi.file.progress, p.duration ?? 0)
  return reply.type('text/vtt; charset=utf-8').header('cache-control', 'no-store').header('x-flix-complete', complete ? '1' : '0').send(vtt)
})

const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' }

async function rawHandler(req: any, reply: any) {
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
}

async function hlsHandler(req: any, reply: any) {
  const { t, f, file } = req.params as any
  const a = audioIdx(req.params.a)
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(file)) return reply.code(400).send({ error: 'bad file' })
  if (file === 'index.m3u8' || !touchHls(+t, +f, a)) {
    const p = await probe(+t, +f)
    try { await ensureHls(+t, +f, p, a) } catch (e: any) { return reply.code(503).send({ error: e.message }) }
  }
  const path = join(jobDir(+t, +f, a), file)
  if (!existsSync(path)) return reply.code(404).send({ error: 'segment not ready' })
  return reply.type(file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t').header('cache-control', 'no-store').send(createReadStream(path))
}

/** The same video routes twice: with the login cookie, and with a signed token in the path for TVs and cast devices. */
const tvAuth = async (req: any, reply: any) => {
  const u = userForTvToken(String(req.params?.token ?? ''))
  if (!u) return reply.code(401).send({ error: 'This link has expired' })
  req.user = u
}
for (const [prefix, pre] of [['/api/stream', [requireUser, torrentGuard]], ['/api/tv/:token', [tvAuth, torrentGuard]]] as const) {
  app.get(`${prefix}/:t/:f/raw`, { preHandler: pre as any }, rawHandler)
  app.get(`${prefix}/:t/:f/hls/:file`, { preHandler: pre as any }, hlsHandler)
  app.get(`${prefix}/:t/:f/hls-a/:a/:file`, { preHandler: pre as any }, hlsHandler)
}

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
  const rows = db.prepare(`SELECT d.torrent_id, d.info_hash, d.state, d.added_at, d.removed_at, d.remove_reason, r.series, r.group_name, r.resolution, r.is_pack
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id ORDER BY d.added_at DESC LIMIT 200`).all() as any[]
  const out = []
  for (const d of rows) {
    if (d.state !== 'active') { out.push(d); continue }
    const t = await engine.info(d.info_hash)
    if (!t) { out.push({ ...d, missing: true }); continue }
    const k = whyKept(t, d.torrent_id)
    out.push({ ...d, progress: t.progress, size: t.total_size, uploaded: t.uploaded, dlspeed: t.dlspeed, upspeed: t.upspeed, seeds: t.num_seeds, peers: t.num_leechs,
      engineState: t.state, eta: t.eta ?? null, left: t.amount_left,
      ratio: k.seed.ratio, seedHours: k.seed.hours, seedMet: k.seed.met, deletable: k.deletable, reasons: k.reasons, waitingFor: k.pending })
  }
  return { requirements: config.seed, downloads: out, disk: diskInfo(), minFreeGb: config.minFreeGb }
})
app.get('/api/admin/health', admin, async () => ({ issues: await health(), backup: lastBackup() }))
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
const userRow = (u: any) => ({ id: u.id, name: u.name, is_admin: !!u.is_admin, created_at: u.created_at, allowed: parseAllowed(u.allowed_ratings) })
const adminCount = () => (db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get() as any).c as number

app.get('/api/admin/users', admin, async () => ({
  users: (db.prepare('SELECT id, name, is_admin, created_at, allowed_ratings FROM users ORDER BY id').all() as any[]).map(userRow),
  ratings: RATINGS, ratingLookup: !!config.tmdb.apiKey,
}))
app.post('/api/admin/users', admin, async (req) => {
  const { name, password, isAdmin, allowedRatings } = req.body as any
  return createUser(String(name ?? ''), String(password ?? ''), !!isAdmin, cleanAllowed(allowedRatings))
})
app.patch('/api/admin/users/:id', admin, async (req) => {
  const id = Number((req.params as any).id)
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!u) throw notFound('No such user')
  const b = req.body as any
  if ('allowedRatings' in b) db.prepare('UPDATE users SET allowed_ratings = ? WHERE id = ?').run((a => (a ? JSON.stringify(a) : null))(cleanAllowed(b.allowedRatings)), id)
  if ('isAdmin' in b) {
    if (!b.isAdmin && u.is_admin && adminCount() <= 1) throw Object.assign(new Error('There must always be at least one admin'), { statusCode: 400 })
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(b.isAdmin ? 1 : 0, id)
  }
  if (b.password !== undefined) {
    if (String(b.password).length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 })
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), id)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id) // sign them out everywhere
  }
  return userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
})
app.post('/api/admin/users/:id/invite', admin, async (req) => {
  const id = Number((req.params as any).id)
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('No such user')
  return { token: createInvite(id), days: 7 }
})
app.delete('/api/admin/users/:id', admin, async (req) => {
  const id = Number((req.params as any).id)
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!u) throw notFound('No such user')
  if (id === req.user!.id) throw Object.assign(new Error("You can't remove your own account"), { statusCode: 400 })
  if (u.is_admin && adminCount() <= 1) throw Object.assign(new Error('There must always be at least one admin'), { statusCode: 400 })
  db.prepare('DELETE FROM users WHERE id = ?').run(id) // sessions and watch holds cascade, so their unwatched shows stop being kept
  return { ok: true }
})

// ---- settings ----------------------------------------------------------------
// The BTN key is write-only: the API reports whether it is set and its last 4 characters, never the key.
app.get('/api/admin/settings', admin, async () => ({ btn: btnKeyStatus(), qb: qbStatus(), tmdb: tmdbKeyStatus() }))
app.put('/api/admin/settings/btn', admin, async (req) => {
  const key = String((req.body as any)?.apiKey ?? '').trim()
  if (key.length > 200 || /\s/.test(key)) throw Object.assign(new Error('That does not look like an API key'), { statusCode: 400 })
  setBtnApiKey(key)
  startBtnSync()
  return { btn: btnKeyStatus() }
})
/** Make one authenticated call so the admin can see whether the key (and this server's IP) is accepted. */
app.post('/api/admin/settings/btn/test', admin, async () => {
  const info = await btnCall<any>('userInfo')
  return { ok: true, username: typeof info?.Username === 'string' ? info.Username : null }
})

app.put('/api/admin/settings/tmdb', admin, async (req) => {
  const key = String((req.body as any)?.apiKey ?? '').trim()
  if (key.length > 200 || /\s/.test(key)) throw Object.assign(new Error('That does not look like an API key'), { statusCode: 400 })
  setTmdbApiKey(key)
  return { tmdb: tmdbKeyStatus() }
})
/** One cheap authenticated TMDB call, so the admin sees whether the key is accepted. */
app.post('/api/admin/settings/tmdb/test', admin, async () => {
  const { apiKey, apiUrl } = config.tmdb
  if (!apiKey) throw Object.assign(new Error('No TMDB key set'), { statusCode: 400 })
  const res = await fetch(`${apiUrl}/configuration?api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw Object.assign(new Error(`Could not reach TMDB: ${e.message}`), { statusCode: 502 })
  })
  if (res.status === 401) throw Object.assign(new Error('TMDB rejected this key'), { statusCode: 400 })
  if (!res.ok) throw Object.assign(new Error(`TMDB returned HTTP ${res.status}`), { statusCode: 502 })
  return { ok: true }
})
app.put('/api/admin/settings/qb', admin, async (req) => {
  const b = (req.body ?? {}) as any
  if (b.reset) clearQb()
  else {
    const url = String(b.url ?? '').trim(), user = String(b.user ?? '').trim(), password = String(b.password ?? '')
    if (!/^https?:\/\/[^\s/]+/i.test(url) || url.length > 300) throw Object.assign(new Error('Enter the qBittorrent address, like http://127.0.0.1:8080'), { statusCode: 400 })
    if (!user || user.length > 100 || password.length > 200) throw Object.assign(new Error('Enter the qBittorrent username'), { statusCode: 400 })
    setQb({ url, user, password })
  }
  return { qb: qbStatus() }
})
/** Log in to qBittorrent with the saved settings so the admin sees whether they work. */
app.post('/api/admin/settings/qb/test', admin, async () => {
  try { return { ok: true, version: await qb.reconnect() } }
  catch (e: any) { throw Object.assign(new Error(`Could not connect to qBittorrent: ${e.message}`), { statusCode: 502 }) }
})

/** Set (or clear, with null = automatic) a show's content rating. */
app.put('/api/admin/series/:id/rating', admin, async (req) => {
  const id = Number((req.params as any).id)
  const { rating } = req.body as any
  if (rating !== null && !isRating(rating)) throw Object.assign(new Error('Unknown rating'), { statusCode: 400 })
  setRating(id, rating)
  if (rating === null) queueRating(id)
  return { ...getRating(id) }
})

// ---- boot -------------------------------------------------------------------
cleanHlsCache()
const runSweep = startSweeper()

let btnSyncStarted = false
/** Start the periodic catalog sync once a key exists; safe to call again (e.g. after the key is saved). */
function startBtnSync() {
  if (!config.btn.apiKey) return false
  if (btnSyncStarted) return true
  btnSyncStarted = true
  syncLatest().catch((e) => app.log.warn(`initial BTN sync failed: ${e.message}`))
  setInterval(() => syncLatest().catch((e) => app.log.warn(`BTN sync failed: ${e.message}`)), 30 * 60_000).unref()
  return true
}

export async function start() {
  try {
    await qb.setup()
    app.log.info(`qBittorrent ${await qb.version()} connected`)
  } catch (e: any) {
    app.log.error(`Cannot reach qBittorrent at ${config.qb.url}: ${e.message}. Playback will fail until it is available.`)
  }
  try {
    await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' })
  } catch (e: any) {
    if (e.code === 'EADDRINUSE') app.log.fatal(`Port ${config.port} is already in use: another Flix (or other app) is still running. Stop it, or set PORT in .env.`)
    else app.log.fatal(`Could not start the web server: ${e.message}`)
    process.exit(1)
  }
  startCrawler()
  startBackups()
  if (!startBtnSync()) app.log.warn('No BTN API key set (BTN_API_KEY or Settings): the catalog will stay empty')
  void runSweep
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) await start()
