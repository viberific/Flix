// The "Up next" box is meant to appear when the credits start, not when the file ends. Two things have to be right for
// that: the moment has to be found (measured once, from ffmpeg, when the file finished downloading) and the player has to
// be willing to use it (the gate that decides whether there is anything to work with yet).
//
// So these pin three things. The picker: what a real ffmpeg stderr looks like, and which black run among them is the
// credits. The clock: ffmpeg reports from where it was told to seek, and those times have to go back onto the file's own
// timeline. And the client's own code, lifted out of public/app.js between its two markers and run here, which is the only
// way to test the gate that used to leave nothing but the end of the file able to raise the box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-credits-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'

const { parseBlackdetect, parseSilencedetect, shiftRuns, pickCreditsAt, saveCredits, creditsAt, creditsNeedsWork, creditsRow } =
  await import('../src/credits.ts')

// ---- what ffmpeg actually says -------------------------------------------------------------------------------------

// A 45-minute episode (2700s), looked at from 2025s -- three quarters of it. The credits go black at 2640 and stay black
// to the end, and the sound stops at 2605. Times are relative to the seek, which is ffmpeg's own habit.
const SEEK = 2025
const VLOG = `ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers
  built with gcc 13.2.0 (Alpine 13.2.1_git20231014)
[blackdetect @ 0x55c1f4e2d300] black_start:615 black_end:675 black_duration:60
`
const ALOG = `[silencedetect @ 0x55c1f4e2d8c0] silence_start: 580.2
[silencedetect @ 0x55c1f4e2d8c0] silence_end: 675 | silence_duration: 94.8
`

test('a black run and a silence run are read out of the lines ffmpeg prints', () => {
  assert.deepEqual(parseBlackdetect(VLOG), [{ start: 615, end: 675 }])
  assert.deepEqual(parseSilencedetect(ALOG, 675), [{ start: 580.2, end: 675 }])
  // Nothing to find in a log with nothing in it, and never a throw: a file with no black at all is an ordinary file.
  assert.deepEqual(parseBlackdetect(''), [])
  assert.deepEqual(parseSilencedetect('', 100), [])
})

test('a silence that never ends runs to the end of what was looked at', () => {
  // A file that ends quiet never prints silence_end: that is the shape of silence over end credits.
  assert.deepEqual(parseSilencedetect('[silencedetect @ 0x1] silence_start: 42.5\n', 675), [{ start: 42.5, end: 675 }])
})

test('times come back onto the file\'s own clock, not the seek\'s', () => {
  assert.deepEqual(shiftRuns([{ start: 615, end: 675 }], SEEK), [{ start: 2640, end: 2700 }])
  assert.deepEqual(shiftRuns([{ start: 1, end: 2 }], 0), [{ start: 1, end: 2 }])
})

// ---- which run is the credits --------------------------------------------------------------------------------------

test('black from 2640s of a 2700s episode, with silence -> the credits start at 2640', () => {
  const black = shiftRuns(parseBlackdetect(VLOG), SEEK)
  const silence = shiftRuns(parseSilencedetect(ALOG, 675), SEEK)
  assert.equal(pickCreditsAt(black, silence, 2700), 2640)
})

test('black in the middle of an episode is not the credits', () => {
  // 30% into a 2700s episode: a scene change, a cut to black, a title card. Not what the box is waiting for.
  assert.equal(pickCreditsAt([{ start: 810, end: 900 }], [{ start: 810, end: 900 }], 2700), null)
})

test('black with no silence, well short of the end, is not the credits either', () => {
  // 600..680 of 2700: black and quiet is not enough on its own, because it has to run out of episode or be followed by
  // silence that is where the credits are.
  assert.equal(pickCreditsAt([{ start: 600, end: 680 }], [], 2700), null)
})

test('a black that is held to the end is the credits even with the theme still playing', () => {
  assert.equal(pickCreditsAt([{ start: 2660, end: 2700 }], [], 2700), 2660)
})

test('a silence that starts just after the picture comes back still counts', () => {
  // Fade to black, then the music stops a few seconds in.
  assert.equal(pickCreditsAt([{ start: 2400, end: 2440 }], [{ start: 2444, end: 2700 }], 2700), 2400)
})

test('a black run too short to be a card is passed over for the one after it', () => {
  const black = [{ start: 2500, end: 2502 }, { start: 2620, end: 2700 }]
  assert.equal(pickCreditsAt(black, [], 2700), 2620)
})

test('a very black episode under 55% of its runtime is never called credits', () => {
  // Half an episode of night footage that runs to the end: the sanity rule is what stops the box arriving at the interval.
  assert.equal(pickCreditsAt([{ start: 1350, end: 2700 }], [{ start: 1350, end: 2700 }], 2700), null)
})

test('no runtime, no answer', () => {
  assert.equal(pickCreditsAt([{ start: 2640, end: 2700 }], [], 0), null)
  assert.equal(pickCreditsAt([{ start: 2640, end: 2700 }], [], NaN), null)
})

// ---- the marker as it is remembered --------------------------------------------------------------------------------

test('a measured marker survives, and a marker measured for a different runtime is not used', () => {
  saveCredits(101, 0, 2640, 2700)
  assert.equal(creditsAt(101, 0, 2700), 2640)
  // The file was replaced by a longer cut: the stored second means nothing now, so the player estimates instead.
  assert.equal(creditsAt(101, 0, 3300), null)
  // 2% of slack either way, because a probe and a remux round differently.
  assert.equal(creditsAt(101, 0, 2710), 2640)
})

test('a file looked at twice with nothing to find is left alone', () => {
  assert.equal(creditsNeedsWork(202, 1), true) // never looked at
  saveCredits(202, 1, null, 2700)
  // One retry: a pass can hit a file the box was still busy with, and one quiet failure should not be final.
  assert.equal(creditsNeedsWork(202, 1), true)
  saveCredits(202, 1, null, 2700)
  assert.equal(creditsNeedsWork(202, 1), false)
  assert.equal(creditsAt(202, 1, 2700), null)
  assert.deepEqual(creditsRow(202, 1), { at: null, duration: 2700, tries: 2 })
})

test('a marker that lands somewhere absurd is refused however it got stored', () => {
  saveCredits(303, 0, 100, 2700) // under 55%: a corrupt row, or a file that is not what it was
  assert.equal(creditsAt(303, 0, 2700), null)
  saveCredits(303, 1, 2699, 2700) // the last second is not a credits sequence
  assert.equal(creditsAt(303, 1, 2700), null)
})

// ---- the gate in the player itself ----------------------------------------------------------------------------------

// public/app.js is served as it is, not compiled, so the shipped code is lifted out of the file by its markers and run.
// That is deliberate: a copy of the function here would pass while the file the browser loads was still wrong.
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const from = appJs.indexOf('/* credits-begin */'), to = appJs.indexOf('/* credits-end */')
assert.ok(from > 0 && to > from, 'public/app.js still marks the credits block')
type Moment = { at: number | null; dur: number; from: string | null }
const make = new Function(`${appJs.slice(from, to)}\nreturn { knownDuration, creditMoment }`) as () =>
  { knownDuration: (i: any, e: any) => number; creditMoment: (i: any, e: any) => Moment }
const { knownDuration, creditMoment } = make()

test('the gate: no probe duration, but the player knows one -> there is a moment to wait for', () => {
  // This is the bug. /info came back with no duration (HLS, some direct plays) and there were no chapters, so the moment
  // was never worked out and nothing but the `ended` event could raise the box.
  const m = creditMoment({ chapters: [] }, { duration: 2700 })
  assert.equal(m.at, 2700 - 150)
  assert.equal(m.from, 'estimate')
  assert.equal(knownDuration({}, { duration: 2700 }), 2700)
})

test('the gate: nothing known at all is still null, so the box waits rather than guessing', () => {
  assert.equal(creditMoment({}, { duration: NaN }).at, null)
  assert.equal(creditMoment({}, { duration: 0 }).at, null)
  assert.equal(creditMoment(null, null).at, null)
})

test('a chapter named for the credits beats the measured marker, which beats the estimate', () => {
  const info = { duration: 2700, creditsAt: 2610, chapters: [{ start: 2655, end: 2700, title: 'End Credits' }] }
  assert.deepEqual(creditMoment(info, { duration: 2700 }), { at: 2655, dur: 2700, from: 'chapter' })
  assert.deepEqual(creditMoment({ duration: 2700, creditsAt: 2610 }, { duration: 2700 }), { at: 2610, dur: 2700, from: 'marker' })
  assert.equal(creditMoment({ duration: 2700 }, { duration: 2700 }).from, 'estimate')
})

test('a marker past the end of the episode is ignored in favour of the estimate', () => {
  assert.equal(creditMoment({ duration: 2700, creditsAt: 2699 }, { duration: 2700 }).from, 'estimate')
  assert.equal(creditMoment({ duration: 2700, creditsAt: 0 }, { duration: 2700 }).from, 'estimate')
})

test('the estimate is 8% of the runtime, held between 45 seconds and two and a half minutes', () => {
  assert.equal(creditMoment({ duration: 1800 }, null).at, 1800 - 144) // 8% is inside the clamp
  assert.equal(creditMoment({ duration: 2700 }, null).at, 2700 - 150) // clamped down to 150
  assert.equal(creditMoment({ duration: 10800 }, null).at, 10800 - 150) // a film: same two and a half minutes
  assert.equal(creditMoment({ duration: 400 }, null).at, 400 - 45) // clamped up to 45
  assert.equal(creditMoment({ duration: 30 }, null).at, 0) // never a negative second
})
