import { db } from './db.ts'
import { catalogVersion } from './seasons.ts'
import { copyOnly } from './settings.ts'
import type { Cand } from './pick.ts'

export interface Row extends Cand { season: number | null; episode: number | null; episode_end: number | null; label: string; is_pack: number }

/** Every release we know for a show, with whether we already hold it on disk. */
export function candidatesFor(seriesId: number): Row[] {
  const rows = db.prepare(`SELECT r.torrent_id, r.season, r.episode, r.episode_end, r.label, r.is_pack, r.resolution, r.codec, r.seeders, r.size,
      EXISTS(SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') AS on_server
    FROM releases r WHERE r.series_id = ?`).all(seriesId) as any[]
  return rows.map((r) => ({ ...r, on_server: !!r.on_server }))
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
    WHERE NOT EXISTS (SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active')
    GROUP BY r.series_id
    HAVING SUM(CASE WHEN r.codec LIKE '%264%' OR r.codec LIKE '%avc%' THEN
      CASE WHEN r.resolution IS NULL OR (r.resolution NOT LIKE '%2160%' AND r.resolution NOT LIKE '%4k%') THEN 1 ELSE 0 END
    ELSE 0 END) = 0`).all() as { id: number }[]
  const ids = new Set(rows.map((r) => r.id))
  hiddenCache = { v, ids }
  return ids
}
