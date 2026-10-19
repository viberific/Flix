import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { createInvite, createUser, hasPin, pinOk, setPin, hashPassword, login, logout, newSession, redeemInvite, requireAdmin, requireUser, sessionUser, setOwnPassword, setSessionCookie, tvToken, userCount, userFor, userForTvToken, renameUser, setAvatar, isChild, hasPassword } from './auth.ts'
import { RATINGS, META_JOIN, canViewSeries, cleanAllowed, getRating, parseAllowed, queueRating, ratingClause } from './ratings.ts'
import { qb } from './qb.ts'
import { searchBtn, startCrawler, syncLatest, syncSeries } from './catalog.ts'
import { IpNotAuthorizedError, RateLimitError, btnCall } from './btn/client.ts'
import { btnKeyStatus, clearQb, omdbKeyStatus, qbStatus, setBtnApiKey, setOmdbApiKey, setQb, setTmdbApiKey, tmdbKeyStatus } from './settings.ts'
import { bufferStatus, fileInfo, readRange, startPlayback, StreamTimeout } from './streaming.ts'
import { SUBFILE, cleanHlsCache, ensureHls, fileSubtitleVtt, guessSubLang, hdrCopyOk, hlsSummary, jobDir, probe, rawUrl, releaseHls, subtitleVtt, touchHls, vodPlaylist, vodSegment, type Probe } from './transcode.ts'
import { offlineCopy, offlineReadyPath, startOfflineSweeper } from './offline.ts'
import { frame as frameAt, startThumbSweeper } from './thumbs.ts'
import { parseEpisodeTag } from './btn/parse.ts'
import { artPathSql, getArt, getCastPhoto, getStill } from './art.ts'
import { episodeInfoFor, queueEpisodeInfo } from './episodeinfo.ts'
import { buildEpisodes, continueWatching } from './episodes.ts'
import { listable, seasonsOf, unsyncedCount } from './seasons.ts'
import { ensurePackFiles } from './packs.ts'
import { diskInfo, freeFloor, health, lastBackup, startBackups } from './health.ts'
import { ROW_SIZE, curateHome } from './home.ts'
import { fullInDays, storageHistory } from './storage.ts'
import { autoFetch, autoNext, NEXT_EPISODE_AT, startAutoDownloads } from './autodl.ts'
import { gatesFor, gatedNote, STARTED_AT } from './gate.ts'
import { ensureNet, isHiddenService, netInfo, startNetworkCrawler } from './networks.ts'
import { tasteOf, tasteSort } from './taste.ts'
import { diag, diagCounts, diagFiles, diagTail, hitch } from './diag.ts'
import { holdersOf, leavingSoonFor, pendingViewers, recheckMissingFiles, relocateDownloads, removeDownload, seedStatus, startSweeper, whyKept } from './retention.ts'
import { qb as engine } from './qb.ts'
import { getDetails, queueDetails, youtubeId } from './details.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((err: any, _req, reply) => {
  const status = err instanceof RateLimitError ? 429 : err instanceof IpNotAuthorizedError ? 403 : err.statusCode ?? 500
  if (status >= 500) app.log.error(err)
  // `gated` and `after` ride along so the player knows to send the viewer to the show page with the one-line note,
  // instead of drawing an error it cannot act on.
  reply.code(status).send({ error: err.message, ...(err.gated ? { gated: true, after: err.after ?? null } : {}) })
})

/** True for a host that only exists on the home network: a private IPv4 literal, an mDNS .local name, whatever
 *  LAN_URL names, or a name listed in LAN_HOSTS. Those are served directly even when PUBLIC_URL is set, so a TV
 *  that cannot install Tailscale reaches Flix by its LAN address. A tailnet address (100.64/10) is not one of
 *  these: it still goes to the one address. */
function isLanHost(name: string): boolean {
  if (config.lanHosts.includes(name) || name.endsWith('.local')) return true
  try {
    if (config.lanUrl && new URL(config.lanUrl).hostname.toLowerCase() === name) return true
  } catch { /* an unparseable LAN_URL is ignored, as it is in health.ts */ }
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

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
    // The home network: http://10.0.0.247:8096 and http://umbrel.local:8096 serve Flix themselves, so the TV
    // needs no Tailscale. Tailscale keeps working exactly as before: its name and its 100.x address still redirect here.
    if (isLanHost(name)) return
    // A TV or cast device fetches the media itself and cannot resolve the tailnet name, so the signed stream links
    // are served on whatever address the device used. They carry an unguessable token in the path, never a cookie.
    if (req.url.startsWith('/api/tv/')) return
    // 307 so a POST keeps its method and body; only a stale cached shell sends one here.
    // Never 308: that is permanently cacheable, and a WebView that pinned one keeps replaying it without ever
    // reaching Flix -- which is exactly how a TV came to fail on its LAN address long after the redirect was gone.
    return reply.code(307).header('cache-control', 'no-store').redirect(config.publicUrl + req.url, 307)
  })
}

await app.register(fastifyStatic, { root: join(root, 'public') })
await app.register(fastifyStatic, { root: join(root, 'node_modules/hls.js/dist'), prefix: '/vendor/', decorateReply: false })

// ---- auth -----------------------------------------------------------------
// `cast` tells the app a TV on the same network could reach the media at all (LAN_URL is set), so the header
// button only appears where casting can actually work.
app.get('/api/me', async (req) => {
  const u = userFor(req)
  // Where this server answers. The home-network address is what a TV uses when it cannot install Tailscale, and the
  // tailnet one is the trustworthily-certificated address; both are shown under Settings so nobody has to guess.
  const addresses = { lan: config.lanUrl || null, tailnet: config.publicUrl || null }
  return { user: u ? { ...u, cast: !!config.lanUrl, hasPassword: hasPassword(u.id) } : u, needsSetup: userCount() === 0, addresses }
})

/** A person changing their own account: the name shown, their picture, their password. */
app.patch('/api/me', { preHandler: requireUser }, async (req, reply) => {
  const me = req.user!
  const b = req.body as any
  let out = me
  if (b.newPassword !== undefined) setOwnPassword(me.id, String(b.currentPassword ?? ''), String(b.newPassword))
  if (b.avatar !== undefined) out = setAvatar(me.id, b.avatar === null || b.avatar === '' ? null : String(b.avatar))
  if (b.name !== undefined) out = renameUser(me.id, String(b.name))
  // A new password signs every device out, this one included -- so give this browser a fresh session and keep them here.
  if (b.newPassword !== undefined) setSessionCookie(reply, newSession(me.id))
  return { user: out }
})

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
  const episodes = buildEpisodes(id, req.user!.id)
  return {
    // The soonest of this show's downloads that is leaving and that this person has not finished, for a note on the show page.
    leavesAt: leavingSoonFor(req.user!).filter((l) => l.seriesId === id).map((l) => l.leavesAt as number).sort((a, b) => a - b)[0] ?? null,
    series: { ...rest, genres, inList: !!db.prepare('SELECT 1 FROM my_list WHERE user_id = ? AND series_id = ?').get(req.user!.id, id), vote: (db.prepare('SELECT vote FROM votes WHERE user_id = ? AND series_id = ?').get(req.user!.id, id) as any)?.vote ?? 0, year: d?.year ?? null, overview: d?.overview ?? null, cast: (d?.cast ?? []).map((c, n) => ({ name: c.name, role: c.role, photo: c.photo ? `/api/cast/${id}/${n}` : null })), trailerId, trailerIds, trailerThumb: trailerId ? `/api/art/${id}/trailer` : null, ...getRating(id) },
    episodes: withInfo(id, episodes),
  }
})

/** Add each episode's title, summary, length and still image when we know them. */
function withInfo<T extends { season: number | null; episode: number | null; watched: boolean; position: number; label: string }>(seriesId: number, eps: T[]) {
  const info = episodeInfoFor(seriesId)
  const gates = gatesFor(eps)
  return eps.map((e, n) => {
    const i = e.season !== null && e.episode !== null ? info.get(`${e.season}|${e.episode}`) : undefined
    // Every episode carries its own answer to "may this be started yet?", so a card, a row and the hero all read the same
    // rule without any of them working it out again.
    return { ...e, ...gates[n], title: i?.name ?? null, overview: i?.overview ?? null, runtime: i?.runtime ?? null, still: e.season !== null && e.episode !== null ? `/api/still/${seriesId}/${e.season}/${e.episode}` : null } // always asked for: the server falls back to the show's artwork
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
 * Crave, Showcase, Disney+, Apple TV+ and Paramount+, then more of those under one genre each. Shows on a hidden service
 * (Netflix) are left off the discovery rows; see HIDDEN_STREAMERS in networks.ts. Discovery rows hold ten shows (see home.ts).
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
    const rec = all.filter((r) => !touched.has(r.id) && !taken.has(r.id) && !taste.hidden.has(r.id) && net.get(r.id)?.streamer && !isHiddenService(net.get(r.id)?.streamer)).map((r) => ({ r, score: r.genres.filter((g: string) => mine.has(g)).length + 0.5 * taste.fit(r.genres) })).filter((x) => x.score > 0)
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
    const cands = all.filter((r) => !started.has(r.id) && !finished.has(r.id) && !taken.has(r.id) && !taste.hidden.has(r.id) && !isHiddenService(net.get(r.id)?.streamer) && taste.fit(r.genres) > 0.2)
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
  return { inList: !!on }
})

app.get('/api/continue', auth, async (req) => ({ items: continueWatching(req.user!) }))

/** Season packs already watched by others and about to be removed, which this person never opened (see updateLeaving in retention.ts). */
app.get('/api/leaving', auth, async (req) => ({ items: leavingSoonFor(req.user!) }))

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
  // One, two, three (see gate.ts). Only a play is held to it: the same route starts a download for the "save this"
  // button, and that must keep working from any episode. `play: true` is what the player itself sends.
  const gates = gatesFor(eps)
  const gate = gates[i]
  if (gate.locked && (req.body as any).play === true) {
    throw Object.assign(new Error(gatedNote(gate.after!)), { statusCode: 409, gated: true, after: gate.after })
  }
  const play = await startPlayback(req.user!.id, ep.torrentId, undefined, { episodeLabel: ep.isPack && ep.episode === null ? undefined : ep.label })
  const ni = eps.findIndex((e, j) => j > i && e.available)
  const next = ni < 0 ? undefined : eps[ni]
  // Has another episode of this show been played? The skip-intro fallback waits for that: the first episode cannot have one,
  // because there is nothing to have learned the intro from yet.
  const playedBefore = eps.some((o, j) => j !== i && (o.watched || o.position > STARTED_AT))
  // The box offered at the credits must itself be allowed: it is, unless this episode was never counted as started.
  const nextOpen = ni >= 0 && !gates[ni].locked
  const seriesName = (db.prepare('SELECT series FROM releases WHERE series_id = ? LIMIT 1').get(Number(seriesId)) as any)?.series
  const titles = episodeInfoFor(Number(seriesId))
  const nameOf = (e: { season: number | null; episode: number | null }) => (e.season !== null && e.episode !== null ? titles.get(`${e.season}|${e.episode}`)?.name ?? null : null)
  return { ...play, seriesName, quality: ep.quality, title: ep.label, episodeTitle: nameOf(ep), playedBefore, next: next ? { season: next.season, label: next.label, title: nameOf(next), locked: !nextOpen } : null }
})

/** Partway through an episode: line up the next one (see autodl.ts for the limits). Quiet by design: it never fails the player. */
app.post('/api/prefetch', auth, async (req) => {
  const { seriesId, season, label } = req.body as any
  if (!canViewSeries(req.user, Number(seriesId))) return { ok: false }
  void autoNext(req.user!.id, Number(seriesId), season ?? null, String(label ?? ''))
  return { ok: true }
})

/**
 * The player has just put the "Up next" box on screen: get that episode's bytes moving and its first piece made now, so
 * the handover at the end of the credits is a cut instead of a wait. Measured on the box, a cold episode spends about
 * 12 s in its first probe waiting for bytes that have not arrived yet; warmed a minute ahead, the same play answers in a
 * fraction of a second. Answers at once and carries on behind: the player is showing a countdown and must not wait.
 */
async function warmNextEpisode(userId: number, seriesId: number, season: number | null, label: string) {
  const eps = buildEpisodes(seriesId, userId)
  const i = eps.findIndex((e) => e.season === season && e.label === label)
  const next = i < 0 ? undefined : eps.slice(i + 1).find((e) => e.available)
  if (!next) return
  // The fetch itself, exactly as at 60% of the episode: idempotent, and held to the automatic-download limits.
  if (!(await autoFetch(userId, next, 'up next, warming the first piece'))) return
  const r = await startPlayback(userId, next.torrentId, undefined, { episodeLabel: next.isPack && next.episode === null ? undefined : next.label, auto: true })
  const p = await probe(r.torrentId, r.fileIndex)
  // The same choice /info makes, in the same order. Bytes that can be served as they are need nothing done to them.
  if (p.direct) return
  // A complete file the player would rather have as one seekable MP4: a remux takes minutes, so building it ahead of the
  // handover is the only way it is ready in time. Worth starting even if it will not finish before the credits do.
  const fi = await fileInfo(r.torrentId, r.fileIndex).catch(() => null)
  if (fi && fi.file.progress >= 1 && !p.hdr && REMUX_VIDEO.has(String(p.videoCodec ?? '')) && (p.height ?? 0) <= 1080) {
    await remuxPlayback(r.torrentId, r.fileIndex, p, () => false, 0)
    return
  }
  // Otherwise the HLS cut, whose first piece is only made when somebody asks for it: ask here.
  await ensureHls(r.torrentId, r.fileIndex, p)
  await vodSegment(r.torrentId, r.fileIndex, 'seg00000.ts', new AbortController().signal).catch(() => null)
}

app.post('/api/warm', auth, async (req) => {
  const b = req.body as any
  const seriesId = Number(b?.seriesId)
  if (!Number.isInteger(seriesId) || !canViewSeries(req.user, seriesId)) return { ok: false }
  void warmNextEpisode(req.user!.id, seriesId, b.season ?? null, String(b.label ?? '')).catch((e) => console.log(`[warm] ${e.message}`))
  return { ok: true }
})

app.get('/api/stream/:t/:f/status', guarded, async (req) => {
  const { t, f } = req.params as any
  return (await bufferStatus(+t, +f)) ?? { error: 'not ready' }
})

/** The player was closed: drop the temporary converted copy (if there was one) after a short grace period. */
app.post('/api/stream/:t/:f/stop', guarded, async (req) => {
  const { t, f } = req.params as any
  releaseHls(+t, +f)
  return { ok: true }
})

const audioIdx = (v: unknown) => { const n = Number(v ?? 0); return Number.isInteger(n) && n >= 0 && n < 32 ? n : 0 }

app.get('/api/stream/:t/:f/info', guarded, async (req, reply) => {
  const { t, f } = req.params as any
  const a = audioIdx((req.query as any).a)
  // A cast is about to be handed to a TV, and a receiver keeps whatever timeline it was given when it loaded: a playlist
  // still being built would leave it with only the part converted so far, and no way to drag past it. So a cast waits
  // longer for the one seekable file, while an ordinary play starts at once and lets the remux catch up in the background.
  const cast = (req.query as any).cast === '1'
  // A remux this call starts may hold the play for a moment; a viewer who has closed the page must not hold it at all.
  let closed = false
  reply.raw.on('close', () => { closed = true })
  const p = await probe(+t, +f)
  const direct = p.direct && a === 0 // another audio track needs the transcode path (raw bytes can't switch tracks)
  // A file that is fully downloaded and needs only its container changed (MKV holding H.264, say) is remuxed once into
  // one MP4 and served with byte ranges. That is what makes the whole episode seekable: the HLS fallback for a passed
  // through picture is built forwards from the start, so a seek ahead of it cannot work until it catches up.
  const remux = !direct && !p.hdr && a === 0 ? await remuxPlayback(+t, +f, p, () => closed, cast ? CAST_WAIT_MS : REMUX_WAIT_MS) : null
  const path = direct ? 'raw' : a ? `hls-a/${a}/index.m3u8` : 'hls/index.m3u8'
  const base = `/api/stream/${t}/${f}`
  const token = tvToken(req.user!.id)
  // A TV or cast device has no cookie, so it gets a link with a signed token in the path instead. A finished episode goes
  // to it as one file served by byte range -- the plain MP4 as it is, anything else as the remuxed MP4 -- because only a
  // file carries its whole length at once. The growing playlist is what is left when there is no finished file to send.
  // direct is decided from the container and codecs alone, so it says nothing about how much is downloaded: a file still
  // arriving is served as raw bytes that run out partway with no way for a receiver to retry, so only a complete one is
  // handed over as a file and an unfinished one keeps the playlist it has always had.
  const complete = ((await fileInfo(+t, +f))?.file.progress ?? 0) >= 1
  const seekable = direct && complete ? 'raw' : remux ? 'offline/file' : null
  const tvPath = seekable ?? (a ? `hls-a/${a}/index.m3u8` : 'hls/index.m3u8')
  const tv = `/api/tv/${token}/${t}/${f}/${tvPath}`
  // The playlist, kept as the fallback for a receiver that will not take the file: same picture, built forwards.
  const tvHls = `/api/tv/${token}/${t}/${f}/${a ? `hls-a/${a}/index.m3u8` : 'hls/index.m3u8'}`
  // What the receiver must be told the link is, since it decides how to play it from this alone.
  const tvType = seekable ? (direct ? await rawType(+t, +f) : 'video/mp4') : 'application/vnd.apple.mpegurl'
  // The HDR path: the HEVC stream is copied, not re-encoded, into fragmented MP4 so the TV keeps its HDR metadata
  // and the picture is bit-for-bit the source instead of an 8-bit downconvert. Only offered when the source is HDR.
  const hdrUrl = p.hdr ? `${base}/hdr/index.m3u8?a=${a}` : null
  const tvHdr = p.hdr ? `/api/tv/${tvToken(req.user!.id)}/${t}/${f}/hdr/index.m3u8?a=${a}` : null
  return {
    mode: direct ? 'direct' : remux ? 'file' : 'hls', url: remux ? `${base}/offline/file` : `${base}/${path}`, tvUrl: tv, tvType, seekable: !!seekable,
    castUrl: config.lanUrl ? config.lanUrl + tv : null, castType: tvType, castFallbackUrl: config.lanUrl ? config.lanUrl + tvHls : null, duration: p.duration, audioIndex: a, hdr: p.hdr,
    hdrUrl, hdrTvUrl: tvHdr, hdrCastUrl: config.lanUrl && tvHdr ? config.lanUrl + tvHdr : null,
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

// ---- downloads to a device ----------------------------------------------------
/** How long /info waits for a remux before letting the play start on HLS instead. It carries on in the background. */
const REMUX_WAIT_MS = Number(process.env.REMUX_WAIT_MS ?? 12_000)
/** How long a cast waits for it instead. Longer: the TV cannot be given a longer timeline later, the phone can. */
const CAST_WAIT_MS = Number(process.env.CAST_WAIT_MS ?? 60_000)

/**
 * One MP4 of a fully downloaded episode, the picture copied rather than re-encoded, so the whole episode can be seeked
 * to at once. Null means play it as HLS instead: still downloading, an audio track other than the first, HDR, or a
 * remux that has not finished yet.
 */
/** The codecs an MP4 can hold with the picture copied. MP4 cannot carry VP8, and a browser will not play VP9 inside one,
 *  so those stay on HLS however well the file is downloaded. */
const REMUX_VIDEO = new Set(['h264', 'hevc', 'av1'])

async function remuxPlayback(t: number, f: number, p: Probe, closed: () => boolean, waitMs = REMUX_WAIT_MS): Promise<boolean> {
  // The same picture rule probe() uses (4K is re-encoded down to 1080p), minus the codecs MP4 cannot hold.
  if (!REMUX_VIDEO.has(String(p.videoCodec ?? '')) || (p.height ?? 0) > 1080) return false
  const fi = await fileInfo(t, f)
  if (!fi || fi.file.progress < 1) return false
  const source = join(fi.layout.savePath, fi.file.name)
  const first = await offlineCopy(t, f, p, source)
  if (first.state === 'ready') return true
  // Only a job this call started is worth waiting for. One already in flight was started by an earlier /info, and the
  // 12 s spent waiting on it again is 12 s on every later play of the same episode, for a picture that is coming anyway.
  // A cast is the exception: its wait is the long one, and it has nowhere else to get a timeline from, so it waits even
  // for a remux someone else started.
  if (first.state !== 'working') return false
  if (!first.started && waitMs <= REMUX_WAIT_MS) return false
  const deadline = Date.now() + waitMs
  for (;;) {
    await new Promise((done) => setTimeout(done, 250))
    if (closed()) return false // the viewer closed the page: nothing left to wait for
    const r = await offlineCopy(t, f, p, source)
    if (r.state === 'ready') return true
    if (r.state === 'error' || Date.now() >= deadline) return false
  }
}

/**
 * The picture above the seek bar while someone scrubs: one small JPEG at the asked-for second. Cached on disk, so a
 * thumb dragged back and forth across the same ground costs one cut per second and nothing after that.
 */
app.get('/api/stream/:t/:f/frame', guarded, async (req, reply) => {
  const { t, f } = req.params as any
  const at = Number((req.query as any).at)
  if (!Number.isFinite(at) || at < 0) return reply.code(400).send({ error: 'Bad time' })
  const fi = await fileInfo(+t, +f)
  if (!fi) return reply.code(404).send({ error: 'Not downloading' })
  const p = await probe(+t, +f)
  // A finished remux is a plain MP4 with an index, so a frame anywhere in it is cut instantly; otherwise ffmpeg seeks
  // in the torrent's own bytes, which the raw route serves by range.
  const source = offlineReadyPath(+t, +f) ?? rawUrl(+t, +f)
  const buf = await frameAt(+t, +f, at, source, p.duration ?? 0, fi.file.progress)
  if (!buf) return reply.code(404).send({ error: 'No frame there yet' })
  return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=604800').send(buf)
})

/**
 * Make one episode ready to save on a device for watching offline: a single MP4, 1080p at most. It can only be made from a file that
 * has finished downloading here, so until then this says how far along it is. Asking again is how the device waits.
 */
app.get('/api/stream/:t/:f/offline', guarded, async (req) => {
  const { t, f } = req.params as any
  const fi = await fileInfo(+t, +f)
  if (!fi) throw notFound('That video is not downloading')
  if (fi.file.progress < 1) return { state: 'waiting', progress: fi.file.progress }
  const r = await offlineCopy(+t, +f, await probe(+t, +f), join(fi.layout.savePath, fi.file.name))
  return r.state === 'ready' ? { state: 'ready', size: r.size } : r
})

const offlineFileHandler = async (req: any, reply: any) => {
  const { t, f } = req.params as any
  const fi = await fileInfo(+t, +f)
  if (!fi || fi.file.progress < 1) return reply.code(409).send({ error: 'Not ready yet' })
  const r = await offlineCopy(+t, +f, await probe(+t, +f), join(fi.layout.savePath, fi.file.name))
  if (r.state !== 'ready') return reply.code(409).send({ error: 'Not ready yet' })
  let start = 0, end = r.size - 1
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (m) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, r.size - Number(m[2])); else { start = Number(m[1] || 0); if (m[2]) end = Math.min(r.size - 1, Number(m[2])) }
    if (start > end || start >= r.size) return reply.code(416).header('content-range', `bytes */${r.size}`).send()
    reply.code(206).header('content-range', `bytes ${start}-${end}/${r.size}`)
  }
  return reply.header('accept-ranges', 'bytes').header('content-length', end - start + 1).header('cache-control', 'no-store').type(r.type).send(createReadStream(r.path, { start, end }))
}
/** The container's own type, so a receiver is told video/mp4 for an MP4 rather than being left to guess. */
async function rawType(t: number, f: number) {
  const fi = await fileInfo(t, f).catch(() => null)
  const ext = String(fi?.file.name.split('.').pop() ?? 'mp4').toLowerCase()
  return MIME[ext] ?? 'video/mp4'
}

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
  // A closed stream is what a hitch looks like from this side: the player gave up on a gap and dropped the connection.
  // Which range it was reading, for how long, and whether it was cut short is the evidence a report can never carry.
  const at = Date.now()
  let sent = 0
  let why = 'eof'
  const t0 = await qb.info(fi.rel.info_hash).catch(() => null)
  diag('stream', 'raw open', { torrent: t, file: f, range: `${start}-${end}`, mb: Math.round((end - start + 1) / 1048576), progress: t0 ? Math.round(t0.progress * 100) / 100 : null, dlspeed: t0?.dlspeed ?? null, seeds: t0?.num_seeds ?? null })
  const stream = readRange(fi.rel.info_hash, fi.layout.savePath, fi.file, start, end, ac.signal)
  stream.on('data', (c: Buffer) => { sent += c.length })
  stream.on('error', (e) => {
    why = ac.signal.aborted ? 'client closed' : `error: ${e.message}`
    if (!ac.signal.aborted) app.log.warn(`stream ${t}/${f}: ${e.message}`)
    reply.raw.destroy()
  })
  reply.raw.on('close', () => {
    const ms = Date.now() - at
    diag('stream', 'raw close', { torrent: t, file: f, sentMb: Math.round(sent / 1048576 * 10) / 10, ms, why })
  })
  return reply.send(stream)
}

async function hlsHandler(req: any, reply: any, hdr = false) {
  const { t, f, file } = req.params as any
  const a = audioIdx(req.params.a ?? req.query?.a)
  if (!/^(index\.m3u8|init\.mp4|seg\d{5}\.(ts|m4s))$/.test(file)) return reply.code(400).send({ error: 'bad file' })
  if (file === 'index.m3u8' || !touchHls(+t, +f, a, hdr)) {
    const p = await probe(+t, +f)
    if (hdr && !hdrCopyOk(p, true)) return reply.code(409).send({ error: 'this file is not HDR' })
    try { await ensureHls(+t, +f, p, a, hdr) } catch (e: any) { return reply.code(503).send({ error: e.message }) }
  }
  const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.m4s') || file.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t'
  // A re-encoded picture has a complete playlist from the start, and each piece is made when it is asked for.
  const list = file === 'index.m3u8' ? vodPlaylist(+t, +f, a, hdr) : null
  if (list) return reply.type(type).header('cache-control', 'no-store').send(list)
  const ac = new AbortController()
  req.raw.on('close', () => ac.abort())
  let path: string | null | undefined
  try { path = await vodSegment(+t, +f, file, ac.signal, a, hdr) } catch (e: any) { return reply.code(503).send({ error: e.message }) }
  if (path === null) return reply.code(404).send({ error: 'no such segment' })
  path ??= join(jobDir(+t, +f, a, hdr), file)
  if (!existsSync(path)) return reply.code(404).send({ error: 'segment not ready' })
  return reply.type(type).header('cache-control', 'no-store').send(createReadStream(path))
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
  // The one file of a finished episode, behind the TV's token: a cast receiver fetches it by byte range, which is what
  // gives it the whole episode to seek in. MIME names it, and rawType is declared below with MIME itself.
  app.get(`${prefix}/:t/:f/offline/file`, { preHandler: pre as any }, offlineFileHandler)
  app.get(`${prefix}/:t/:f/hls/:file`, { preHandler: pre as any }, hlsHandler)
  app.get(`${prefix}/:t/:f/hls-a/:a/:file`, { preHandler: pre as any }, hlsHandler)
  app.get(`${prefix}/:t/:f/hdr/:file`, { preHandler: pre as any }, (req, reply) => hlsHandler(req, reply, true))
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
  const rows = db.prepare(`SELECT d.torrent_id, d.info_hash, d.state, d.added_at, d.removed_at, d.remove_reason, d.origin, d.leaving_at, d.remove_when_seeded, r.series, r.group_name, r.resolution, r.is_pack
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
/**
 * What Flix itself saw: the hits the player took, the streams it dropped, the pieces that were late.
 * Kept in memory and on disk, and only ever shown to an admin.
 */
app.get('/api/admin/diag', admin, async (req) => {
  const q = (req.query ?? {}) as any
  const n = Math.max(1, Math.min(3000, Number(q.n) || 200))
  const areas = String(q.area ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const tail = diagTail(3000).filter((e) => (!areas.length || areas.includes(e.area)) && (!q.level || e.lvl === q.level)).slice(-n)
  return {
    counts: diagCounts(),
    files: diagFiles(),
    // The box as it is now: a hitch during a transcode on a loaded CPU has a different cause from one on an idle one.
    host: { cpus: cpus().length, model: cpus()[0]?.model ?? '', load: loadavg().map((x) => Math.round(x * 100) / 100), uptimeH: Math.round(uptime() / 360) / 10, memMb: Math.round(freemem() / 1048576), totalMb: Math.round(totalmem() / 1048576), node: process.version },
    hls: hlsSummary(),
    events: tail,
  }
})
/** A viewer's player saying what it felt: a stall, a seek, a picture that fell back. Kept with the server's own stream events. */
app.post('/api/diag/client', auth, async (req) => {
  const b = (req.body ?? {}) as any
  const kind = String(b.kind ?? '').slice(0, 20)
  if (!kind) return { ok: false }
  const at = Number(b.at) || null
  diag('client', kind, {
    torrent: Number(b.torrentId) || null, file: Number(b.fileIndex) || null, at, bufferedAhead: Number(b.bufferedAhead) || 0,
    height: Number(b.height) || null, readyState: Number(b.readyState) || null, paused: !!b.paused,
    stalledForMs: Number(b.stalledForMs) || null, code: b.code ?? null, message: b.message ?? null, user: req.user!.id,
  }, kind === 'error' ? 'error' : kind === 'stall' || kind === 'stalled' ? 'warn' : 'info')
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
app.get('/api/admin/storage', admin, async () => {
  const h = storageHistory(), disk = diskInfo()
  return { ...h, disk, fullInDays: disk ? fullInDays(h.points, disk.free - freeFloor(disk)) : null }
})
/** Let a download go as soon as BTN's seeding rule is met, without waiting for people who have not started it (anyone partway through still keeps it). */
app.post('/api/admin/downloads/:id/when-seeded', admin, async (req) => {
  const id = Number((req.params as any).id), on = !!(req.body as any)?.on
  const r = db.prepare(`UPDATE downloads SET remove_when_seeded = ? WHERE torrent_id = ? AND state = 'active'`).run(on ? 1 : 0, id)
  if (!r.changes) throw Object.assign(new Error('Not an active download'), { statusCode: 404 })
  return { on }
})
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
const userRow = (u: any) => ({ id: u.id, name: u.name, is_admin: !!u.is_admin, created_at: u.created_at, allowed: parseAllowed(u.allowed_ratings), hasPin: !!u.pin_hash, hasPassword: !!u.pass_hash })
const adminCount = () => (db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get() as any).c as number

app.get('/api/admin/users', admin, async () => ({
  users: (db.prepare('SELECT id, name, is_admin, created_at, allowed_ratings, pin_hash, pass_hash FROM users ORDER BY id').all() as any[]).map(userRow),
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
  // An account that can no longer be called a child (made admin, or allowed TV-MA) needs a password from now on.
  const nextAllowed = 'allowedRatings' in b ? cleanAllowed(b.allowedRatings) : parseAllowed(u.allowed_ratings)
  const nextAdmin = 'isAdmin' in b ? !!b.isAdmin : !!u.is_admin
  if (b.password !== undefined && String(b.password).length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 })
  if (!u.pass_hash && b.password === undefined && !isChild(nextAdmin, nextAllowed))
    throw Object.assign(new Error(`Set a password for ${u.name} first: admins and anyone allowed TV-MA need one`), { statusCode: 400 })
  if ('allowedRatings' in b) db.prepare('UPDATE users SET allowed_ratings = ? WHERE id = ?').run((a => (a ? JSON.stringify(a) : null))(cleanAllowed(b.allowedRatings)), id)
  if ('isAdmin' in b) {
    if (!b.isAdmin && u.is_admin && adminCount() <= 1) throw Object.assign(new Error('There must always be at least one admin'), { statusCode: 400 })
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(b.isAdmin ? 1 : 0, id)
  }
  if ('pin' in b) setPin(id, b.pin === null || b.pin === '' ? null : String(b.pin))
  if (b.password !== undefined) {
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
startOfflineSweeper()
startThumbSweeper()
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
