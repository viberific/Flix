import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync, existsSync } from 'node:fs'
import { writeFile, rename, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { getDetails, youtubeId } from './details.ts'

const MAX_BYTES = 8 << 20
const dir = join(config.dataDir, 'art')
mkdirSync(dir, { recursive: true })

db.exec(`CREATE TABLE IF NOT EXISTS art_cache (url_hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL)`)

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase()
    if (l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    return m ? isPrivateIp(m[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Only real raster images; SVG (scriptable) is deliberately not accepted. */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Fetch an image server-side: http(s) only, no internal addresses, bounded redirects/size/time. */
async function download(url: string, hops = 3): Promise<Buffer> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme')
  if (!config.art.allowPrivateHosts) {
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true })
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('refusing to fetch an internal address')
  }
  const res = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'Flix/0.1', accept: 'image/*' }, signal: AbortSignal.timeout(15_000) })
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (hops <= 0) throw new Error('too many redirects')
    return download(new URL(res.headers.get('location')!, u).toString(), hops - 1)
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of res.body as any) {
    total += c.length
    if (total > MAX_BYTES) throw new Error('image too large')
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks)
}

let running = 0
const waiters: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiters.push(r))
  running++
  try { return await fn() } finally { running--; waiters.shift()?.() }
}

const inflight = new Map<string, Promise<{ path: string; type: string } | null>>()
const failed = new Map<string, number>()

export type ArtKind = 'poster' | 'banner' | 'trailer' | 'still'

// ---- backup artwork -------------------------------------------------------------------------------------
// BTN's own poster/banner come first. When they are missing, or BTN's image host refuses us, the lookup below finds
// the same show's artwork on TMDB (with a key) and TVmaze (without), and remembers the answer for a day.

db.exec(`CREATE TABLE IF NOT EXISTS art_fallback (series_id INTEGER PRIMARY KEY, poster TEXT, banner TEXT, fetched_at INTEGER NOT NULL)`)

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'Flix/0.1', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function lookupFallback(seriesId: number): Promise<{ poster: string | null; banner: string | null }> {
  const t = db.prepare('SELECT series, tvdb_id, imdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
  let poster: string | null = null, banner: string | null = null
  if (!t) return { poster, banner }
  const { apiKey, apiUrl } = config.tmdb
  if (apiKey && t.tvdb_id) {
    try {
      const f = await getJson(`${apiUrl}/find/${t.tvdb_id}?external_source=tvdb_id&api_key=${encodeURIComponent(apiKey)}`)
      const hit = f.tv_results?.[0]
      if (hit?.poster_path) poster = `${config.art.tmdbImages}/w780${hit.poster_path}`
      if (hit?.backdrop_path) banner = `${config.art.tmdbImages}/w1280${hit.backdrop_path}` // sharp enough for a hero at 1440px
    } catch (e: any) { console.warn(`[art] TMDB lookup for series ${seriesId}: ${e.message}`) }
  }
  if ((!poster || !banner) && config.art.tvmazeUrl) {
    try {
      const base = config.art.tvmazeUrl
      const q = t.tvdb_id ? `lookup/shows?thetvdb=${t.tvdb_id}` : /^tt\d+$/.test(t.imdb_id ?? '') ? `lookup/shows?imdb=${t.imdb_id}` : `singlesearch/shows?q=${encodeURIComponent(t.series)}`
      let show = await getJson(`${base}/${q}`).catch(() => null)
      if (!show?.image && t.tvdb_id) show = await getJson(`${base}/singlesearch/shows?q=${encodeURIComponent(t.series)}`).catch(() => null)
      const img = show?.image?.original ?? show?.image?.medium
      if (!poster && typeof img === 'string') poster = img.replace(/^http:\/\/static\.tvmaze\.com/, 'https://static.tvmaze.com')
    } catch (e: any) { console.warn(`[art] TVmaze lookup for series ${seriesId}: ${e.message}`) }
  }
  return { poster, banner }
}

const lookups = new Map<number, Promise<{ poster: string | null; banner: string | null }>>()

async function fallbackFor(seriesId: number) {
  const have = db.prepare('SELECT poster, banner, fetched_at FROM art_fallback WHERE series_id = ?').get(seriesId) as any
  if (have && have.fetched_at > now() - 86400) return have as { poster: string | null; banner: string | null }
  let p = lookups.get(seriesId)
  if (!p) {
    p = lookupFallback(seriesId).then((r) => { db.prepare('INSERT OR REPLACE INTO art_fallback VALUES (?,?,?,?)').run(seriesId, r.poster, r.banner, now()); return r }).finally(() => lookups.delete(seriesId))
    lookups.set(seriesId, p)
  }
  return p
}

const btnUrl = (seriesId: number, kind: 'poster' | 'banner'): string | null => {
  const col = kind === 'poster' ? 'series_poster' : 'series_banner'
  const r = db.prepare(`SELECT ${col} AS u FROM releases WHERE series_id = ? AND ${col} IS NOT NULL AND ${col} != '' ORDER BY fetched_at DESC LIMIT 1`).get(seriesId) as { u: string } | undefined
  return r?.u ?? null
}

/** The trailer's YouTube id, from BTN's own field or the details lookup. */
function trailerIdFor(seriesId: number): string | null {
  const r = db.prepare('SELECT MAX(youtube_trailer) AS u FROM releases WHERE series_id = ?').get(seriesId) as { u: string | null } | undefined
  const d = getDetails(seriesId)
  return d?.trailers[0] ?? youtubeId(d?.trailer) ?? youtubeId(r?.u) // a checked trailer first: BTN's own link may be private
}

/** Where to try getting this picture from, best first. Later entries are only looked up when the earlier ones fail. */
async function* sources(seriesId: number, kind: Exclude<ArtKind, 'still'>): AsyncGenerator<string> {
  if (kind === 'trailer') {
    const id = trailerIdFor(seriesId)
    if (id) { yield `${config.art.youtubeImages}/${id}/maxresdefault.jpg`; yield `${config.art.youtubeImages}/${id}/hqdefault.jpg` }
    return
  }
  const own = btnUrl(seriesId, kind)
  if (own) yield own
  const fb = await fallbackFor(seriesId).catch(() => null)
  if (fb?.[kind] && fb[kind] !== own) yield fb[kind]!
  // A show with no banner anywhere still gets a wide picture: its poster, via the page's blurred-poster backdrop (client side).
}

async function fetchCached(url: string, seriesId: number, kind: ArtKind) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const hit = db.prepare('SELECT content_type FROM art_cache WHERE url_hash = ?').get(hash) as { content_type: string } | undefined
  if (hit) {
    const path = join(dir, `${hash}.${EXT[hit.content_type]}`)
    if (existsSync(path)) return { path, type: hit.content_type }
  }
  if ((failed.get(hash) ?? 0) > Date.now() - 30 * 60_000) return null
  let p = inflight.get(hash)
  if (!p) {
    p = limited(async () => {
      try {
        const buf = await download(url)
        const type = sniffImage(buf)
        if (!type) throw new Error('not a supported image')
        const path = join(dir, `${hash}.${EXT[type]}`)
        await writeFile(path + '.tmp', buf)
        await rename(path + '.tmp', path)
        db.prepare('INSERT OR REPLACE INTO art_cache VALUES (?,?,?)').run(hash, type, now())
        return { path, type }
      } catch (e: any) {
        console.warn(`[art] ${kind} for series ${seriesId} failed: ${e.message}`)
        failed.set(hash, Date.now())
        return null
      }
    }).finally(() => inflight.delete(hash))
    inflight.set(hash, p)
  }
  return p
}

/** An episode's still image (a frame from the episode), cached like the other artwork. */
export async function getStill(seriesId: number, season: number, episode: number) {
  const r = db.prepare('SELECT still FROM episode_info WHERE series_id = ? AND season = ? AND episode = ?').get(seriesId, season, episode) as { still: string | null } | undefined
  const own = r?.still ? await fetchCached(r.still, seriesId, 'still') : null
  // No picture of its own for this episode (or it would not download): the show's wide artwork stands in, so the tile is never blank.
  return own ?? (await getArt(seriesId, 'banner')) ?? (await getArt(seriesId, 'poster'))
}

/** An actor's photo (TMDB's, from the show's cast list), cached like the other artwork. Null when the cast member has none. */
export async function getCastPhoto(seriesId: number, index: number) {
  const url = getDetails(seriesId)?.cast[index]?.photo
  return url ? fetchCached(url, seriesId, 'still') : null
}

/** The pixel size of a JPEG, PNG or WebP file, read from its header. Null when the header is not understood. */
function pixelSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) } }
    return null
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  return null
}

/** Sizes already measured, by file path, so a request does not re-read the same file. */
const sizes = new Map<string, { w: number; h: number } | null>()

/**
 * Whether a picture is wide and sharp enough to be a show's backdrop. TheTVDB's "banner" art for most shows
 * is a 758x140 logo strip, which stretched across the page is the blur, so anything that thin, or under 900px
 * wide, is skipped in favour of the next source (TMDB's backdrop, then the poster the page blurs).
 */
async function sizeOf(path: string) {
  let s = sizes.get(path)
  if (s === undefined) {
    try { s = pixelSize(await readFile(path)) } catch { s = null }
    sizes.set(path, s)
  }
  return s
}

async function usableAsBackdrop(path: string): Promise<boolean> {
  const s = await sizeOf(path)
  return !s || (s.w >= 900 && s.w / s.h >= 1.5)
}

/**
 * YouTube answers a missing thumbnail with a grey 120x90 placeholder (a play button on grey) instead of an error, and
 * the fallback sizes are always at least 480 wide, so anything narrower is that placeholder. Better no picture --
 * the page's own gradient -- than that one stretched across the trailer card.
 */
async function usableAsTrailerThumb(path: string): Promise<boolean> {
  const s = await sizeOf(path)
  return !s || s.w >= 400
}

/** Cached artwork for a series, downloading it on first use and trying the backup sources when one fails. Null when there is none. */
export async function getArt(seriesId: number, kind: Exclude<ArtKind, 'still'>) {
  for await (const url of sources(seriesId, kind)) {
    const got = await fetchCached(url, seriesId, kind)
    if (!got) continue
    if (kind === 'banner' && !(await usableAsBackdrop(got.path))) continue
    if (kind === 'trailer' && !(await usableAsTrailerThumb(got.path))) continue
    return got
  }
  return null
}

/** SQL fragment: local artwork path instead of BTN's URL (which never reaches the browser). Always present: the server finds a backup, and the page copes with a 404. */
export const artPathSql = (_col: 'series_poster' | 'series_banner', alias: string, kind: 'poster' | 'banner') =>
  `'/api/art/' || series_id || '/${kind}' AS ${alias}`

/** Widths a poster may be asked for in, so the cache holds a few known sizes rather than one per request. */
export const POSTER_WIDTHS = [342] as const
const shrinking = new Map<string, Promise<string | null>>()
const unshrinkable = new Set<string>() // ffmpeg could not read it: the original is served, without trying again

/**
 * A show's poster no wider than `w` pixels, as a JPEG cut once with ffmpeg and kept beside the original. A television's
 * home screen holds a hundred posters, and decoding each at its full 780px (or a TVmaze original, often larger) is
 * hundreds of megabytes of picture memory on a set that has little to spare, for tiles a third of that size on screen.
 * Falls back to the original when it is already small enough or ffmpeg cannot read it.
 */
export async function getPosterThumb(seriesId: number, w: number) {
  const art = await getArt(seriesId, 'poster')
  if (!art) return null
  const size = await sizeOf(art.path)
  if (size && size.w <= w) return art
  const out = art.path.replace(/\.[a-z]+$/, `.w${w}.jpg`)
  if (existsSync(out)) return { path: out, type: 'image/jpeg' }
  if (unshrinkable.has(out)) return art
  let p = shrinking.get(out)
  if (!p) {
    p = limited(() => new Promise<string | null>((done) => {
      const proc = spawn('ffmpeg', ['-v', 'error', '-i', art.path, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '4', '-f', 'mjpeg', '-y', out + '.tmp'], { stdio: 'ignore' })
      proc.on('error', () => done(null))
      proc.on('close', (code) => { if (code === 0) rename(out + '.tmp', out).then(() => done(out), () => done(null)); else done(null) })
    })).finally(() => shrinking.delete(out))
    shrinking.set(out, p)
  }
  const got = await p
  if (!got) unshrinkable.add(out)
  return got ? { path: got, type: 'image/jpeg' } : art
}
