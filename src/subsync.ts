import { existsSync } from 'node:fs'
import { db, now } from './db.ts'
import { parseSilencedetect, stderrOf, type Run } from './credits.ts'
import { lowPriority } from './sprites.ts'

/**
 * Subtitles that line up with the sound without anybody touching a control.
 *
 * Release groups time a subtitle against their own cut of the show, and a different cut (an ad break trimmed, a longer cold
 * open, a 25 fps PAL transfer of a 23.976 original) leaves every line a little early or late. The audio is the one thing
 * that is certainly right, so it is the reference: decode it once, find where somebody starts speaking, and slide the
 * subtitle's start times until as many lines as possible begin where the speech does. Nothing here runs during playback. The measurement is one
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
/**
 * How early a line may appear before the speech it belongs to and still count as on its mark: subtitlers put the words up a
 * couple of frames early, and no detector lands on the first phoneme twice. This is also the resolution of the answer -- a
 * shift smaller than this cannot be told apart from none, and is deliberately not corrected.
 */
const LEAD_MS = 250
/** How late after the start of a run of speech a line still counts as that first line. Symmetric with LEAD_MS, so nothing is late by more than it may be early. */
const ON_MS = 250
/** A fitted slope is drift only if it spreads the lines by more than this across the episode; less is one answer seen twice. */
const DRIFT_MS = 150

/**
 * How far a window of lines has to be ahead of its best rival before fitSync believes that window while it is looking for
 * drift. It is no longer the gate a measurement is applied behind -- PEAK_MIN is -- because what it asks is the gap between two
 * competent peaks, and on real audio that gap is small for reasons that have nothing to do with a subtitle being wrong: a music
 * bed flattens the curve, a quiet opener flattens it, and people talking over a laugh track give silencedetect a ragged mask.
 * Asked as the gate it was never reached by anything in this library (0.03 to 0.24 over eleven real fits), so the fitter
 * corrected nothing at all on real audio. It stays as the window test and as the synthetic noise contract, where a real answer
 * scores 0.3 to 0.7 and an answer nowhere near the speech 0.03 to 0.09.
 */
export const CONFIDENCE_MIN = 0.25
/**
 * What the gate reads instead: the shape of the curve, not the gap to a rival. `peak` is the top of the score curve -- the
 * share of a subtitle's lines that start where speech starts at the best shift -- and `rival` is that same score 600 ms either
 * side of the answer. A subtitle whose lines sit on speech starts has a peak near 1 and a rival near 0; one fitted to a mask
 * that is not speech has no peak anywhere.
 *
 * Two numbers, because either one alone is fooled. The floor refuses a sharp but worthless curve, which is what a sparse mask
 * gives: Always Sunny S18E04 came out with runs of speech so rare that five hundred lines landed near one of them by chance --
 * peak 0.09, rival 0.02, four times the rival, and still nothing. The ratio refuses a high but flat curve, which is what a
 * music bed and a long quiet stretch give: every shift scores well, so the winner is luck.
 *
 * Measured on the real library with /tmp/syn/harness/measure.ts: the nine episodes that are properly masked came out at peak 0.20
 * to 0.42 with a rival of 0.007 to 0.09, and the two that are not at peak 0.09. 0.20 and 2.5 sit between those with room on
 * both sides. This is the only version of the feature that corrects real episodes, and it is deliberately on the tight side: a
 * shift that is wrong is worse than none, because the existing timing is usually close.
 */
export const PEAK_MIN = 0.2
/** How many times its own anti-peak the top of the curve has to be before the shift is believed. */
export const PEAK_OVER_FAR = 2.5
/**
 * How far from the answer the anti-peak is read. Wider than the 250 ms a line may be off and still count, so the skirt of a
 * good peak is not read as its own rival.
 */
export const FAR_MS = 600
/**
 * The finest a shift is ever applied. A line is scored against a 250 ms window around a speech start, so the statistic places
 * an answer to about a quarter second; serving the 50 ms step it searches on would claim a precision it does not have, and one
 * press of the player's nudge is a quarter second too. Every served offset is rounded to this, and one that rounds to nothing
 * is no correction at all.
 */
export const APPLY_STEP = 250
/** Fewer lines than this is not enough to tell a peak from luck, whatever the gap looks like. */
export const MIN_CUES = 12
/**
 * Which fitter made a measurement. It moves whenever fitSync or estimateOffset changes in a way that would have answered
 * differently, and every row made by an older one is measured again the next time its subtitle is played. Rows are cheap to
 * keep and a decode is not, so this is the only reason to re-decode a subtitle that was measured confidently. It was 1 while
 * the fitter was the one 0.3.89 shipped, and the column is added at 1 rather than 0: a subtitle measured before the column
 * existed was measured by that same fitter, so an update does not send the whole library through a decode again. It was 2 once
 * the score stopped counting lines that land anywhere inside a run of speech and started counting lines that start where the
 * speech starts. It is 3 since the gate stopped reading confidence and started reading the shape of the curve: a row written at
 * 2 has no peak and no rival stored, so the gate cannot be applied to it at all, and those rows have to be measured again
 * before anything can be decided about them.
 */
export const FIT_VERSION = 3
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

export interface Estimate { offsetMs: number; confidence: number; peak: number; rival: number; scored: number }

/**
 * The shift, in milliseconds, that puts the most cue starts where speech starts, and how sure that is. `cues` are start times in
 * milliseconds, `runs` the speech in seconds. `range` is how far either way to look; the whole-file search uses ±6 s.
 *
 * WHY THIS COUNTS STARTS AND NOT "INSIDE SPEECH". A binary speech mask made by silencedetect has one thing to say about a cue:
 * whether it is inside a run. But a line is inside its run for as long as it takes somebody to say it -- a second or three --
 * so every shift within a run's length scores the same, the score curve is a plateau as wide as the speech, and the answer is
 * the same whether the subtitle is right or half a second out. Measured on synthetic speech with real silencedetect output, a
 * line laid 500 ms late came back as "no shift needed" with 0.93 confidence, and a line laid 700 ms early came back as +750 ms
 * -- the wrong way, with the same 0.93. Where a run of speech *begins* is the only part of the mask that says when a line
 * should appear, so that is what a cue is scored against: a line counts when it starts within LEAD_MS before a run starts, or
 * ON_MS after it. A cue deep inside a long run says nothing either way and scores 0, which is honest: a mouth that never stops
 * moving cannot be timed.
 *
 * The answer is the middle of the plateau, not its edge, when the plateau excludes doing nothing. Any shift in the plateau is
 * equally good evidence, and its edge is always half a window short of the middle, so an edge answer would leave every
 * corrected subtitle a little bit out in the same direction -- the mistake this fitter exists to remove. When the plateau
 * contains zero the answer is zero: a shift that close to none cannot be believed, and a subtitle already on its marks is left
 * alone.
 */
export function estimateOffset(cues: number[], runs: Run[], range = RANGE): Estimate {
  if (!cues.length || !runs.length) return { offsetMs: 0, confidence: 0, peak: 0, rival: 0, scored: cues.length }
  // Where each run of speech begins, in milliseconds, sorted so a cue can be placed between two of them by bisection.
  const starts = runs.map((r) => Math.round(r.start * 1000)).sort((a, b) => a - b)
  const onALine = (t: number) => {
    let lo = 0, hi = starts.length - 1, before = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] <= t) { before = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (before >= 0 && t - starts[before] <= ON_MS) return true
    return before + 1 < starts.length && starts[before + 1] - t <= LEAD_MS
  }
  const lo = -Math.floor(range / STEP) * STEP
  const n = Math.floor(range / STEP) * 2 + 1
  const scores: number[] = []
  for (let i = 0; i < n; i++) {
    const shift = lo + i * STEP
    let s = 0
    for (const c of cues) if (onALine(c + shift)) s++
    scores.push(s / cues.length)
  }
  let best = 0
  for (let i = 1; i < n; i++) if (scores[i] > scores[best]) best = i
  let l = best, r = best
  while (l > 0 && scores[l - 1] >= scores[best] - 0.01) l--
  while (r < n - 1 && scores[r + 1] >= scores[best] - 0.01) r++
  const zero = (n - 1) / 2
  const pick = zero >= l && zero <= r ? zero : Math.round((l + r) / 2)
  const offsetMs = lo + pick * STEP
  // The rival is the best score away from the plateau itself, at least 500 ms past either end of it, not away from the one
  // point picked: a plateau is one answer seen with some blur, and only a separate peak is a reason to doubt it.
  const gap = APART / STEP
  let rival = -Infinity
  for (let i = 0; i < n; i++) if ((i < l - gap || i > r + gap) && scores[i] > rival) rival = scores[i]
  // The two numbers the gate reads (see PEAK_MIN). Both are read from the answer the fitter picked rather than from the plateau's
  // edges, so that everything the rule needs is in the row it stores: the edges are not kept, and a gate that needed them could
  // not be re-run later from what is on disk.
  const at = (ms: number) => scores[Math.round((ms - lo) / STEP)] ?? 0
  const rivalFar = Math.max(at(offsetMs - FAR_MS), at(offsetMs + FAR_MS))
  return { offsetMs, confidence: rival === -Infinity ? 0 : scores[best] - rival, peak: scores[best], rival: rivalFar, scored: cues.length }
}

export interface Fit { offsetMs: number; scale: number; confidence: number; peak: number; rival: number; cues: number }

/**
 * Offset and scale for a whole subtitle: the line `t' = t * scale + offset` that lines it up with the sound. An episode is
 * fitted in local windows of about 45 s of lines rather than in thirds, because one offset cannot see drift at all. A window
 * of lines can be lined up to the nearest tenth of a second only if the drift inside it is smaller than that, while 1% of a
 * five-minute third already spreads its lines over three seconds, so in a drifting file no shift fits a whole third, every
 * window's confidence collapses and the slope comes back as 1. Short windows keep the drift inside a window under a second,
 * where one offset does fit, and the slope of those offsets against their time is the frame rate. Fewer than four windows worth believing, or a slope too wild to be a
 * frame rate, and the flat answer is used instead: scale 1, one offset for the whole subtitle.
 */
export function fitSync(cues: number[], runs: Run[], _durationSec: number): Fit {
  const whole = estimateOffset(cues, runs)
  const flat: Fit = { offsetMs: whole.offsetMs, scale: 1, confidence: whole.confidence, peak: whole.peak, rival: whole.rival, cues: cues.length }

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

  const kept: { at: number; offset: number; confidence: number; peak: number; rival: number }[] = []
  for (const w of windows) {
    if (w.length < MIN_CUES) continue
    const at = w[w.length >> 1] // the median line of the chunk: its nominal time on the subtitle's own clock
    // A drifting file is far out by its end, so the search widens with how far into the episode a window sits: ±6 s plus 6%
    // of its own time, which covers a PAL transfer. Wider windows than that invite false peaks, which the gate rejects.
    const e = estimateOffset(w, runs, RANGE + 0.06 * at)
    if (e.confidence > CONFIDENCE_MIN) kept.push({ at, offset: e.offsetMs, confidence: e.confidence, peak: e.peak, rival: e.rival })
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
  // A drifting subtitle is served a slope as well as an offset, so the gate is handed the worst of the windows it believed: the
  // lowest peak and the highest rival. Judging drift on the whole-file curve instead would refuse every drifting subtitle there
  // will ever be, because no single shift fits one -- which is the reason for the windows in the first place.
  return { offsetMs: Math.round(meanO - a * meanT), scale, confidence: Math.min(...kept.map((p) => p.confidence)), peak: Math.min(...kept.map((p) => p.peak)), rival: Math.max(...kept.map((p) => p.rival)), cues: cues.length }
}

export interface SyncRow { offset_ms: number; scale: number; confidence: number; cues: number; peak?: number; rival?: number; fit_version?: number; measured_at?: number }

/**
 * Whether a stored measurement is a good enough answer to be worth anything: enough lines, a peak worth calling a peak, and a
 * peak standing clear of the score 600 ms away. BOTH readers of a row go through this -- what is served (syncApplies) and
 * whether it is worth measuring again (needsMeasure) -- so a row cannot be one thing to one and another to the other. While
 * "sure" was a different rule from "applies", a row the gate refused was still re-decoded every seven days, a core per episode
 * per week spent to reach the same answer.
 */
function sure(r: SyncRow): boolean {
  const peak = r.peak ?? 0
  return r.cues >= MIN_CUES && peak >= PEAK_MIN && peak >= PEAK_OVER_FAR * (r.rival ?? 0)
}

/** The shift a measured offset is served as: a quarter second at a time, and nothing at all for one too small to resolve. */
export function appliedOffset(ms: number): number {
  return Math.sign(ms) * Math.round(Math.abs(ms) / APPLY_STEP) * APPLY_STEP
}

/** Whether a stored measurement is sure enough to be used, and actually moves something. */
export function syncApplies(r: SyncRow | undefined | null): boolean {
  return !!r && sure(r) && (appliedOffset(r.offset_ms) !== 0 || r.scale !== 1)
}

/** Whether a row should be measured again: made by an older fitter, or never sure of itself and old enough for another look. */
export function needsMeasure(r: SyncRow | undefined | null, at = Date.now()): boolean {
  if (!r) return true
  if ((r.fit_version ?? 0) < FIT_VERSION) return true
  // Sure, not "applies": a measurement that found no shift to make is a good answer and stays put like any other, however old.
  return !sure(r) && at - (r.measured_at ?? 0) * 1000 > RECHECK_MS
}

export function syncRow(t: number, f: number, key: string): SyncRow | undefined {
  try {
    return db.prepare('SELECT offset_ms, scale, confidence, cues, peak, rival, fit_version, measured_at FROM sub_sync WHERE torrent_id = ? AND file_index = ? AND subtitle_key = ?').get(t, f, key) as SyncRow | undefined
  } catch { return undefined }
}

/** One row per subtitle, replaced rather than added to: a second measurement of the same subtitle is a better answer, not another one. */
export function saveSync(t: number, f: number, key: string, fit: Fit) {
  db.prepare(`INSERT INTO sub_sync (torrent_id, file_index, subtitle_key, offset_ms, scale, confidence, cues, peak, rival, measured_at, fit_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torrent_id, file_index, subtitle_key) DO UPDATE SET offset_ms = excluded.offset_ms, scale = excluded.scale,
      confidence = excluded.confidence, cues = excluded.cues, peak = excluded.peak, rival = excluded.rival,
      measured_at = excluded.measured_at, fit_version = excluded.fit_version`)
    .run(t, f, key, fit.offsetMs, fit.scale, fit.confidence, fit.cues, fit.peak, fit.rival, now(), FIT_VERSION)
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
 *
 * The measurement's own offset goes out a quarter second at a time (APPLY_STEP): it is placed by a statistic that scores lines
 * against a 250 ms window, so serving the 50 ms grid it searches on would present a precision it does not have. A nudge is
 * served as given -- it is a person's number, and the endpoint only accepts whole quarter seconds anyway.
 */
export function shiftFor(t: number, f: number, key: string): Shift {
  const row = syncRow(t, f, key)
  const measured = syncApplies(row)
  const manual = manualOffset(t, f, key)
  const scale = measured && row ? row.scale : 1
  return { offsetMs: manual || (measured && row ? appliedOffset(row.offset_ms) : 0), scale, manual, measured }
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
