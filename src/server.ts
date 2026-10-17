import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { createInvite, createUser, hasPin, pinOk, setPin, hashPassword, login, logout, newSession, redeemInvite, requireAdmin, requireUser, sessionUser, setSessionCookie, tvToken, userCount, userFor, userForTvToken } from './auth.ts'
import { RATINGS, META_JOIN, canViewSeries, cleanAllowed, getRating, parseAllowed, queueRating, ratingClause } from './ratings.ts'
import { qb } from './qb.ts'
import { searchBtn, startCrawler, syncLatest, syncSeries } from './catalog.ts'
import { IpNotAuthorizedError, RateLimitError, btnCall } from './btn/client.ts'
import { btnKeyStatus, clearQb, omdbKeyStatus, qbStatus, setBtnApiKey, setOmdbApiKey, setQb, setTmdbApiKey, tmdbKeyStatus } from './settings.ts'
import { bufferStatus, fileInfo, readRange, startPlayback, StreamTimeout } from './streaming.ts'
import { SUBFILE, cleanHlsCache, ensureHls, fileSubtitleVtt, guessSubLang, jobDir, probe, subtitleVtt, touchHls } from './transcode.ts'
import { parseEpisodeTag } from './btn/parse.ts'
import { artPathSql, getArt, getCastPhoto, getStill } from './art.ts'
import { episodeInfoFor, queueEpisodeInfo } from './episodeinfo.ts'
import { buildEpisodes, continueWatching } from './episodes.ts'
import { listable, seasonsOf, unsyncedCount } from './seasons.ts'
import { ensurePackFiles } from './packs.ts'
import { diskInfo, health, lastBackup, startBackups } from './health.ts'
import { ROW_SIZE, curateHome } from './home.ts'
import { storageHistory } from './storage.ts'
import { autoForListed, autoNext, NEXT_EPISODE_AT, startAutoDownloads } from './autodl.ts'
import { ensureNet, netInfo, startNetworkCrawler } from './networks.ts'
import { tasteOf, tasteSort } from './taste.ts'
import { holdersOf, pendingViewers, recheckMissingFiles, relocateDownloads, removeDownload, seedStatus, startSweeper, whyKept } from './retention.ts'
import { qb as engine } from './qb.ts'
import { getDetails, queueDetails, youtubeId } from './details.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err: any, _req, reply) => {
  const status = err instanceof RateLimitError ? 429 : err instanceof IpNotAuthorizedError ? 403 : err.statusCode ?? 500
  if (status >= 500) app.log.error(err)
  reply.code(status).send({ error: err.message })
})

// ---- one address ------------------------------------------------------------
// Umbrel puts its own HTTPS in front of Flix's plain-HTTP port 8096, and that
// certificate is only issued for umbrel.local — so https://<tailnet-name>:8096 can
// never validate and a phone that guesses https first shows a certificate warning.
// Tailscale Serve on :9443 holds a real certificate for the name and proxies here.
// With PUBLIC_URL set, every other address is sent there; with it unset (the
// default) every address serves Flix exactly as before.
if (config.publicUrl) {
  const canonical = new URL(config.publicUrl)
  // The exact Host values that are already the one address (https on the default port
  // arrives without it).
  const ok = new Set([canonical.host])
  if (!canonical.port || canonical.port === '443') ok.add(canonical.hostname)
  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '').toLowerCase()
    // Already on the good address — the loop is broken here. Same name on port 8096
    // is not: that is Umbrel's proxy with its umbrel.local certificate.
    if (ok.has(host)) return
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    // Loopback (also what the Tailscale proxy dials if it ever stops forwarding the
    // original Host) and Docker service names, which have no dot
    // (blofstedt-flix_app_1, app), keep working.
    if (name === 'localhost' || name === '[::1]' || name.startsWith('127.') || !name.includes('.')) return
    // A TV or cast device fetches the media itself and cannot resolve the tailnet name, so the signed stream links
    // are served on whatever address the device used. They carry an unguessable token in the path, never a cookie.
    if (req.url.startsWith('/api/tv/')) return
    // 308 so a POST keeps its method and body; only a stale cached shell sends one here.
    return reply.redirect(config.publicUrl + req.url, 308)
  })
}

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
  const uid = sessionUser(token)
  if (!uid) return reply.code(401).send({ error: 'That profile needs to sign in again' })
  if (userFor(req)?.id !== uid) { // moving between profiles; a PIN guards the one being opened
    const ok = pinOk(uid, (req.body as any)?.pin)
    if (ok === 'locked') return reply.code(429).send({ error: 'Too many wrong tries. Wait a few minutes.', pin: true })
    if (!ok) return reply.code(403).send({ error: (req.body as any)?.pin ? 'Wrong PIN' : 'PIN needed', pin: true })
  }
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
const ensureSynced = (id: number) => syncSeries(id).then(() => ensureNet(id)).catch((e) => { if (!(e instanceof RateLimitError)) app.log.warn(`series sync failed: ${e.message}`) })

const btnSearched = new Map<string, number>()
app.get('/api/series', auth, async (req) => {
  const { q, local } = req.query as { q?: string; local?: string }
  const f = ratingClause(req.user)
  const query = () => db.prepare(`SELECT ${seriesCols}, MAX(COALESCE(m.m_rating, 'Unrated')) AS rating FROM releases ${META_JOIN}releases.series_id
      WHERE ${f.sql}${q ? ' AND series LIKE ?' : ''} GROUP BY series_id ORDER BY latest DESC LIMIT 400`).all(...f.params, ...(q ? [`%${q}%`] : [])) as any[]
  // `local` answers from what Flix already knows, instantly; the page follows up without it to bring in BTN's results.
  // A term searched on BTN in the last few minutes is not asked again.
  const term = q?.trim().toLowerCase() ?? ''
  if (!local && term.length >= 2 && (btnSearched.get(term) ?? 0) < Date.now() - 300_000) {
    btnSearched.set(term, Date.now())
    if (btnSearched.size > 500) btnSearched.delete(btnSearched.keys().next().value!)
    await searchBtn(q!.trim()).catch((e) => { if (!(e instanceof RateLimitError)) app.log.warn(e.message) })
    // A search only brings back some of a show's releases; read the rest of the top few matches (and their language and season lengths) so their seasons can be judged.
    const unsynced = query().filter((r) => !db.prepare('SELECT 1 FROM series_sync WHERE series_id = ?').get(r.id) || !db.prepare('SELECT 1 FROM series_net WHERE series_id = ?').get(r.id)).slice(0, 5)
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
  const looking = Promise.all([queueDetails(id), queueEpisodeInfo(id)])
  if (!getDetails(id) || !episodeInfoFor(id).size) await Promise.race([looking, new Promise((r) => setTimeout(r, 4000))])
  const d = getDetails(id)
  db.prepare('UPDATE my_list SET seen_at = ? WHERE user_id = ? AND series_id = ?').run(info.latest, req.user!.id, id) // clears the "new episode" badge
  let genres: string[] = []
  try { genres = JSON.parse(info.genres ?? '[]') } catch { /* none */ }
  const { trailer, ...rest } = info
  // Checked trailers first (BTN's own link is only used while none are known: it can be private or removed). The player tries them in turn.
  const trailerIds = d?.trailers.length ? d.trailers : [youtubeId(trailer) ?? youtubeId(d?.trailer)].filter((x): x is string => !!x)
  const trailerId = trailerIds[0] ?? null
  // Only episodes are exposed: sources are chosen server-side, and torrent_link (passkey!) never leaves the server.
  return {
    series: { ...rest, genres, inList: !!db.prepare('SELECT 1 FROM my_list WHERE user_id = ? AND series_id = ?').get(req.user!.id, id), vote: (db.prepare('SELECT vote FROM votes WHERE user_id = ? AND series_id = ?').get(req.user!.id, id) as any)?.vote ?? 0, year: d?.year ?? null, overview: d?.overview ?? null, cast: (d?.cast ?? []).map((c, n) => ({ name: c.name, role: c.role, photo: c.photo ? `/api/cast/${id}/${n}` : null })), trailerId, trailerIds, trailerThumb: trailerId ? `/api/art/${id}/trailer` : null, ...getRating(id) },
    episodes: withInfo(id, buildEpisodes(id, req.user!.id)),
  }
})

/** Add each episode's title, summary, length and still image when we know them. */
function withInfo<T extends { season: number | null; episode: number | null }>(seriesId: number, eps: T[]) {
  const info = episodeInfoFor(seriesId)
  return eps.map((e) => {
    const i = e.season !== null && e.episode !== null ? info.get(`${e.season}|${e.episode}`) : undefined
    return { ...e, title: i?.name ?? null, overview: i?.overview ?? null, runtime: i?.runtime ?? null, still: e.season !== null && e.episode !== null ? `/api/still/${seriesId}/${e.season}/${e.episode}` : null } // always asked for: the server falls back to the show's artwork
  })
}

/** An episode's still image from our own cache. */
app.get('/api/still/:id/:s/:e', auth, async (req, reply) => {
  const { id, s, e } = req.params as any
  if (!canViewSeries(req.user, Number(id))) return reply.code(404).send({ error: 'no image' })
  const art = await getStill(Number(id), Number(s), Number(e))
  if (!art) return reply.code(404).send({ error: 'no image' })
  return reply.type(art.type).header('cache-control', 'private, max-age=604800').header('x-content-type-options', 'nosniff').send(createReadStream(art.path))
})

const NEW_DAYS = 7
const genresOf = (r: any): string[] => { try { return (JSON.parse(r.genres ?? '[]') as any[]).map((x) => String(x).trim()).filter(Boolean) } catch { return [] } }

/**
 * Netflix-style home: your own rows first (My List, "Because you watched"), then what is trending and the newest shows from HBO,
 * Crave, Showcase, Netflix, Disney+ and Apple TV+, then more of those under one genre each. Discovery rows hold ten shows (see home.ts).
 */
app.get('/api/home', auth, async (req) => {
  const f = ratingClause(req.user)
  const net = netInfo()
  const all = (db.prepare(`SELECT ${seriesCols}, MAX(genres) AS genres, MAX(COALESCE(m.m_rating, 'Unrated')) AS rating FROM releases ${META_JOIN}releases.series_id
      WHERE ${f.sql} GROUP BY series_id ORDER BY latest DESC`).all(...f.params) as any[]).filter(isListed).slice(0, 1500)
  all.forEach((r) => { r.genres = genresOf(r) })
  all.filter((r) => r.rating === 'Unrated').forEach((r) => queueRating(r.id))
  const taste = tasteOf(req.user!.id, (id) => all.find((r) => r.id === id)?.genres ?? [])
  const fresh = now() - NEW_DAYS * 86400
  const clean = ({ genres, ...r }: any) => ({ ...r, isNew: r.latest > fresh })

  const uid = req.user!.id
  const listed = db.prepare('SELECT series_id, seen_at FROM my_list WHERE user_id = ? ORDER BY added_at DESC').all(uid) as { series_id: number; seen_at: number | null }[]
  // hasNew: something was uploaded for a show on the list since the viewer last opened its page
  // A show in Continue Watching is not shown again anywhere else on the screen.
  const resume = new Set<number>(continueWatching(req.user!).map((c: any) => c.seriesId))
  const myList = listed.filter((l) => !resume.has(l.series_id)).map((l) => { const r = all.find((x) => x.id === l.series_id); return r && { ...clean(r), hasNew: l.seen_at !== null && r.latest > l.seen_at } }).filter(Boolean) as any[]
  const taken = new Set<number>([...resume, ...myList.map((r) => r.id)])

  // "Because you watched X": other shows sharing X's genres that this person has not started.
  let because: { name: string; liked: boolean; series: any[] } | null = null
  const last = db.prepare('SELECT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? ORDER BY i.updated_at DESC LIMIT 1').get(uid) as any
  // The last show they gave a thumbs up to leads over the last one they watched.
  const base = (taste.lastLiked != null && all.find((r) => r.id === taste.lastLiked)) || (last && all.find((r) => r.id === last.id))
  const likedBase = !!base && base.id === taste.lastLiked
  if (base) {
    const mine = new Set<string>(base.genres)
    const touched = new Set((db.prepare('SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ?').all(uid) as any[]).map((r) => r.id))
    const rec = all.filter((r) => !touched.has(r.id) && !taken.has(r.id) && !taste.hidden.has(r.id) && net.get(r.id)?.streamer).map((r) => ({ r, score: r.genres.filter((g: string) => mine.has(g)).length + 0.5 * taste.fit(r.genres) })).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.latest - a.r.latest).slice(0, ROW_SIZE).map((x) => clean(x.r))
    if (rec.length === ROW_SIZE) { because = { name: base.name, liked: likedBase, series: rec }; rec.forEach((r) => taken.add(r.id)) }
  }
  // Shows already being watched stay out of the discovery rows: they are in Continue Watching.
  const started = new Set((db.prepare('SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? AND i.watched_at IS NULL AND i.position > 30').all(uid) as any[]).map((r) => r.id as number))
  // A show watched all the way through is not recommended again (it stays in My List and search, and shows what is new in it there).
  const finished = new Set<number>()
  for (const r of db.prepare('SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? AND i.watched_at IS NOT NULL').all(uid) as { id: number }[]) {
    const eps = buildEpisodes(r.id, uid)
    if (eps.length && eps.every((e) => e.watched)) finished.add(r.id)
  }
  // "Picked for you": the freshest shows that suit their taste, when they have given any thumbs or finished enough to tell.
  let picked: any[] | null = null
  if (taste.genres.size) {
    const cands = all.filter((r) => !started.has(r.id) && !finished.has(r.id) && !taken.has(r.id) && !taste.hidden.has(r.id) && taste.fit(r.genres) > 0.2)
    const rows = tasteSort(cands, taste, 40).slice(0, ROW_SIZE)
    if (rows.length === ROW_SIZE) { picked = rows.map(clean); rows.forEach((r) => taken.add(r.id)) }
  }
  const { hero, sections } = curateHome(all.filter((r) => !started.has(r.id) && !taste.hidden.has(r.id) && !finished.has(r.id)), net, taken, taste)
  const listIds = listed.map((l) => l.series_id)
  return { hero: hero && clean(hero), listIds, sections: sections.map((s) => ({ title: s.title, series: s.series.map(clean) })), checking: unsyncedCount(), myList, because, picked }
})

/** Thumbs up (1), thumbs down (-1) or clear (0) for a show. Feeds the home screen's picks. */
app.post('/api/vote', auth, async (req) => {
  const { seriesId, vote } = (req.body ?? {}) as any
  const id = Number(seriesId), v = Number(vote)
  if (!Number.isInteger(id) || !canViewSeries(req.user, id) || ![-1, 0, 1].includes(v)) throw notFound()
  if (v) db.prepare('INSERT INTO votes (user_id, series_id, vote, voted_at) VALUES (?,?,?,?) ON CONFLICT(user_id, series_id) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at').run(req.user!.id, id, v, now())
  else db.prepare('DELETE FROM votes WHERE user_id = ? AND series_id = ?').run(req.user!.id, id)
  return { vote: v }
})

/** Add or remove a show from the viewer's own list. */
app.post('/api/mylist', auth, async (req) => {
  const { seriesId, on } = req.body as any
  const id = Number(seriesId)
  if (!Number.isInteger(id) || !canViewSeries(req.user, id) || !seasonsOf(id)) throw notFound()
  if (on) db.prepare('INSERT OR IGNORE INTO my_list (user_id, series_id, added_at, seen_at) VALUES (?,?,?,(SELECT MAX(time) FROM releases WHERE series_id = ?))').run(req.user!.id, id, now(), id)
  else db.prepare('DELETE FROM my_list WHERE user_id = ? AND series_id = ?').run(req.user!.id, id)
  if (on) void autoForListed(req.user!.id, id) // its first unwatched episode starts downloading, within the pre-download limits
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

/** A cast member's photo from our own cache. */
app.get('/api/cast/:id/:i', auth, async (req, reply) => {
  const { id, i } = req.params as any
  if (!canViewSeries(req.user, Number(id))) return reply.code(404).send({ error: 'no image' })
  const art = await getCastPhoto(Number(id), Number(i))
  if (!art) return reply.code(404).send({ error: 'no image' })
  return reply.type(art.type).header('cache-control', 'private, max-age=604800').header('x-content-type-options', 'nosniff').send(createReadStream(art.path))
})

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
  const titles = episodeInfoFor(Number(seriesId))
  const nameOf = (e: { season: number | null; episode: number | null }) => (e.season !== null && e.episode !== null ? titles.get(`${e.season}|${e.episode}`)?.name ?? null : null)
  return { ...play, seriesName, quality: ep.quality, title: ep.label, episodeTitle: nameOf(ep), next: next ? { season: next.season, label: next.label, title: nameOf(next) } : null }
})

/** Partway through an episode: line up the next one (see autodl.ts for the limits). Quiet by design: it never fails the player. */
app.post('/api/prefetch', auth, async (req) => {
  const { seriesId, season, label } = req.body as any
  if (!canViewSeries(req.user, Number(seriesId))) return { ok: false }
  void autoNext(req.user!.id, Number(seriesId), season ?? null, String(label ?? ''))
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
  // Casting always uses the HLS playlist: the cast receiver plays HLS but not Matroska. It is made absolute on the
  // LAN address when one is configured, because the receiver cannot resolve the tailnet name this page came from.
  const tvHls = `/api/tv/${tvToken(req.user!.id)}/${t}/${f}/${a ? `hls-a/${a}/index.m3u8` : 'hls/index.m3u8'}`
  return {
    mode: direct ? 'direct' : 'hls', url: `${base}/${path}`, tvUrl: tv, castUrl: config.lanUrl ? config.lanUrl + tvHls : null, duration: p.duration, audioIndex: a, hdr: p.hdr,
    audio: p.audio, chapters: p.chapters,
    subs: [...p.subs.map((s) => ({ n: s.n as number | string, lang: s.lang, label: s.label, forced: s.forced, default: s.default, url: `${base}/subs/${s.n}.vtt` })), ...(await externalSubs(+t, +f, base))],
  }
})

/** Subtitle files shipped beside the video (".srt" etc.): in a season pack only the ones for this episode. Needs the file fully downloaded to be read. */
async function externalSubs(t: number, f: number, base: string) {
  const fi = await fileInfo(t, f).catch(() => null)
  if (!fi) return []
  const mine = parseEpisodeTag(fi.file.name.split('/').pop()!)
  return fi.layout.files.filter((x) => SUBFILE.test(x.name)).filter((x) => {
    if (!fi.rel.is_pack) return true
    const tag = parseEpisodeTag(x.name.split('/').pop()!) ?? parseEpisodeTag(x.name)
    return !!mine && !!tag && tag.season === mine.season && mine.episode >= tag.episode && mine.episode <= tag.episodeEnd
  }).map((x) => { const g = guessSubLang(x.name); return { n: `x${x.index}`, lang: g.lang, label: g.label, forced: g.forced, default: false, url: `${base}/xsubs/${x.index}.vtt` } })
}

app.get('/api/stream/:t/:f/xsubs/:file', guarded, async (req, reply) => {
  const { t, f, file } = req.params as any
  const m = /^(\d{1,4})\.vtt$/.exec(file)
  const fi = m ? await fileInfo(+t, +f) : null
  const sub = fi?.layout.files.find((x) => x.index === Number(m![1]) && SUBFILE.test(x.name))
  if (!fi || !sub) return reply.code(404).send({ error: 'no such subtitle' })
  const ready = sub.progress >= 1
  reply.type('text/vtt; charset=utf-8').header('cache-control', 'no-store').header('x-flix-complete', ready ? '1' : '0')
  return ready ? fileSubtitleVtt(join(fi.layout.savePath, sub.name)) : 'WEBVTT\n\n'
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
  // A cast receiver fetches the playlist and every segment from its own origin, so it needs CORS.
  reply.header('access-control-allow-origin', '*').header('access-control-expose-headers', 'content-length, content-range')
}
// Ranges (and anything else a receiver asks with) need a preflight answered before the media is fetched.
app.options('/api/tv/*', async (_req, reply) =>
  reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    .header('access-control-allow-headers', 'range, origin, content-type').header('access-control-max-age', '86400').code(204).send())
for (const [prefix, pre] of [['/api/stream', [requireUser, torrentGuard]], ['/api/tv/:token', [tvAuth, torrentGuard]]] as const) {
  app.get(`${prefix}/:t/:f/raw`, { preHandler: pre as any }, rawHandler)
  app.get(`${prefix}/:t/:f/hls/:file`, { preHandler: pre as any }, hlsHandler)
  app.get(`${prefix}/:t/:f/hls-a/:a/:file`, { preHandler: pre as any }, hlsHandler)
}

// ---- watch state ------------------------------------------------------------
/** Which episode of a torrent this file is, so the one after it can be lined up (a pack names each file by its own SxxEyy). */
async function lineUpNext(userId: number, torrentId: number, fileIndex: number) {
  const rel = db.prepare('SELECT series_id, season, label, is_pack FROM releases WHERE torrent_id = ?').get(torrentId) as any
  if (!rel) return
  let label = String(rel.label ?? '')
  if (rel.is_pack) {
    const i = db.prepare('SELECT file_name FROM interests WHERE user_id=? AND torrent_id=? AND file_index=?').get(userId, torrentId, fileIndex) as any
    const tag = /S\d+E\d+/i.exec(i?.file_name ?? '')?.[0]?.toUpperCase()
    if (!tag) return
    label = tag
  }
  if (label) await autoNext(userId, rel.series_id, rel.season, label, 'next episode, current one is past 60%')
}
app.post('/api/progress', auth, async (req) => {
  const { torrentId, fileIndex, position, duration, ended } = req.body as any
  const frac = duration > 0 ? position / duration : 0
  // "Watched" means played to the end: the player says so when the video ends, and the last few seconds count as the end
  // (the reported length and the playing position rarely agree to the frame). Anything less keeps the file for the viewer.
  const done = !!ended || (config.watchedThreshold >= 1 ? duration > 0 && duration - position <= 3 : frac >= config.watchedThreshold)
  db.prepare(`UPDATE interests SET position=?, duration=?, updated_at=?, watched_at = CASE WHEN ? THEN COALESCE(watched_at, ?) ELSE watched_at END
    WHERE user_id=? AND torrent_id=? AND file_index=?`).run(position, duration, now(), done ? 1 : 0, now(), req.user!.id, torrentId, fileIndex)
  // The player asks for the next episode itself once it is 60% through, but a client that does not (a TV app, a reloaded
  // tab) must still get it: line it up from here as well. Repeats are dropped inside autoFetch for ten minutes.
  if (!done && frac >= NEXT_EPISODE_AT) void lineUpNext(req.user!.id, torrentId, fileIndex).catch(() => {})
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
  const rows = db.prepare(`SELECT d.torrent_id, d.info_hash, d.state, d.added_at, d.removed_at, d.remove_reason, d.origin, r.series, r.group_name, r.resolution, r.is_pack
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id ORDER BY d.added_at DESC LIMIT 200`).all() as any[]
  const out = []
  for (const d of rows) {
    if (d.state !== 'active') { out.push(d); continue }
    const t = await engine.info(d.info_hash)
    if (!t) { out.push({ ...d, missing: true }); continue }
    const k = whyKept(t, d.torrent_id)
    out.push({ ...d, progress: t.progress, size: t.total_size, uploaded: t.uploaded, dlspeed: t.dlspeed, upspeed: t.upspeed, seeds: t.num_seeds, peers: t.num_leechs,
      engineState: t.state, eta: t.eta ?? null, left: t.amount_left,
      ratio: k.seed.ratio, seedHours: k.seed.hours, seedMet: k.seed.met, deletable: k.deletable, reasons: k.reasons, waitingFor: k.pending, holders: holdersOf(d.torrent_id) })
  }
  return { requirements: config.seed, downloads: out, disk: diskInfo(), minFreeGb: config.minFreeGb, minFreePct: config.minFreePct, warnFreePct: config.warnFreePct, autoPausePct: config.auto.pausePct, folder: config.downloadDir }
})
/** A viewer tapped "Something's wrong", or playback failed on its own. Quiet duplicates are dropped. */
app.post('/api/report', auth, async (req) => {
  const b = (req.body ?? {}) as any
  const torrentId = Number.isInteger(Number(b.torrentId)) && Number(b.torrentId) > 0 ? Number(b.torrentId) : null
  const seriesId = Number.isInteger(Number(b.seriesId)) && Number(b.seriesId) > 0 ? Number(b.seriesId) : null
  const kind = b.kind === 'auto' ? 'auto' : 'manual'
  const label = String(b.label ?? '').slice(0, 40), message = String(b.message ?? '').slice(0, 300)
  const dup = db.prepare('SELECT 1 FROM reports WHERE user_id = ? AND torrent_id IS ? AND label = ? AND kind = ? AND created_at > ? AND resolved_at IS NULL').get(req.user!.id, torrentId, label, kind, now() - 600)
  if (!dup) db.prepare('INSERT INTO reports (user_id, torrent_id, series_id, label, kind, message, created_at) VALUES (?,?,?,?,?,?,?)').run(req.user!.id, torrentId, seriesId, label, kind, message, now())
  return { ok: true }
})
app.get('/api/admin/reports', admin, async () => ({
  reports: db.prepare(`SELECT p.id, p.kind, p.label, p.message, p.created_at, u.name AS user, r.series, r.group_name, r.resolution, r.seeders
    FROM reports p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN releases r ON r.torrent_id = p.torrent_id
    WHERE p.resolved_at IS NULL ORDER BY p.created_at DESC LIMIT 100`).all(),
}))
app.post('/api/admin/reports/resolve', admin, async (req) => {
  const id = (req.body as any)?.id
  if (id === 'all') db.prepare('UPDATE reports SET resolved_at = ? WHERE resolved_at IS NULL').run(now())
  else db.prepare('UPDATE reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now(), Number(id))
  return { ok: true }
})
app.get('/api/admin/health', admin, async () => ({ issues: await health(), backup: lastBackup() }))
app.get('/api/admin/storage', admin, async () => ({ ...storageHistory(), disk: diskInfo() }))
app.delete('/api/admin/downloads/:id', admin, async (req) => {
  const id = Number((req.params as any).id)
  const d = db.prepare(`SELECT info_hash FROM downloads WHERE torrent_id=? AND state='active'`).get(id) as any
  if (!d) throw Object.assign(new Error('Not an active download'), { statusCode: 404 })
  // The seeding requirement cannot be overridden: only allow removal once it is met (or nothing was ever downloaded).
  // If the engine cannot be read, the seeding requirement cannot be checked either: fail closed, never open.
  const t = await engine.info(d.info_hash).catch((e: any) => {
    console.warn(`[admin] could not read engine state for ${d.info_hash} (${e?.message ?? e}); refusing removal`)
    return null
  })
  if (!t)
    throw Object.assign(new Error('Could not read the torrent from the engine, so the BTN seeding requirement cannot be confirmed; refusing to remove'), { statusCode: 409 })
  if (t.downloaded > 0 && !seedStatus(t).met)
    throw Object.assign(new Error('BTN seeding requirement (130 h or 1:1) not met yet; refusing to remove'), { statusCode: 409 })
  // Nor while somebody is still partway through it: that would take the file out from under them.
  const watching = pendingViewers(id)
  if (watching.length)
    throw Object.assign(new Error(`Still being watched by ${watching.join(', ')}; refusing to remove until they finish or release it`), { statusCode: 409 })
  await removeDownload(id, d.info_hash, 'removed by admin')
  return { ok: true }
})
const userRow = (u: any) => ({ id: u.id, name: u.name, is_admin: !!u.is_admin, created_at: u.created_at, allowed: parseAllowed(u.allowed_ratings), hasPin: !!u.pin_hash })
const adminCount = () => (db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get() as any).c as number

app.get('/api/admin/users', admin, async () => ({
  users: (db.prepare('SELECT id, name, is_admin, created_at, allowed_ratings, pin_hash FROM users ORDER BY id').all() as any[]).map(userRow),
  ratings: RATINGS, ratingLookup: !!(config.omdb.apiKey || config.tmdb.apiKey),
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
  if ('pin' in b) setPin(id, b.pin === null || b.pin === '' ? null : String(b.pin))
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
app.get('/api/admin/settings', admin, async () => ({ btn: btnKeyStatus(), qb: qbStatus(), tmdb: tmdbKeyStatus(), omdb: omdbKeyStatus() }))
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
app.put('/api/admin/settings/omdb', admin, async (req) => {
  const key = String((req.body as any)?.apiKey ?? '').trim()
  if (key.length > 200 || /\s/.test(key)) throw Object.assign(new Error('That does not look like an API key'), { statusCode: 400 })
  setOmdbApiKey(key)
  return { omdb: omdbKeyStatus() }
})
/** Ask OMDb about a well-known title, so the admin sees whether the key is accepted. */
app.post('/api/admin/settings/omdb/test', admin, async () => {
  const { apiKey, apiUrl } = config.omdb
  if (!apiKey) throw Object.assign(new Error('No OMDb key set'), { statusCode: 400 })
  const res = await fetch(`${apiUrl}/?i=tt0903747&apikey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw Object.assign(new Error(`Could not reach OMDb: ${e.message}`), { statusCode: 502 })
  })
  if (res.status === 401) throw Object.assign(new Error('OMDb rejected this key (a new key must be activated from the email OMDb sends)'), { statusCode: 400 })
  if (!res.ok) throw Object.assign(new Error(`OMDb returned HTTP ${res.status}`), { statusCode: 502 })
  const j = await res.json() as any
  if (j.Response === 'False') throw Object.assign(new Error(`OMDb: ${j.Error}`), { statusCode: 400 })
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
  startNetworkCrawler()
  await relocateDownloads() // point every torrent at the Downloads folder Flix is set to use now, without taking any out of the engine
  await recheckMissingFiles() // then let qBittorrent re-verify the ones whose files it cannot find there (a moved folder), nothing re-added or deleted
  startAutoDownloads()
  startBackups()
  if (!startBtnSync()) app.log.warn('No BTN API key set (BTN_API_KEY or Settings): the catalog will stay empty')
  void runSweep
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) await start()
