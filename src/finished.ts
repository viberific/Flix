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
