import { db } from './db.ts'

/**
 * Which seasons of a show may be listed.
 *
 * - Season 1 has to be complete, or the show is not listed at all.
 * - After that only the next sequential season can follow: the first season that is missing or incomplete ends the list,
 *   so a show with seasons 1 and 3 shows season 1 only.
 * - A season is complete when it has a season pack (a pack is the whole season by definition), or when single episodes
 *   run from E01 to its last episode with nothing missing. Single episodes win over a pack when they are complete.
 */
export interface SeasonRow { season: number | null; episode: number | null; episode_end?: number | null; is_pack: number | boolean }
export type SeasonSource = 'episodes' | 'pack'

export function visibleSeasons(rows: SeasonRow[]): Map<number, SeasonSource> {
  const covered = new Map<number, Set<number>>()
  const packs = new Set<number>()
  for (const r of rows) {
    if (r.season === null || r.season < 1) continue // specials and unnumbered releases never count
    if (r.is_pack) { packs.add(r.season); continue }
    if (r.episode === null) continue // date-named releases carry no episode number, so completeness can't be judged
    const set = covered.get(r.season) ?? covered.set(r.season, new Set()).get(r.season)!
    for (let e = r.episode; e <= Math.max(r.episode, r.episode_end ?? r.episode); e++) set.add(e)
  }
  const out = new Map<number, SeasonSource>()
  for (let n = 1; ; n++) {
    const eps = covered.get(n)
    let whole = false
    if (eps?.size) { whole = true; for (let e = 1; e <= Math.max(...eps); e++) if (!eps.has(e)) { whole = false; break } }
    if (whole) out.set(n, 'episodes')
    else if (packs.has(n)) out.set(n, 'pack')
    else break
  }
  return out
}

// ---- which shows are listable -----------------------------------------------------------------

let version = 0
let cache: { v: number; map: Map<number, Map<number, SeasonSource>> } | null = null
/** Call whenever releases or sync state change, so the next listing recomputes. */
export const catalogChanged = () => { version++ }

/**
 * Every show whose catalog we have fully read (a series_sync row) and whose season 1 is complete, with its visible seasons.
 * A show we have only seen a few recent uploads of is not listed yet: its season 1 simply may not have been fetched.
 */
export function listable(): Map<number, Map<number, SeasonSource>> {
  if (cache?.v === version) return cache.map
  const by = new Map<number, SeasonRow[]>()
  for (const r of db.prepare(`SELECT series_id, season, episode, episode_end, is_pack FROM releases
      WHERE series_id IN (SELECT series_id FROM series_sync)`).all() as any[]) {
    const l = by.get(r.series_id) ?? by.set(r.series_id, []).get(r.series_id)!
    l.push(r)
  }
  const map = new Map<number, Map<number, SeasonSource>>()
  for (const [id, rows] of by) { const s = visibleSeasons(rows); if (s.has(1)) map.set(id, s) }
  cache = { v: version, map }
  return map
}

export const seasonsOf = (seriesId: number) => listable().get(seriesId)

/** How many shows still have to be read from BTN before the catalog is complete (for the "still checking" notice). */
export function unsyncedCount(): number {
  return (db.prepare('SELECT COUNT(DISTINCT series_id) AS n FROM releases WHERE series_id NOT IN (SELECT series_id FROM series_sync)').get() as any).n
}
