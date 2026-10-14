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

const { pickRelease, qualityLabel } = await import('../src/pick.ts')
const { youtubeUrl } = await import('../src/catalog.ts')
const c = (id: number, resolution: string, o: any = {}) => ({ torrent_id: id, resolution, codec: 'H.264', seeders: 10, size: 1, on_server: false, ...o })

test('source pick: 1080p first, 4K only when there is no (living) 1080p', () => {
  assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p'), c(3, '720p')])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '2160p'), c(3, '720p')])!.torrent_id, 1) // no 1080p -> 4K
  assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p', { seeders: 0 })])!.torrent_id, 1) // dead 1080p is not "found"
  assert.equal(pickRelease([c(2, '1080p', { seeders: 0, on_server: true }), c(1, '2160p')])!.torrent_id, 2) // already on disk counts as alive
  assert.equal(pickRelease([c(3, '720p'), c(4, 'SD')])!.torrent_id, 3) // last resort
  assert.equal(pickRelease([]), undefined)
})

test('source pick tie-breaks: on-server, then H.264, then seeders', () => {
  assert.equal(pickRelease([c(1, '1080p', { seeders: 50 }), c(2, '1080p', { on_server: true, seeders: 1 })])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '1080p', { codec: 'H.265', seeders: 99 }), c(2, '1080p', { seeders: 5 })])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '1080p', { seeders: 5 }), c(2, '1080p', { seeders: 9 })])!.torrent_id, 2)
  assert.deepEqual(['1080p', '2160p', '1080i', 'SD'].map(qualityLabel), ['1080p', '4K', '1080p', 'SD'])
})

test('youtubeUrl only ever yields a youtube.com watch link', () => {
  assert.equal(youtubeUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(youtubeUrl('https://youtu.be/dQw4w9WgXcQ?t=3'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(youtubeUrl('javascript:alert(1)'), null)
  assert.equal(youtubeUrl(''), null)
})
