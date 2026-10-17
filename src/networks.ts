import { db, now } from './db.ts'
import { config } from './config.ts'
import { NET_VER, catalogChanged } from './seasons.ts'

/**
 * What the home screen and the library rules are built from: which streaming service a show belongs to (HBO, Crave, Showcase,
 * Netflix, Disney+, Apple TV+, Paramount+), when it premiered, how popular it is, whether it is trending, what language it is in and how many
 * episodes each season has. BTN knows none of that, so it comes from TMDB (needs the optional key) and, as a fallback, from
 * TVmaze (no key). Read in the background for every show BTN has been fully read for (the `series_net` table lives in db.ts).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS trending_tv (tmdb_id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
`)

/** The services the home screen is made of, in the order of its rows. A show on none of them is not on the home screen. */
export const STREAMERS = ['HBO', 'Crave', 'Showcase', 'Netflix', 'Disney+', 'Apple TV+', 'Paramount+'] as const
const PATTERNS: [string, RegExp][] = [['HBO', /\bhbo\b|^max$/i], ['Crave', /\bcrave\b/i], ['Showcase', /\bshowcase\b/i], ['Netflix', /netflix/i],
  ['Disney+', /disney\s*(\+|plus)|hulu originals? on disney/i], ['Apple TV+', /apple\s*tv/i], ['Paramount+', /paramount\s*(\+|plus)/i]]

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

interface Net { lang: string | null; counts: Record<number, number>; tmdb_id: number | null; streamer: string | null; network: string | null; first_air: string | null; popularity: number | null; notable: boolean }

async function tvmaze(t: { series: string; tvdb_id: number | null; imdb_id: string | null }): Promise<any | null> {
  const base = config.art.tvmazeUrl
  if (!base) return null
  const q = t.tvdb_id ? `lookup/shows?thetvdb=${t.tvdb_id}` : /^tt\d+$/.test(t.imdb_id ?? '') ? `lookup/shows?imdb=${t.imdb_id}` : null
  return (q ? await getJson(`${base}/${q}`).catch(() => null) : null) ?? (await getJson(`${base}/singlesearch/shows?q=${encodeURIComponent(t.series)}`).catch(() => null))
}

async function lookup(seriesId: number): Promise<Net> {
  const t = db.prepare('SELECT series, tvdb_id, imdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
  const out: Net = { lang: null, counts: {}, tmdb_id: null, streamer: null, network: null, first_air: null, popularity: null, notable: false }
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
      out.lang = d.original_language ? String(d.original_language).toLowerCase() : null
      for (const x of d.seasons ?? []) if (x.season_number >= 1 && x.episode_count > 0) out.counts[x.season_number] = x.episode_count
      // The season on the air has episodes still to come; "whole" for it means everything that has aired so far.
      const aired = d.last_episode_to_air
      if (aired?.season_number >= 1 && aired.episode_number > 0) out.counts[aired.season_number] = Math.min(out.counts[aired.season_number] ?? Infinity, aired.episode_number)
    }
  }
  // TVmaze answers without a key, and knows web channels ("Netflix") that TMDB sometimes files under a production company.
  if (!out.streamer || out.popularity === null || !out.lang || !Object.keys(out.counts).length) {
    const show = await tvmaze(t)
    if (show) {
      out.lang ??= show.language ? String(show.language).toLowerCase() : null
      if (!Object.keys(out.counts).length && show.id) {
        const seasons = await getJson(`${config.art.tvmazeUrl}/shows/${show.id}/seasons`).catch(() => [])
        for (const x of Array.isArray(seasons) ? seasons : []) if (x.number >= 1 && x.episodeOrder > 0) out.counts[x.number] = x.episodeOrder
      }
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

/** Read one show's service/language/season lengths and keep them. */
async function readNet(seriesId: number) {
  const n = await lookup(seriesId)
  db.prepare(`INSERT OR REPLACE INTO series_net (series_id, tmdb_id, streamer, network, first_air, popularity, notable, fetched_at, lang, season_counts, ver)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(seriesId, n.tmdb_id, n.streamer, n.network, n.first_air, n.popularity, n.notable ? 1 : 0, now(), n.lang, JSON.stringify(n.counts), NET_VER)
  catalogChanged() // the show's language and season lengths decide whether, and how much of it, is listed
}

/** For a show someone just searched for or opened: read it now unless we already have, rather than wait for the background crawl. Never throws. */
export async function ensureNet(seriesId: number): Promise<void> {
  if (db.prepare('SELECT 1 FROM series_net WHERE series_id = ?').get(seriesId)) return
  await readNet(seriesId).catch((e) => console.warn(`[networks] series ${seriesId}: ${e.message}`))
}

/** Read one more show's service/premiere/popularity (newest first; a show not yet read, else the stalest). True when it did something. */
export async function crawlNetworksOnce(): Promise<boolean> {
  if (busy) return false
  busy = true
  try {
    const skip = (id: number) => (failedAt.get(id) ?? 0) > Date.now() - 3600_000
    const ids = (db.prepare('SELECT series_id FROM series_sync').all() as any[]).map((r) => r.series_id as number)
    if (!ids.length) return false
    // A row written by an older version counts as unread, so it is read again for the language and season lengths.
    const have = new Map((db.prepare('SELECT series_id, fetched_at FROM series_net WHERE ver >= ?').all(NET_VER) as any[]).map((r) => [r.series_id as number, r.fetched_at as number]))
    const latest = new Map((db.prepare('SELECT series_id, MAX(time) AS t FROM releases GROUP BY series_id').all() as any[]).map((r) => [r.series_id as number, r.t as number]))
    const byNew = (a: number, b: number) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0)
    const next = ids.filter((id) => !have.has(id) && !skip(id)).sort(byNew)[0]
      ?? ids.filter((id) => (have.get(id) ?? 0) < now() - 14 * 86400 && !skip(id)).sort((a, b) => (have.get(a) ?? 0) - (have.get(b) ?? 0))[0]
    if (next === undefined) return false
    try { await readNet(next) } catch (e: any) { failedAt.set(next, Date.now()); console.warn(`[networks] series ${next}: ${e.message}`); return false }
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

export function startNetworkCrawler(everyMs = 2000) {
  const tick = () => { void crawlNetworksOnce(); void refreshTrending().catch((e) => console.warn(`[networks] trending: ${e.message}`)) }
  const t = setInterval(tick, everyMs)
  t.unref()
  return t
}

export interface NetRow { streamer: string | null; first_air: string | null; notable: boolean; popularity: number; trending: number | null }
/** Everything the home screen needs about every show we have read: service, premiere, popularity, trending rank. */
export function netInfo(): Map<number, NetRow> {
  const m = new Map<number, NetRow>()
  for (const r of db.prepare(`SELECT n.series_id, n.streamer, n.first_air, n.notable, n.popularity, t.rank FROM series_net n LEFT JOIN trending_tv t ON t.tmdb_id = n.tmdb_id`).all() as any[])
    m.set(r.series_id, { streamer: r.streamer, first_air: r.first_air, notable: !!r.notable, popularity: r.popularity ?? 0, trending: r.rank ?? null })
  return m
}
