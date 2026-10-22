import { db } from './db.ts'

/**
 * Which seasons of a show may be listed.
 *
 * - Season 1 has to be complete, or the show is not listed at all.
 * - After that only the next sequential season can follow: the first season that is missing or incomplete ends the list,
 *   so a show with seasons 1 and 3 shows season 1 only.
 * - A season is complete when it has a season pack (a pack is the whole season by definition), or when single episodes
 *   run from E01 to its last episode with nothing missing. A living pack always wins (a dead one gives way to whole singles): seasons are downloaded whole, and single
 *   episodes are only the fallback for a season that has no pack. Singles count when they reach the season's known length
 *   (`expected`, from TMDB/TVmaze): "just E01" is not a whole season. When the length is not known they count when they
 *   run unbroken from E01.
 */
export interface SeasonRow { season: number | null; episode: number | null; episode_end?: number | null; is_pack: number | boolean
  /** Whether somebody is seeding it, or we hold it. Left out = alive. */
  alive?: boolean }
export type SeasonSource = 'episodes' | 'pack'

export function visibleSeasons(rows: SeasonRow[], expected?: Map<number, number>): Map<number, SeasonSource> {
  const covered = new Map<number, Set<number>>()
  const packs = new Set<number>()
  const livePacks = new Set<number>()
  for (const r of rows) {
    if (r.season === null || r.season < 1) continue // specials and unnumbered releases never count
    if (r.is_pack) { packs.add(r.season); if (r.alive !== false) livePacks.add(r.season); continue }
    if (r.episode === null) continue // date-named releases carry no episode number, so completeness can't be judged
    const set = covered.get(r.season) ?? covered.set(r.season, new Set()).get(r.season)!
    for (let e = r.episode; e <= Math.max(r.episode, r.episode_end ?? r.episode); e++) set.add(e)
  }
  const out = new Map<number, SeasonSource>()
  for (let n = 1; ; n++) {
    const eps = covered.get(n)
    let whole = false
    if (eps?.size) {
      const last = Math.max(...eps)
      whole = true
      for (let e = 1; e <= last; e++) if (!eps.has(e)) { whole = false; break }
      const want = expected?.get(n)
      if (whole && want !== undefined) whole = last >= want
    }
    // A dead pack (nobody seeding, nothing on disk) gives way to whole single episodes; with no such singles it stays listed.
    if (livePacks.has(n)) out.set(n, 'pack')
    else if (whole) out.set(n, 'episodes')
    else if (packs.has(n)) out.set(n, 'pack')
    else break
  }
  return out
}

// ---- which shows are listable -----------------------------------------------------------------

/** Bumped whenever the network crawler learns something new about how a show is read (see networks.ts); older rows are read again. */
export const NET_VER = 3

let version = 0
let cache: { v: number; map: Map<number, Map<number, SeasonSource>> } | null = null
/** Call whenever releases, sync state or what we know about a show change, so the next listing recomputes. */
export const catalogChanged = () => { version++ }
/** The catalog's revision: anything caching an answer about releases keys on this and recomputes when it moves. */
export const catalogVersion = () => version

/** True when a show is in English: TMDB's original language, or TVmaze's. A show whose language nobody could tell is let through. */
export const isEnglish = (lang: string | null | undefined) => !lang || /^(en|english)$/i.test(lang.trim())

/** What the crawler learned per show: its language and how many episodes each season has. Absent = not read yet. */
function netFacts(): Map<number, { lang: string | null; counts: Map<number, number> }> {
  const m = new Map<number, { lang: string | null; counts: Map<number, number> }>()
  for (const r of db.prepare('SELECT series_id, lang, season_counts FROM series_net').all() as any[]) {
    const counts = new Map<number, number>()
    try { for (const [k, v] of Object.entries(JSON.parse(r.season_counts ?? '{}'))) if (Number(v) > 0) counts.set(Number(k), Number(v)) } catch { /* unknown */ }
    m.set(r.series_id, { lang: r.lang, counts })
  }
  return m
}

/**
 * Every English-language show whose catalog we have fully read (a series_sync row), whose season 1 is complete, and that
 * the network crawler has looked at (language and season lengths are needed to judge), with its visible seasons.
 * A show we have only seen a few recent uploads of is not listed yet: its season 1 simply may not have been fetched.
 */
export function listable(): Map<number, Map<number, SeasonSource>> {
  if (cache?.v === version) return cache.map
  const by = new Map<number, SeasonRow[]>()
  for (const r of db.prepare(`SELECT series_id, season, episode, episode_end, is_pack,
        (COALESCE(seeders, 0) > 0 OR EXISTS(SELECT 1 FROM downloads d WHERE d.torrent_id = releases.torrent_id AND d.state = 'active')) AS alive FROM releases
      WHERE series_id IN (SELECT series_id FROM series_sync)`).all() as any[]) {
    const l = by.get(r.series_id) ?? by.set(r.series_id, []).get(r.series_id)!
    l.push({ ...r, alive: !!r.alive })
  }
  const facts = netFacts()
  const map = new Map<number, Map<number, SeasonSource>>()
  for (const [id, rows] of by) {
    const f = facts.get(id)
    if (!f || !isEnglish(f.lang)) continue
    const s = visibleSeasons(rows, f.counts)
    if (s.has(1)) map.set(id, s)
  }
  cache = { v: version, map }
  return map
}
export const seasonsOf = (seriesId: number) => listable().get(seriesId)

/** How many shows still have to be read from BTN before the catalog is complete (for the "still checking" notice). */
export function unsyncedCount(): number {
  return (db.prepare('SELECT COUNT(DISTINCT series_id) AS n FROM releases WHERE series_id NOT IN (SELECT series_id FROM series_sync)').get() as any).n
}
