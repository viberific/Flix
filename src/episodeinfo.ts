import { db, now } from './db.ts'
import { config } from './config.ts'
import { seasonsOf } from './seasons.ts'

export interface EpInfo { name: string | null; overview: string | null; still: string | null; runtime: number | null }

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'Flix/0.1', accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
const plain = (html?: string | null) => (html ? html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim() : null) || null

type Row = { season: number; episode: number } & EpInfo

async function fromTmdb(tvdbId: number, seasons: number[]): Promise<{ id: number | null; rows: Row[] }> {
  const { apiKey, apiUrl } = config.tmdb
  if (!apiKey) return { id: null, rows: [] }
  const key = `api_key=${encodeURIComponent(apiKey)}`
  const id = (await getJson(`${apiUrl}/find/${tvdbId}?external_source=tvdb_id&${key}`)).tv_results?.[0]?.id
  if (!id) return { id: null, rows: [] }
  const out: Row[] = []
  for (const season of seasons) {
    const s = await getJson(`${apiUrl}/tv/${id}/season/${season}?${key}`).catch(() => null)
    for (const e of s?.episodes ?? []) {
      out.push({ season, episode: e.episode_number, name: e.name || null, overview: e.overview || null, runtime: e.runtime || null,
        still: e.still_path ? `${config.art.tmdbImages}/w500${e.still_path}` : null })
    }
  }
  return { id, rows: out }
}

/** TMDB's other pictures for one episode (an episode can have images but no "main" still). Null when it has none. */
async function tmdbEpisodeImage(tmdbId: number, season: number, episode: number): Promise<string | null> {
  const { apiKey, apiUrl } = config.tmdb
  const r = await getJson(`${apiUrl}/tv/${tmdbId}/season/${season}/episode/${episode}/images?api_key=${encodeURIComponent(apiKey)}`).catch(() => null)
  const best = (r?.stills ?? [])[0]
  return best?.file_path ? `${config.art.tmdbImages}/w500${best.file_path}` : null
}

async function fromTvmaze(tvdbId: number | null, name: string): Promise<Row[]> {
  const base = config.art.tvmazeUrl
  if (!base) return []
  let show = tvdbId ? await getJson(`${base}/lookup/shows?thetvdb=${tvdbId}`).catch(() => null) : null
  show ??= await getJson(`${base}/singlesearch/shows?q=${encodeURIComponent(name)}`).catch(() => null)
  if (!show?.id) return []
  const eps = await getJson(`${base}/shows/${show.id}/episodes`)
  return (Array.isArray(eps) ? eps : []).filter((e: any) => e.season && e.number).map((e: any) => ({
    season: e.season, episode: e.number, name: e.name || null, overview: plain(e.summary), runtime: e.runtime || null,
    still: typeof (e.image?.original ?? e.image?.medium) === 'string' ? (e.image.original ?? e.image.medium).replace(/^http:\/\/static\.tvmaze\.com/, 'https://static.tvmaze.com') : null,
  }))
}

const failedAt = new Map<number, number>()
const pending = new Map<number, Promise<void>>()

/** Titles, summaries and stills for the seasons that are listed. TMDB when keyed, otherwise TVmaze (no key). Refreshed monthly. */
export function queueEpisodeInfo(seriesId: number): Promise<void> {
  const have = db.prepare('SELECT fetched_at FROM episode_info_sync WHERE series_id = ?').get(seriesId) as any
  // Monthly, or every 3 days while some episode still has no picture (new episodes get theirs a little after they air).
  const gaps = (db.prepare('SELECT COUNT(*) AS n FROM episode_info WHERE series_id = ? AND still IS NULL').get(seriesId) as any).n
  if (have && have.fetched_at > now() - (gaps ? 3 : 30) * 86400) return Promise.resolve()
  if ((failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return Promise.resolve()
  const running = pending.get(seriesId)
  if (running) return running
  const p = (async () => {
    try {
      const seasons = [...(seasonsOf(seriesId)?.keys() ?? [])]
      const t = db.prepare('SELECT series, tvdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
      if (!t || !seasons.length) return
      const tm = t.tvdb_id ? await fromTmdb(t.tvdb_id, seasons).catch((e) => { console.warn(`[episodes] TMDB for series ${seriesId}: ${e.message}`); return { id: null, rows: [] as Row[] } }) : { id: null, rows: [] as Row[] }
      let rows = tm.rows
      // Pictures are patched from further sources, in turn: TVmaze's, then TMDB's other images for the episode. What is still missing falls back to the show's artwork at display time.
      if (!rows.length || rows.some((r) => !r.still)) {
        const tv = await fromTvmaze(t.tvdb_id ?? null, t.series).catch((e) => { console.warn(`[episodes] TVmaze for series ${seriesId}: ${e.message}`); return [] as Row[] })
        const by = new Map(rows.map((r) => [`${r.season}|${r.episode}`, r]))
        for (const x of tv) {
          const have = by.get(`${x.season}|${x.episode}`)
          if (!have) { rows.push(x); continue }
          have.still ??= x.still; have.name ??= x.name; have.overview ??= x.overview; have.runtime ??= x.runtime
        }
      }
      if (tm.id) for (const r of rows.filter((x) => !x.still).slice(0, 40)) r.still = await tmdbEpisodeImage(tm.id, r.season, r.episode)
      db.exec('BEGIN')
      try {
        const ins = db.prepare('INSERT OR REPLACE INTO episode_info VALUES (?,?,?,?,?,?,?)')
        for (const r of rows) ins.run(seriesId, r.season, r.episode, r.name, r.overview, r.still, r.runtime)
        // An empty answer is remembered for a day only, so a show TMDB/TVmaze simply lacks is not asked about on every visit.
        db.prepare('INSERT OR REPLACE INTO episode_info_sync VALUES (?,?)').run(seriesId, rows.length ? now() : now() - 29 * 86400)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    } catch (e: any) { failedAt.set(seriesId, Date.now()); console.warn(`[episodes] series ${seriesId}: ${e.message}`) }
    finally { pending.delete(seriesId) }
  })()
  pending.set(seriesId, p)
  return p
}

/** What we know about each episode of a show, keyed "season|episode". */
export function episodeInfoFor(seriesId: number): Map<string, EpInfo> {
  const m = new Map<string, EpInfo>()
  for (const r of db.prepare('SELECT season, episode, name, overview, still, runtime FROM episode_info WHERE series_id = ?').all(seriesId) as any[])
    m.set(`${r.season}|${r.episode}`, { name: r.name, overview: r.overview, still: r.still, runtime: r.runtime })
  return m
}
