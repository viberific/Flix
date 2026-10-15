import { db } from './db.ts'
import { META_JOIN, ratingClause } from './ratings.ts'
import type { User } from './auth.ts'
import { isAlive, pickRelease, qualityLabel, type Cand } from './pick.ts'

interface Row extends Cand { season: number | null; episode: number | null; label: string; is_pack: number }
export interface Episode {
  season: number | null; episode: number | null; label: string; isPack: boolean
  torrentId: number; quality: string; available: boolean; onServer: boolean
  watched: boolean; position: number; duration: number
}

export function candidatesFor(seriesId: number): Row[] {
  const rows = db.prepare(`SELECT r.torrent_id, r.season, r.episode, r.label, r.is_pack, r.resolution, r.codec, r.seeders, r.size,
      EXISTS(SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') AS on_server
    FROM releases r WHERE r.series_id = ?`).all(seriesId) as any[]
  return rows.map((r) => ({ ...r, on_server: !!r.on_server }))
}

/** One entry per episode (best source chosen automatically); season packs only appear for seasons with no single episodes. */
export function buildEpisodes(seriesId: number, userId: number): Episode[] {
  const rows = candidatesFor(seriesId)
  const groups = new Map<string, Row[]>()
  const seasonsWithEpisodes = new Set<number | null>()
  for (const r of rows) if (!r.is_pack) seasonsWithEpisodes.add(r.season)
  for (const r of rows) {
    if (r.is_pack && seasonsWithEpisodes.has(r.season)) continue
    const k = `${r.season}|${r.label}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const prog = db.prepare(`SELECT r.season, r.label, i.watched_at, i.position, i.duration, i.updated_at FROM interests i
    JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? AND r.series_id = ? AND i.released_at IS NULL ORDER BY i.updated_at DESC`).all(userId, seriesId) as any[]
  const out: Episode[] = []
  for (const [k, g] of groups) {
    const pick = pickRelease(g)!
    const mine = prog.filter((p) => `${p.season}|${p.label}` === k)
    const watched = mine.some((p) => p.watched_at)
    const cur = mine.find((p) => !p.watched_at)
    out.push({
      season: pick.season, episode: pick.episode, label: pick.label, isPack: !!pick.is_pack,
      torrentId: pick.torrent_id, quality: qualityLabel(pick.resolution), available: isAlive(pick), onServer: pick.on_server,
      watched, position: cur?.position ?? 0, duration: cur?.duration ?? 0,
    })
  }
  return out.sort((a, b) => (a.season ?? 1e9) - (b.season ?? 1e9) || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.label.localeCompare(b.label))
}

export function continueWatching(user: User) {
  const f = ratingClause(user)
  const rows = db.prepare(`SELECT r.series_id AS seriesId, r.series, CASE WHEN r.series_poster IS NOT NULL AND r.series_poster != '' THEN '/api/art/' || r.series_id || '/poster' END AS poster, r.season, r.label, i.position, i.duration
    FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id ${META_JOIN}r.series_id
    WHERE i.user_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL AND i.position > 30 AND ${f.sql} ORDER BY i.updated_at DESC LIMIT 40`).all(user.id, ...f.params) as any[]
  const seen = new Set<string>()
  return rows.filter((r) => (seen.has(r.seriesId + r.label) ? false : (seen.add(r.seriesId + r.label), true))).slice(0, 12)
}
