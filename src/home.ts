import { STREAMERS, primaryGenre, type NetRow } from './networks.ts'

export interface HomeRow { id: number; name: string; poster: string | null; banner: string | null; genres: string[]; latest: number; rating?: string; [k: string]: unknown }
export interface Section { title: string; series: HomeRow[] }

const byAir = (net: Map<number, NetRow>) => (a: HomeRow, b: HomeRow) =>
  (net.get(b.id)?.first_air ?? '').localeCompare(net.get(a.id)?.first_air ?? '') || b.latest - a.latest

/**
 * The home screen's discovery rows. Every show appears once, at most, across all of them (`taken` holds the ones already
 * shown higher up, such as My List): the featured show first, then Trending, then the newest from each streaming service,
 * then everything else notable under the single genre it fits best. Shows we know nothing about yet, and obscure ones, are left
 * out of the home screen (search still finds them) unless there is too little else to fill it.
 */
export function curateHome(rows: HomeRow[], net: Map<number, NetRow>, taken: Set<number> = new Set(), minCurated = 8): { hero: HomeRow | null; sections: Section[] } {
  const used = new Set(taken)
  const take = (list: HomeRow[], n: number) => { const out = list.filter((r) => !used.has(r.id)).slice(0, n); out.forEach((r) => used.add(r.id)); return out }

  const trending = rows.filter((r) => net.get(r.id)?.trending != null).sort((a, b) => net.get(a.id)!.trending! - net.get(b.id)!.trending!)
  const streamers = STREAMERS.map((s) => ({ s, list: rows.filter((r) => net.get(r.id)?.streamer === s).sort(byAir(net)) }))

  // The billboard: the top trending show, else the newest streaming original. It is not repeated in a row below.
  const hero = [trending, ...streamers.map((x) => x.list)].flat().find((r) => !used.has(r.id) && r.poster) ?? null
  if (hero) used.add(hero.id)

  const sections: Section[] = []
  const push = (title: string, list: HomeRow[]) => { if (list.length) sections.push({ title, series: list }) }
  push('Trending now', take(trending, 20))
  for (const { s, list } of streamers) push(`New on ${s}`, take(list, 20))

  const curated = rows.filter((r) => used.has(r.id) || net.get(r.id)?.trending != null || net.get(r.id)?.streamer).length
  const rest = rows.filter((r) => !used.has(r.id) && (net.get(r.id)?.notable || curated < minCurated)).sort(byAir(net))
  const groups = new Map<string, HomeRow[]>()
  for (const r of rest) { const g = primaryGenre(r.genres) ?? 'More to watch'; (groups.get(g) ?? groups.set(g, []).get(g)!).push(r) }
  const small: HomeRow[] = []
  const rowsByGenre = [...groups.entries()].filter(([, l]) => { if (l.length >= 3) return true; small.push(...l); return false })
    .sort((a, b) => b[1].length - a[1].length).slice(0, 12)
  for (const [g, l] of rowsByGenre) push(g, take(l, 30))
  push('More to watch', take(small.sort(byAir(net)), 30))
  return { hero, sections }
}
