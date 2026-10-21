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

test('the episode being played opens the one after it, so Up next is offered from a fresh start', async () => {
  // /api/watch works the gates out before this play has counted: an episode opened from 0:00 had not been "started", so
  // the next one read as locked, no Up next came, and the end of the episode went back to the show page.
  const eps = [ep(1, true), ep(2), ep(3)]
  assert.equal(gatesFor(eps)[2].locked, true, 'before: E03 looks locked while E02 sits at 0:00')
  const playing = 1
  const now = gatesFor(eps.map((e, j) => (j === playing ? { ...e, position: Math.max(e.position, STARTED_AT + 1) } : e)))
  assert.equal(now[2].locked, false, 'counted as started, E02 opens E03')
  const server = (await import('node:fs')).readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(server, /const nowGates = gatesFor\(eps\.map\(\(e, j\) => \(j === i \? \{ \.\.\.e, position: Math\.max\(e\.position, STARTED_AT \+ 1\) \} : e\)\)\)/)
  assert.match(server, /const nextOpen = ni >= 0 && !nowGates\[ni\]\.locked/)
})

test('the episode a show is on is the one played last, not the first with any progress', async () => {
  const { currentEpisode } = await import('../src/episodes.ts')
  const e = (watched: boolean, position: number, lastAt: number, available = true) => ({ watched, position, lastAt, available })
  // E01 left in its credits long ago, E02 and E03 watched since: the show is on E04, not back on E01.
  assert.equal(currentEpisode([e(false, 1300, 100), e(true, 0, 200), e(true, 0, 300), e(false, 0, 0)]), 3)
  // Partway through the last one played: that one, from where it was.
  assert.equal(currentEpisode([e(true, 0, 100), e(false, 600, 200), e(false, 0, 0)]), 1)
  // A rewatch of an early episode that is still going is where the show is.
  assert.equal(currentEpisode([e(false, 500, 400), e(true, 0, 200), e(false, 0, 0)]), 0)
  // The next one is not available yet: nothing to resume (the show page falls back to its own first-unwatched rule).
  assert.equal(currentEpisode([e(true, 0, 100), e(false, 0, 0, false)]), -1)
  // Never started.
  assert.equal(currentEpisode([e(false, 0, 0), e(false, 10, 50)]), -1)
})
