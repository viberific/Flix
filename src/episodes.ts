import { db, now } from './db.ts'
import { META_JOIN, canViewSeries, ratingClause } from './ratings.ts'
import type { User } from './auth.ts'
import { isAlive, pickRelease, qualityLabel } from './pick.ts'
import { parseEpisodeTag } from './btn/parse.ts'
import { candidatesFor, type Row } from './candidates.ts'
import { seasonsOf } from './seasons.ts'
import { packEpisodes, packFor } from './packs.ts'

export { candidatesFor }
export interface Episode {
  season: number | null; episode: number | null; label: string
  /** True when the episode lives inside a season pack (the whole pack is downloaded, in order, so it can be seeded). */
  isPack: boolean
  torrentId: number; quality: string; available: boolean; onServer: boolean
  watched: boolean; position: number; duration: number
}

/** An interest on a pack is keyed by the episode its file holds, not by the pack's own "Season N" label. */
function episodeKey(r: { season: number | null; label: string; is_pack: number; file_name: string | null }): { season: number | null; label: string } {
  const tag = r.is_pack && r.file_name ? parseEpisodeTag(r.file_name.split('/').pop()!) : null
  return tag ? { season: tag.season, label: `S${String(tag.season).padStart(2, '0')}E${String(tag.episode).padStart(2, '0')}` } : { season: r.season, label: r.label }
}

/**
 * One entry per episode, best source chosen automatically, for the seasons that may be listed (see seasons.ts):
 * individual episode releases when the season has them all, otherwise the season pack expanded into its episodes.
 * Call ensurePackFiles() first so packs can be expanded.
 */
/** `avoid` lists sources that did not work for this viewer; the next-best release is used instead. */
export function buildEpisodes(seriesId: number, userId: number, avoid?: Set<number>): Episode[] {
  const seasons = seasonsOf(seriesId)
  if (!seasons) return []
  const rows = candidatesFor(seriesId).filter((r) => !avoid?.has(r.torrent_id))
  const prog = (db.prepare(`SELECT r.season, r.label, r.is_pack, i.file_name, i.watched_at, i.position, i.duration, i.updated_at FROM interests i
    JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? AND r.series_id = ? AND i.released_at IS NULL ORDER BY i.updated_at DESC`).all(userId, seriesId) as any[])
    .map((p) => ({ ...p, ...episodeKey(p) }))
  const out: Episode[] = []
  const add = (e: Omit<Episode, 'watched' | 'position' | 'duration'>) => {
    // Progress is keyed by label, so it carries over whichever release (single or pack) the episode came from.
    const mine = prog.filter((p) => p.season === e.season && p.label === e.label)
    const cur = mine.find((p) => !p.watched_at)
    out.push({ ...e, watched: mine.some((p) => p.watched_at), position: cur?.position ?? 0, duration: cur?.duration ?? 0 })
  }
  for (const [season, source] of seasons) {
    if (source === 'episodes') {
      const groups = new Map<string, Row[]>()
      for (const r of rows) if (!r.is_pack && r.season === season && r.episode !== null) (groups.get(r.label) ?? groups.set(r.label, []).get(r.label)!).push(r)
      for (const g of groups.values()) {
        const pick = pickRelease(g)!
        add({ season, episode: pick.episode, label: pick.label, isPack: false, torrentId: pick.torrent_id, quality: qualityLabel(pick.resolution), available: isAlive(pick), onServer: pick.on_server })
      }
      continue
    }
    const packId = packFor(seriesId, season, avoid)
    const pack = rows.find((r) => r.torrent_id === packId)
    if (!pack) continue
    const files = packEpisodes(pack.torrent_id)
    if (!files.length) { // pack not readable yet: one "Season N" entry that resumes at the next unfinished file
      add({ season, episode: null, label: `Season ${season}`, isPack: true, torrentId: pack.torrent_id, quality: qualityLabel(pack.resolution), available: isAlive(pack), onServer: pack.on_server })
      continue
    }
    for (const f of files) {
      add({ season, episode: f.episode, label: `S${String(season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`, isPack: true,
        torrentId: pack.torrent_id, quality: qualityLabel(pack.resolution), available: isAlive(pack), onServer: pack.on_server })
    }
  }
  return out.sort((a, b) => (a.season ?? 1e9) - (b.season ?? 1e9) || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.label.localeCompare(b.label))
}

export function continueWatching(user: User) {
  const f = ratingClause(user)
  const rows = (db.prepare(`SELECT r.series_id AS seriesId, r.series, '/api/art/' || r.series_id || '/poster' AS poster, r.season, r.label, r.is_pack, i.file_name, i.position, i.duration
    FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id ${META_JOIN}r.series_id
    WHERE i.user_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL AND i.position > 30 AND ${f.sql} ORDER BY i.updated_at DESC LIMIT 40`).all(user.id, ...f.params) as any[])
    .map(({ is_pack, file_name, ...r }) => ({ ...r, ...episodeKey({ season: r.season, label: r.label, is_pack, file_name }) }))
  const seen = new Set<string>()
  const started = rows.filter((r) => (seen.has(r.seriesId + r.label) ? false : (seen.add(r.seriesId + r.label), true))).slice(0, 12)
  return [...started, ...nextUp(user, new Set(started.map((r) => r.seriesId)))].slice(0, 12)
}

/** For shows the viewer finished an episode of recently and has not carried on with: the next episode, ready to press. */
function nextUp(user: User, skip: Set<number>) {
  const recent = db.prepare(`SELECT r.series_id AS id, r.series AS name, MAX(i.watched_at) AS w FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id
    WHERE i.user_id = ? AND i.watched_at IS NOT NULL AND i.watched_at > ? GROUP BY r.series_id ORDER BY w DESC LIMIT 8`).all(user.id, now() - 60 * 86400) as { id: number; name: string }[]
  const out: any[] = []
  for (const s of recent) {
    if (skip.has(s.id) || !seasonsOf(s.id) || !canViewSeries(user, s.id)) continue
    const eps = buildEpisodes(s.id, user.id)
    const last = eps.map((e) => e.watched).lastIndexOf(true)
    const next = last < 0 ? undefined : eps.slice(last + 1).find((e) => e.available && !e.watched)
    if (next) out.push({ seriesId: s.id, series: s.name, poster: `/api/art/${s.id}/poster`, season: next.season, label: next.label, position: 0, duration: 0, next: true })
  }
  return out
}
