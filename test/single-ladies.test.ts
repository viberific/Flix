// The Single Ladies S01E01 stall (19:12, 2026-10-25). Two defects, both here as regressions:
//
// A. The copy plan's playlist and the media it points at disagreed. The plan is cut on the film's own keyframes (b[],
//    every 4.004 s of a 2 h 6 GB WEB-DL) and each piece is cut for exactly its declared length -- but ffmpeg's input seek
//    lands on the keyframe at or BEFORE the time asked, so a piece's picture begins up to one keyframe interval early and
//    therefore ENDS one interval short of where the playlist says it ends. Seeking to 1152.3 s asked for a place in the last
//    second of the piece [1149.148, 1153.152) where the media had already stopped at 1151.067: nothing to show, hls.js
//    re-seeked to the same second every 38 s and stalled, for ever. Measured on the box's own ffmpeg 7.1.5, not guessed.
//    The same run also proved the second half: the cached keyframe list for that file stops at 4952.9 s of a ~7568 s film,
//    so the plan's last piece spanned the remaining 43 minutes.
//
// B. The logo overlay only came down when the play clock moved FORWARD (t > seenT + 0.2, and `moving ||` in
//    ontimeupdate). A copy plan that re-seeks backwards never satisfies that, so the logo sat over a playing episode.
//
// Everything here is pure: no ffmpeg, no network, so it runs everywhere the unit tests do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEG, copyBounds, copyPieceLen, copyPlanFor } from '../src/transcode.ts'
import { holdsDataAt, isPlaying } from '../public/playclock.js'

// The real numbers, from the box: keyframes every 2.002 s, and b[287] / b[288] as the live job used them.
const B287 = 1149.148
const B288 = 1153.152
const GAP = 2.002
const FILM = 7568 // ~2 h 6 m, the premiere

const plan = () => {
  const b: number[] = []
  for (let t = 0; t + GAP < FILM; t += 2.002) b.push(Number(t.toFixed(3)))
  return copyBounds(b, FILM, SEG)!
}

test('a copied piece covers its own declared span, so a seek into its last second finds picture', () => {
  const b = plan()
  const n = 287
  assert.equal(b[n], B287)
  assert.equal(b[n + 1], B288)

  // What the piece really holds: the seek always starts one keyframe interval early (that is the demuxer, whatever is
  // asked for), and then runs for whatever length the cut asked ffmpeg for.
  const covered = (from: number, to: number, cutGap: number) => b[from] - GAP + copyPieceLen(b, from, to, cutGap)

  // Before the fix the run was cut for the declared length alone, and the piece stopped 2 s short of 1153.152 -- which is
  // the hole 1152.3 fell into.
  assert.ok(covered(n, n + 1, 0) < B288, 'without the overlap the piece must fall short, or this test proves nothing')
  assert.ok(covered(n, n + 1, 0) < 1152.3, 'the failing case: the media ends before the seek target')
  assert.ok(covered(n, n + 1, GAP) >= B288, 'with one keyframe interval the piece reaches its declared end')
  assert.ok(covered(n, n + 1, GAP) > 1152.3)

  // And the same holds for every piece in the plan, not just the one that was reported.
  for (let i = 0; i < b.length - 1; i++) assert.ok(covered(i, i + 1, GAP) >= b[i + 1] - 0.001, `piece ${i} does not reach its end`)
})

test('a probe that ran out of time cannot become a seek target', () => {
  const kf = [0, 2.002, 4.004]
  // Real report #12: "ffprobe failed (signal=SIGTERM killed=true)" -- killed at its budget, so no duration was ever read.
  assert.equal(copyPlanFor(kf, { duration: undefined }, true), null)
  assert.equal(copyPlanFor(kf, {}, true), null)
  assert.equal(copyPlanFor(kf, { duration: 0 }, true), null)
  assert.equal(copyPlanFor(kf, { duration: Number.NaN }, true), null)
  // A file still arriving has no plan either, whatever the probe said.
  assert.equal(copyPlanFor(kf, { duration: 40 }, false), null)
  // No keyframes read is not a plan.
  assert.equal(copyPlanFor(null, { duration: 40 }, true), null)
  assert.equal(copyPlanFor([], { duration: 40 }, true), null)
  // A truthful probe of a whole file is, and it starts at the file's own first timestamp.
  const healthy: number[] = []
  for (let t = 0; t < 40; t += 2.002) healthy.push(Number(t.toFixed(3)))
  const ok = copyPlanFor(healthy, { duration: 40, startTime: 0 }, true)
  assert.deepEqual(ok, [0, 4.004, 8.008, 12.012, 16.016, 20.02, 24.024, 28.028, 32.032, 36.036, 40])
})

test('a keyframe list that stops early is refused instead of becoming one 43-minute piece', () => {
  // The list on the box ended at 4952.948 s while the film runs to 7568 s.
  const truncated = [0, 2.002, 4.004, 4950.946, 4952.948]
  assert.equal(copyBounds(truncated, FILM, SEG), null, 'a plan with a 43-minute final piece must be refused')
  // A healthy list of the same film is fine.
  assert.ok(copyBounds(plan(), FILM, SEG))
  // A short tail is not a truncation: the last second folds into the piece before it.
  const tail = []
  for (let t = 0; t < 40; t += 2.002) tail.push(Number(t.toFixed(3)))
  const b = copyBounds(tail, 40.5, SEG)!
  assert.equal(b[b.length - 1], 40.5)
})

test('the logo comes down on a clock that jumped backwards, and a real wait still shows the ring', () => {
  const video = (o: Record<string, unknown> = {}) => ({
    paused: false, ended: false, readyState: 2, currentTime: 0,
    buffered: { length: 1, start: () => 1149.1, end: () => 1153.2 },
    ...o,
  })

  // The reported case: playing, readyState 2 (HAVE_CURRENT_DATA), and the clock back where it was 2 s ago.
  const jumpedBack = video({ currentTime: 1152.3 })
  assert.equal(isPlaying(jumpedBack), true, 'a backwards jump is still a picture that plays')
  // The old rule, for the record: the clock did not go forward, so it called this not playing and kept the logo up.
  assert.equal(1152.3 > 1154.9 + 0.2, false)

  // Honest waits: nothing buffered, paused, ended, or still waiting for the seek to arrive.
  assert.equal(isPlaying(video({ readyState: 1 })), false)
  assert.equal(isPlaying(video({ paused: true })), false)
  assert.equal(isPlaying(video({ ended: true })), false)
  assert.equal(isPlaying(video({ buffered: { length: 0, start: () => 0, end: () => 0 } })), false)
  assert.equal(isPlaying(video({ buffered: { length: 1, start: () => 1140, end: () => 1151 } })), false, 'a buffer that ends before the playhead is not data at it')
  assert.equal(holdsDataAt(video(), 1152.3), true)
  assert.equal(holdsDataAt(video({ buffered: { length: 0, start: () => 0, end: () => 0 } }), 1152.3), false)
})
