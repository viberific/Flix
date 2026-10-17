import { db, now } from './db.ts'
import { fetchTorrentFile } from './btn/client.ts'
import { isVideo, parseEpisodeTag } from './btn/parse.ts'
import { torrentFiles } from './btn/torrentfile.ts'
import { seasonsOf } from './seasons.ts'
import { pickRelease } from './pick.ts'
import { candidatesFor } from './candidates.ts'

export interface PackFile { idx: number; path: string; size: number; season: number; episode: number; episode_end: number }
const inflight = new Map<number, Promise<void>>()

/** Read a pack's .torrent once and remember which episode each video is. */
async function list(torrentId: number, season: number) {
  const done = db.prepare('SELECT 1 FROM pack_listed WHERE torrent_id = ?').get(torrentId)
  if (done) return
  const rel = db.prepare('SELECT torrent_link FROM releases WHERE torrent_id = ?').get(torrentId) as { torrent_link: string | null } | undefined
  if (!rel?.torrent_link) return
  const files = torrentFiles(await fetchTorrentFile(rel.torrent_link))
  const vids = files.map((f, idx) => ({ ...f, idx })).filter((f) => isVideo(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const ins = db.prepare('INSERT OR REPLACE INTO pack_files VALUES (?,?,?,?,?,?,?)')
  db.exec('BEGIN')
  try {
    // A file whose name has no episode tag is numbered by its place in the pack, so it can still be played.
    vids.forEach((f, i) => {
      const tag = parseEpisodeTag(f.path.split('/').pop()!)
      ins.run(torrentId, f.idx, f.path, f.size, tag?.season ?? season, tag?.episode ?? i + 1, tag?.episodeEnd ?? tag?.episode ?? i + 1)
    })
    db.prepare('INSERT OR REPLACE INTO pack_listed VALUES (?,?)').run(torrentId, now())
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

/** The pack the show's pack-sourced seasons play from (the best living one for that season). */
export function packFor(seriesId: number, season: number): number | undefined {
  return pickRelease(candidatesFor(seriesId).filter((r) => r.is_pack && r.season === season))?.torrent_id
}

/** Make sure every pack-sourced season of this show has its episode list. A pack that can't be read keeps showing as one "Season N" entry. */
export async function ensurePackFiles(seriesId: number): Promise<void> {
  const seasons = seasonsOf(seriesId)
  if (!seasons) return
  await Promise.all([...seasons].filter(([, src]) => src === 'pack').map(async ([season]) => {
    const id = packFor(seriesId, season)
    if (id === undefined) return
    let p = inflight.get(id)
    if (!p) { p = list(id, season).catch((e) => console.warn(`[packs] could not list torrent ${id}: ${e.message}`)).finally(() => inflight.delete(id)); inflight.set(id, p) }
    await p
  }))
}

export const packEpisodes = (torrentId: number) =>
  db.prepare('SELECT idx, path, size, season, episode, episode_end FROM pack_files WHERE torrent_id = ? ORDER BY season, episode, idx').all(torrentId) as unknown as PackFile[]
