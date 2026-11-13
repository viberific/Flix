import { db } from './db.ts'
import { catalogVersion } from './seasons.ts'
import { copyOnly } from './settings.ts'
import type { Cand } from './pick.ts'

export interface Row extends Cand { season: number | null; episode: number | null; episode_end: number | null; label: string; is_pack: number }

/** Every release we know for a show, with whether we already hold it on disk. */
export function candidatesFor(seriesId: number): Row[] {
  const rows = db.prepare(`SELECT r.torrent_id, r.season, r.episode, r.episode_end, r.label, r.is_pack, r.resolution, r.codec, r.seeders, r.size, r.time, r.dead_at,
      EXISTS(SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') AS on_server
    FROM releases r WHERE r.series_id = ?`).all(seriesId) as any[]
  return rows.map((r) => ({ ...r, on_server: !!r.on_server, dead: r.dead_at ? 1 : 0 }))
}

/**
 * Shows with nothing that can play without converting. In copy-only mode a release that needs the picture
 * re-encoded is never downloaded, so such a show would be a poster that leads to a dead end: it is hidden from
 * the library, search and home instead. A show that already has bytes on disk stays visible, because those play.
 *
 * Cached until the catalog changes (one grouped scan over every release, and the rows are read on every screen;
 * against this library it is 17 shows of 589).
 */
let hiddenCache: { v: number; ids: Set<number> } | null = null
export function unplayableSeries(): Set<number> {
  if (!copyOnly()) return new Set()
  const v = catalogVersion()
  if (hiddenCache && hiddenCache.v === v) return hiddenCache.ids
  // The same rule as convertCost() in pick.ts, in SQL: H.264 at 1080p or below. 'x264-Hi10P' matches too, and
  // SQLite's LIKE ignores case, so 'avc' catches AVC.
  const rows = db.prepare(`
    SELECT r.series_id AS id FROM releases r
    GROUP BY r.series_id
    HAVING SUM(CASE WHEN EXISTS (SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') THEN 1
      WHEN r.codec LIKE '%264%' OR r.codec LIKE '%avc%' THEN
      CASE WHEN r.resolution IS NULL OR (r.resolution NOT LIKE '%2160%' AND r.resolution NOT LIKE '%4k%') THEN 1 ELSE 0 END
    ELSE 0 END) = 0`).all() as { id: number }[]
  const ids = new Set(rows.map((r) => r.id))
  hiddenCache = { v, ids }
  return ids
}

/**
 * Shows with nothing left to watch: every copy Flix knows of is one BTN no longer serves, or one nobody is seeding, and
 * none of it is on the box. Such a show is not a recommendation -- the person opens it and every episode is unavailable,
 * which is what "some shows that aren't available yet show up" means -- so it is left off the home screen's rows and off
 * Discover. See `isAlive` in pick.ts: this is that same rule, in SQL and over a whole show rather than one episode.
 *
 * Two things keep a show visible whatever its releases look like, both of them the person's own doing rather than the
 * screen's pick: a torrent of it on the box (`downloads.state = 'active'` -- downloaded, kept, seeding) is here already
 * and plays; My List and Continue watching are drawn from `my_list` and the watch history on their own, never from this
 * set, so a show they added or started stays where they put it.
 *
 * Cached until the catalog changes, like unplayableSeries(): streaming.ts bumps it when a download starts (a show becomes
 * watchable) and when a release is found dead (one stops being).
 */
let emptyCache: { v: number; ids: Set<number> } | null = null
export function unavailableSeries(): Set<number> {
  const v = catalogVersion()
  if (emptyCache && emptyCache.v === v) return emptyCache.ids
  const rows = db.prepare(`
    SELECT r.series_id AS id FROM releases r WHERE r.series_id IS NOT NULL
    GROUP BY r.series_id
    HAVING SUM(CASE
      WHEN EXISTS (SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') THEN 1
      WHEN r.dead_at IS NULL AND COALESCE(r.seeders, 0) > 0 THEN 1
      ELSE 0 END) = 0`).all() as { id: number }[]
  const ids = new Set(rows.map((r) => r.id))
  emptyCache = { v, ids }
  return ids
}
