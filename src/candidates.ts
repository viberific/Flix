import { db } from './db.ts'
import type { Cand } from './pick.ts'

export interface Row extends Cand { season: number | null; episode: number | null; episode_end: number | null; label: string; is_pack: number }

/** Every release we know for a show, with whether we already hold it on disk. */
export function candidatesFor(seriesId: number): Row[] {
  const rows = db.prepare(`SELECT r.torrent_id, r.season, r.episode, r.episode_end, r.label, r.is_pack, r.resolution, r.codec, r.seeders, r.size,
      EXISTS(SELECT 1 FROM downloads d WHERE d.torrent_id = r.torrent_id AND d.state = 'active') AS on_server
    FROM releases r WHERE r.series_id = ?`).all(seriesId) as any[]
  return rows.map((r) => ({ ...r, on_server: !!r.on_server }))
}
