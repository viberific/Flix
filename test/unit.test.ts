import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { parseGroupName, isVideo } = await import('../src/btn/parse.ts')
const { seedStatus } = await import('../src/retention.ts')
const { config } = await import('../src/config.ts')

test('BTN seeding requirement is fixed at 130h OR 1:1', () => {
  assert.equal(config.seed.minHours, 130)
  assert.equal(config.seed.minRatio, 1)
  assert.equal(config.seed.mode, 'any')
})

test('seedStatus: either condition is enough', () => {
  const size = 1000
  assert.equal(seedStatus({ uploaded: 0, total_size: size, seeding_time: 0 }).met, false)
  assert.equal(seedStatus({ uploaded: 999, total_size: size, seeding_time: 129 * 3600 }).met, false)
  assert.equal(seedStatus({ uploaded: 1000, total_size: size, seeding_time: 0 }).met, true) // 1:1
  assert.equal(seedStatus({ uploaded: 0, total_size: size, seeding_time: 130 * 3600 }).met, true) // 130h
})

test('ratio is measured against full torrent size', () => {
  assert.equal(seedStatus({ uploaded: 500, total_size: 1000, seeding_time: 0 }).ratio, 0.5)
})

test('parseGroupName', () => {
  assert.deepEqual(parseGroupName('Some Show - S02E05'), { season: 2, episode: 5, label: 'S02E05', isPack: false })
  assert.deepEqual(parseGroupName('Some Show - Season 3', 'Season'), { season: 3, episode: null, label: 'Season 3', isPack: true })
  const d = parseGroupName('Late Show - 2024.03.01')
  assert.equal(d.label, '2024-03-01'); assert.equal(d.season, 2024)
})

test('isVideo ignores samples and non-video', () => {
  assert.equal(isVideo('a/b.mkv'), true)
  assert.equal(isVideo('a/Sample.mkv'), false)
  assert.equal(isVideo('a/b.nfo'), false)
})
