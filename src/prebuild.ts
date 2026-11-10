import { freemem } from 'node:os'
import { join } from 'node:path'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { diag } from './diag.ts'
import { fileInfo } from './streaming.ts'
import { audioDirect, copyPictureFor, directPlay, ensureHls, evictHls, hlsBusy, hlsCacheBytes, keepHls, probe, type ProbeOptions } from './transcode.ts'
import { engineFiles } from './wanted.ts'
import { isVideo } from './btn/parse.ts'

/**
 * The copy made ahead of time.
 *
 * An episode whose sound the browser cannot decode (E-AC-3 and AC-3, i.e. most WEB-DLs) is served as a playlist: the picture
 * copied, the sound converted to AAC. That copy used to be built only when someone pressed play, so the first minute of an
 * episode was the box reading and remuxing the whole file while the viewer watched a spinner -- measured on 2026-11-04 as
 * 187 pieces in 46 seconds on a box down to 236 MB of free memory, with the player stalling five times and restarting.
 *
 * So it is built when the download finishes instead, one at a time, at low priority, and the play then finds the pieces
 * already on disk. Three things keep it honest:
 *
 *  - it costs disk (well over 700 MB for a 1080p episode), so the cache has a cap and the oldest copies nobody is watching
 *    are evicted to stay under it (evictHls);
 *  - it must never be the reason something else is slow, so one build runs at a time, at nice 19, with the decoder limited
 *    to a single thread, and nothing is built while a play is in progress or the box is short of memory;
 *  - it is idempotent: asking for a copy that exists (or is being made) returns that one job, never a second ffmpeg.
 */

/** Folders are keyed the way transcode.ts keys its jobs, so a marker survives a restart without a schema change. */
const markerKey = (torrentId: number, fileIndex: number) => `prebuild:${torrentId}:${fileIndex}`
const getMarker = (torrentId: number, fileIndex: number) =>
  Number((db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey(torrentId, fileIndex)) as { value: string } | undefined)?.value ?? 0)
const setMarker = (torrentId: number, fileIndex: number) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(markerKey(torrentId, fileIndex), String(now()))

/**
 * Files that were tried and could not be built ahead, and when. Only one copy is started per tick and it is always the
 * head of the list, so a file that never gets a marker -- one ffprobe cannot read, one whose picture would have to be
 * re-encoded -- was picked again every minute for ever, and nothing queued behind it was ever built. Such a file now
 * stands aside for a while (in memory: a restart is a fair moment to look again).
 */
const skipped = new Map<string, number>()
const SKIP_MS = 6 * 3600_000
const skipKey = (torrentId: number, fileIndex: number) => `${torrentId}:${fileIndex}`
function setAside(torrentId: number, fileIndex: number) {
  skipped.set(skipKey(torrentId, fileIndex), Date.now())
  if (skipped.size > 2000) skipped.delete(skipped.keys().next().value!)
}
const isSetAside = (torrentId: number, fileIndex: number) => (skipped.get(skipKey(torrentId, fileIndex)) ?? 0) > Date.now() - SKIP_MS

export interface Candidate { torrentId: number; fileIndex: number; size: number; name: string }

/**
 * The finished files worth copying: downloaded in full, actually wanted (a season pack holds every episode, and only the
 * ones somebody picked have arrived), and not the kind of file that plays as it is -- a file that needs no playlist needs
 * no copy, and one whose picture has to be re-encoded is left to the play rather than tying the box up for an hour.
 */
export async function prebuildCandidates(filesOf: typeof engineFiles = engineFiles): Promise<Candidate[]> {
  // No alias is named `group`: GROUP is a keyword in SQLite, and `r.group_name AS group` is a syntax error at prepare time,
  // not a bad row -- which threw this whole query every tick for seven versions and copied nothing ahead (0.3.89-0.3.96).
  // test/prebuild-candidates.test.ts runs this statement against real rows so a keyword can never silence it again.
  const rows = db.prepare(`SELECT d.torrent_id AS torrentId, r.info_hash AS infoHash, r.is_pack AS isPack
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id
    WHERE d.state = 'active' ORDER BY d.added_at DESC`).all() as { torrentId: number; infoHash: string; isPack: number }[]
  const out: Candidate[] = []
  for (const r of rows) {
    const files = await filesOf(r.infoHash).catch(() => [])
    for (const f of files) {
      if (f.progress < 1) continue
      if (!isVideo(f.name)) continue // the .nfo, the subtitles and the sample beside an episode are not episodes
      if (isSetAside(r.torrentId, f.index)) continue // tried, and could not be built: not the head of the queue again
      if (r.isPack && !(f.priority > 0)) continue // a pack's other episodes have not been fetched at all
      if (getMarker(r.torrentId, f.index) > now() - config.hls.keepHours * 3600) continue // asked for already
      out.push({ torrentId: r.torrentId, fileIndex: f.index, size: f.size, name: f.name })
    }
  }
  return out
}

/** Whether a player would need a playlist for this file at all, and whether the copy is the cheap kind (picture untouched). */
export async function needsCopy(torrentId: number, fileIndex: number, opts: ProbeOptions = { complete: true }) {
  const p = await probe(torrentId, fileIndex, opts)
  if (directPlay(p) && audioDirect(p)) return { wanted: false, copy: false, p } // plays as it is: nothing to build
  // The picture can be copied for H.264/HEVC in TS. Anything else would be a full encode: left to the play, not built ahead.
  return { wanted: true, copy: copyPictureFor(p), p }
}

/**
 * Build one file's copy now. Returns null when it was not worth building. Never throws: a prebuild is an optimisation and a
 * failure must not reach any caller.
 */
export async function prebuildOne(torrentId: number, fileIndex: number, opts: { source?: string } = {}): Promise<string | null> {
  try {
    const fi = await fileInfo(torrentId, fileIndex).catch(() => null)
    // The path is built the one way it is built everywhere, and handed on so a file that is already whole is read from the
    // disk instead of being streamed back to us through /raw.
    const source = opts.source ?? (fi ? join(fi.layout.savePath, fi.file.name) : undefined)
    const local = { complete: true, source, savePath: fi?.layout.savePath }
    const { wanted, copy } = await needsCopy(torrentId, fileIndex, local)
    if (!wanted) { setMarker(torrentId, fileIndex); return null }
    if (!copy) { setAside(torrentId, fileIndex); diag('prebuild', 'left for the play: this picture would have to be re-encoded', { torrentId, fileIndex }); return null }
    const size = fi?.file.size ?? 0
    // Room first: the copy comes to about the size of the file, and the oldest copies nobody is watching are evicted to
    // make it, so the cap holds before it is reached rather than after the disk is full.
    const cap = Math.round(config.hls.cacheMaxGb * 1e9)
    evictHls(Math.max(0, cap - size))
    const started = Date.now()
    const dir = await ensureHls(torrentId, fileIndex, await probe(torrentId, fileIndex, local), 0, false,
      { complete: true, source, lowPriority: true })
    keepHls(torrentId, fileIndex, config.hls.keepHours * 3600_000)
    setMarker(torrentId, fileIndex)
    const bytes = hlsCacheBytes().find((x) => join(config.dataDir, 'hls', x.dir) === dir)?.bytes ?? 0
    diag('prebuild', 'copied an episode ahead of the play', { torrentId, fileIndex, dir: dir.split('/').pop(), mb: Math.round(bytes / 1e6), ms: Date.now() - started })
    return dir
  } catch (e: any) {
    setAside(torrentId, fileIndex)
    diag('prebuild', 'could not copy an episode ahead of the play', { torrentId, fileIndex, why: String(e?.message ?? e).slice(0, 160) })
    return null
  }
}

let running = false

/**
 * One tick: keep the cache under its cap, then start the next copy if the box is in a state to afford it. Called after a
 * download finishes and on a timer, so an episode copied overnight is ready in the morning.
 */
export async function prebuildTick(): Promise<void> {
  if (!config.hls.prebuild || running) return
  running = true
  try {
    // The room is made every tick, not only when something is about to be built: a cache left over the cap is the thing
    // that fills the disk quietly.
    const cap = Math.round(config.hls.cacheMaxGb * 1e9)
    const freed = evictHls(cap)
    if (freed.removed.length) diag('prebuild', 'evicted copies to stay under the cache cap', { freedMb: Math.round(freed.freed / 1e6), leftMb: Math.round(freed.left / 1e6), capGb: config.hls.cacheMaxGb })
    const freeMb = Math.round(freemem() / 1048576)
    if (freeMb < config.hls.minFreeMb) return diag('prebuild', 'not building ahead: the box is short of memory', { freeMb, needMb: config.hls.minFreeMb })
    // Nothing is built while somebody is watching: the disk it reads is the disk the player reads.
    if (hlsBusy()) return diag('prebuild', 'not building ahead while something plays', {})
    const list = await prebuildCandidates()
    if (!list.length) return
    // One at a time, newest download first: it is the one about to be watched.
    await prebuildOne(list[0].torrentId, list[0].fileIndex)
  } catch (e: any) {
    diag('prebuild', 'prebuild tick failed', { why: String(e?.message ?? e).slice(0, 160) })
  } finally {
    running = false
  }
}

/**
 * Start the sweeper. Every minute: cheap when there is nothing to do (one query, and the engine's file list is cached), and
 * it starts at most one copy per tick, so a queue of finished episodes is worked through slowly rather than all at once.
 */
export function startPrebuild() {
  if (!config.hls.prebuild) return
  const every = 60_000
  setTimeout(() => void prebuildTick(), 30_000).unref() // let the app finish starting first
  setInterval(() => void prebuildTick(), every).unref()
}
