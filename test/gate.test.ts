import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { shortEp } = await import('../src/gate.ts')

test('short episode names read as E03; anything else is left alone', () => {
  assert.equal(shortEp('S01E03'), 'E03')
  assert.equal(shortEp('S02E10'), 'E10')
  assert.equal(shortEp('Season 1'), 'Season 1')
})

test('no episode is locked by order any more: the server sends no gate, and /api/opened is gone', async () => {
  const fs = await import('node:fs')
  const server = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(server, /gatesFor|gatedNote|\/api\/opened|autoFirst/)
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
