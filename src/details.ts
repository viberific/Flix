import { db, now } from './db.ts'
import { config } from './config.ts'

db.exec(`CREATE TABLE IF NOT EXISTS series_details (
  series_id INTEGER PRIMARY KEY, overview TEXT, cast_json TEXT, trailer TEXT, year INTEGER, fetched_at INTEGER NOT NULL
)`)
// Every trailer worth trying, best first, each checked to be playable when found (a JSON array of YouTube ids). NULL = not looked up this way yet.
try { db.exec('ALTER TABLE series_details ADD COLUMN trailers TEXT') } catch { /* already present */ }
// Which version of the lookup wrote the row; older rows are read again (2 added the cast's photos).
try { db.exec('ALTER TABLE series_details ADD COLUMN v INTEGER NOT NULL DEFAULT 0') } catch { /* already present */ }

export interface Details { overview: string | null; cast: { name: string; role: string; photo?: string | null }[]; trailer: string | null; trailers: string[]; year: number | null }

const YT_ID = /^[\w-]{11}$/
/** The 11-character YouTube video id out of a bare id or any youtube URL; null when it isn't one. */
export function youtubeId(v?: string | null): string | null {
  if (!v) return null
  if (YT_ID.test(v)) return v
  return /(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(v)?.[1] ?? null
}

export function getDetails(seriesId: number): Details | null {
  const r = db.prepare('SELECT overview, cast_json, trailer, trailers, year FROM series_details WHERE series_id = ?').get(seriesId) as any
  if (!r) return null
  let cast: Details['cast'] = []
  try { cast = JSON.parse(r.cast_json ?? '[]') } catch { /* keep empty */ }
  let trailers: string[] = []
  try { trailers = (JSON.parse(r.trailers ?? '[]') as unknown[]).filter((x): x is string => typeof x === 'string' && YT_ID.test(x)) } catch { /* keep empty */ }
  return { overview: r.overview, cast, trailer: r.trailer, trailers, year: r.year }
}

async function tmdb(path: string): Promise<any> {
  const { apiKey, apiUrl } = config.tmdb
  const res = await fetch(`${apiUrl}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`)
  return res.json()
}

/** YouTube's top hits for "<name> official trailer", best first; no API key needed. Empty when nothing parses. */
async function searchYoutube(name: string): Promise<string[]> {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(name + ' official trailer')}&sp=EgIQAQ%253D%253D`, {
    headers: { 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`)
  return [...new Set([...(await res.text()).matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"/g)].map((m) => m[1]))].slice(0, 8)
}

/**
 * Whether a video can be played in an embedded player: YouTube's oEmbed answers 401/403/404 for private, removed and
 * embedding-disabled videos. If YouTube can't be reached the video gets the benefit of the doubt (the player tries the next one if it fails).
 */
export async function trailerPlayable(id: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(6_000) })
    return res.ok || res.status >= 500
  } catch { return true }
}

const failedAt = new Map<number, number>()
const pending = new Set<number>()

/** Fill in summary, cast and a trailer (TMDB by TVDB id when keyed, else a YouTube search) when we have none or only a stale copy. */
export function queueDetails(seriesId: number): Promise<void> {
  if (pending.has(seriesId)) return Promise.resolve()
  const have = db.prepare('SELECT fetched_at, trailers, v FROM series_details WHERE series_id = ?').get(seriesId) as any
  if (have && have.fetched_at > now() - 14 * 86400 && have.trailers !== null && have.v >= 2) return Promise.resolve()
  if ((failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return Promise.resolve()
  pending.add(seriesId)
  return (async () => {
    try {
      const t = db.prepare('SELECT series, tvdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
      if (!t) return
      let d: any = null
      const id = config.tmdb.apiKey && t.tvdb_id ? (await tmdb(`/find/${t.tvdb_id}?external_source=tvdb_id`)).tv_results?.[0]?.id : null
      if (id) d = await tmdb(`/tv/${id}?append_to_response=aggregate_credits,videos`)
      const cast = (d?.aggregate_credits?.cast ?? []).slice(0, 12).map((c: any) => ({ name: String(c.name), role: String(c.roles?.[0]?.character ?? ''), photo: c.profile_path ? `${config.art.tmdbImages}/w185${c.profile_path}` : null }))
      const vids = (d?.videos?.results ?? []).filter((v: any) => v.site === 'YouTube' && YT_ID.test(v.key))
      const year = Number(String(d?.first_air_date ?? '').slice(0, 4)) || null
      // Every candidate, best first: BTN's own link, TMDB's trailers then teasers, then a YouTube search. The first few that actually play are kept.
      const rank = (v: any) => (v.type === 'Trailer' ? 0 : 2) + (v.official ? 0 : 1)
      const own = db.prepare('SELECT MAX(youtube_trailer) AS u FROM releases WHERE series_id = ?').get(seriesId) as any
      const candidates = [youtubeId(own?.u), ...[...vids].filter((v: any) => v.type === 'Trailer' || v.type === 'Teaser').sort((a: any, b: any) => rank(a) - rank(b)).map((v: any) => v.key as string)]
      if (candidates.filter(Boolean).length < 3 && t.series) candidates.push(...await searchYoutube(t.series).catch((e) => { console.warn(`[details] trailer search for series ${seriesId}: ${e.message}`); return [] as string[] }))
      const trailers: string[] = []
      for (const id of new Set(candidates)) {
        if (!id || trailers.length >= 4) continue
        if (await trailerPlayable(id)) trailers.push(id)
      }
      db.prepare('INSERT OR REPLACE INTO series_details (series_id, overview, cast_json, trailer, year, fetched_at, trailers, v) VALUES (?,?,?,?,?,?,?,2)').run(seriesId, d?.overview || null, JSON.stringify(cast), trailers[0] ?? null, year, now(), JSON.stringify(trailers))
    } catch (e: any) { failedAt.set(seriesId, Date.now()); console.warn(`[details] series ${seriesId}: ${e.message}`) }
    finally { pending.delete(seriesId) }
  })()
}
