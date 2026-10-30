import { db, now } from './db.ts'
import { RateLimitError, btnBudgetLeft, getTorrents, type BtnTorrent } from './btn/client.ts'
import { parseGroupName } from './btn/parse.ts'
import { queueRating } from './ratings.ts'
import { catalogChanged } from './seasons.ts'

const upsert = db.prepare(`INSERT INTO releases (torrent_id, group_id, series_id, series, series_poster, series_banner, tvdb_id, imdb_id,
  group_name, release_name, season, episode, label, is_pack, resolution, codec, container, source, origin, size, seeders, time,
  info_hash, torrent_link, genres, fetched_at, youtube_trailer, episode_end, leechers)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(torrent_id) DO UPDATE SET seeders=excluded.seeders, leechers=excluded.leechers, torrent_link=excluded.torrent_link, series_poster=excluded.series_poster,
    series_banner=excluded.series_banner, youtube_trailer=excluded.youtube_trailer, fetched_at=excluded.fetched_at, episode_end=excluded.episode_end`)

/** BTN gives either a bare video id or a URL; only ever keep a youtube.com watch link we build ourselves. */
export function youtubeUrl(v?: string | null): string | null {
  if (!v) return null
  const m = /^[\w-]{11}$/.exec(v) ?? /(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(v)
  return m ? `https://www.youtube.com/watch?v=${m[1] ?? m[0]}` : null
}

const int = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v))

export function storeTorrents(list: BtnTorrent[]) {
  const t = now()
  db.exec('BEGIN')
  try {
    for (const x of list) {
      if (!x.InfoHash || !x.TorrentID || !x.Series) continue
      const p = parseGroupName(x.GroupName, x.Category)
      upsert.run(int(x.TorrentID), int(x.GroupID), int(x.SeriesID), x.Series, x.SeriesPoster ?? null, x.SeriesBanner ?? null,
        int(x.TvdbID), x.ImdbID ?? null, x.GroupName, x.ReleaseName ?? null, p.season, p.episode, p.label, p.isPack ? 1 : 0,
        x.Resolution ?? null, x.Codec ?? null, x.Container ?? null, x.Source ?? null, x.Origin ?? null,
        int(x.Size), int(x.Seeders), int(x.Time), x.InfoHash.toLowerCase(), x.TorrentLink ?? null,
        JSON.stringify(x.Genres ?? []), t, youtubeUrl(x.YoutubeTrailer), p.episodeEnd, int(x.Leechers))
    }
    db.exec('COMMIT')
    catalogChanged()
    for (const id of new Set(list.map((x) => Number(x.SeriesID)).filter(Boolean))) queueRating(id)
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

/**
 * BTN's string filters are SQL LIKE and apply no wildcards of their own: `{series: 'Firefly'}`
 * matches nothing, `{series: '%Firefly%'}` matches. Wrap the term, and escape a wildcard the
 * name itself contains (LIKE escapes a literal % or _ with a backslash) so it stays literal.
 */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

// When each term was last searched, and whether BTN's answer held every match (fewer than the 200 asked for).
const searchCache = new Map<string, { at: number; complete: boolean }>()

/**
 * Search BTN by series name (cached 10 min to protect the API budget) and store results. Typing "breaking" would
 * otherwise spend a call on every prefix: once a shorter term came back complete, everything a longer one could
 * match is already stored, so it is not asked again.
 */
export async function searchBtn(q: string) {
  const key = q.toLowerCase(), fresh = Date.now() - 600_000
  for (const [k, c] of searchCache) {
    if (c.at <= fresh) searchCache.delete(k)
    else if (k === key || (c.complete && key.includes(k))) return
  }
  const { torrents, total } = await getTorrents({ series: like(q) }, 200, 0)
  storeTorrents(torrents)
  searchCache.set(key, { at: Date.now(), complete: total <= torrents.length })
}

/**
 * Pull every release BTN has for one series, at most once per hour. A show is only listed once this has run
 * (until then we may have seen a few recent uploads but not its first season).
 */
export async function syncSeries(seriesId: number, force = false) {
  const row = db.prepare('SELECT series FROM releases WHERE series_id = ? LIMIT 1').get(seriesId) as { series: string } | undefined
  if (!row) return
  const last = db.prepare('SELECT synced_at FROM series_sync WHERE series_id = ?').get(seriesId) as { synced_at: number } | undefined
  if (!force && last && last.synced_at > now() - 3600) return
  for (let page = 0; page < 6; page++) {
    const { torrents, total } = await getTorrents({ series: like(row.series) }, 1000, page * 1000)
    storeTorrents(torrents.filter((t) => Number(t.SeriesID) === seriesId))
    if ((page + 1) * 1000 >= total) break
  }
  db.prepare('INSERT OR REPLACE INTO series_sync VALUES (?,?)').run(seriesId, now())
  catalogChanged()
}

/** API calls the background crawl leaves free for searches and show pages. */
const RESERVE = 30
let crawling = false
const crawlFailed = new Map<number, number>()

/** Read the next show we have not fully fetched yet (newest first), or refresh the stalest one. Never dips into the reserve. */
export async function crawlOnce(): Promise<boolean> {
  if (crawling || btnBudgetLeft() <= RESERVE) return false
  crawling = true
  try {
    const skip = (id: number) => (crawlFailed.get(id) ?? 0) > Date.now() - 30 * 60_000
    const next = (db.prepare(`SELECT r.series_id AS id FROM releases r LEFT JOIN series_sync s ON s.series_id = r.series_id
        WHERE s.series_id IS NULL GROUP BY r.series_id ORDER BY MAX(r.time) DESC LIMIT 25`).all() as { id: number }[]).find((r) => !skip(r.id))
      ?? (db.prepare(`SELECT series_id AS id FROM series_sync WHERE synced_at < ? ORDER BY synced_at LIMIT 25`).all(now() - 12 * 3600) as { id: number }[]).find((r) => !skip(r.id))
    if (!next) return false
    try { await syncSeries(next.id, true) } catch (e: any) { crawlFailed.set(next.id, Date.now()); throw e }
    return true
  } catch (e: any) {
    if (!(e instanceof RateLimitError)) console.warn(`[crawl] ${e.message}`)
    return false
  } finally { crawling = false }
}

/** Keep reading shows from BTN in the background, one at a time, so the library fills in without anyone opening each show. */
export function startCrawler(everyMs = 20_000) {
  const t = setInterval(() => void crawlOnce(), everyMs)
  t.unref()
  return t
}

/** Newest uploads, so the home page has something to show. */
export async function syncLatest() {
  for (let page = 0; page < 3; page++) {
    const { torrents, total } = await getTorrents({}, 100, page * 100)
    storeTorrents(torrents)
    if ((page + 1) * 100 >= total) break
  }
}
