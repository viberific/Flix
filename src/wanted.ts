import { db } from './db.ts'
import { qb } from './qb.ts'

/**
 * What a DOWNLOAD holds, as opposed to what the engine holds.
 *
 * A season pack is a 38 GB torrent with fourteen episodes in it; Flix only ever downloads the one somebody pressed play
 * on (plus the next one, enabled ahead of time). The engine then reports the torrent as 9% done and 38 GB in size, and
 * every number made from that is about the pack rather than about the 6.25 GB the person is waiting for. So the wanted
 * files are read from `interests` (one row per file somebody asked for) and the sizes and per-file progress from
 * qBittorrent's own file list. Everything the Torrents page, the storage graph and the show page say comes from here.
 */

/** One file inside a torrent, as qBittorrent reports it. */
export interface EngineFile { index: number; size: number; progress: number; priority: number; name: string }

const TTL = 4000
const cache = new Map<string, { at: number; files: EngineFile[] }>()

/**
 * The engine's file list for a torrent, cached for a few seconds: one show page asks about every episode on it, and a
 * pack is one call for all of them. An empty answer is not cached -- the engine may be starting up.
 */
export async function engineFiles(hash: string): Promise<EngineFile[]> {
  const hit = cache.get(hash)
  if (hit && Date.now() - hit.at < TTL) return hit.files
  const files = ((await qb.files(hash).catch(() => [])) as EngineFile[]).map((f) => ({ index: f.index, size: f.size, progress: f.progress, priority: f.priority, name: f.name }))
  if (files.length) {
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
    cache.set(hash, { at: Date.now(), files })
  }
  return files
}

/** The files anybody has asked for on this torrent -- the episodes somebody pressed play on, or Flix fetched for them. */
export function wantedIndexes(torrentId: number): number[] {
  const rows = db.prepare('SELECT DISTINCT file_index AS i FROM interests WHERE torrent_id = ?').all(torrentId) as { i: number }[]
  return rows.map((r) => r.i)
}

export interface Wanted {
  /** Bytes of the files somebody asked for -- not the torrent's total_size. */
  wanted: number
  /** How much of that is on disk now. */
  held: number
  /** held / wanted, 0..1. */
  progress: number
  /** wanted - held, in bytes. */
  left: number
  files: number[]
}

/**
 * What this download is for, in bytes. Null when the engine cannot say (torrent not in it, or the engine is down): the
 * caller then keeps the engine's own numbers rather than showing a zero.
 */
export async function wantedBytes(torrentId: number): Promise<Wanted | null> {
  const rel = db.prepare('SELECT info_hash, is_pack FROM releases WHERE torrent_id = ?').get(torrentId) as { info_hash: string; is_pack: number } | undefined
  if (!rel) return null
  // A single-file release needs nothing done to it: the torrent's own size and progress ARE its file's, so the caller's
  // numbers are already right and there is no reason to ask the engine for a file list.
  if (!rel.is_pack) return null
  const files = await engineFiles(rel.info_hash)
  if (!files.length) return null
  const want = wantedIndexes(torrentId)
  // Files somebody asked for. Before the first interest is written (a pack added but not yet played, an adopted torrent)
  // the files the engine has enabled are the ones Flix selected, so those stand in.
  const asked = files.filter((f) => want.includes(f.index))
  const list = asked.length ? asked : files.filter((f) => f.priority > 0)
  if (!list.length) return null
  const wanted = list.reduce((n, f) => n + f.size, 0)
  const held = list.reduce((n, f) => n + f.size * Math.min(1, Math.max(0, f.progress)), 0)
  return { wanted, held, progress: wanted ? Math.min(1, held / wanted) : 0, left: Math.max(0, wanted - held), files: list.map((f) => f.index) }
}

/** A single file's own progress, or null when the engine does not have the torrent. */
export async function fileProgress(torrentId: number, fileIndex: number): Promise<number | null> {
  const rel = db.prepare('SELECT info_hash FROM releases WHERE torrent_id = ?').get(torrentId) as { info_hash: string } | undefined
  if (!rel) return null
  const f = (await engineFiles(rel.info_hash)).find((x) => x.index === fileIndex)
  return f ? Math.min(1, Math.max(0, f.progress)) : null
}

/** One episode's place in a pack, before its file state is filled in. */
export interface EpisodeFile { torrentId: number; isPack: boolean; fileIndex: number | null }

/**
 * Fill in, for every episode, whether ITS OWN file is on disk in full -- ready to watch -- how far it has got, and
 * whether the pack holds it at all without anybody having asked for it. A release that merely exists in the engine (or
 * a pack whose download has only just started) is not ready to watch, and saying so is the whole point.
 */
export async function withFileProgress<T extends EpisodeFile & { onServer: boolean }>(eps: T[]): Promise<(T & { fileProgress: number | null; inPack: boolean })[]> {
  const relOf = db.prepare('SELECT info_hash, is_pack FROM releases WHERE torrent_id = ?')
  const rels = new Map<number, { info_hash: string; is_pack: number }>()
  for (const id of new Set(eps.map((e) => e.torrentId))) {
    const r = relOf.get(id) as { info_hash: string; is_pack: number } | undefined
    if (r) rels.set(id, r)
  }
  // One call for every single-file release on the page: for those the torrent's own progress IS the file's.
  const all = await qb.listAll().catch(() => [] as { hash: string; progress: number }[])
  const whole = new Map(all.map((t) => [String(t.hash).toLowerCase(), Number(t.progress ?? 0)]))
  const out: (T & { fileProgress: number | null; inPack: boolean })[] = []
  for (const e of eps) {
    const rel = rels.get(e.torrentId)
    if (!rel) { out.push({ ...e, fileProgress: null, inPack: false }); continue }
    if (!rel.is_pack) {
      const p = whole.get(rel.info_hash.toLowerCase())
      out.push({ ...e, fileProgress: p === undefined ? 0 : p, onServer: p !== undefined && p >= 0.999, inPack: false })
      continue
    }
    if (e.fileIndex === null) { out.push({ ...e, fileProgress: null, inPack: false }); continue } // a pack that could not be listed: leave as it was
    const files = await engineFiles(rel.info_hash)
    const f = files.find((x) => x.index === e.fileIndex)
    if (!f) { out.push({ ...e, fileProgress: files.length ? 0 : null, onServer: false, inPack: files.length > 0 }); continue }
    out.push({ ...e, fileProgress: f.progress, onServer: f.progress >= 0.999, inPack: f.priority <= 0 && f.progress < 0.999 })
  }
  return out
}
