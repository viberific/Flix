import { db, now } from './db.ts'
import { META_JOIN, canViewSeries, ratingClause } from './ratings.ts'
import type { User } from './auth.ts'
import { isAlive, pickRelease, qualityLabel } from './pick.ts'
import { parseEpisodeTag } from './btn/parse.ts'
import { candidatesFor, type Row } from './candidates.ts'
import { seasonsOf } from './seasons.ts'
import { packEpisodes, packFor } from './packs.ts'
import { STARTED_AT } from './gate.ts'

export { candidatesFor }
export interface Episode {
  season: number | null; episode: number | null; label: string
  /** True when the episode lives inside a season pack (fetched one episode at a time, as it is watched, so it can be seeded). */
  isPack: boolean
  torrentId: number; quality: string; available: boolean; onServer: boolean
  /** Which file inside the torrent this episode plays. Null for a single-file release (whose own progress is the
   *  file's), and for a pack whose .torrent could not be read yet. */
  fileIndex: number | null
  watched: boolean; position: number; duration: number
  /** When this person last played any of it (unix seconds), 0 never: what "the episode they were on" is decided by. */
  lastAt: number
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
  const add = (e: Omit<Episode, 'watched' | 'position' | 'duration' | 'lastAt'>) => {
    // Progress is keyed by label, so it carries over whichever release (single or pack) the episode came from.
    const mine = prog.filter((p) => p.season === e.season && p.label === e.label)
    const cur = mine.find((p) => !p.watched_at)
    out.push({ ...e, watched: mine.some((p) => p.watched_at), position: cur?.position ?? 0, duration: cur?.duration ?? 0, lastAt: Number(mine[0]?.updated_at ?? 0) })
  }
  for (const [season, source] of seasons) {
    if (source === 'episodes') {
      const groups = new Map<string, Row[]>()
      for (const r of rows) if (!r.is_pack && r.season === season && r.episode !== null) (groups.get(r.label) ?? groups.set(r.label, []).get(r.label)!).push(r)
      for (const g of groups.values()) {
        // No pick means every release of this episode would have to be re-encoded, and Flix is set never to
        // convert the picture: it is left out rather than offered as a tile that cannot play. The show is hidden
        // entirely by unplayableSeries() when it has nothing playable at all.
        const pick = pickRelease(g)
        if (!pick) continue
        add({ season, episode: pick.episode, label: pick.label, isPack: false, torrentId: pick.torrent_id, quality: qualityLabel(pick.resolution), available: isAlive(pick), onServer: pick.on_server, fileIndex: null })
      }
      continue
    }
    const packId = packFor(seriesId, season, avoid)
    const pack = rows.find((r) => r.torrent_id === packId)
    if (!pack) continue
    const files = packEpisodes(pack.torrent_id)
    if (!files.length) { // pack not readable yet: one "Season N" entry that resumes at the next unfinished file
      add({ season, episode: null, label: `Season ${season}`, isPack: true, torrentId: pack.torrent_id, quality: qualityLabel(pack.resolution), available: isAlive(pack), onServer: pack.on_server, fileIndex: null })
      continue
    }
    for (const f of files) {
      add({ season, episode: f.episode, label: `S${String(season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`, isPack: true,
        torrentId: pack.torrent_id, quality: qualityLabel(pack.resolution), available: isAlive(pack), onServer: pack.on_server, fileIndex: f.idx })
    }
  }
  return out.sort((a, b) => (a.season ?? 1e9) - (b.season ?? 1e9) || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.label.localeCompare(b.label))
}

/**
 * The episode this person is on: the one they played last. Still partway through, it is resumed; finished, the next
 * available one they have not watched is. -1 when they have not started the show.
 *
 * "Last played", never "first in the list with some progress": that rule resumed an episode left two minutes from its end
 * weeks ago, after the three that followed it had been watched, and a show whose next episode had been started showed
 * the old one under Continue Watching with the new one nowhere.
 */
export function currentEpisode(eps: Pick<Episode, 'watched' | 'position' | 'available' | 'lastAt'>[]): number {
  let last = -1
  eps.forEach((e, i) => { if ((e.watched || e.position > STARTED_AT) && (last < 0 || e.lastAt >= eps[last].lastAt)) last = i })
  if (last < 0) return -1
  const e = eps[last]
  if (!e.watched) return last
  return eps.findIndex((x, j) => j > last && x.available && !x.watched)
}

/** One entry per show, newest first: the episode that show is on (see currentEpisode), with where it was left. */
export function continueWatching(user: User) {
  const f = ratingClause(user)
  const shows = db.prepare(`SELECT r.series_id AS id, r.series AS name, MAX(i.updated_at) AS u FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id ${META_JOIN}r.series_id
    WHERE i.user_id = ? AND i.released_at IS NULL AND ((i.watched_at IS NULL AND i.position > ?) OR i.watched_at > ?) AND ${f.sql}
    GROUP BY r.series_id ORDER BY u DESC LIMIT 20`).all(user.id, STARTED_AT, now() - 60 * 86400, ...f.params) as { id: number; name: string }[]
  const out: any[] = []
  for (const s of shows) {
    if (out.length >= 12) break
    if (!seasonsOf(s.id) || !canViewSeries(user, s.id)) continue
    const eps = buildEpisodes(s.id, user.id)
    const k = currentEpisode(eps)
    if (k < 0) continue
    const e = eps[k]
    const started = !e.watched && e.position > STARTED_AT
    out.push({ seriesId: s.id, series: s.name, poster: `/api/art/${s.id}/poster`, season: e.season, label: e.label, position: started ? e.position : 0, duration: started ? e.duration : 0, ...(started ? {} : { next: true }) })
  }
  return out
}
