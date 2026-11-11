// The player's auto-quality ladder used to read every stall as "a connection slower than the file". On 2026-11-04 that was
// wrong: gigabit ethernet, a file already on the box's own disk, and the stalls were ffmpeg failing to make segments --
// yet the picture stepped 960 -> 720 -> 640, each rung starting another encoder on the same four cores.
//
// public/app.js is served as it is, not compiled, so the shipped rule is lifted out of the file by its markers and run
// here. A copy in this file would pass while the browser was still running the old one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const from = app.indexOf('/* stall-begin */'), to = app.indexOf('/* stall-end */')
assert.ok(from > 0 && to > from, 'public/app.js still marks the stall block')
const stallBlamesLine = new Function(`${app.slice(from, to)}\nreturn stallBlamesLine`)() as (stallMs: number, lateMs: number) => boolean

test('a stall the box was late for is not a slow connection', () => {
  // The measured shape of it: 3.5 s waiting for a segment the box had not made yet, over a gigabit line.
  assert.equal(stallBlamesLine(3500, 3500), false)
  assert.equal(stallBlamesLine(3500, 1200), false)
  assert.equal(stallBlamesLine(10_000, 9000), false)
})

test('a stall the box had nothing to do with still steps the picture down, exactly as before', () => {
  assert.equal(stallBlamesLine(3500, 0), true)
  assert.equal(stallBlamesLine(3500, NaN), true)
  assert.equal(stallBlamesLine(3500, -1), true)
  // A little lateness beside a long stall is still mostly the line's doing.
  assert.equal(stallBlamesLine(20_000, 1000), true)
})

test('a tenth of a second of lateness does not excuse a long stall', () => {
  assert.equal(stallBlamesLine(6000, 400), true)
  assert.equal(stallBlamesLine(6000, 1800), false)
})
