import { db, now } from './db.ts'
import { config } from './config.ts'
import { listable } from './seasons.ts'

/**
 * What the home screen is built from: which streaming service a show belongs to (Netflix, Disney+, Apple TV+), when it
 * premiered, how popular it is and whether it is trending. BTN knows none of that, so it comes from TMDB (needs the optional
 * key) and, for the service/premiere/popularity, from TVmaze (no key). Read in the background for every listed show.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS series_net (
  series_id INTEGER PRIMARY KEY, tmdb_id INTEGER, streamer TEXT, network TEXT, first_air TEXT, popularity REAL, notable INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trending_tv (tmdb_id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
`)

/** The services the home screen has a row for. Anything else a show is on is just "its network". */
export const STREAMERS = ['Netflix', 'Disney+', 'Apple TV+'] as const
const PATTERNS: [string, RegExp][] = [['Netflix', /netflix/i], ['Disney+', /disney\s*(\+|plus)|hulu originals? on disney/i], ['Apple TV+', /apple\s*tv/i]]

/** A network name as TMDB or TVmaze spells it, mapped onto one of our rows ('Disney Plus' and 'Disney+' are the same row). */
export function normalizeStreamer(name?: string | null): string | null {
  if (!name) return null
  return PATTERNS.find(([, rx]) => rx.test(name))?.[0] ?? null
}

/**
 * A show sits under one genre row only: the most specific of its genres. "Documentary" beats "Drama", "Animation" beats "Comedy",
 * and the broad ones (Drama, Comedy) are what is left when nothing more specific applies.
 */
const SPECIFIC = ['Animation', 'Anime', 'Documentary', 'Reality', 'Game Show', 'Talk Show', 'News', 'Sport', 'Sports', 'Kids', 'Children', 'Horror', 'Science Fiction', 'Sci-Fi', 'Fantasy',
  'Crime', 'Mystery', 'Thriller', 'Western', 'War', 'History', 'Biography', 'Music', 'Musical', 'Action', 'Adventure', 'Romance', 'Family', 'Comedy', 'Drama']
export function primaryGenre(genres: string[]): string | null {
  const lower = new Map(genres.map((g) => [g.trim().toLowerCase(), g.trim()]))
  for (const g of SPECIFIC) if (lower.has(g.toLowerCase())) return lower.get(g.toLowerCase())!
  return genres.find((g) => g.trim()) ?.trim() ?? null
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'Flix/0.1', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

interface Net { tmdb_id: number | null; streamer: string | null; network: string | null; first_air: string | null; popularity: number | null; notable: boolean }

async function tvmaze(t: { series: string; tvdb_id: number | null; imdb_id: string | null }): Promise<any | null> {
  const base = config.art.tvmazeUrl
  if (!base) return null
  const q = t.tvdb_id ? `lookup/shows?thetvdb=${t.tvdb_id}` : /^tt\d+$/.test(t.imdb_id ?? '') ? `lookup/shows?imdb=${t.imdb_id}` : null
  return (q ? await getJson(`${base}/${q}`).catch(() => null) : null) ?? (await getJson(`${base}/singlesearch/shows?q=${encodeURIComponent(t.series)}`).catch(() => null))
}

async function lookup(seriesId: number): Promise<Net> {
  const t = db.prepare('SELECT series, tvdb_id, imdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
  const out: Net = { tmdb_id: null, streamer: null, network: null, first_air: null, popularity: null, notable: false }
  if (!t) return out
  const { apiKey, apiUrl } = config.tmdb
  if (apiKey && t.tvdb_id) {
    const key = `api_key=${encodeURIComponent(apiKey)}`
    const id = (await getJson(`${apiUrl}/find/${t.tvdb_id}?external_source=tvdb_id&${key}`)).tv_results?.[0]?.id
    if (id) {
      const d = await getJson(`${apiUrl}/tv/${id}?${key}`)
      const names: string[] = (d.networks ?? []).map((n: any) => String(n.name))
      out.tmdb_id = id; out.network = names[0] ?? null
      out.streamer = names.map(normalizeStreamer).find(Boolean) ?? null
      out.first_air = d.first_air_date || null
      out.popularity = typeof d.popularity === 'number' ? d.popularity : null
      out.notable = (out.popularity ?? 0) >= 20
    }
  }
  // TVmaze answers without a key, and knows web channels ("Netflix") that TMDB sometimes files under a production company.
  if (!out.streamer || out.popularity === null) {
    const show = await tvmaze(t)
    if (show) {
      const net = show.webChannel?.name ?? show.network?.name ?? null
      out.network ??= net
      out.streamer ??= normalizeStreamer(show.webChannel?.name) ?? normalizeStreamer(show.network?.name)
      out.first_air ??= show.premiered || null
      if (out.popularity === null && typeof show.weight === 'number') { out.popularity = show.weight; out.notable = show.weight >= 70 }
    }
  }
  return out
}

const failedAt = new Map<number, number>()
let busy = false

/** Read one more show's service/premiere/popularity (newest first; a show not yet read, else the stalest). True when it did something. */
export async function crawlNetworksOnce(): Promise<boolean> {
  if (busy) return false
  busy = true
  try {
    const skip = (id: number) => (failedAt.get(id) ?? 0) > Date.now() - 3600_000
    const ids = [...listable().keys()]
    if (!ids.length) return false
    const have = new Map((db.prepare('SELECT series_id, fetched_at FROM series_net').all() as any[]).map((r) => [r.series_id as number, r.fetched_at as number]))
    const latest = new Map((db.prepare('SELECT series_id, MAX(time) AS t FROM releases GROUP BY series_id').all() as any[]).map((r) => [r.series_id as number, r.t as number]))
    const byNew = (a: number, b: number) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0)
    const next = ids.filter((id) => !have.has(id) && !skip(id)).sort(byNew)[0]
      ?? ids.filter((id) => (have.get(id) ?? 0) < now() - 14 * 86400 && !skip(id)).sort((a, b) => (have.get(a) ?? 0) - (have.get(b) ?? 0))[0]
    if (next === undefined) return false
    try {
      const n = await lookup(next)
      db.prepare('INSERT OR REPLACE INTO series_net VALUES (?,?,?,?,?,?,?,?)').run(next, n.tmdb_id, n.streamer, n.network, n.first_air, n.popularity, n.notable ? 1 : 0, now())
    } catch (e: any) { failedAt.set(next, Date.now()); console.warn(`[networks] series ${next}: ${e.message}`); return false }
    return true
  } finally { busy = false }
}

/** TMDB's trending shows this week (top ~60), refreshed twice a day. Needs the TMDB key; without it there is simply no "Trending" row. */
export async function refreshTrending(): Promise<number> {
  const { apiKey, apiUrl } = config.tmdb
  if (!apiKey) return 0
  const have = db.prepare('SELECT MAX(fetched_at) AS t FROM trending_tv').get() as any
  if (have?.t && have.t > now() - 12 * 3600) return 0
  const ids: number[] = []
  for (let page = 1; page <= 3; page++) {
    const r = await getJson(`${apiUrl}/trending/tv/week?page=${page}&api_key=${encodeURIComponent(apiKey)}`)
    for (const x of r.results ?? []) ids.push(Number(x.id))
  }
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM trending_tv')
    const ins = db.prepare('INSERT OR IGNORE INTO trending_tv VALUES (?,?,?)')
    ids.forEach((id, i) => ins.run(id, i + 1, now()))
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return ids.length
}

export function startNetworkCrawler(everyMs = 4000) {
  const tick = () => { void crawlNetworksOnce(); void refreshTrending().catch((e) => console.warn(`[networks] trending: ${e.message}`)) }
  const t = setInterval(tick, everyMs)
  t.unref()
  return t
}

export interface NetRow { streamer: string | null; first_air: string | null; notable: boolean; trending: number | null }
/** Everything the home screen needs about every show we have read: service, premiere, popularity, trending rank. */
export function netInfo(): Map<number, NetRow> {
  const m = new Map<number, NetRow>()
  for (const r of db.prepare(`SELECT n.series_id, n.streamer, n.first_air, n.notable, t.rank FROM series_net n LEFT JOIN trending_tv t ON t.tmdb_id = n.tmdb_id`).all() as any[])
    m.set(r.series_id, { streamer: r.streamer, first_air: r.first_air, notable: !!r.notable, trending: r.rank ?? null })
  return m
}
