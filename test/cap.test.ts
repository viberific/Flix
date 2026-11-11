// The transcode job cap. What went wrong on the box on 2026-11-04 at 00:16:24Z was not that the cap was too low: it was
// that nothing enforced it. Three jobs ran for ONE play (a copied picture plus a 720 and a 640 step-down) with cap 1, the
// log said `starting a conversion over the job cap {cap:1,running:3}` and the box carried on regardless, at load 11.9-13.7.
//
// planCap is the decision on its own, so this runs without ffmpeg: the repo's CI has none.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { planCap } = await import('../src/transcode.ts')

const NOW = 1_750_000_000_000
const ACTIVE = 90_000
/** A job key as transcode.ts builds it: torrent:file:audio[:hdr][:x][:hNNN]. */
const key = (t: number, f: number, tag = '') => `${t}:${f}:0${tag}`
const enc = (k: string, touchedAgo: number) => ({ key: k, touched: NOW - touchedAgo, enc: true })
const copy = (k: string, touchedAgo: number) => ({ key: k, touched: NOW - touchedAgo, enc: false })

test('the job being started is not counted against the cap: one conversion alone fits', () => {
  const plan = planCap([], 1, key(7, 0, ':x'), true, NOW)
  assert.deepEqual(plan.close, [])
  assert.equal(plan.low, false)
  assert.equal(plan.encoders, 1)
})

test('three jobs for one play, cap 1: the two conversions the player left are closed, nothing runs over the cap', () => {
  // What the box was actually running: the copied picture (cheap, and the fallback a step back up needs), the 720 it
  // stepped down to 20 s ago, and the 640 being asked for now. Both conversions belong to the same playback.
  const view = [copy(key(2273108, 0), 4_000), enc(key(2273108, 0, ':x:h720'), 20_000)]
  const plan = planCap(view, 1, key(2273108, 0, ':x:h480'), true, NOW)
  assert.deepEqual(plan.close, [key(2273108, 0, ':x:h720')])
  assert.equal(plan.low, false)
  assert.equal(plan.encoders, 1, 'one play ends up with one conversion')
})

test('a copied picture never holds a slot: it is counted, closed or blamed for nothing', () => {
  const view = [copy(key(9, 1), 0), copy(key(9, 2), 0)]
  const plan = planCap(view, 1, key(9, 1, ':x'), true, NOW)
  assert.deepEqual(plan.close, [], 'a remux of a copied picture is not an encode and costs a fraction of a core')
  assert.equal(plan.low, false)
})

test('a live conversion on ANOTHER play is never closed to make room: the new one runs below it instead', () => {
  // The ninety-second rule, kept. 2 s ago someone was reading that job.
  const plan = planCap([enc(key(1, 0), 2_000)], 1, key(2, 0, ':x'), true, NOW)
  assert.deepEqual(plan.close, [])
  assert.equal(plan.low, true, 'a second screen is not turned away, it is niced under the first')
})

test('a conversion nobody is watching is closed to make room, whatever play it belongs to', () => {
  const plan = planCap([enc(key(1, 0), ACTIVE + 60_000)], 1, key(2, 0, ':x'), true, NOW)
  assert.deepEqual(plan.close, [key(1, 0)])
  assert.equal(plan.low, false)
})

test('the same playback keeps its slot until it is actually abandoned', () => {
  // Asked for a new size two seconds ago: the player is still reading the old one, so it is not taken away from it.
  const plan = planCap([enc(key(1, 0, ':x:h720'), 2_000)], 1, key(1, 0, ':x:h480'), true, NOW)
  assert.deepEqual(plan.close, [])
  assert.equal(plan.low, true)
})

test('a copy being started is never throttled and closes nothing', () => {
  const view = [enc(key(1, 0), 2_000)]
  const plan = planCap(view, 1, key(2, 0), false, NOW)
  assert.deepEqual(plan.close, [])
  assert.equal(plan.low, false)
  assert.equal(plan.encoders, 1)
})

test('two encodes fit a cap of two, and the third is the one that runs below', () => {
  const view = [enc(key(1, 0), 2_000)]
  const fits = planCap(view, 2, key(3, 0, ':x'), true, NOW)
  assert.deepEqual(fits.close, [])
  assert.equal(fits.low, false, 'one playing now plus this one is the second slot')
  assert.equal(fits.encoders, 2)
  const over = planCap([...view, enc(key(2, 0), 2_000)], 2, key(4, 0, ':x'), true, NOW)
  assert.deepEqual(over.close, [])
  assert.equal(over.low, true)
})

test('a cap of 0 or a negative is still one slot, not an unlimited box', () => {
  const plan = planCap([enc(key(1, 0), 2_000), enc(key(2, 0), 2_000)], 0, key(3, 0, ':x'), true, NOW)
  assert.equal(plan.cap, 1)
  assert.equal(plan.low, true)
})
