import { db } from './db.ts'
import { buildEpisodes } from './episodes.ts'

/**
 * The shows a person has watched all the way through, which are then kept out of the discovery rows.
 *
 * Two tests, because one is not enough:
 *
 *  - on disk: every episode the show has right now has been watched (`buildEpisodes`).
 *  - gone: every episode this person was ever given for the show was watched or released, and no download for that show is
 *    still active. The episodes table is populated from what is on disk, so `buildEpisodes` returns nothing for a show
 *    whose download has been deleted -- it cannot see the show at all. That is why a show used to come back under
 *    Recommended the moment it was cleaned up: the evidence of having watched it was deleted along with the files. The
 *    interests rows outlive the download, so they are the record that survives.
 *
 * A show with an episode this person has neither watched nor released is not finished by either test: something left
 * half-seen is still worth recommending.
 */
export function finishedShows(userId: number): Set<number> {
  const out = new Set<number>()

  // Still on disk: every episode it has, watched.
  const onDisk = db.prepare(`SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id
    WHERE i.user_id = ? AND i.watched_at IS NOT NULL AND r.series_id IS NOT NULL`).all(userId) as { id: number }[]
  for (const r of onDisk) {
    const eps = buildEpisodes(r.id, userId)
    if (eps.length && eps.every((e) => e.watched)) out.add(r.id)
  }

  // Gone: nothing left to watch, nothing left on disk. This is the half that survives a delete.
  const gone = db.prepare(`SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id
    WHERE i.user_id = ? AND i.watched_at IS NOT NULL AND r.series_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM downloads d WHERE d.torrent_id = i.torrent_id AND d.state = 'active')
      AND NOT EXISTS (SELECT 1 FROM interests i2 JOIN releases r2 ON r2.torrent_id = i2.torrent_id
        WHERE i2.user_id = i.user_id AND r2.series_id = r.series_id
          AND i2.watched_at IS NULL AND i2.released_at IS NULL)`).all(userId) as { id: number }[]
  for (const r of gone) out.add(r.id)

  return out
}

/** How long a finished show stays back on the home screen for something new in it, if the person does not watch it. */
export const RETURN_DAYS = 30

/**
 * Finished shows with something new in them: a release that is further along than anything this person watched (a later
 * episode, or a new season) and that was uploaded after the last episode they watched. These come back out of
 * finishedShows: they are shown again, with a "New episode" badge, instead of staying hidden for good.
 *
 * "Further along", not just "newer", so a fresh copy of an episode already seen -- a re-encode, a 4K upload, a complete-
 * season pack of the season they watched -- does not bring a show back. A new episode that nobody seeds or that BTN no
 * longer serves does not either: the show would open onto nothing to play.
 *
 * It lasts RETURN_DAYS from the newest such release. Watching the new episode makes the show finished again on its own
 * (the last watch is then after it), and starting it puts it in Continue watching like anything else.
 *
 * Returns series id -> time of the newest new release.
 */
export function returningShows(userId: number, finished = finishedShows(userId), at = Math.floor(Date.now() / 1000)): Map<number, number> {
  const out = new Map<number, number>()
  if (!finished.size) return out
  // Where the person got to in each show, as season * 10000 + episode. A pack file that could not be matched to an
  // episode counts as the whole season.
  const reached = new Map((db.prepare(`
    SELECT r.series_id AS id, COALESCE(MAX(i.watched_at), MAX(i.released_at)) AS last,
      MAX(COALESCE(pf.season, r.season) * 10000 + COALESCE(pf.episode_end, pf.episode,
        CASE WHEN r.is_pack = 0 THEN COALESCE(r.episode_end, r.episode) END, 9999)) AS pos
    FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id
    LEFT JOIN pack_files pf ON pf.torrent_id = i.torrent_id AND pf.idx = i.file_index
    WHERE i.user_id = ? AND r.series_id IS NOT NULL AND (i.watched_at IS NOT NULL OR i.released_at IS NOT NULL)
      AND COALESCE(pf.season, r.season) IS NOT NULL
    GROUP BY r.series_id`).all(userId) as { id: number; last: number; pos: number }[]).map((r) => [r.id, r]))
  for (const id of finished) {
    const seen = reached.get(id)
    if (!seen) continue
    // A pack of the season they were in (S*10000) is behind any episode of it they watched; a later season's is ahead.
    const newest = newerReleases(id, seen.pos, seen.last, at - RETURN_DAYS * 86400).reduce((m, r) => Math.max(m, r.time), 0)
    if (newest) out.set(id, newest)
  }
  return out
}

/**
 * Where a release sits in its show, as one number: season * 10000 + episode, and a season pack counts as the START of its
 * season, so it is behind any episode of that season already watched. NULL for a release with no season.
 */
export const RELEASE_POS = `COALESCE(r.season, 0) * 10000 + CASE WHEN r.is_pack = 0 THEN COALESCE(r.episode_end, r.episode, 0) ELSE 0 END`

/**
 * The releases of a show that are FURTHER ALONG than `pos` and were uploaded to BTN after `since` (and after `floor`, if
 * given), and that could actually be played: not dead, still seeded.
 *
 * This is the one definition of "there is something new in this show" in Flix -- what brings a finished show back to the
 * home screen (returningShows above) and what brings a deleted show out of hiding (hidden.ts). "Further along", not just
 * "newer", so a re-encode or a complete-season pack of what was already there is not news. A release's own `fetched_at` is
 * NOT used: a catalog sync refreshes it on rows Flix already had, which would make every sync look like news.
 */
export function newerReleases(seriesId: number, pos: number, since: number, floor = 0): { pos: number; time: number }[] {
  const rows = db.prepare(`SELECT ${RELEASE_POS} AS pos, r.time AS time FROM releases r
    WHERE r.series_id = ? AND r.season IS NOT NULL AND r.time > ? AND r.time > ?
      AND r.dead_at IS NULL AND COALESCE(r.seeders, 0) > 0`).all(seriesId, since, floor) as { pos: number; time: number }[]
  return rows.filter((r) => r.pos > pos)
}
