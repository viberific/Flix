import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { db, now } from './db.ts'
import { lowPriority } from './sprites.ts'

/**
 * Where the end credits start, measured once per finished file.
 *
 * "Up next" is meant to arrive while the credits are still running, so the player has to know where they begin. A chapter
 * named for them is exact but rare. An LLM costs money per playback and adds latency; a black-pixel test in the player
 * fights the decoder and calls every night scene and every fade-out credits. So this is done once, here, in the
 * background, with the same ffmpeg the seek sheet already uses: look at the last quarter of the file and ask it where the
 * picture goes black and where the sound stops. A file that has not finished downloading is never looked at, nothing is
 * ever run during playback or per request, and a failure is silent -- the player falls back to the percentage estimate.
 *
 * Measured markers are remembered in `credits_marker`, keyed the way a sprite sheet is (torrent id + file index), so they
 * survive a restart. A row with a null `at` means "looked, found nothing": the pass does not look again.
 */

/** A run of black picture, or of silence, in seconds of the file. */
export type Run = { start: number; end: number }

/** Look at the last quarter of the file only: the credits are never in the first three. */
export const LOOK_FROM = 0.75
/** A black run shorter than this is a cut or a fade, not a card. */
const MIN_BLACK = 3
/** Below this share of the runtime it is not a normal credit sequence, whatever the picture does. */
const SANITY = 0.55
/** A black run that runs out the clock within this many seconds of the end is the credits even without silence. */
const NEAR_END = 20
/** Silence counts as following a black run if it starts within this many seconds of the picture coming back. */
const FOLDS = 10

/** A whole measurement is minutes: two decodes of a quarter of an episode, one process at a time. */
const TIMEOUT_MS = 6 * 60_000
const THREADS = '1'

/** `[blackdetect @ 0x...] black_start:615 black_end:679.4 black_duration:64.4` */
export function parseBlackdetect(stderr: string): Run[] {
  const runs: Run[] = []
  for (const m of stderr.matchAll(/black_start:\s*(-?\d+(?:\.\d+)?)\s+black_end:\s*(-?\d+(?:\.\d+)?)/g)) {
    const start = Number(m[1]), end = Number(m[2])
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) runs.push({ start, end })
  }
  return runs.sort((a, b) => a.start - b.start)
}

/**
 * `[silencedetect @ 0x...] silence_start: 2600` and, later, `silence_end: 2700 | silence_duration: 100`.
 * A file that ends quiet never prints an end, so an unpaired start runs to the end of what was looked at.
 */
export function parseSilencedetect(stderr: string, until: number): Run[] {
  const runs: Run[] = []
  let open: number | null = null
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (s) {
      const at = Number(s[1])
      if (Number.isFinite(at)) open = Math.max(0, at)
      continue
    }
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (e && open != null) {
      const end = Number(e[1])
      if (Number.isFinite(end) && end > open) runs.push({ start: open, end })
      open = null
    }
  }
  if (open != null && until > open) runs.push({ start: open, end: until })
  return runs
}

/** ffmpeg reports times from where the seek put it; the runs have to be put back on the file's own clock. */
export function shiftRuns(runs: Run[], offset: number): Run[] {
  if (!offset) return runs
  return runs.map((r) => ({ start: r.start + offset, end: r.end + offset }))
}

/**
 * Which second the credits begin at, or null when this file gives no answer worth trusting.
 *
 * The earliest black run that starts in the last 30% of the episode, lasts at least three seconds, and either has silence
 * over it or after it (credits over quiet, or a music cue that has stopped) or runs out the clock (a card held to the end
 * while the theme plays). Everything under 55% of the runtime is thrown out however black it is.
 */
export function pickCreditsAt(black: Run[], silence: Run[], duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  for (const b of [...black].sort((x, y) => x.start - y.start)) {
    if (b.start < 0.70 * duration) continue // the credits are not in the first 70% of anything
    if (b.end - b.start < MIN_BLACK) continue
    const quiet = silence.some((s) => s.start < b.end + FOLDS && s.end > b.start)
    const runsOut = b.end >= duration - NEAR_END
    if (!quiet && !runsOut) continue
    const at = Math.round(b.start)
    if (at < SANITY * duration) continue // belt and braces: nothing this early is a credit sequence
    if (at > duration - MIN_BLACK) continue // the credits are already over by then
    return at
  }
  return null
}

/** Run one ffmpeg pass over the tail of the file and give back its stderr, or null when it did not finish cleanly. */
function stderrOf(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(...lowPriority(args), { stdio: ['ignore', 'ignore', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let done = false
    const finish = (v: string | null) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGKILL') } catch { /* gone */ } resolve(v) }
    const timer = setTimeout(() => finish(null), TIMEOUT_MS)
    proc.stderr!.on('data', (d: Buffer) => {
      bytes += d.length
      if (bytes <= 4 << 20) chunks.push(d) // a long file prints a lot; the head of it is where the runs are
    })
    proc.on('error', () => finish(null))
    proc.on('exit', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null))
  })
}

/**
 * ffmpeg over the final quarter, twice: the picture for black, the sound for silence. Two passes rather than one because
 * `-af` on a file with no audio track fails the whole run, and black alone still answers the question.
 */
export async function measureCredits(source: string, duration: number): Promise<number | null> {
  if (!existsSync(source) || !Number.isFinite(duration) || duration < 60) return null
  const offset = Math.floor(duration * LOOK_FROM)
  const tail = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', THREADS, '-ss', String(offset), '-i', source]
  const out = ['-threads', THREADS, '-f', 'null', '-']
  // The picture is read from its keyframes alone. A cut to a credit card is a scene change, which an encoder starts with
  // a keyframe, so the start of the black is still found to within a frame or two; what is lost is only precision about
  // where it ends, which nothing here needs. That is what keeps this pass to a sliver of one core: 0.3.44 decoded every
  // frame of the last quarter and was measured at 3.46 of the box's 4 cores. The sound is cheap to decode as it is.
  const [vlog, alog] = [await stderrOf(['-skip_frame', 'nokey', ...tail, '-map', '0:v:0', '-an', '-vf', 'blackdetect=d=2:pix_th=0.10', ...out]),
    await stderrOf([...tail, '-map', '0:a:0', '-vn', '-af', 'silencedetect=n=-35dB:d=2', ...out])]
  // One process at a time, not two: this runs on the same box the family is watching, and the pass is in no hurry.
  if (vlog == null) return null // nothing to say without the picture
  const black = shiftRuns(parseBlackdetect(vlog), offset)
  const silence = alog == null ? [] : shiftRuns(parseSilencedetect(alog, duration - offset), offset)
  return pickCreditsAt(black, silence, duration)
}

/** The marker remembered for this file, and how many times it has been looked at. Null when it never has. */
export function creditsRow(t: number, f: number): { at: number | null; duration: number | null; tries: number } | null {
  try {
    const r = db.prepare('SELECT at, duration, tries FROM credits_marker WHERE torrent_id = ? AND file_index = ?').get(t, f) as any
    if (!r) return null
    return { at: r.at ?? null, duration: r.duration ?? null, tries: Number(r.tries) || 0 }
  } catch { return null }
}

/** Remember what the last look found: `at` null means it looked and there were no credits to be sure of. */
export function saveCredits(t: number, f: number, at: number | null, duration: number) {
  try {
    const tries = (creditsRow(t, f)?.tries ?? 0) + 1
    db.prepare('INSERT OR REPLACE INTO credits_marker (torrent_id, file_index, at, duration, tries, made_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t, f, at, Math.round(duration), tries, now())
  } catch { /* the player falls back; never a reason to fail a play */ }
}

/** Whether this file still wants a look: never looked at, or looked at and failed, twice at most. */
export function creditsNeedsWork(t: number, f: number): boolean {
  const r = creditsRow(t, f)
  return !r ? true : r.at == null && r.tries < 2
}

/**
 * The measured marker for a playing file, or null when there is none. A marker measured for a different runtime is not
 * used: the file has been replaced or remuxed since, and its credits would be at a different second.
 */
export function creditsAt(t: number, f: number, duration: number): number | null {
  const r = creditsRow(t, f)
  if (!r || !(r.at != null && r.at > 0)) return null
  if (!Number.isFinite(duration) || duration <= 0) return null
  if (r.duration != null && Math.abs(r.duration - duration) > Math.max(3, duration * 0.02)) return null
  if (r.at < 0.55 * duration || r.at > duration - 3) return null
  return Math.round(r.at)
}
