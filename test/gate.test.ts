import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { gatesFor, gatedNote, shortEp, STARTED_AT } = await import('../src/gate.ts')

/** Episodes in playing order, in the shape buildEpisodes returns the three fields the rule uses. */
const ep = (n: number, watched = false, position = 0) => ({ label: `S01E0${n}`, watched, position })
const open = (g: { locked: boolean }) => !g.locked

test('the first episode of a show is always open', () => {
  const g = gatesFor([ep(1), ep(2), ep(3)])
  assert.equal(open(g[0]), true)
})

test('the rest wait their turn, one behind the other', () => {
  const g = gatesFor([ep(1), ep(2), ep(3), ep(4)])
  assert.deepEqual(g.map(open), [true, false, false, false])
  assert.equal(g[1].after, 'S01E01')
  assert.equal(g[3].after, 'S01E03')
})

test('a watched episode opens the one after it, and only that one', () => {
  const g = gatesFor([ep(1, true), ep(2), ep(3)])
  assert.deepEqual(g.map(open), [true, true, false])
})

test('an episode started but not finished opens the next as well', () => {
  const g = gatesFor([ep(1, false, STARTED_AT + 1), ep(2), ep(3)])
  assert.deepEqual(g.map(open), [true, true, false])
  // exactly at the threshold is not yet started
  const h = gatesFor([ep(1, false, STARTED_AT), ep(2)])
  assert.equal(open(h[1]), false)
})

test('an episode that was itself started is never locked again, so a resume always works', () => {
  const g = gatesFor([ep(1, true), ep(2, false, 0), ep(3, false, 600)])
  assert.equal(open(g[2]), true) // E03 was started, even though E02 was not
})

test('a watched episode can be watched again, and opens the one after it', () => {
  const g = gatesFor([ep(1), ep(2, true), ep(3)])
  // E02 itself is always open (it has been watched, so a re-watch is not a skip), and it in turn opens E03.
  assert.deepEqual(g.map(open), [true, true, true])
})

test('the note names the episode that comes first, the way it is said out loud', () => {
  assert.equal(shortEp('S01E03'), 'E03')
  assert.equal(shortEp('S12E10'), 'E10')
  assert.equal(shortEp('Season 1'), 'Season 1')
  assert.equal(gatedNote('S02E07'), 'Watch E07 first')
})
