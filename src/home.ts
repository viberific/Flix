import { STREAMERS, primaryGenre, type NetRow } from './networks.ts'

export interface HomeRow { id: number; name: string; poster: string | null; banner: string | null; genres: string[]; latest: number; rating?: string; [k: string]: unknown }
export interface Section { title: string; series: HomeRow[] }

/** Every discovery row holds exactly this many shows: a row that cannot be filled to it is left out. */
export const ROW_SIZE = 10
/** Genre rows after the service rows; the most fully-stocked ones win. */
const MAX_GENRE_ROWS = 8

const byAir = (net: Map<number, NetRow>) => (a: HomeRow, b: HomeRow) =>
  (net.get(b.id)?.first_air ?? '').localeCompare(net.get(a.id)?.first_air ?? '') || b.latest - a.latest

/**
 * The home screen's discovery rows. Only shows on HBO, Crave, Showcase, Netflix, Disney+ or Apple TV+ are on it (everything
 * else is still in the library and search). From the top: the featured show, Trending, then the newest from each service in
 * turn, then the rest under the single genre each fits best. Every row has exactly ROW_SIZE shows.
 *
 * A show is shown once on the screen (`taken` holds the ones already shown higher up, such as My List) for as long as there are
 * enough others to fill a row. When a service has only a few, its row is topped up with shows already shown elsewhere rather than
 * left short; a row that still cannot reach ROW_SIZE is dropped.
 */
export function curateHome(rows: HomeRow[], net: Map<number, NetRow>, taken: Set<number> = new Set()): { hero: HomeRow | null; sections: Section[] } {
  const used = new Set(taken)
  const eligible = rows.filter((r) => net.get(r.id)?.streamer)
  const newest = byAir(net)
  const popular = (a: HomeRow, b: HomeRow) => (net.get(b.id)?.popularity ?? 0) - (net.get(a.id)?.popularity ?? 0)

  const trending = eligible.filter((r) => net.get(r.id)?.trending != null).sort((a, b) => net.get(a.id)!.trending! - net.get(b.id)!.trending!)

  // The billboard: the top trending show, else the newest from a service. It is not repeated in a row below.
  const hero = [trending, [...eligible].sort(newest)].flat().find((r) => !used.has(r.id) && r.poster) ?? null
  if (hero) used.add(hero.id)

  const sections: Section[] = []
  /**
   * A row of ROW_SIZE: shows not shown yet first (`primary` in order, then `fallback`), then shows already shown, until it is full.
   * Nothing is marked as shown unless the row is made. `repeats: false` refuses to reuse a show at all.
   */
  const row = (title: string, primary: HomeRow[], fallback: HomeRow[] = [], repeats = true) => {
    const all = [...new Map([...primary, ...fallback].map((r) => [r.id, r])).values()]
    const fresh = all.filter((r) => !used.has(r.id))
    const picked = [...fresh, ...(repeats ? all.filter((r) => used.has(r.id)) : [])].slice(0, ROW_SIZE)
    if (picked.length < ROW_SIZE) return
    picked.forEach((r) => used.add(r.id))
    sections.push({ title, series: picked })
  }

  row('Trending shows', trending, [...eligible].sort(popular))
  for (const s of STREAMERS) row(`New on ${s}`, eligible.filter((r) => net.get(r.id)?.streamer === s).sort(newest))

  const groups = new Map<string, HomeRow[]>()
  for (const r of eligible) { const g = primaryGenre(r.genres); if (g) (groups.get(g) ?? groups.set(g, []).get(g)!).push(r) }
  const unseen = (l: HomeRow[]) => l.filter((r) => !used.has(r.id)).length
  const genres = [...groups.entries()].filter(([, l]) => unseen(l) >= ROW_SIZE).sort((a, b) => unseen(b[1]) - unseen(a[1])).slice(0, MAX_GENRE_ROWS)
  for (const [g, l] of genres) row(g, l.sort(newest), [], false)
  return { hero, sections }
}
