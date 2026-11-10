import { Readable } from 'node:stream'
import { open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, now } from './db.ts'
import { config } from './config.ts'
import { convertCost, pickRelease } from './pick.ts'
import { copyOnly } from './settings.ts'
import { qb, type QbFile } from './qb.ts'
import { DeadTorrentLinkError, fetchTorrentFile } from './btn/client.ts'
import { isVideo, parseEpisodeTag } from './btn/parse.ts'
import { assertSpace } from './health.ts'
import { SUBFILE } from './transcode.ts'
import { diag, hitch } from './diag.ts'
import { catalogChanged } from './seasons.ts'
import { candidatesFor } from './candidates.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Release { size: number | null; is_pack: number; torrent_id: number; info_hash: string; torrent_link: string; series: string; group_name: string
  series_id: number | null; season: number | null; episode: number | null; label: string | null; release_name: string | null }
export const getRelease = (id: number) => db.prepare('SELECT * FROM releases WHERE torrent_id = ?').get(id) as Release | undefined

const adding = new Map<number, Promise<void>>()

/** Make sure the torrent is in the engine (re-adding it if a previous copy was already cleaned up). */
async function ensureAdded(rel: Release, origin: 'flix' | 'auto' = 'flix', needBytes = Number(rel.size ?? 0)) {
  const hash = rel.info_hash
  let from: 'flix' | 'auto' | 'adopted' = origin
  let heldBack = false // a season pack added stopped: playback turns on only the wanted file(s) and then resumes it
  if (await qb.info(hash)) {
    await qb.resume(hash).catch(() => {})
    // Already in the engine but not ours (downloaded by hand in the Downloads folder): take it over rather than fetch a second copy.
    if (!db.prepare(`SELECT 1 FROM downloads WHERE torrent_id = ? AND state = 'active'`).get(rel.torrent_id)) { from = 'adopted'; await qb.addTags(hash, 'flix').catch(() => {}) }
  } else {
    assertSpace(needBytes) // a season pack is fetched whole
    const file = await fetchTorrentFile(rel.torrent_link)
    try {
      heldBack = !!rel.is_pack
      await qb.add(file, config.downloadDir, { paused: heldBack }) // straight into the Downloads folder: qBittorrent puts each torrent in its own named folder there
    } catch (e) {
      // The reply is not the proof: qBittorrent can take the torrent and still answer oddly. If it is in the engine now, it was added.
      if (!(await qb.info(hash).catch(() => undefined))) throw e
    }
  }
  // Somebody is waiting on this one (not a quiet ahead-of-time fetch): skip the engine's queue and find peers now.
  if (origin === 'flix' && !heldBack) {
    const cur = await qb.info(hash).catch(() => undefined)
    if (!cur || cur.progress < 1) { void qb.reannounce(hash); void qb.prioritize(hash) } // one already on disk needs neither
  }
  // wait for metadata (files list)
  const deadline = Date.now() + 60_000
  for (;;) {
    const files = await qb.files(hash).catch(() => [] as QbFile[])
    if (files.length) break
    if (Date.now() > deadline) throw new Error('Timed out waiting for torrent metadata from the tracker')
    await sleep(200)
  }
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at, origin) VALUES (?,?, 'active', ?, ?)
    ON CONFLICT(torrent_id) DO UPDATE SET origin = CASE WHEN state = 'active' THEN origin ELSE excluded.origin END, state='active', removed_at=NULL, remove_reason=NULL`).run(rel.torrent_id, hash, now(), from)
  catalogChanged() // a release on the server counts as alive and playable: the cached listings must see it
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

/** Disk a play will take: always the whole release -- a season is fetched whole, so a pack counts in full. */
const bytesToFetch = (rel: Release): number => Number(rel.size ?? 0)

/**
 * How many other releases one play will try after the best one turns out to be dead. Two is enough to get past a stale
 * cached listing to the one BTN actually has (Get Jiro S01E04: three releases listed, the first two gone).
 */
const MAX_DEAD_SKIPS = 2

/** BTN no longer serves this release's .torrent: remember it, so the picker never chooses it again. */
function markDead(rel: Release, why: string) {
  db.prepare('UPDATE releases SET dead_at = ? WHERE torrent_id = ?').run(now(), rel.torrent_id)
  catalogChanged() // a dead release stops counting as available, so the cached listings have to see it
  diag('play', `release ${rel.torrent_id} is dead: ${why}`, { torrentId: rel.torrent_id, series: rel.series, label: rel.label }, 'warn')
}

/** The next release for the same slot (the same episode, or the same season's pack), leaving out what this play has tried. */
function nextSource(rel: Release, tried: Set<number>) {
  // Read through a map rather than adding torrent_link to every candidate row: the link carries the passkey and the
  // candidate rows travel towards the client.
  const links = new Map((db.prepare('SELECT torrent_id, torrent_link FROM releases WHERE series_id = ?').all(rel.series_id) as { torrent_id: number; torrent_link: string | null }[])
    .map((r) => [r.torrent_id, r.torrent_link]))
  const same = candidatesFor(Number(rel.series_id)).filter((r) =>
    !tried.has(r.torrent_id) && !!links.get(r.torrent_id) && (rel.is_pack
      ? r.is_pack === 1 && r.season === rel.season
      : r.is_pack === 0 && r.season === rel.season && r.episode === rel.episode))
  return pickRelease(same)
}

/**
 * Play a release, moving on to the next-best one when BTN no longer has it.
 *
 * A listing cached months ago can point at a torrent BTN has since deleted. That used to end the play with "Failed to
 * download .torrent (HTTP 404)" with nothing else tried, even though the same episode had two healthy releases beside
 * it. Now the dead one is recorded as dead (so the picker never chooses it again), the next candidate is played, and
 * the person only hears about a dead link when every copy of that episode is gone.
 *
 * `fileIndex` is a position in one release's file list, so it is dropped once the source changes: the new release picks
 * its own file, by the episode label when it is a pack.
 */
export async function withSourceFallback<T>(torrentId: number, fileIndex: number | undefined, play: (rel: Release, fileIndex?: number) => Promise<T>): Promise<T> {
  const tried = new Set<number>()
  let id = torrentId
  let index = fileIndex
  let skips = 0
  for (;;) {
    const rel = getRelease(id)
    if (!rel) throw new Error('Unknown release')
    tried.add(id)
    try {
      return await play(rel, index)
    } catch (e) {
      if (!(e instanceof DeadTorrentLinkError)) throw e
      if (e.permanent) markDead(rel, e.message)
      const next = nextSource(rel, tried)
      if (!next || skips >= MAX_DEAD_SKIPS) {
        // Plain words for the viewer (the client shows this text as it is); the cause BTN gave is in the log.
        diag('play', `every release for ${rel.series} ${rel.label ?? ''} is dead`, { series: rel.series, label: rel.label, tried: [...tried], why: e.message }, 'warn')
        throw new Error(`Every copy of this episode that BTN lists is gone (${tried.size} tried). Flix looks for new copies when it next refreshes the show, so try again later.`)
      }
      id = next.torrent_id
      index = undefined
      skips++
    }
  }
}

/** Start (or join) a download for a user and return the file to play. */
export async function startPlayback(userId: number, torrentId: number, fileIndex?: number, opts: { episodeLabel?: string; auto?: boolean } = {}) {
  return withSourceFallback(torrentId, fileIndex, (rel, index) => playOne(userId, rel, index, opts))
}

async function playOne(userId: number, rel: Release, fileIndex: number | undefined, opts: { episodeLabel?: string; auto?: boolean }) {
  const torrentId = rel.torrent_id
  // The last gate before any byte is fetched: in copy-only mode a release whose picture would have to be re-encoded
  // is refused here too, so a stale link, a pack or a warm-ahead fetch cannot slip one past the picker.
  if (copyOnly() && convertCost(rel as any) !== 0) {
    throw new Error('This copy would have to be converted, and Flix is set never to convert the picture, so it is not downloaded.')
  }
  let p = adding.get(torrentId)
  if (!p) { p = ensureAdded(rel, opts.auto ? 'auto' : 'flix', bytesToFetch(rel)).finally(() => adding.delete(torrentId)); adding.set(torrentId, p) }
  await p

  const files = await qb.files(rel.info_hash)
  const file = fileIndex !== undefined ? files.find((f) => f.index === fileIndex) : rel.is_pack ? pickFromPack(files, userId, torrentId, opts.episodeLabel) : pickVideo(files)
  if (!file) throw new Error('No playable video file in this torrent')

  // A season pack is fetched whole, front to back: that is how seasons are packaged, a half-downloaded pack cannot be
  // seeded, and BTN's seeding requirement is per torrent. The episode somebody tapped goes first (highest priority);
  // everything else is enabled behind it in file order, and the torrent downloads sequentially, so earlier episodes
  // land before later ones. A single-episode release is just that one file.
  const wanted = new Set<number>()
  if (rel.is_pack) for (const f of files) wanted.add(f.index)
  wanted.add(file.index)
  for (const f of files) if (SUBFILE.test(f.name)) wanted.add(f.index) // tiny, and the player offers them as subtitles
  const toEnable = files.filter((f) => wanted.has(f.index) && f.priority === 0).map((f) => f.index)
  await qb.filePrio(rel.info_hash, toEnable, 1)
  await qb.filePrio(rel.info_hash, [file.index], 7)
  if (rel.is_pack) { // a pack is added stopped so that its files are chosen before the first byte is fetched
    await qb.resume(rel.info_hash)
    if (!opts.auto) { void qb.reannounce(rel.info_hash); void qb.prioritize(rel.info_hash) }
  }

  const t = now()
  if (opts.auto) { // started ahead of time: never bring back something this person finished or let go of
    const ex = db.prepare('SELECT watched_at, released_at FROM interests WHERE user_id=? AND torrent_id=? AND file_index=?').get(userId, torrentId, file.index) as any
    if (ex && (ex.watched_at || ex.released_at)) throw new Error('already finished')
  }
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, file_name, created_at, updated_at, auto) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, torrent_id, file_index) DO UPDATE SET updated_at=excluded.updated_at, released_at=NULL, auto=MIN(auto, excluded.auto)`)
    .run(userId, torrentId, file.index, file.name, t, t, opts.auto ? 1 : 0)
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
  if (c && Date.now() - c.at < 250) return c.states
  const states = await qb.pieceStates(hash)
  pieceCache.set(hash, { at: Date.now(), states })
  return states
}

export class StreamTimeout extends Error {}

/** Resolve once every piece covering bytes [start,end] of the file has been downloaded and verified (state 2). */
async function waitForBytes(hash: string, fileIndex: number, start: number, end: number, signal: AbortSignal, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  const from = Date.now()
  let logged = false // one line per stall, not one per poll: a long wait must not bury the log it is recorded in
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
    let missing = 0
    for (let i = first; i <= last; i++) if (states[i] !== 2) missing++
    if (!missing) return
    const waited = Date.now() - from
    // A wait of half a second is where a player starts to hitch: that is the line worth having, and it records what was
    // actually short (how many of the pieces under these bytes had not arrived) rather than only that something was slow.
    if (!logged && waited > 500) {
      logged = true
      const t = await qb.info(hash).catch(() => null)
      hitch('pieces', 'playback waiting for data', { file: fileIndex, atBytes: start, pieces: `${missing} missing of ${last - first + 1}`, waitedMs: waited, progress: Math.round(f.progress * 100) / 100, dlspeed: t?.dlspeed ?? null, seeds: t?.num_seeds ?? null, peers: t?.num_leechs ?? null, state: t?.state ?? null })
    }
    if (Date.now() > deadline) {
      hitch('pieces', 'gave up waiting for data', { file: fileIndex, atBytes: start, waitedMs: Date.now() - from, pieces: `${missing} missing of ${last - first + 1}` })
      throw new StreamTimeout('Timed out waiting for data (no seeders?)')
    }
    await sleep(200)
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
  // 2 MB per read: the player takes what it is given as fast as the pieces allow, and every read costs a piece-state
  // round trip to the engine. At 1 MB a 4 Mbit/s episode asked the engine forty times a minute for an answer it had just had.
  const CHUNK = 2 << 20
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
  const a = Math.floor(base / layout.pieceSize), b = Math.max(a, Math.floor((base + headBytes - 1) / layout.pieceSize)) // an empty file still spans one piece
  let have = 0
  for (let i = a; i <= b; i++) if (states[i] === 2) have++
  return {
    bufferedPct: file.progress >= 1 ? 100 : Math.round((have / (b - a + 1)) * 100),
    fileProgress: file.progress, size: file.size, dlspeed: t?.dlspeed ?? 0, seeds: t?.num_seeds ?? 0, peers: t?.num_leechs ?? 0, state: t?.state ?? 'unknown',
  }
}
