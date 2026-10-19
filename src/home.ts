import { STREAMERS, primaryGenre, isHiddenService, type NetRow } from './networks.ts'
import { tasteSort, type Taste } from './taste.ts'

export interface HomeRow { id: number; name: string; poster: string | null; banner: string | null; genres: string[]; latest: number; rating?: string; [k: string]: unknown }
export interface Section { title: string; series: HomeRow[] }

/** Every discovery row holds exactly this many shows: a row that cannot be filled to it is left out. */
export const ROW_SIZE = 10
/** Genre rows after the service rows; the most fully-stocked ones win. */
const MAX_GENRE_ROWS = 8
/** A genre row may be shorter than ROW_SIZE: genres are sparse, and a short row beats an empty page. */
const GENRE_MIN = 6
/**
 * A service row may be shorter than ROW_SIZE too, down to this: the library holds few shows on some services (Disney+, Apple
 * TV+), and a row of the four it has beats no row at all. Such a row is not topped up with repeats of what is shown above.
 */
const SERVICE_MIN = 4

const byAir = (net: Map<number, NetRow>) => (a: HomeRow, b: HomeRow) =>
  (net.get(b.id)?.first_air ?? '').localeCompare(net.get(a.id)?.first_air ?? '') || b.latest - a.latest

/**
 * The home screen's discovery rows. Only shows on HBO, Crave, Showcase, Disney+, Apple TV+ or Paramount+ are on it (everything
 * else is still in the library and search), and a show on a hidden service such as Netflix is left off it altogether. From the
 * top: the featured show, Trending, then the newest from each service in
 * turn, then the rest under the single genre each fits best. Every row has exactly ROW_SIZE shows, except a service row that the
 * library cannot fill (see SERVICE_MIN).
 *
 * A show is shown once on the screen (`taken` holds the ones already shown higher up, such as My List) for as long as there are
 * enough others to fill a row. A service with ROW_SIZE shows or more gets a full row, topped up with shows already shown
 * elsewhere; a service with fewer gets a short row of just its own shows (see SERVICE_MIN), which is dropped below that.
 */
export function curateHome(rows: HomeRow[], net: Map<number, NetRow>, taken: Set<number> = new Set(), taste?: Taste): { hero: HomeRow | null; sections: Section[] } {
  const used = new Set(taken)
  // A hidden service (Netflix) is off the screen entirely: not the billboard, not a service row, not a genre row.
  const pool = rows.filter((r) => !isHiddenService(net.get(r.id)?.streamer))
  const eligible = pool.filter((r) => net.get(r.id)?.streamer)
  const newest = byAir(net)
  const popular = (a: HomeRow, b: HomeRow) => (net.get(b.id)?.popularity ?? 0) - (net.get(a.id)?.popularity ?? 0)

  const trending = eligible.filter((r) => net.get(r.id)?.trending != null).sort((a, b) => net.get(a.id)!.trending! - net.get(b.id)!.trending!)

  // The billboard: the top trending show, else the newest from a service, else the newest show there is.
  const hero = [trending, [...eligible].sort(newest), [...pool].sort(newest)].flat().find((r) => !used.has(r.id) && r.poster) ?? null
  if (hero) used.add(hero.id)

  const sections: Section[] = []
  /**
   * A row of ROW_SIZE: shows not shown yet first (`primary` in order, then `fallback`), then shows already shown, until it is full.
   * Nothing is marked as shown unless the row is made. `repeats: false` refuses to reuse a show at all.
   */
  const row = (title: string, primary: HomeRow[], fallback: HomeRow[] = [], repeats = true, min = ROW_SIZE) => {
    const all = [...new Map([...primary, ...fallback].map((r) => [r.id, r])).values()]
    const fresh = tasteSort(all.filter((r) => !used.has(r.id)), taste)
    const picked = [...fresh, ...(repeats ? all.filter((r) => used.has(r.id)) : [])].slice(0, ROW_SIZE)
    if (picked.length < min) return
    picked.forEach((r) => used.add(r.id))
    sections.push({ title, series: picked })
  }

  row('Trending shows', trending, [...eligible].sort(popular))
  for (const s of STREAMERS) {
    const own = eligible.filter((r) => net.get(r.id)?.streamer === s).sort(newest)
    // Enough on this service for a full row: fill it as before, topping up from the same service's shows already shown above.
    // Too few: show the ones there are, short and without repeats, and only if that still makes SERVICE_MIN.
    if (own.length >= ROW_SIZE) row(`New on ${s}`, own)
    else row(`New on ${s}`, own, [], false, SERVICE_MIN)
  }

  // Genres are filled from the whole library, not just the shows whose service Flix has worked out: only 16 of 166 have
  // one, which left the home screen with a single row and a lot of empty page below it. A show on a known service still
  // comes first inside its row.
  const groups = new Map<string, HomeRow[]>()
  for (const r of pool) { const g = primaryGenre(r.genres); if (g) (groups.get(g) ?? groups.set(g, []).get(g)!).push(r) }
  const streamed = (a: HomeRow, b: HomeRow) => (Number(!!net.get(b.id)?.streamer) - Number(!!net.get(a.id)?.streamer)) || newest(a, b)
  const unseen = (l: HomeRow[]) => l.filter((r) => !used.has(r.id)).length
  const liking = (g: string) => taste?.genres.get(g) ?? 0
  const genres = [...groups.entries()].filter(([g, l]) => unseen(l) >= GENRE_MIN && liking(g) > -1).sort((a, b) => (liking(b[0]) > 0 ? 1 : 0) - (liking(a[0]) > 0 ? 1 : 0) || unseen(b[1]) - unseen(a[1])).slice(0, MAX_GENRE_ROWS)
  for (const [g, l] of genres) row(g, l.sort(streamed), [], false, GENRE_MIN)
  // Whatever is left, so the page is never a billboard over an empty screen.
  const rest = pool.filter((r) => r.poster).sort(streamed)
  row('More to watch', rest, [], false, ROW_SIZE)
  if (sections.length < 4) row('Newest additions', pool.filter((r) => r.poster).sort(newest), pool.filter((r) => r.poster).sort(newest))
  return { hero, sections }
}
