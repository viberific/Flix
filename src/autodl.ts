import { db, now } from './db.ts'
import { config } from './config.ts'
import { diskInfo, freeFloor } from './health.ts'
import { qb } from './qb.ts'
import { buildEpisodes, type Episode } from './episodes.ts'
import { getRelease, startPlayback } from './streaming.ts'
import { canView, getRating, parseAllowed } from './ratings.ts'
import { seasonsOf } from './seasons.ts'

/**
 * Downloads Flix starts before anyone presses play, so a show does not buffer for ages:
 *   - the next episode, once the current one is watched past 60% (or fully downloaded);
 *   - the first unwatched episode of a show added to My List;
 *   - a new episode, for someone who is caught up on that show.
 * They are conservative on purpose: a download has to seed 130 h (or 1:1) before it may be deleted, so a wasted one holds the disk
 * for days. Limits: a few per person, a total size, no big season packs, nothing below 25% free disk, and one nobody opens lapses in a week.
 * Something a person pressed play on is never held back by any of this.
 */

/** How far into an episode counts as "they are watching this": past this the next one is lined up on disk. */
export const NEXT_EPISODE_AT = 0.6

const autoCutoff = () => now() - config.auto.expireDays * 86400
const mb = (n: number) => `${Math.round(n / 1e6)} MB`

/** Why an automatic download of this size may not start right now, or null when it may. */
export function autoBlocked(userId: number, needBytes: number): string | null {
  if (!config.auto.enabled) return 'automatic downloads are off'
  const d = diskInfo()
  if (d && (d.free / d.total) * 100 < config.auto.pausePct) return 'storage is getting low'
  if (d && d.free - needBytes < freeFloor(d)) return 'it would not leave enough free space'
  const mine = (db.prepare(`SELECT COUNT(*) AS n FROM interests WHERE user_id = ? AND auto = 1 AND watched_at IS NULL AND released_at IS NULL AND updated_at > ?`).get(userId, autoCutoff()) as any).n as number
  if (mine >= config.auto.perUser) return 'this person already has enough lined up'
  const held = (db.prepare(`SELECT COALESCE(SUM(r.size), 0) AS s FROM releases r WHERE r.torrent_id IN (
      SELECT torrent_id FROM interests WHERE auto = 1 AND watched_at IS NULL AND released_at IS NULL AND updated_at > ?
        AND torrent_id NOT IN (SELECT torrent_id FROM interests WHERE auto = 0 AND watched_at IS NULL AND released_at IS NULL))
      AND EXISTS (SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active')`).get(autoCutoff()) as any).s as number
  if (held + needBytes > config.auto.maxGb * 1e9) return 'the pre-download budget is used up'
  return null
}

const recent = new Map<string, number>()

/** Start fetching one episode for a person ahead of time. True when it was started (or was already on its way). Never throws. */
export async function autoFetch(userId: number, ep: Pick<Episode, 'torrentId' | 'label' | 'isPack' | 'episode'>, why: string): Promise<boolean> {
  try {
    if (!config.auto.enabled) return false
    const key = `${userId}:${ep.torrentId}:${ep.label}`
    if ((recent.get(key) ?? 0) > Date.now() - 600_000) return true
    const rel = getRelease(ep.torrentId)
    if (!rel) return false
    const onServer = !!db.prepare(`SELECT 1 FROM downloads WHERE torrent_id = ? AND state = 'active'`).get(ep.torrentId)
    if (!onServer) {
      const size = Number(rel.size ?? 0)
      if (rel.is_pack && size > config.auto.packMaxGb * 1e9) { console.log(`[auto] not fetching ${rel.group_name} (${why}): a ${mb(size)} season pack is too big to fetch unasked`); return false }
      const no = autoBlocked(userId, size)
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

/**
 * A person opened a show they are partway through: the episode they would resume is the one they are about to play, so get it started
 * now, before they tap Play. Only for a show with real progress, and under all the usual limits of an ahead-of-time fetch.
 */
export async function autoWarm(userId: number, eps: Episode[]) {
  const started = eps.some((e) => e.watched || e.position > 30)
  if (!started) return false
  const target = eps.find((e) => !e.watched && e.position > 30 && e.available) ?? eps.slice(eps.map((e) => e.watched).lastIndexOf(true) + 1).find((e) => e.available && !e.watched)
  return target && (!target.onServer || target.isPack) ? autoFetch(userId, target, 'opened the show') : false
}

/** A show just added to My List: its first unwatched episode, unless that means a big season pack. */
export async function autoForListed(userId: number, seriesId: number) {
  if (!seasonsOf(seriesId)) return false
  const next = buildEpisodes(seriesId, userId).find((e) => e.available && !e.watched)
  return next ? autoFetch(userId, next, 'added to My List') : false
}

const viewer = (id: number) => {
  const u = db.prepare('SELECT id, is_admin, allowed_ratings FROM users WHERE id = ?').get(id) as any
  return u && { id: u.id, is_admin: u.is_admin, allowed: parseAllowed(u.allowed_ratings) }
}

/** Every half hour: a new episode (up in the last 3 days) for people who have watched everything before it. */
export async function autoNewEpisodes() {
  const pairs = db.prepare(`SELECT user_id, series_id FROM (
      SELECT user_id, series_id FROM my_list
      UNION SELECT i.user_id, r.series_id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.watched_at > ?) LIMIT 80`).all(now() - 60 * 86400) as { user_id: number; series_id: number }[]
  for (const p of pairs) {
    if (!seasonsOf(p.series_id)) continue
    const u = viewer(p.user_id)
    if (!u || !canView(u, getRating(p.series_id).rating)) continue
    const eps = buildEpisodes(p.series_id, p.user_id)
    const i = eps.findIndex((e) => !e.watched)
    if (i <= 0) continue // nothing watched yet (not caught up), or everything watched (nothing new)
    const e = eps[i]
    const age = (db.prepare('SELECT time FROM releases WHERE torrent_id = ?').get(e.torrentId) as any)?.time as number | undefined
    if (e.available && !e.isPack && age && age > now() - 3 * 86400) await autoFetch(p.user_id, e, 'new episode')
  }
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
  every(30 * 60_000, autoNewEpisodes)
}
