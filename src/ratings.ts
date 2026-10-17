import { db, now } from './db.ts'
import { config } from './config.ts'

/** US TV Parental Guidelines (BTN is TV-only). Movie-style ratings are mapped onto these. */
export const RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Unrated'] as const
export type Rating = (typeof RATINGS)[number]
export const isRating = (v: unknown): v is Rating => RATINGS.includes(v as Rating)

export function normalizeRating(raw?: string | null): Rating {
  const r = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^(TV-?Y)$/.test(r)) return 'TV-Y'
  if (/^TV-?Y7(-FV)?$/.test(r)) return 'TV-Y7'
  if (/^(TV-?G|G)$/.test(r)) return 'TV-G'
  if (/^(TV-?PG|PG)$/.test(r)) return 'TV-PG'
  if (/^(TV-?14|PG-?13|14\+?)$/.test(r)) return 'TV-14'
  if (/^(TV-?MA|R|NC-?17|MA|17\+?|18\+?)$/.test(r)) return 'TV-MA'
  return 'Unrated'
}

db.exec(`CREATE TABLE IF NOT EXISTS series_meta (
  series_id INTEGER PRIMARY KEY, rating TEXT NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL
)`)
try { db.exec('ALTER TABLE series_meta ADD COLUMN imdb_score REAL') } catch { /* already present */ }
try { db.exec('ALTER TABLE users ADD COLUMN allowed_ratings TEXT') } catch { /* already present */ }
// Ratings are always automatic now: a rating an admin once set by hand is dropped and looked up again.
db.exec(`DELETE FROM series_meta WHERE source = 'admin'`)

export function getRating(seriesId: number): { rating: Rating; source: string; score: number | null } {
  const r = db.prepare('SELECT rating, source, imdb_score FROM series_meta WHERE series_id = ?').get(seriesId) as any
  return r ? { rating: r.rating, source: r.source, score: r.imdb_score ?? null } : { rating: 'Unrated', source: 'none', score: null }
}

/** null = no restriction. An empty array blocks everything. */
export type Allowed = Rating[] | null
export function parseAllowed(json: string | null | undefined): Allowed {
  if (!json) return null
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter(isRating) : null } catch { return null }
}
export function cleanAllowed(v: unknown): Allowed {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v) || !v.every(isRating)) throw Object.assign(new Error('Invalid ratings list'), { statusCode: 400 })
  return RATINGS.every((r) => v.includes(r)) ? null : [...new Set(v)] // everything ticked == unrestricted
}

interface Viewer { is_admin: number; allowed: Allowed }
export function canView(u: Viewer | null | undefined, rating: Rating): boolean {
  return !u || !!u.is_admin || u.allowed === null || u.allowed.includes(rating)
}
export function canViewSeries(u: Viewer | null | undefined, seriesId: number): boolean {
  return canView(u, getRating(seriesId).rating)
}

/** SQL fragment restricting a query that joins `series_meta` as (m_sid, m_rating). */
export const META_JOIN = `LEFT JOIN (SELECT series_id AS m_sid, rating AS m_rating FROM series_meta) m ON m.m_sid = `
export function ratingClause(u: Viewer | null | undefined): { sql: string; params: string[] } {
  if (!u || u.is_admin || u.allowed === null) return { sql: '1=1', params: [] }
  if (!u.allowed.length) return { sql: '0', params: [] }
  return { sql: `COALESCE(m.m_rating, 'Unrated') IN (${u.allowed.map(() => '?').join(',')})`, params: [...u.allowed] }
}

// ---- automatic lookup (IMDb through OMDb, then TMDB) ------------------------------------------------------

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** IMDb's own certificate ("TV-MA") and score for a title. IMDb has no public API and blocks scraping; OMDb serves its data. */
export async function lookupImdb(imdbId: string): Promise<{ rating: Rating | null; score: number | null }> {
  const { apiKey, apiUrl } = config.omdb
  const j = await getJson(`${apiUrl}/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`)
  if (j.Response === 'False') {
    if (/invalid api key|limit reached/i.test(String(j.Error))) throw new Error(`OMDb: ${j.Error}`)
    return { rating: null, score: null } // IMDb id unknown to OMDb
  }
  const rated = String(j.Rated ?? '')
  const score = Number(j.imdbRating)
  return { rating: !rated || rated === 'N/A' ? null : normalizeRating(rated), score: Number.isFinite(score) && score > 0 ? score : null }
}

async function lookupTmdb(tvdbId: number): Promise<Rating | null> {
  const { apiKey, apiUrl } = config.tmdb
  const j = (path: string) => getJson(`${apiUrl}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`)
  const found = await j(`/find/${tvdbId}?external_source=tvdb_id`)
  const id = found.tv_results?.[0]?.id
  if (!id) return null
  const cr = await j(`/tv/${id}/content_ratings`)
  const us = (cr.results ?? []).find((x: any) => x.iso_3166_1 === 'US')
  return us?.rating ? normalizeRating(us.rating) : null
}

/** BTN gives either "tt0903747" or the bare number. */
const imdbId = (v: unknown) => { const m = /^(?:tt)?(\d{5,10})$/i.exec(String(v ?? '').trim()); return m ? `tt${m[1]}` : null }

const failedAt = new Map<number, number>()
const pending = new Set<number>()
let active = 0
const queue: number[] = []

/** Fire-and-forget: fetch a rating for a show if we have none, or only an old one (an IMDb answer is kept a week, a fallback one a day). */
export function queueRating(seriesId: number) {
  if ((!config.omdb.apiKey && !config.tmdb.apiKey) || pending.has(seriesId)) return
  const have = db.prepare('SELECT source, fetched_at FROM series_meta WHERE series_id = ?').get(seriesId) as any
  if (have && have.fetched_at > now() - (have.source === 'imdb' ? 7 : 1) * 86400) return
  if ((failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return
  pending.add(seriesId); queue.push(seriesId); pump()
}
function pump() {
  while (active < 2 && queue.length) {
    const id = queue.shift()!
    active++
    ;(async () => {
      try {
        const ids = db.prepare('SELECT imdb_id, tvdb_id FROM releases WHERE series_id = ? AND (imdb_id IS NOT NULL OR tvdb_id IS NOT NULL)').all(id) as any[]
        const imdb = ids.map((r) => imdbId(r.imdb_id)).find(Boolean) ?? null
        const tvdb = ids.map((r) => r.tvdb_id).find(Boolean) ?? null
        let rating: Rating | null = null, score: number | null = null, source = 'imdb', failed: Error | null = null
        if (config.omdb.apiKey && imdb) {
          try { ({ rating, score } = await lookupImdb(imdb)) } catch (e: any) { failed = e }
        }
        if (!rating && config.tmdb.apiKey && tvdb) {
          try { rating = await lookupTmdb(tvdb); source = 'tmdb' } catch (e: any) { failed ??= e }
        }
        if (!rating && failed) throw failed
        if (!rating && !score && !imdb && !tvdb) return
        db.prepare(`INSERT OR REPLACE INTO series_meta (series_id, rating, source, fetched_at, imdb_score) VALUES (?,?,?,?,?)`).run(id, rating ?? 'Unrated', rating ? source : 'imdb', now(), score)
      } catch (e: any) { failedAt.set(id, Date.now()); console.warn(`[ratings] series ${id}: ${e.message}`) }
      finally { active--; pending.delete(id); pump() }
    })()
  }
}
