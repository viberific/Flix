import { test } from 'node:test'
import assert from 'node:assert/strict'

// The query behind "copy an episode ahead of the play" named a column `group`, which SQLite reads as the GROUP BY keyword.
// Every tick threw, once a minute, for 1320 ticks between 0.3.89 and 0.3.96, and not one episode was ever copied ahead:
// the fix is a statement that parses, so this test runs the real statement against real rows and reads what comes back.
// The engine is stubbed, because a file list from qBittorrent is the one thing a test cannot have.
process.env.DB_PATH = ':memory:'
// Nothing answers on these: the one test that lets a build run needs it to fail at once, not to find a real engine.
process.env.QB_URL = 'http://127.0.0.1:9'
process.env.PORT = '9'
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

// One copy is started per tick, and it is always the head of this list. A file that can never be built must therefore not
// stay at the head of it: the .nfo beside an episode was picked every minute for ever, and nothing behind it was built.
test('only the videos in a download are candidates', async () => {
  const mixed: Files = async (hash: string) => hash === 'mixed' ? [
    { index: 0, size: 900, progress: 1, priority: 1, name: 'Show.S01E01/Show.S01E01.mkv' },
    { index: 1, size: 1, progress: 1, priority: 1, name: 'Show.S01E01/Show.S01E01.nfo' },
    { index: 2, size: 2, progress: 1, priority: 1, name: 'Show.S01E01/Show.S01E01.en.srt' },
    { index: 3, size: 50, progress: 1, priority: 1, name: 'Show.S01E01/Sample/sample.mkv' },
  ] : []
  seed(4, 'mixed', { addedAt: 4000 })
  const list = await prebuildCandidates(mixed)
  assert.deepEqual(list.filter((c) => c.torrentId === 4).map((c) => c.fileIndex), [0])
})

test('a file that could not be built stands aside, so the one behind it gets its turn', async () => {
  const { prebuildOne } = await import('../src/prebuild.ts')
  const two: Files = async (hash: string) => hash === 'broken' ? [{ index: 0, size: 1000, progress: 1, priority: 1, name: 'S29E06.mkv' }]
    : hash === 'behind' ? [{ index: 0, size: 1000, progress: 1, priority: 1, name: 'S29E07.mkv' }] : []
  seed(6, 'behind', { addedAt: 5000 })
  seed(5, 'broken', { addedAt: 6000 }) // the newest download, so it is the head of the queue
  const head = (await prebuildCandidates(two))[0]
  assert.deepEqual([head.torrentId, head.fileIndex], [5, 0])
  // Nothing is in the engine and there is no file to read, so this build fails -- as it would for a file ffprobe cannot open.
  assert.equal(await prebuildOne(5, 0), null)
  const after = await prebuildCandidates(two)
  assert.equal(after.some((c) => c.torrentId === 5), false, 'the one that failed is not offered again straight away')
  assert.deepEqual([after[0].torrentId, after[0].fileIndex], [6, 0], 'and the next download is now the head of the queue')
})
