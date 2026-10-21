import { join } from 'node:path'
import { cpus, loadavg } from 'node:os'
import { db } from './db.ts'
import { fileInfo } from './streaming.ts'
import { keyframes, probe } from './transcode.ts'
import { offlineReadyPath } from './offline.ts'
import { buildSprite, spriteMeta } from './sprites.ts'
import { creditsNeedsWork, measureCredits, saveCredits } from './credits.ts'
import { diag } from './diag.ts'

/**
 * What a finished episode gets once, in the background, so playing it never has to work anything out: the pictures over
 * the seek bar, where its credits begin, and (for a file that plays as a playlist) where its keyframes are.
 *
 * This is the pass 0.3.45 deleted because it took the box over: a whole-file decode for the sheet and a decode of the last
 * quarter for the credits, which together left nothing to serve the app with. It comes back cheap: both decode keyframes
 * only (a small fraction of the frames, and of the work), on one thread, at the lowest CPU and disk priority, one file at
 * a time, and not at all while the box is busy. The keyframe list is a read of the file with nothing decoded.
 *
 * Nothing tells the server when qBittorrent finishes a file, so "has it finished?" is asked on a slow timer. Never on a
 * seek or a play: the request path only reads what this has already written.
 */
const tried = new Map<string, number>()
let busy = false
/** How many episodes are measured for credits in one pass; the pass runs every few minutes, so a library fills in over hours. */
const CREDITS_PER_PASS = 4

/** The box is doing something else (a conversion, several streams): leave it alone and try on the next pass. */
const tooBusy = () => loadavg()[0] > Math.max(1, cpus().length * 0.6)

export async function planExtras() {
  if (busy) return
  busy = true
  try {
    const rows = db.prepare('SELECT DISTINCT torrent_id, file_index FROM interests').all() as { torrent_id: number; file_index: number }[]
    let creditsDone = 0
    for (const r of rows) {
      if (tooBusy()) return
      const t = r.torrent_id, f = r.file_index, key = `${t}:${f}`
      if ((tried.get(key) ?? 0) >= 2) continue // a file ffmpeg cannot read is not worth a third go
      const wantSprite = !spriteMeta(t, f)
      const wantCredits = creditsDone < CREDITS_PER_PASS && creditsNeedsWork(t, f)
      if (!wantSprite && !wantCredits) continue
      const fi = await fileInfo(t, f).catch(() => null)
      if (!fi || fi.file.progress < 1) continue // still arriving: next pass
      const source = join(fi.layout.savePath, fi.file.name)
      const p = await probe(t, f, { complete: true }).catch(() => null) // one probe answers every job
      if (!p?.duration) { tried.set(key, (tried.get(key) ?? 0) + 1); continue }
      // Read before anything decodes: a playlist cut on these is what makes a copied picture seekable at once.
      if (!p.direct) await keyframes(t, f, source)
      let ok = true
      if (wantSprite) {
        const sheet = await buildSprite(t, f, offlineReadyPath(t, f) ?? source, p.duration)
        if (!sheet) { ok = false; diag('extras', 'no seek pictures for this file', { torrentId: t, fileIndex: f }) }
      }
      if (wantCredits && !tooBusy()) {
        creditsDone++
        const at = await measureCredits(source, p.duration)
        saveCredits(t, f, at, p.duration)
      }
      if (!ok) tried.set(key, (tried.get(key) ?? 0) + 1)
    }
  } finally { busy = false }
}

export function startExtrasPlanner() {
  setTimeout(() => void planExtras().catch(() => {}), 60_000).unref()
  setInterval(() => void planExtras().catch(() => {}), 3 * 60_000).unref()
}
