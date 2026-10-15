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
try { db.exec('ALTER TABLE users ADD COLUMN allowed_ratings TEXT') } catch { /* already present */ }

export function getRating(seriesId: number): { rating: Rating; source: string } {
  const r = db.prepare('SELECT rating, source FROM series_meta WHERE series_id = ?').get(seriesId) as any
  return r ? { rating: r.rating, source: r.source } : { rating: 'Unrated', source: 'none' }
}
export function setRating(seriesId: number, rating: Rating | null) {
  if (rating === null) db.prepare('DELETE FROM series_meta WHERE series_id = ?').run(seriesId) // back to automatic
  else db.prepare(`INSERT OR REPLACE INTO series_meta VALUES (?,?, 'admin', ?)`).run(seriesId, rating, now())
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

// ---- automatic lookup (TMDB, by TVDB id) ----------------------------------------------------------------

async function lookupTmdb(tvdbId: number): Promise<Rating> {
  const { apiKey, apiUrl } = config.tmdb
  const j = async (path: string) => {
    const res = await fetch(`${apiUrl}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`)
    return res.json() as Promise<any>
  }
  const found = await j(`/find/${tvdbId}?external_source=tvdb_id`)
  const id = found.tv_results?.[0]?.id
  if (!id) return 'Unrated'
  const cr = await j(`/tv/${id}/content_ratings`)
  const us = (cr.results ?? []).find((x: any) => x.iso_3166_1 === 'US')
  return normalizeRating(us?.rating)
}

const failedAt = new Map<number, number>()
const pending = new Set<number>()
let active = 0
const queue: number[] = []

/** Fire-and-forget: fetch a rating for a series if we have none (or only an old automatic one). */
export function queueRating(seriesId: number) {
  if (!config.tmdb.apiKey || pending.has(seriesId)) return
  const have = db.prepare('SELECT source, fetched_at FROM series_meta WHERE series_id = ?').get(seriesId) as any
  if (have && (have.source === 'admin' || have.fetched_at > now() - 7 * 86400)) return
  if ((failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return
  pending.add(seriesId); queue.push(seriesId); pump()
}
function pump() {
  while (active < 2 && queue.length) {
    const id = queue.shift()!
    active++
    ;(async () => {
      try {
        const t = db.prepare('SELECT tvdb_id FROM releases WHERE series_id = ? AND tvdb_id IS NOT NULL LIMIT 1').get(id) as any
        if (!t?.tvdb_id) return
        const rating = await lookupTmdb(t.tvdb_id)
        db.prepare(`INSERT OR REPLACE INTO series_meta VALUES (?,?, 'tmdb', ?)`).run(id, rating, now())
      } catch (e: any) { failedAt.set(id, Date.now()); console.warn(`[ratings] series ${id}: ${e.message}`) }
      finally { active--; pending.delete(id); pump() }
    })()
  }
}
