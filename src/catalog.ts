import { db, now } from './db.ts'
import { getTorrents, type BtnTorrent } from './btn/client.ts'
import { parseGroupName } from './btn/parse.ts'

const upsert = db.prepare(`INSERT INTO releases (torrent_id, group_id, series_id, series, series_poster, series_banner, tvdb_id, imdb_id,
  group_name, release_name, season, episode, label, is_pack, resolution, codec, container, source, origin, size, seeders, time,
  info_hash, torrent_link, genres, fetched_at, youtube_trailer)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(torrent_id) DO UPDATE SET seeders=excluded.seeders, torrent_link=excluded.torrent_link, series_poster=excluded.series_poster,
    series_banner=excluded.series_banner, youtube_trailer=excluded.youtube_trailer, fetched_at=excluded.fetched_at`)

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
        JSON.stringify(x.Genres ?? []), t, youtubeUrl(x.YoutubeTrailer))
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

const searchCache = new Map<string, number>()

/** Search BTN by series name (cached 10 min to protect the API budget) and store results. */
export async function searchBtn(q: string) {
  const key = q.toLowerCase()
  if ((searchCache.get(key) ?? 0) > Date.now() - 600_000) return
  const { torrents } = await getTorrents({ series: `%${q.replace(/[%_]/g, '')}%` }, 200, 0)
  storeTorrents(torrents)
  searchCache.set(key, Date.now())
}

/** Pull every release BTN has for one series (up to 3 pages), at most once per hour. */
export async function syncSeries(seriesId: number, force = false) {
  const row = db.prepare('SELECT series FROM releases WHERE series_id = ? LIMIT 1').get(seriesId) as { series: string } | undefined
  if (!row) return
  const last = db.prepare('SELECT synced_at FROM series_sync WHERE series_id = ?').get(seriesId) as { synced_at: number } | undefined
  if (!force && last && last.synced_at > now() - 3600) return
  for (let page = 0; page < 3; page++) {
    const { torrents, total } = await getTorrents({ series: row.series }, 1000, page * 1000)
    storeTorrents(torrents.filter((t) => Number(t.SeriesID) === seriesId))
    if ((page + 1) * 1000 >= total) break
  }
  db.prepare('INSERT OR REPLACE INTO series_sync VALUES (?,?)').run(seriesId, now())
}

/** Newest uploads, so the home page has something to show. */
export async function syncLatest() {
  const { torrents } = await getTorrents({}, 100, 0)
  storeTorrents(torrents)
}
