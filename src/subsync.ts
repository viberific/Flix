import { existsSync } from 'node:fs'
import { db, now } from './db.ts'
import { parseSilencedetect, stderrOf, type Run } from './credits.ts'
import { lowPriority } from './sprites.ts'

/**
 * Subtitles that line up with the sound without anybody touching a control.
 *
 * Release groups time a subtitle against their own cut of the show, and a different cut (an ad break trimmed, a longer cold
 * open, a 25 fps PAL transfer of a 23.976 original) leaves every line a little early or late. The audio is the one thing
 * that is certainly right, so it is the reference: decode it once, find where somebody is speaking, and slide the subtitle's
 * start times until as many as possible land inside speech. Nothing here runs during playback. The measurement is one
 * background decode of the sound per subtitle, kept in `sub_sync` for good, and the shift is applied where the WebVTT is
 * built (shiftVtt), so a TV and a phone get the same corrected text from the same URL.
 */

/** Candidate shifts are tried from -RANGE to +RANGE in STEP milliseconds. Subtitles are rarely off by more than a few seconds. */
const RANGE = 6000
const STEP = 50
/** A second-best answer closer than this is the same answer seen through a wide peak, not a rival. */
const APART = 500
/** A line that lands in silence costs twice what a line in speech earns: speech is most of an episode, so a hit alone proves little. */
const HIT = 1
const MISS = -2
/** A fitted slope is drift only if it spreads the lines by more than this across the episode; less is one answer seen twice. */
const DRIFT_MS = 150

/**
 * How far the best shift has to beat the best rival (one at least 500 ms away) before it is applied. The score runs from -2
 * (every line in silence) to +1 (every line in speech), so 0.25 is a quarter of a point on that line: with a hit worth +1 and
 * a miss -2, it takes a shift that puts roughly a tenth more of the lines into speech than any other place does. A shift that
 * is wrong is worse than none, because the existing timing is usually close and a wrong guess makes it visibly bad. Music, a
 * quiet opener and long silences all read as "no speech" and drag the estimate toward whatever hides the most lines, and
 * every one of them shows up as a flat score curve, which is a small gap. So when in doubt the subtitle is left alone.
 */
export const CONFIDENCE_MIN = 0.25
/** Fewer lines than this is not enough to tell a peak from luck, whatever the gap looks like. */
export const MIN_CUES = 12
/**
 * How much of the episode one offset is fitted over. A window has to be short enough that 1% of it (0.45 s here) is well
 * inside the second or so a line stays in speech as the subtitle slides, or no single shift would fit even a local stretch.
 */
const CHUNK_MS = 45_000
/** Windows that survived the confidence gate; fewer than this and a slope would be fitted through noise. */
const CHUNKS_MIN = 4
/** A frame rate is 4.3% at most (23.976 against 25). Ten percent out is a different cut, and no slope should be applied. */
const SCALE_MAX = 0.1

/** The time of every `hh:mm:ss.mmm --> hh:mm:ss.mmm` line (the hours are optional in WebVTT). Captures: start, arrow, end. */
const TIMING = /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([ \t]+-->[ \t]+)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/gm

function toMs(ts: string): number {
  const p = ts.split(':')
  const sec = Number(p.pop())
  const min = Number(p.pop())
  const hr = p.length ? Number(p.pop()) : 0
  return Math.round(((hr * 60 + min) * 60 + sec) * 1000)
}
function fromMs(ms: number): string {
  const t = Math.max(0, Math.round(ms))
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}`
}

/** The start time of every cue, in milliseconds, in the order they are written. */
export function cueStarts(vtt: string): number[] {
  return [...vtt.matchAll(TIMING)].map((m) => toMs(m[1]))
}

/**
 * The same WebVTT with every timing line moved to `t * scale + offsetMs`, never below zero. Only the two timestamps of a timing
 * line are rewritten: the cue settings after them, the cue text, the header and the line endings are left as they were. A
 * shift of nothing returns the text itself, byte for byte.
 */
export function shiftVtt(vtt: string, offsetMs: number, scale = 1): string {
  if (!offsetMs && scale === 1) return vtt
  return vtt.replace(TIMING, (_all, a: string, arrow: string, b: string) => fromMs(toMs(a) * scale + offsetMs) + arrow + fromMs(toMs(b) * scale + offsetMs))
}

/** Where somebody is speaking: everything that is not one of the silences, clipped to [0, duration]. Seconds. */
export function speechFrom(silence: Run[], duration: number): Run[] {
  const out: Run[] = []
  let at = 0
  for (const s of [...silence].sort((x, y) => x.start - y.start)) {
    const a = Math.max(0, s.start), b = Math.min(duration, s.end)
    if (b <= a) continue
    if (a > at) out.push({ start: at, end: a })
    at = Math.max(at, b)
  }
  if (duration > at) out.push({ start: at, end: duration })
  return out
}

/**
 * The speech runs of a file, or null when it could not be measured (no file, no sound, ffmpeg gone or too slow). One pass
 * over the sound alone, down to 8 kHz mono, which is a fraction of a core and no video decode. Run at the lowest priority with
 * one thread, the way the credits pass is, because it reads the whole file off the same drive somebody may be watching from.
 */
export async function speechRuns(file: string, durationSec: number): Promise<Run[] | null> {
  if (!existsSync(file) || !Number.isFinite(durationSec) || durationSec < 60) return null
  const err = await stderrOf(['-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', '1', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000',
    '-af', 'silencedetect=noise=-30dB:d=0.25', '-threads', '1', '-f', 'null', '-'])
  if (err == null) return null
  return speechFrom(parseSilencedetect(err, durationSec), durationSec)
}

export interface Estimate { offsetMs: number; confidence: number; scored: number }

/**
 * The shift, in milliseconds, that puts the most cue starts inside speech, and how sure that is. `cues` are start times in
 * milliseconds, `runs` the speech in seconds. Confidence is the best score minus the best score at least 500 ms away from the
 * best one. Many shifts usually tie (a plateau, since a line stays inside its run for a second or so of sliding); that is read
 * as one answer, and "away" is measured from the edge of the plateau. `range` is how far either way to look; the whole-file
 * search uses ±6 s. This departs from the brief in two small ways, both because the plain reading fails on real speech: the
 * rival is measured from the plateau, and the answer is the plateau's edge nearest to zero, not its middle (see below).
 */
export function estimateOffset(cues: number[], runs: Run[], range = RANGE): Estimate {
  if (!cues.length || !runs.length) return { offsetMs: 0, confidence: 0, scored: cues.length }
  const rs = [...runs].sort((a, b) => a.start - b.start).map((r) => [r.start * 1000, r.end * 1000] as const)
  const inSpeech = (t: number) => {
    let lo = 0, hi = rs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (rs[mid][0] > t) hi = mid - 1
      else if (rs[mid][1] < t) lo = mid + 1
      else return true
    }
    return false
  }
  const lo = -Math.floor(range / STEP) * STEP
  const n = Math.floor(range / STEP) * 2 + 1
  const scores: number[] = []
  for (let i = 0; i < n; i++) {
    const shift = lo + i * STEP
    let s = 0
    for (const c of cues) s += inSpeech(c + shift) ? HIT : MISS
    scores.push(s / cues.length)
  }
  let best = 0
  for (let i = 1; i < n; i++) if (scores[i] > scores[best]) best = i
  let l = best, r = best
  while (l > 0 && scores[l - 1] >= scores[best] - 0.01) l--
  while (r < n - 1 && scores[r + 1] >= scores[best] - 0.01) r++
  // A subtitle starts when the speech does, so a line is inside a run of speech for as long as the shift is anywhere in a
  // window as wide as that run, and the true shift is the edge of the window that is nearest to doing nothing. The middle of
  // the window would move a subtitle that is already right by half a sentence. So: no shift if no shift is on the plateau,
  // otherwise the end of the plateau that is closest to it.
  const zero = (n - 1) / 2
  const pick = zero >= l && zero <= r ? zero : r < zero ? r : l
  const offsetMs = lo + pick * STEP
  // The rival is the best score away from the plateau itself, at least 500 ms past either end of it, not away from the one
  // point picked: a plateau is one answer seen with some blur, and only a separate peak is a reason to doubt it.
  const gap = APART / STEP
  let rival = -Infinity
  for (let i = 0; i < n; i++) if ((i < l - gap || i > r + gap) && scores[i] > rival) rival = scores[i]
  return { offsetMs, confidence: rival === -Infinity ? 0 : scores[best] - rival, scored: cues.length }
}

export interface Fit { offsetMs: number; scale: number; confidence: number; cues: number }

/**
 * Offset and scale for a whole subtitle: the line `t' = t * scale + offset` that lines it up with the sound. An episode is
 * fitted in local windows of about 45 s of lines rather than in thirds, because one offset cannot see drift at all. A line
 * stays inside a run of speech for only a second or so of sliding, while 1% of a five-minute third already spreads its lines
 * over three seconds, so in a drifting file no shift fits a whole third, every window's confidence collapses and the slope
 * comes back as 1. Short windows keep the drift inside a window under a second, where one offset does fit, and the slope of
 * those offsets against their time is the frame rate. Fewer than four windows worth believing, or a slope too wild to be a
 * frame rate, and the flat answer is used instead: scale 1, one offset for the whole subtitle.
 */
export function fitSync(cues: number[], runs: Run[], _durationSec: number): Fit {
  const whole = estimateOffset(cues, runs)
  const flat: Fit = { offsetMs: whole.offsetMs, scale: 1, confidence: whole.confidence, cues: cues.length }

  // Chunks by line count, not by the clock: the count is sized from the median gap between lines so a chunk spans about
  // CHUNK_MS of subtitle, and never fewer than MIN_CUES lines. A short tail is folded into the chunk before it.
  const sorted = [...cues].sort((a, b) => a - b)
  if (sorted.length < MIN_CUES) return flat
  const gaps = sorted.slice(1).map((c, i) => c - sorted[i]).filter((g) => g > 0).sort((a, b) => a - b)
  const medianGap = gaps.length ? gaps[gaps.length >> 1] : CHUNK_MS
  const per = Math.max(MIN_CUES, Math.round(CHUNK_MS / medianGap))
  const windows: number[][] = []
  for (let i = 0; i < sorted.length; i += per) windows.push(sorted.slice(i, i + per))
  if (windows.length > 1 && windows[windows.length - 1].length < MIN_CUES) {
    const tail = windows.pop()!
    windows[windows.length - 1].push(...tail)
  }

  const kept: { at: number; offset: number; confidence: number }[] = []
  for (const w of windows) {
    if (w.length < MIN_CUES) continue
    const at = w[w.length >> 1] // the median line of the chunk: its nominal time on the subtitle's own clock
    // A drifting file is far out by its end, so the search widens with how far into the episode a window sits: ±6 s plus 6%
    // of its own time, which covers a PAL transfer. Wider windows than that invite false peaks, which the gate rejects.
    const e = estimateOffset(w, runs, RANGE + 0.06 * at)
    if (e.confidence > CONFIDENCE_MIN) kept.push({ at, offset: e.offsetMs, confidence: e.confidence })
  }
  if (kept.length < CHUNKS_MIN) return flat

  // Least squares through the windows: offset(t) = a*t + b. The subtitle wants t + offset(t) = (1 + a)*t + b, so the scale is
  // 1 + a and the offset is b.
  const n = kept.length
  const meanT = kept.reduce((s, p) => s + p.at, 0) / n
  const meanO = kept.reduce((s, p) => s + p.offset, 0) / n
  let cov = 0, spread = 0
  for (const p of kept) { cov += (p.at - meanT) * (p.offset - meanO); spread += (p.at - meanT) ** 2 }
  if (!(spread > 0)) return flat
  const a = cov / spread
  const scale = 1 + a
  if (!(Math.abs(scale - 1) <= SCALE_MAX)) return flat
  // A slope that moves the lines by less than DRIFT_MS from the first window to the last is not a frame rate: it is the same
  // flat answer with a little noise on it, and applying it would move a subtitle that is already right.
  if (Math.abs(a) * (kept[n - 1].at - kept[0].at) <= DRIFT_MS) return flat
  return { offsetMs: Math.round(meanO - a * meanT), scale, confidence: Math.min(...kept.map((p) => p.confidence)), cues: cues.length }
}

export interface SyncRow { offset_ms: number; scale: number; confidence: number; cues: number }

/** Whether a stored measurement is sure enough to be used, and actually moves something. */
export function syncApplies(r: SyncRow | undefined | null): r is SyncRow {
  return !!r && r.confidence > CONFIDENCE_MIN && r.cues >= MIN_CUES && (r.offset_ms !== 0 || r.scale !== 1)
}

export function syncRow(t: number, f: number, key: string): SyncRow | undefined {
  try {
    return db.prepare('SELECT offset_ms, scale, confidence, cues FROM sub_sync WHERE torrent_id = ? AND file_index = ? AND subtitle_key = ?').get(t, f, key) as SyncRow | undefined
  } catch { return undefined }
}

function saveSync(t: number, f: number, key: string, fit: Fit) {
  db.prepare('INSERT OR IGNORE INTO sub_sync (torrent_id, file_index, subtitle_key, offset_ms, scale, confidence, cues, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t, f, key, fit.offsetMs, fit.scale, fit.confidence, fit.cues, now())
}

/** One decode at a time, and a file that failed is left alone for an hour instead of being retried by every request. */
const running = new Set<string>()
const failedAt = new Map<string, number>()
const RETRY_MS = 60 * 60_000

/**
 * Measure a subtitle against the sound in the background and remember the answer. Returns at once; the request that asked
 * is served the subtitle as it is, and the player asks again when the response says a measurement is under way. `vtt` is the
 * unshifted text. Nothing is stored when it could not be measured, so the next play gets another try; a row that exists is
 * never measured again.
 */
export function startSync(t: number, f: number, key: string, source: string, durationSec: number, vtt: string): void {
  const id = `${t}:${f}:${key}`
  if (running.size || syncRow(t, f, key) || Date.now() - (failedAt.get(id) ?? 0) < RETRY_MS) return
  const cues = cueStarts(vtt)
  if (!cues.length) return // nothing to line up (an empty read, or a track with no text): not worth a decode
  running.add(id)
  void speechRuns(source, durationSec)
    .then((runs) => {
      if (!runs?.length) { failedAt.set(id, Date.now()); return }
      saveSync(t, f, key, fitSync(cues, runs, durationSec))
    })
    .catch(() => { failedAt.set(id, Date.now()) })
    .finally(() => running.delete(id))
}
