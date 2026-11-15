import { db, now } from './db.ts'
import { RELEASE_POS, newerReleases } from './finished.ts'
import { catalogVersion } from './seasons.ts'
import { unplayableSeries } from './candidates.ts'

/**
 * Shows the admin deleted on purpose, and when they come back.
 *
 * DELETE SHOW removes the downloads, but every screen in Flix is built from `releases`, and the release rows stay (they are
 * the catalog, and BTN's next sync puts them straight back if they are purged). So a show the admin deleted kept its cards
 * on the home screen, in search and on Discover -- confirmed on the box at 0.3.116: four packs marked removed, forty-eight
 * releases still listed. Nothing recorded that the person wanted the show gone.
 *
 * A row here is that record. It hides the show everywhere (server.ts folds it into hidden(), which isListed() uses) until
 * something new turns up in it, which is what the person asked for in their own words: "Hidden everywhere until new
 * episodes are available. And then it shows in the show's area, not in the queue."
 *
 * "New" is not invented here: newerReleases() in finished.ts is the one test, the same one that brings a finished show back
 * with a "New episode" badge. Further along than what the box had when it was hidden, and uploaded to BTN after that.
 *
 * The watch history is never touched. `interests` outlives the download, and it is what ticks the episodes already seen and
 * says where to resume once the show is back (see buildEpisodes in episodes.ts).
 *
 * It is one row per show for the whole box, not per person: Delete show is an admin action on shared disk, and hiding it
 * for one person would leave the cards there for everyone else. Adding it to My List or starting a download unhides it.
 */
export interface HiddenRow { series_id: number; series: string | null; hidden_at: number; hidden_by: number | null; pos: number; max_time: number }

// Which shows are hidden is asked for on every card of every row (isListed calls hidden()), so it is worked out once per
// catalog and per change of this table, like unplayableSeries() in candidates.ts. A sync bumps the catalog version, which is
// exactly when a new episode could have arrived.
let stamp = 0
let cache: { v: string; ids: Set<number> } | null = null
let merged: { a: Set<number>; b: Set<number>; ids: Set<number> } | null = null

function rows(): HiddenRow[] {
  return db.prepare(`SELECT h.series_id, h.hidden_at, h.hidden_by, h.pos, h.max_time,
      (SELECT r.series FROM releases r WHERE r.series_id = h.series_id ORDER BY r.time DESC LIMIT 1) AS series
    FROM hidden_series h`).all() as unknown as HiddenRow[]
}

/** True once the show has something that was not there when it was hidden: a later episode or season, uploaded since. */
const hasNew = (h: HiddenRow) => newerReleases(h.series_id, h.pos, h.hidden_at).length > 0

/** The shows still hidden: a row, unless something new has arrived in it, which brings it back on its own. */
export function hiddenSeries(): Set<number> {
  const v = `${catalogVersion()}:${stamp}`
  if (cache && cache.v === v) return cache.ids
  const ids = new Set<number>()
  for (const h of rows()) if (!hasNew(h)) ids.add(h.series_id)
  cache = { v, ids }
  return ids
}

/**
 * Every show the listings leave out, which is what isListed() in server.ts asks: one with nothing that plays without
 * converting (see unplayableSeries), or one the admin deleted on purpose and that has nothing new in it yet. Both halves are
 * already worked out once per catalog version, so this is one small copy, not two scans on every card.
 */
export function hiddenShows(): Set<number> {
  const a = unplayableSeries(), b = hiddenSeries()
  if (merged && merged.a === a && merged.b === b) return merged.ids
  const ids = new Set([...a, ...b])
  merged = { a, b, ids }
  return ids
}

/**
 * Hide a show, recording what the catalog held at that moment. Re-hiding a show that is already hidden re-stamps it, so a
 * second Delete show after a new episode arrived hides it again from what is there now.
 */
export function hideSeries(seriesId: number, by: number | null): void {
  const at = now()
  const had = db.prepare(`SELECT COALESCE(MAX(${RELEASE_POS}), 0) AS pos, COALESCE(MAX(r.time), 0) AS time FROM releases r WHERE r.series_id = ?`)
    .get(seriesId) as { pos: number; time: number }
  db.prepare(`INSERT INTO hidden_series (series_id, hidden_at, hidden_by, pos, max_time) VALUES (?,?,?,?,?)
    ON CONFLICT(series_id) DO UPDATE SET hidden_at = excluded.hidden_at, hidden_by = excluded.hidden_by, pos = excluded.pos, max_time = excluded.max_time`)
    .run(seriesId, at, by, had.pos, had.time)
  stamp++
}

/** Show it again, now. Used by Restore, by adding it to My List, and by starting a download of it. */
export function unhideSeries(seriesId: number): boolean {
  const r = db.prepare('DELETE FROM hidden_series WHERE series_id = ?').run(seriesId)
  stamp++
  return r.changes > 0
}

/**
 * What Settings lists under "Hidden shows": only the ones still hidden. A row whose new episode has already brought the
 * show back is left in the table rather than deleted from a getter -- it is harmless, it is not listed, and the next Delete
 * show on that series re-stamps it.
 */
export function hiddenList(): { seriesId: number; series: string; hiddenAt: number }[] {
  return rows()
    .filter((h) => !hasNew(h))
    .map((h) => ({ seriesId: h.series_id, series: h.series ?? `Show ${h.series_id}`, hiddenAt: h.hidden_at }))
}
