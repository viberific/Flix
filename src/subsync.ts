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
 * background decode of the sound per subtitle, kept in `sub_sync`, and the shift is applied where the WebVTT is built
 * (shiftVtt), so a TV and a phone get the same corrected text from the same URL.
 *
 * Nothing here is for good any more. A measurement is kept until it is worth taking again -- a better fitter than the one that
 * made it (FIT_VERSION), or an answer that was never sure of itself and is now old (RECHECK_MS) -- and a person can correct
 * the result by eye with the + and − in the player, which is kept separately (`sub_offset`) so measuring again cannot undo it.
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
 * Which fitter made a measurement. It moves whenever fitSync or estimateOffset changes in a way that would have answered
 * differently, and every row made by an older one is measured again the next time its subtitle is played. Rows are cheap to
 * keep and a decode is not, so this is the only reason to re-decode a subtitle that was measured confidently. It is 1 while
 * the fitter is the one 0.3.89 shipped, and the column is added at 1 rather than 0: a subtitle measured before the column
 * existed was measured by this same fitter, so an update does not send the whole library through a decode again. A change to
 * how a subtitle is fitted is what makes this 2.
 */
export const FIT_VERSION = 1
/**
 * How long an answer that was not sure of itself is left alone. A quiet opener, a heavy music cue or a subtitle read from a
 * file that had only half arrived can leave a low-confidence row, and the same subtitle often measures better later (a whole
 * file, a different cut of the same episode). A confident row is never touched by age: nothing about it improves with waiting,
 * and re-decoding it would cost a core every time it is watched.
 */
const RECHECK_MS = 7 * 24 * 60 * 60_000
/**
 * How far a person may nudge subtitles either way. Half a minute is already more than a different cut of the same episode
 * costs, so a bigger number is a subtitle for something else rather than this one being late.
 */
export const OFFSET_MAX = 30_000
/**
 * The keys a subtitle is filed under, and the only shapes the nudge endpoint will take: an embedded track's number, a file
 * sitting beside the video, or the language of the one picked from the web. Anything else never matches a served subtitle.
 */
export const SUB_KEY = /^(?:embedded:\d{1,2}|file:.{1,200}|online:[a-z]{2,3})$/

/** A nudge as a browser sends it: which subtitle, and how far. */
export interface OffsetAsk { t: number; f: number; key: string; offsetMs: number }

/**
 * A nudge as the player sends it, or a sentence saying why it is not one. The subtitle has to be named the way the server
 * files them (SUB_KEY) and the offset has to be a whole number of milliseconds inside OFFSET_MAX: a browser can send
 * anything at all, and a stored number that is not a number would shift a subtitle off the screen with nothing to correct it.
 */
export function offsetAsk(body: any): OffsetAsk | string {
  const t = Number(body?.torrentId), f = Number(body?.fileIndex)
  if (!Number.isInteger(t) || t < 0 || !Number.isInteger(f) || f < 0) return 'No such subtitle.'
  const key = typeof body?.key === 'string' ? body.key : ''
  if (!SUB_KEY.test(key)) return 'No such subtitle.'
  const ms = body?.offsetMs
  if (typeof ms !== 'number' || !Number.isInteger(ms) || Math.abs(ms) > OFFSET_MAX) {
    return `A subtitle offset is a whole number of milliseconds, up to ${OFFSET_MAX / 1000} seconds either way.`
  }
  return { t, f, key, offsetMs: ms }
}
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

export interface SyncRow { offset_ms: number; scale: number; confidence: number; cues: number; fit_version?: number; measured_at?: number }

/** Whether a stored measurement is sure enough to be used, and actually moves something. */
export function syncApplies(r: SyncRow | undefined | null): boolean {
  return !!r && r.confidence > CONFIDENCE_MIN && r.cues >= MIN_CUES && (r.offset_ms !== 0 || r.scale !== 1)
}

/** Whether a row should be measured again: made by an older fitter, or never sure of itself and old enough for another look. */
export function needsMeasure(r: SyncRow | undefined | null, at = Date.now()): boolean {
  if (!r) return true
  if ((r.fit_version ?? 0) < FIT_VERSION) return true
  // Sure, not "applies": a measurement that found no shift to make is a good answer and stays put like any other.
  const sure = r.confidence > CONFIDENCE_MIN && r.cues >= MIN_CUES
  return !sure && at - (r.measured_at ?? 0) * 1000 > RECHECK_MS
}

export function syncRow(t: number, f: number, key: string): SyncRow | undefined {
  try {
    return db.prepare('SELECT offset_ms, scale, confidence, cues, fit_version, measured_at FROM sub_sync WHERE torrent_id = ? AND file_index = ? AND subtitle_key = ?').get(t, f, key) as SyncRow | undefined
  } catch { return undefined }
}

/** One row per subtitle, replaced rather than added to: a second measurement of the same subtitle is a better answer, not another one. */
export function saveSync(t: number, f: number, key: string, fit: Fit) {
  db.prepare(`INSERT INTO sub_sync (torrent_id, file_index, subtitle_key, offset_ms, scale, confidence, cues, measured_at, fit_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torrent_id, file_index, subtitle_key) DO UPDATE SET offset_ms = excluded.offset_ms, scale = excluded.scale,
      confidence = excluded.confidence, cues = excluded.cues, measured_at = excluded.measured_at, fit_version = excluded.fit_version`)
    .run(t, f, key, fit.offsetMs, fit.scale, fit.confidence, fit.cues, now(), FIT_VERSION)
}

/** How far a person has nudged a subtitle in the player, in milliseconds, or 0 when they have not touched it. */
export function manualOffset(t: number, f: number, key: string): number {
  try {
    const r = db.prepare('SELECT offset_ms FROM sub_offset WHERE torrent_id = ? AND file_index = ? AND subtitle_key = ?').get(t, f, key) as { offset_ms: number } | undefined
    return r?.offset_ms ?? 0
  } catch { return 0 }
}

/** Keep a nudge; forget it when it is back to zero, so the measurement speaks for itself again. */
export function setManualOffset(t: number, f: number, key: string, offsetMs: number): void {
  const ms = Math.round(offsetMs)
  if (!ms) { db.prepare('DELETE FROM sub_offset WHERE torrent_id = ? AND file_index = ? AND subtitle_key = ?').run(t, f, key); return }
  db.prepare(`INSERT INTO sub_offset (torrent_id, file_index, subtitle_key, offset_ms, set_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(torrent_id, file_index, subtitle_key) DO UPDATE SET offset_ms = excluded.offset_ms, set_at = excluded.set_at`)
    .run(t, f, key, ms, now())
}

export interface Shift { offsetMs: number; scale: number; manual: number; measured: boolean }

/**
 * The shift actually served for a subtitle: the measurement's drift, moved by whatever a person nudged by. The offset is the
 * person's number once they have given one, so a press that says 0.25 s moves the lines 0.25 s whether or not a measurement
 * is there to fight with it; the scale is still the measurement's, because drift is a property of the cut and no button can
 * show it. A nudge of zero leaves no row behind and so serves the measurement exactly.
 */
export function shiftFor(t: number, f: number, key: string): Shift {
  const row = syncRow(t, f, key)
  const measured = syncApplies(row)
  const manual = manualOffset(t, f, key)
  const scale = measured && row ? row.scale : 1
  return { offsetMs: manual || (measured && row ? row.offset_ms : 0), scale, manual, measured }
}

/** One decode at a time, and a file that failed is left alone for an hour instead of being retried by every request. */
const running = new Set<string>()
const failedAt = new Map<string, number>()
const RETRY_MS = 60 * 60_000

/**
 * Measure a subtitle against the sound in the background and remember the answer. Returns at once; the request that asked
 * is served the subtitle as it is, and the player asks again when the response says a measurement is under way. `vtt` is the
 * unshifted text. Nothing is stored when it could not be measured, so the next play gets another try.
 *
 * A stored answer is not kept for good: needsMeasure says when one is worth taking again. That stays the one decode at a
 * time it has always been -- a second subtitle is measured when the first is done, on the next play -- because this box is
 * often short of memory while it is transcoding.
 */
export function startSync(t: number, f: number, key: string, source: string, durationSec: number, vtt: string): void {
  const id = `${t}:${f}:${key}`
  if (running.size || Date.now() - (failedAt.get(id) ?? 0) < RETRY_MS) return
  if (!needsMeasure(syncRow(t, f, key))) return
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
