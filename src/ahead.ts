import { db } from './db.ts'
import { qb } from './qb.ts'
import { engineFiles } from './wanted.ts'

/**
 * Getting the NEXT episode of a season pack started before the current one ends.
 *
 * Timing this by percentage was wrong for a pack: 60% of the playback position says nothing about how much of the file
 * is on disk, and it is the download that is slow (a 6.25 GB episode at 443 KB/s is nearly four hours). So the trigger is
 * TIME the current file can already cover: once enough of it is downloaded to play for 20 minutes, or it is complete,
 * the next episode's file is enabled inside the same torrent. Only that one file -- the rest of the pack stays skipped,
 * and the current file keeps its priority, so the next one only takes bandwidth the watched episode is not using.
 *
 * The bitrate comes from the file itself (size / duration), so it holds whatever the episode, and a shorter episode
 * (3.2 GB) reaches the same 20 minutes of cover sooner than a longer one (6.25 GB) instead of both waiting for the same
 * percentage. Duration is whatever is already known: the player's own reported length, the credits marker, or the
 * episode's runtime from the show's metadata. When no length is known, the file has to be complete.
 */
// Was 40 minutes (about 93% of a normal episode): the next one arrived only after the current one was nearly all here.
// 20 minutes is roughly half an episode, so the next file starts with real time in hand. Raise it for a faster current
// episode, lower it for a warmer next one.
const COVER_SEC = 20 * 60

/** How long the file being watched is, in seconds, from the cheapest source that has it. */
function durationOf(torrentId: number, fileIndex: number): number | null {
  const i = db.prepare('SELECT duration FROM interests WHERE torrent_id = ? AND file_index = ? AND duration > 0 ORDER BY duration DESC LIMIT 1').get(torrentId, fileIndex) as { duration: number } | undefined
  if (i?.duration) return i.duration
  const c = db.prepare('SELECT duration FROM credits_marker WHERE torrent_id = ? AND file_index = ? AND duration > 0').get(torrentId, fileIndex) as { duration: number } | undefined
  if (c?.duration) return c.duration
  const r = db.prepare('SELECT series_id, season, episode FROM releases WHERE torrent_id = ?').get(torrentId) as { series_id: number; season: number | null; episode: number | null } | undefined
  if (!r || r.season === null || r.episode === null) return null
  const e = db.prepare('SELECT runtime FROM episode_info WHERE series_id = ? AND season = ? AND episode = ?').get(r.series_id, r.season, r.episode) as { runtime: number | null } | undefined
  return e?.runtime ? e.runtime * 60 : null
}

/** The episode after this file inside the same pack, in playing order. */
function fileAfter(torrentId: number, fileIndex: number): { idx: number; season: number; episode: number } | null {
  const cur = db.prepare('SELECT season, episode FROM pack_files WHERE torrent_id = ? AND idx = ?').get(torrentId, fileIndex) as { season: number | null; episode: number | null } | undefined
  if (!cur || cur.season === null || cur.episode === null) return null
  const rows = db.prepare(`SELECT idx, season, episode FROM pack_files WHERE torrent_id = ? AND season IS NOT NULL AND episode IS NOT NULL AND idx != ?
    ORDER BY season, episode`).all(torrentId, fileIndex) as { idx: number; season: number; episode: number }[]
  return rows.find((r) => r.season > cur.season! || (r.season === cur.season && r.episode > cur.episode!)) ?? null
}

const recent = new Map<string, number>()

/**
 * Bytes that cover COVER_SEC of playback in a file of `size` bytes and `duration` seconds: bitrate is size/duration, so
 * the share needed is COVER_SEC/duration. A short episode needs fewer bytes than a long one, which is the whole reason
 * this is not a percentage. Unknown length means the whole file.
 */
export function coverBytes(size: number, duration: number | null): number {
  if (!duration || duration <= 0) return size
  return size * Math.min(1, COVER_SEC / duration)
}

/**
 * Called while an episode is playing (the player's status poll). Fires and forgets: the player never waits on it, and a
 * failure here must not touch playback. Safe to call as often as you like -- it does one engine read and, at most once
 * per minute per file, one priority change.
 */
export async function enableNextFile(torrentId: number, fileIndex: number): Promise<void> {
  const rel = db.prepare('SELECT info_hash, is_pack FROM releases WHERE torrent_id = ?').get(torrentId) as { info_hash: string; is_pack: number } | undefined
  if (!rel?.is_pack) return
  const next = fileAfter(torrentId, fileIndex)
  if (!next) return // the last episode of the pack: nothing to line up
  const files = await engineFiles(rel.info_hash)
  const cur = files.find((f) => f.index === fileIndex)
  const nf = files.find((f) => f.index === next.idx)
  if (!cur || !nf) return
  if (nf.priority > 0 || nf.progress >= 1) return // already lined up (or already here): nothing to do
  const dur = durationOf(torrentId, fileIndex)
  const need = coverBytes(cur.size, dur)
  if (cur.progress < 1 && cur.size * cur.progress < need) return
  const key = `${torrentId}:${next.idx}`
  if (Date.now() - (recent.get(key) ?? 0) < 60_000) return
  recent.set(key, Date.now())
  if (recent.size > 500) recent.delete(recent.keys().next().value!)
  // A lower priority than the file being watched, which startPlayback holds at 7: this one waits its turn in the queue
  // instead of competing with the episode somebody is actually watching. Only this file -- never the rest of the pack.
  await qb.filePrio(rel.info_hash, [next.idx], 1)
}
