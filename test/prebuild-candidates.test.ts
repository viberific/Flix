import { test } from 'node:test'
import assert from 'node:assert/strict'

// The query behind "copy an episode ahead of the play" named a column `group`, which SQLite reads as the GROUP BY keyword.
// Every tick threw, once a minute, for 1320 ticks between 0.3.89 and 0.3.96, and not one episode was ever copied ahead:
// the fix is a statement that parses, so this test runs the real statement against real rows and reads what comes back.
// The engine is stubbed, because a file list from qBittorrent is the one thing a test cannot have.
process.env.DB_PATH = ':memory:'
const { db, now } = await import('../src/db.ts')
const { prebuildCandidates } = await import('../src/prebuild.ts')

type Files = Parameters<typeof prebuildCandidates>[0]

/** The engine's answer for one torrent: one whole file, one half-downloaded, and one the pack left switched off. */
const engine: Files = async (hash: string) => {
  if (hash === 'pack') return [
    { index: 0, size: 900, progress: 1, priority: 1, name: 'S29E01.mkv' },
    { index: 1, size: 900, progress: 1, priority: 0, name: 'S29E02.mkv' },
  ]
  if (hash === 'single') return [{ index: 0, size: 1000, progress: 1, priority: 1, name: 'S29E04.mkv' }]
  if (hash === 'partial') return [{ index: 0, size: 1000, progress: 0.4, priority: 1, name: 'S29E05.mkv' }]
  return []
}

function seed(torrentId: number, hash: string, opts: { isPack?: number; state?: string; addedAt: number }) {
  db.prepare('INSERT INTO releases (torrent_id, series, group_name, is_pack, info_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(torrentId, 'Rick and Morty', 'NTb', opts.isPack ?? 0, hash, now())
  db.prepare('INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (?, ?, ?, ?)')
    .run(torrentId, hash, opts.state ?? 'active', opts.addedAt)
}

test('a finished file on an active download is a candidate', async () => {
  seed(1, 'single', { addedAt: 1000 })
  const list = await prebuildCandidates(engine)
  assert.deepEqual(list.map((c) => [c.torrentId, c.fileIndex]), [[1, 0]])
})

test('a pack offers only the episode that was actually fetched', async () => {
  seed(2, 'pack', { isPack: 1, addedAt: 2000 })
  const list = await prebuildCandidates(engine)
  assert.deepEqual(list.filter((c) => c.torrentId === 2).map((c) => [c.torrentId, c.fileIndex]), [[2, 0]])
})

test('a download that is not half-downloaded, or is gone, offers nothing', async () => {
  const partial = await prebuildCandidates(engine)
  assert.equal(partial.some((c) => c.name === 'S29E05.mkv'), false)
  seed(3, 'single', { addedAt: 3000, state: 'removed' })
  const list = await prebuildCandidates(engine)
  assert.equal(list.some((c) => c.torrentId === 3), false)
})

test('a copy already asked for inside the keep window is not asked for again', async () => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('prebuild:1:0', String(now()))
  const list = await prebuildCandidates(engine)
  assert.equal(list.some((c) => c.torrentId === 1), false)
})
