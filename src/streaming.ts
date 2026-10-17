import { Readable } from 'node:stream'
import { open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, now } from './db.ts'
import { config } from './config.ts'
import { qb, type QbFile } from './qb.ts'
import { fetchTorrentFile } from './btn/client.ts'
import { isVideo, parseEpisodeTag } from './btn/parse.ts'
import { assertSpace } from './health.ts'
import { SUBFILE } from './transcode.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Release { size: number | null; is_pack: number; torrent_id: number; info_hash: string; torrent_link: string; series: string; group_name: string }
export const getRelease = (id: number) => db.prepare('SELECT * FROM releases WHERE torrent_id = ?').get(id) as Release | undefined

const adding = new Map<number, Promise<void>>()

/** Make sure the torrent is in the engine (re-adding it if a previous copy was already cleaned up). */
async function ensureAdded(rel: Release) {
  const hash = rel.info_hash
  if (await qb.info(hash)) {
    await qb.resume(hash).catch(() => {})
  } else {
    assertSpace(Number(rel.size ?? 0))
    const file = await fetchTorrentFile(rel.torrent_link)
    await qb.add(file, join(config.downloadDir, hash))
  }
  // wait for metadata (files list)
  const deadline = Date.now() + 60_000
  for (;;) {
    const files = await qb.files(hash).catch(() => [] as QbFile[])
    if (files.length) break
    if (Date.now() > deadline) throw new Error('Timed out waiting for torrent metadata from the tracker')
    await sleep(400)
  }
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (?,?, 'active', ?)
    ON CONFLICT(torrent_id) DO UPDATE SET state='active', removed_at=NULL, remove_reason=NULL`).run(rel.torrent_id, hash, now())
}

export function pickVideo(files: QbFile[]): QbFile | undefined {
  return files.filter((f) => isVideo(f.name)).sort((a, b) => b.size - a.size)[0]
}

const byName = (a: QbFile, b: QbFile) => a.name.localeCompare(b.name, undefined, { numeric: true })

/** In a season pack: the requested episode (by its S01E02 tag), else the first video this user has not finished (so "Play" resumes the season). */
function pickFromPack(files: QbFile[], userId: number, torrentId: number, label?: string): QbFile | undefined {
  const vids = files.filter((f) => isVideo(f.name)).sort(byName)
  if (label) {
    const want = parseEpisodeTag(label)
    const hit = vids.find((f) => { const t = parseEpisodeTag(f.name.split('/').pop()!); return want && t && t.season === want.season && want.episode >= t.episode && want.episode <= t.episodeEnd })
      ?? vids.find((f) => f.name.toUpperCase().includes(label.toUpperCase()))
    if (hit) return hit
  }
  const done = new Set((db.prepare('SELECT file_index FROM interests WHERE user_id = ? AND torrent_id = ? AND watched_at IS NOT NULL').all(userId, torrentId) as any[]).map((r) => r.file_index))
  return vids.find((f) => !done.has(f.index)) ?? vids[0]
}

/** Start (or join) a download for a user and return the file to play. */
export async function startPlayback(userId: number, torrentId: number, fileIndex?: number, opts: { episodeLabel?: string } = {}) {
  const rel = getRelease(torrentId)
  if (!rel) throw new Error('Unknown release')
  let p = adding.get(torrentId)
  if (!p) { p = ensureAdded(rel).finally(() => adding.delete(torrentId)); adding.set(torrentId, p) }
  await p

  const files = await qb.files(rel.info_hash)
  const file = fileIndex !== undefined ? files.find((f) => f.index === fileIndex) : rel.is_pack ? pickFromPack(files, userId, torrentId, opts.episodeLabel) : pickVideo(files)
  if (!file) throw new Error('No playable video file in this torrent')

  if (rel.is_pack) {
    // A season pack is downloaded whole, in order, whether or not anyone watches every episode: BTN's seeding rule
    // applies to the complete torrent, and a half-downloaded pack can't be seeded. The requested episode goes first
    // (max priority), the episodes after it next (high), then the earlier ones and the extras (normal).
    const vids = files.filter((f) => isVideo(f.name)).sort(byName)
    const at = vids.findIndex((f) => f.index === file.index)
    const after = new Set(vids.slice(at + 1).map((f) => f.index))
    const rank = (f: QbFile) => (f.index === file.index ? 7 : after.has(f.index) ? 6 : 1)
    for (const prio of [7, 6, 1]) {
      const ids = files.filter((f) => rank(f) === prio && f.priority !== prio && f.progress < 1).map((f) => f.index)
      await qb.filePrio(rel.info_hash, ids, prio)
    }
  } else {
    // A single episode: fetch only what somebody asked to watch (a torrent can hold extras).
    const wanted = new Set(
      (db.prepare('SELECT file_index FROM interests WHERE torrent_id = ? AND watched_at IS NULL AND released_at IS NULL').all(torrentId) as any[]).map((r) => r.file_index),
    )
    wanted.add(file.index)
    for (const f of files) if (SUBFILE.test(f.name)) wanted.add(f.index) // tiny, and the player offers them as subtitles
    const toEnable = files.filter((f) => wanted.has(f.index) && f.priority === 0).map((f) => f.index)
    const toSkip = files.filter((f) => !wanted.has(f.index) && f.priority !== 0 && f.progress === 0).map((f) => f.index)
    await qb.filePrio(rel.info_hash, toSkip, 0)
    await qb.filePrio(rel.info_hash, toEnable, 1)
    await qb.filePrio(rel.info_hash, [file.index], 7)
  }

  const t = now()
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, file_name, created_at, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, torrent_id, file_index) DO UPDATE SET updated_at=excluded.updated_at, released_at=NULL`)
    .run(userId, torrentId, file.index, file.name, t, t)
  const row = db.prepare('SELECT position, watched_at FROM interests WHERE user_id=? AND torrent_id=? AND file_index=?').get(userId, torrentId, file.index) as any
  return { torrentId, fileIndex: file.index, name: file.name, size: file.size, position: row?.watched_at ? 0 : row?.position ?? 0 }
}

// ---- piece-aware reading -------------------------------------------------

interface Layout { files: QbFile[]; offsets: Map<number, number>; pieceSize: number; savePath: string; at: number }
const layouts = new Map<string, Layout>()
const pieceCache = new Map<string, { at: number; states: number[] }>()

async function layoutFor(hash: string): Promise<Layout> {
  const l = layouts.get(hash)
  if (l && Date.now() - l.at < 5000) return l
  const [files, props] = await Promise.all([qb.files(hash), qb.properties(hash)])
  const offsets = new Map<number, number>()
  let off = 0
  for (const f of [...files].sort((a, b) => a.index - b.index)) { offsets.set(f.index, off); off += f.size }
  const nl = { files, offsets, pieceSize: props.piece_size, savePath: props.save_path, at: Date.now() }
  layouts.set(hash, nl)
  return nl
}

async function pieces(hash: string): Promise<number[]> {
  const c = pieceCache.get(hash)
  if (c && Date.now() - c.at < 600) return c.states
  const states = await qb.pieceStates(hash)
  pieceCache.set(hash, { at: Date.now(), states })
  return states
}

export class StreamTimeout extends Error {}

/** Resolve once every piece covering bytes [start,end] of the file has been downloaded and verified (state 2). */
async function waitForBytes(hash: string, fileIndex: number, start: number, end: number, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const l = await layoutFor(hash)
    const f = l.files.find((x) => x.index === fileIndex)
    if (!f) throw new Error('file vanished')
    if (f.progress >= 1) return
    const base = l.offsets.get(fileIndex)!
    const first = Math.floor((base + start) / l.pieceSize)
    const last = Math.floor((base + end) / l.pieceSize)
    const states = await pieces(hash)
    let ok = true
    for (let i = first; i <= last; i++) if (states[i] !== 2) { ok = false; break }
    if (ok) return
    if (Date.now() > deadline) throw new StreamTimeout('Timed out waiting for data (no seeders?)')
    await sleep(350)
  }
}

export async function fileInfo(torrentId: number, fileIndex: number) {
  const rel = getRelease(torrentId)
  if (!rel) return null
  const l = await layoutFor(rel.info_hash).catch(() => null)
  const f = l?.files.find((x) => x.index === fileIndex)
  return f && l ? { rel, file: f, layout: l } : null
}

/** Readable over [start,end] that blocks (without busy-reading zeros) until the needed pieces exist. */
export function readRange(hash: string, savePathHint: string, f: QbFile, start: number, end: number, signal: AbortSignal): Readable {
  const CHUNK = 1 << 20
  async function* gen() {
    const path = join(savePathHint, f.name)
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      let pos = start
      while (pos <= end) {
        const stop = Math.min(pos + CHUNK - 1, end)
        await waitForBytes(hash, f.index, pos, stop, signal, 5 * 60_000)
        if (!fh) {
          for (let i = 0; i < 50 && !existsSync(path); i++) await sleep(200)
          fh = await open(path, 'r')
        }
        const buf = Buffer.allocUnsafe(stop - pos + 1)
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
        if (bytesRead === 0) throw new Error('unexpected EOF')
        yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
        pos += bytesRead
      }
    } finally { await fh?.close() }
  }
  return Readable.from(gen(), { objectMode: false })
}

/** Progress of the first few MB (for a "buffering" indicator) plus swarm stats. */
export async function bufferStatus(torrentId: number, fileIndex: number) {
  const fi = await fileInfo(torrentId, fileIndex)
  if (!fi) return null
  const { rel, file, layout } = fi
  const t = await qb.info(rel.info_hash)
  const headBytes = Math.min(file.size, 8 << 20)
  const base = layout.offsets.get(fileIndex)!
  const states = await pieces(rel.info_hash)
  const a = Math.floor(base / layout.pieceSize), b = Math.floor((base + headBytes - 1) / layout.pieceSize)
  let have = 0
  for (let i = a; i <= b; i++) if (states[i] === 2) have++
  return {
    bufferedPct: file.progress >= 1 ? 100 : Math.round((have / (b - a + 1)) * 100),
    fileProgress: file.progress, dlspeed: t?.dlspeed ?? 0, seeds: t?.num_seeds ?? 0, peers: t?.num_leechs ?? 0, state: t?.state ?? 'unknown',
  }
}
