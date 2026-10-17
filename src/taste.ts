import { db } from './db.ts'

export interface Taste {
  /** Shows the person gave a thumbs down: kept out of the discovery rows. */
  hidden: Set<number>
  /** Genres they lean towards (positive) or away from (negative). */
  genres: Map<string, number>
  /** The show they most recently gave a thumbs up, if any. */
  lastLiked: number | null
  /** How much a show suits them, -1 to 1: 0 when nothing is known about its genres. */
  fit: (genres: string[]) => number
}

/**
 * What a person seems to like, from their thumbs (strongest) plus what they finished or put on their list (a gentle nudge).
 * A thumbs down also counts against the show's genres, a little less than a thumbs up counts for them.
 */
export function tasteOf(userId: number, genresOfSeries: (id: number) => string[]): Taste {
  const genres = new Map<string, number>()
  const add = (id: number, w: number) => { for (const g of genresOfSeries(id)) genres.set(g, (genres.get(g) ?? 0) + w) }
  const votes = db.prepare('SELECT series_id, vote FROM votes WHERE user_id = ? ORDER BY voted_at DESC').all(userId) as { series_id: number; vote: number }[]
  for (const v of votes) add(v.series_id, v.vote > 0 ? 1 : -0.8)
  const done = db.prepare('SELECT DISTINCT r.series_id AS id FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE i.user_id = ? AND i.watched_at IS NOT NULL').all(userId) as { id: number }[]
  const voted = new Set(votes.map((v) => v.series_id))
  for (const d of done) if (!voted.has(d.id)) add(d.id, 0.3)
  for (const l of db.prepare('SELECT series_id FROM my_list WHERE user_id = ?').all(userId) as { series_id: number }[]) if (!voted.has(l.series_id)) add(l.series_id, 0.4)
  return {
    hidden: new Set(votes.filter((v) => v.vote < 0).map((v) => v.series_id)),
    genres,
    lastLiked: votes.find((v) => v.vote > 0)?.series_id ?? null,
    fit: (gs) => (gs.length ? Math.tanh(gs.reduce((s, g) => s + (genres.get(g) ?? 0), 0) / (1.5 * gs.length)) : 0),
  }
}

/**
 * Newest first, but taste can move a show up or down inside the freshest few. `sorted` is already newest-first; a show's place in
 * it counts for twice what its fit does, so something much older never overtakes something new just for suiting the viewer.
 */
export function tasteSort<T extends { id: number; genres: string[] }>(sorted: T[], t: Taste | undefined, window = 30): T[] {
  if (!t || !t.genres.size) return sorted
  const head = sorted.slice(0, window)
  const score = new Map(head.map((r, i) => [r.id, (1 - i / head.length) + 0.5 * t.fit(r.genres)]))
  return [...head].sort((a, b) => score.get(b.id)! - score.get(a.id)!).concat(sorted.slice(window))
}
