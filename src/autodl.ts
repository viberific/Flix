import { db, now } from './db.ts'
import { config } from './config.ts'
import { diskInfo, freeFloor } from './health.ts'
import { qb } from './qb.ts'
import { buildEpisodes, type Episode } from './episodes.ts'
import { getRelease, startPlayback } from './streaming.ts'

/**
 * Nothing downloads because somebody looked at a show: a download starts only when an episode is tapped. The one thing
 * Flix lines up on its own after that is the NEXT episode of a show someone is watching, once they are past 60% of the
 * current one (or the current one has finished downloading) -- relevant for shows fetched as single episodes, since a
 * season pack is already coming whole. Always one whole episode file, never part of one.
 * A download has to seed 130 h (or 1:1) before it may be deleted, so this stays small: a few episodes per person, nothing below
 * 25% free disk, and one nobody opens lapses in a week. Something a person pressed play on is never held back by any of this.
 */

/** How far into an episode counts as "they are watching this": past this the next one is lined up on disk. */
export const NEXT_EPISODE_AT = 0.6

const autoCutoff = () => now() - config.auto.expireDays * 86400

/** Disk one episode needs: its own file inside a season pack (only that file is fetched), else the whole release. */
function episodeBytes(rel: { torrent_id: number; size: number | null; is_pack: number }, ep: Pick<Episode, 'season' | 'episode'>): number {
  if (rel.is_pack && ep.episode !== null) {
    const f = db.prepare('SELECT size FROM pack_files WHERE torrent_id = ? AND season IS ? AND episode = ?').get(rel.torrent_id, ep.season, ep.episode) as { size: number } | undefined
    if (f) return f.size
  }
  return Number(rel.size ?? 0)
}

/** Why an automatic download of this size may not start right now, or null when it may. */
export function autoBlocked(userId: number, needBytes: number): string | null {
  if (!config.auto.enabled) return 'automatic downloads are off'
  const d = diskInfo()
  if (d && (d.free / d.total) * 100 < config.auto.pausePct) return 'storage is getting low'
  if (d && d.free - needBytes < freeFloor(d)) return 'it would not leave enough free space'
  const mine = (db.prepare(`SELECT COUNT(*) AS n FROM interests WHERE user_id = ? AND auto = 1 AND watched_at IS NULL AND released_at IS NULL AND updated_at > ?`).get(userId, autoCutoff()) as any).n as number
  if (mine >= config.auto.perUser) return 'this person already has enough lined up'
  return null
}

const recent = new Map<string, number>()

/** Start fetching one episode for a person ahead of time. True when it was started (or was already on its way). Never throws. */
export async function autoFetch(userId: number, ep: Pick<Episode, 'torrentId' | 'label' | 'isPack' | 'episode' | 'season'>, why: string): Promise<boolean> {
  try {
    if (!config.auto.enabled) return false
    const key = `${userId}:${ep.torrentId}:${ep.label}`
    if ((recent.get(key) ?? 0) > Date.now() - 600_000) return true
    const rel = getRelease(ep.torrentId)
    if (!rel) return false
    if (rel.is_pack && ep.episode === null) return false // never a whole season: only a single, named episode is fetched ahead of time
    const onServer = !!db.prepare(`SELECT 1 FROM downloads WHERE torrent_id = ? AND state = 'active'`).get(ep.torrentId)
    if (!onServer) {
      const no = autoBlocked(userId, episodeBytes(rel, ep))
      if (no) { console.log(`[auto] not fetching ${rel.group_name} (${why}): ${no}`); return false }
    }
    recent.set(key, Date.now())
    await startPlayback(userId, ep.torrentId, undefined, { episodeLabel: ep.isPack && ep.episode === null ? undefined : ep.label, auto: true })
    console.log(`[auto] fetching ${rel.group_name} (${why})`)
    return true
  } catch (e: any) {
    if (e.message !== 'already finished') console.log(`[auto] skipped: ${e.message}`)
    return false
  }
}

/** After a person is partway through an episode: line up the one after it. */
export async function autoNext(userId: number, seriesId: number, season: number | null, label: string, why = 'next episode') {
  const eps = buildEpisodes(seriesId, userId)
  const i = eps.findIndex((e) => e.season === season && e.label === label)
  const next = i < 0 ? undefined : eps.slice(i + 1).find((e) => e.available)
  return next ? autoFetch(userId, next, why) : false
}

/** Every few minutes: whoever is partway through an episode that has now finished downloading gets the next one lined up. */
export async function autoNextWhenComplete() {
  const rows = db.prepare(`SELECT i.user_id, i.file_index, r.torrent_id, r.info_hash, r.series_id, r.season, r.label, r.is_pack, i.file_name FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id
    WHERE i.watched_at IS NULL AND i.released_at IS NULL AND i.auto = 0 AND i.duration > 0 AND i.position >= i.duration * ${NEXT_EPISODE_AT} AND i.updated_at > ?`).all(now() - 900) as any[]
  for (const r of rows) {
    const files = await qb.files(r.info_hash).catch(() => [])
    if (!files.find((f) => f.index === r.file_index && f.progress >= 1)) continue
    const label = r.is_pack ? /S\d+E\d+/i.exec(r.file_name ?? '')?.[0]?.toUpperCase() : r.label
    if (label) await autoNext(r.user_id, r.series_id, r.season, label, 'next episode, current one is downloaded')
  }
}

export function startAutoDownloads() {
  const every = (ms: number, fn: () => Promise<unknown>) => setInterval(() => void fn().catch((e) => console.warn(`[auto] ${e.message}`)), ms).unref()
  every(5 * 60_000, autoNextWhenComplete)
}
