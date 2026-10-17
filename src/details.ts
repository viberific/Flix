import { db, now } from './db.ts'
import { config } from './config.ts'

db.exec(`CREATE TABLE IF NOT EXISTS series_details (
  series_id INTEGER PRIMARY KEY, overview TEXT, cast_json TEXT, trailer TEXT, year INTEGER, fetched_at INTEGER NOT NULL
)`)

export interface Details { overview: string | null; cast: { name: string; role: string }[]; trailer: string | null; year: number | null }

const YT_ID = /^[\w-]{11}$/
/** The 11-character YouTube video id out of a bare id or any youtube URL; null when it isn't one. */
export function youtubeId(v?: string | null): string | null {
  if (!v) return null
  if (YT_ID.test(v)) return v
  return /(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(v)?.[1] ?? null
}

export function getDetails(seriesId: number): Details | null {
  const r = db.prepare('SELECT overview, cast_json, trailer, year FROM series_details WHERE series_id = ?').get(seriesId) as any
  if (!r) return null
  let cast: Details['cast'] = []
  try { cast = JSON.parse(r.cast_json ?? '[]') } catch { /* keep empty */ }
  return { overview: r.overview, cast, trailer: r.trailer, year: r.year }
}

async function tmdb(path: string): Promise<any> {
  const { apiKey, apiUrl } = config.tmdb
  const res = await fetch(`${apiUrl}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`)
  return res.json()
}

/** Top YouTube search hit for "<name> official trailer"; no API key needed. Null when nothing parses. */
async function searchYoutube(name: string): Promise<string | null> {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(name + ' official trailer')}&sp=EgIQAQ%253D%253D`, {
    headers: { 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`)
  return /"videoRenderer":\{"videoId":"([\w-]{11})"/.exec(await res.text())?.[1] ?? null
}

const failedAt = new Map<number, number>()
const pending = new Set<number>()

/** Fill in summary, cast and a trailer (TMDB by TVDB id when keyed, else a YouTube search) when we have none or only a stale copy. */
export function queueDetails(seriesId: number): Promise<void> {
  if (pending.has(seriesId)) return Promise.resolve()
  const have = db.prepare('SELECT fetched_at FROM series_details WHERE series_id = ?').get(seriesId) as any
  if (have && have.fetched_at > now() - 14 * 86400) return Promise.resolve()
  if ((failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return Promise.resolve()
  pending.add(seriesId)
  return (async () => {
    try {
      const t = db.prepare('SELECT series, tvdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
      if (!t) return
      let d: any = null
      const id = config.tmdb.apiKey && t.tvdb_id ? (await tmdb(`/find/${t.tvdb_id}?external_source=tvdb_id`)).tv_results?.[0]?.id : null
      if (id) d = await tmdb(`/tv/${id}?append_to_response=aggregate_credits,videos`)
      const cast = (d?.aggregate_credits?.cast ?? []).slice(0, 12).map((c: any) => ({ name: String(c.name), role: String(c.roles?.[0]?.character ?? '') }))
      const vids = (d?.videos?.results ?? []).filter((v: any) => v.site === 'YouTube' && YT_ID.test(v.key))
      const best = vids.find((v: any) => v.type === 'Trailer' && v.official) ?? vids.find((v: any) => v.type === 'Trailer') ?? vids.find((v: any) => v.type === 'Teaser')
      const year = Number(String(d?.first_air_date ?? '').slice(0, 4)) || null
      let trailer: string | null = best?.key ?? null
      if (!trailer && t.series) trailer = await searchYoutube(t.series).catch((e) => { console.warn(`[details] trailer search for series ${seriesId}: ${e.message}`); return null })
      db.prepare('INSERT OR REPLACE INTO series_details VALUES (?,?,?,?,?,?)').run(seriesId, d?.overview || null, JSON.stringify(cast), trailer, year, now())
    } catch (e: any) { failedAt.set(seriesId, Date.now()); console.warn(`[details] series ${seriesId}: ${e.message}`) }
    finally { pending.delete(seriesId) }
  })()
}
