import { config } from './config.ts'

/**
 * The Torrents page's finished-seeding view, grouped the way the disk fills up: a show, then its seasons, then the
 * episodes inside them.
 *
 * Why grouping and not a folder tree: Flix is not a file manager, and torrents are not files. What is on disk is a set of
 * torrents -- a season pack is one torrent holding twelve episodes, a single episode is one torrent holding one, and a
 * two-part episode is one torrent holding two. A tree of folders would be a second, made-up copy of that, wrong the moment
 * anything is added or removed. Grouping rows reads the truth instead: one row per show, its seasons under it, each
 * torrent under its season, with only torrents that have met BTN's seeding goal anywhere in it.
 *
 * The deleting rules are here too, in one place the route and the page both use:
 *  - a torrent left the seeding goal short is never in the view at all, so it can never be picked;
 *  - a season or a show is only offered for removal when every torrent under it has finished seeding, and its removal
 *    names what is still seeding instead;
 *  - nothing is ever deleted silently: the route refuses the whole group when any member fails.
 */

/** The numbers retention.ts reports for one torrent, against what BTN asks. */
export interface SeedNumbers { ratio: number; hours: number; ratioMet: boolean; hoursMet: boolean; met: boolean }

/** Where one torrent stands against BTN's seeding goal, in the words shown under it. */
export function seedNote(s: SeedNumbers, c: { minHours: number; minRatio: number } = config.seed): string {
  if (s.met) return 'Seeding goal met'
  const parts: string[] = []
  if (!s.hoursMet) parts.push(`${Math.max(0, c.minHours - s.hours).toFixed(0)} h more seeding`)
  if (!s.ratioMet) parts.push(`ratio ${s.ratio.toFixed(2)} of ${c.minRatio}:1`)
  return parts.join(' or ') || 'Seeding goal met'
}

/** One row of GET /api/admin/downloads: what the page is handed for a torrent, and what the grouping reads. */
export interface FinishedRow {
  torrent_id: number
  series_id: number | null
  series: string
  season: number | null
  episode: number | null
  episode_end?: number | null
  is_pack?: number | boolean | null
  label?: string | null
  state: string
  missing?: boolean
  left?: number | null
  size?: number | null
  poster?: string | null
  seedMet?: boolean
  ratio?: number
  seedHours?: number
  notWatched?: string[]
}

export interface FinishedItem {
  torrentId: number
  label: string
  size: number
  ratio: number
  seedHours: number
  /** Who in the house has not finished it yet. Deleting it means they have to download it again if they do. */
  heldFor: string[]
}

export interface StillItem { torrentId: number; label: string; note: string }

export interface FinishedSeason {
  season: number | null
  items: FinishedItem[]
  /** Torrents in this season that have not met the seeding goal: the reason a season cannot be removed as one. */
  still: StillItem[]
  size: number
  /** True when every torrent in this season has finished seeding, and there is at least one. */
  finished: boolean
}

export interface FinishedShow {
  seriesId: number | null
  series: string
  poster: string | null
  seasons: FinishedSeason[]
  /** Torrents of this show, in any season, that have not met the seeding goal. */
  still: StillItem[]
  size: number
  /** How many episodes (torrents) are finished, and how many the show has in the engine at all. */
  episodes: number
  held: string[]
  finished: boolean
}

/** A torrent is finished when the engine says it holds the whole thing and BTN's seeding goal is met on it. */
export function isFinished(r: FinishedRow): boolean {
  return r.state === 'active' && !r.missing && (r.left ?? 0) === 0 && !!r.seedMet
}

/** "S02E05", "S02E05E06" for a two-part file, "Season 2" for a pack, and the release's own label when it has neither. */
export function episodeLabel(r: Pick<FinishedRow, 'season' | 'episode' | 'episode_end' | 'is_pack' | 'label' | 'series'>): string {
  const two = (n: number) => String(n).padStart(2, '0')
  if (r.season != null && (r.is_pack || r.episode == null)) return `Season ${r.season} (whole season)`
  if (r.season != null && r.episode != null) {
    const end = r.episode_end ?? r.episode
    return `S${two(r.season)}E${two(r.episode)}${end > r.episode ? `E${two(end)}` : ''}`
  }
  return r.label || (r.is_pack ? 'Whole show' : 'Episode')
}

/** The seeding numbers for a row that only carries a ratio and an hour count. */
function numbers(r: FinishedRow): SeedNumbers {
  const ratio = r.ratio ?? 0, hours = r.seedHours ?? 0
  const ratioMet = ratio >= config.seed.minRatio, hoursMet = hours >= config.seed.minHours
  return { ratio, hours, ratioMet, hoursMet, met: !!r.seedMet || (config.seed.mode === 'all' ? ratioMet && hoursMet : ratioMet || hoursMet) }
}

function stillItem(r: FinishedRow): StillItem {
  return { torrentId: r.torrent_id, label: episodeLabel(r), note: (r.left ?? 0) > 0 ? 'still downloading' : seedNote(numbers(r)) }
}

const seasonOrder = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0)

/**
 * The shows whose torrents have finished seeding, each with its seasons and their episodes. Only finished torrents are in
 * `seasons[].items`, so nothing in this view can be picked to delete and then refused for still seeding. A show is listed
 * when at least one of its torrents is finished; the ones that are not are counted in `still`, which is what stops its
 * season or its show being removed as a whole.
 */
export function groupFinished(rows: FinishedRow[]): FinishedShow[] {
  const byShow = new Map<string, { seriesId: number | null; series: string; poster: string | null; seasons: Map<number | null, FinishedRow[]> }>()
  for (const r of rows) {
    if (r.state !== 'active' || r.missing) continue
    const key = r.series_id != null ? `id:${r.series_id}` : `name:${r.series}`
    const show = byShow.get(key) ?? byShow.set(key, { seriesId: r.series_id ?? null, series: r.series, poster: r.poster ?? null, seasons: new Map() }).get(key)!
    if (!show.poster && r.poster) show.poster = r.poster
    const list = show.seasons.get(r.season ?? null) ?? show.seasons.set(r.season ?? null, []).get(r.season ?? null)!
    list.push(r)
  }

  const out: FinishedShow[] = []
  for (const show of byShow.values()) {
    const seasons: FinishedSeason[] = []
    const showStill: StillItem[] = []
    const held = new Set<string>()
    let showSize = 0, episodes = 0
    for (const [season, list] of [...show.seasons.entries()].sort((a, b) => seasonOrder(a[0], b[0]))) {
      const items: FinishedItem[] = []
      const still: StillItem[] = []
      let size = 0
      for (const r of list) {
        if (isFinished(r)) {
          items.push({ torrentId: r.torrent_id, label: episodeLabel(r), size: r.size ?? 0, ratio: r.ratio ?? 0, seedHours: r.seedHours ?? 0, heldFor: r.notWatched ?? [] })
          size += r.size ?? 0
          for (const n of r.notWatched ?? []) held.add(n)
        } else {
          const s = stillItem(r)
          still.push(s)
          showStill.push(s)
        }
      }
      if (!items.length) continue // a season with nothing finished has nothing to show: only what is still seeding, listed above
      items.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      seasons.push({ season, items, still, size, finished: still.length === 0 })
      showSize += size
      episodes += items.length
    }
    if (!episodes) continue // nothing of this show has finished seeding: it belongs to the "still seeding" list, not here
    out.push({ seriesId: show.seriesId, series: show.series, poster: show.poster, seasons, still: showStill, size: showSize, episodes, held: [...held].sort(), finished: showStill.length === 0 })
  }
  return out.sort((a, b) => a.series.localeCompare(b.series))
}

export interface GroupTarget { seriesId: number | null; season?: number | null }

export interface GroupPlan {
  ok: boolean
  /** Every torrent the removal would take, when it is allowed. */
  torrentIds: number[]
  still: StillItem[]
  /** The line shown when it is refused: exactly what is still seeding, so it is never a bare "no". */
  why: string
}

/**
 * Whether a whole show, or one season of one, can be removed. Allowed only when every torrent under it is on disk and
 * past BTN's seeding goal: one still seeding refuses the group, and says which. The route applies the same rule, so a
 * request made by hand cannot get past it either.
 */
export function groupDeletePlan(rows: FinishedRow[], target: GroupTarget): GroupPlan {
  const members = rows.filter((r) => r.state === 'active' && !r.missing && r.series_id === target.seriesId
    && (target.season == null || r.season === target.season))
  if (!members.length) return { ok: false, torrentIds: [], still: [], why: 'Flix is not holding anything for this show' }
  const still = members.filter((r) => !isFinished(r)).map(stillItem)
  if (still.length) {
    const what = target.season == null ? 'this show' : `Season ${target.season}`
    return { ok: false, torrentIds: [], still, why: `${what} cannot be removed as one: still seeding ${still.map((s) => `${s.label} (${s.note})`).join(', ')}` }
  }
  return { ok: true, torrentIds: members.map((r) => r.torrent_id), still: [], why: '' }
}
