// A .torrent link BTN no longer serves must not end the play. The dead release is recorded as dead, the next candidate
// for the same episode is played, and the person is only told when every copy is gone.
//
// The case this comes from (Get Jiro S01E04, live box): the cached listing held 2280208, whose download link answered
// HTTP 404 with an HTML page, while 2280735/2280736 beside it answered with real .torrents. Nothing was tried after the
// first failure, and the play died on "Failed to download .torrent (HTTP 404)".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-dead-'))
// env has to be set before the modules are imported: config reads it at import time.
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = tmp
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.BTN_API_URL = 'http://127.0.0.1:18896/'

const PORT = 18895
let stub: Server
let answer: { status: number; body: string } = { status: 200, body: 'd4:infod4:name4:teste' }

const { db, now } = await import('../src/db.ts')
const { fetchTorrentFile, DeadTorrentLinkError } = await import('../src/btn/client.ts')
const { withSourceFallback } = await import('../src/streaming.ts')

before(async () => {
  stub = createServer((_req, res) => {
    res.writeHead(answer.status, { 'content-type': 'text/html' })
    res.end(answer.body)
  })
  await new Promise<void>((r) => stub.listen(PORT, '127.0.0.1', () => r()))
})
after(() => { stub.close() })

/** One release row, as the catalog stores a single episode: the same shape 2280208 and 2280736 have. */
function release(id: number, o: { seriesId: number; seeders?: number; size?: number; time?: number; isPack?: number; season?: number; episode?: number | null }) {
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, season, episode, label, group_name, is_pack, resolution, codec, size, seeders, "time", info_hash, torrent_link, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, o.seriesId, 'Get Jiro', o.season ?? 1, o.episode ?? 4, o.isPack ? 'Season 1' : 'S01E04', 'GROUP', o.isPack ?? 0,
    '1080p', 'H.264', o.size ?? 970_313_565, o.seeders ?? 10, o.time ?? 1, String(id).padStart(40, 'a'),
    `http://127.0.0.1:${PORT}/${id}`, now())
}
const alive = (id: number) => (db.prepare('SELECT dead_at FROM releases WHERE torrent_id = ?').get(id) as any)?.dead_at ?? null

test('fetchTorrentFile: a link BTN no longer serves is a dead release, a refused one is not', async () => {
  answer = { status: 404, body: '<html><body>torrent not found</body></html>' }
  await assert.rejects(() => fetchTorrentFile(`http://127.0.0.1:${PORT}/x`), (e: any) => e instanceof DeadTorrentLinkError && e.permanent === true)
  answer = { status: 410, body: 'gone' }
  await assert.rejects(() => fetchTorrentFile(`http://127.0.0.1:${PORT}/x`), (e: any) => e instanceof DeadTorrentLinkError && e.permanent === true)
  // 403 is not proof the release is gone: BTN answers that for every release when it is refusing this address, so the
  // release is skipped for this play and the row is kept.
  answer = { status: 403, body: 'forbidden' }
  await assert.rejects(() => fetchTorrentFile(`http://127.0.0.1:${PORT}/x`), (e: any) => e instanceof DeadTorrentLinkError && e.permanent === false)
  // An answer that is not a torrent at all (a login page, an error page) is a dead link too.
  answer = { status: 200, body: '<html><body>please sign in</body></html>' }
  await assert.rejects(() => fetchTorrentFile(`http://127.0.0.1:${PORT}/x`), (e: any) => e instanceof DeadTorrentLinkError && e.permanent === true)
  // A real torrent body still comes back as bytes.
  answer = { status: 200, body: 'd4:infod4:name4:teste' }
  assert.equal((await fetchTorrentFile(`http://127.0.0.1:${PORT}/x`))[0], 0x64)
  // Anything else is an ordinary failure, not a dead release: it must not mark the release or move the play.
  answer = { status: 500, body: 'oops' }
  await assert.rejects(() => fetchTorrentFile(`http://127.0.0.1:${PORT}/x`), (e: any) => !(e instanceof DeadTorrentLinkError))
})

test('a dead link moves the play to the next candidate, twice if it has to', async () => {
  const seriesId = 9001
  release(11, { seriesId, seeders: 30 })
  release(12, { seriesId, seeders: 20 })
  release(13, { seriesId, seeders: 10 })
  const tried: number[] = []
  const got = await withSourceFallback(11, undefined, async (rel) => {
    tried.push(rel.torrent_id)
    if (rel.torrent_id !== 13) throw new DeadTorrentLinkError(`Failed to download .torrent (HTTP 404)`, true)
    return { torrentId: rel.torrent_id, fileIndex: 0 }
  })
  assert.deepEqual(tried, [11, 12, 13]) // the first attempt, then two more: the pick moved on both times
  assert.equal(got.fileIndex, 0)
  assert.ok(alive(11), 'the first dead release is remembered as dead')
  assert.ok(alive(12), 'and so is the second')
  assert.equal(alive(13), null, 'the release that played is not touched')
})

test('with every copy dead the play fails once, in plain words, and marks them all', async () => {
  const seriesId = 9002
  release(21, { seriesId, seeders: 30 })
  release(22, { seriesId, seeders: 20 })
  release(23, { seriesId, seeders: 10 })
  const tried: number[] = []
  await assert.rejects(() => withSourceFallback(21, undefined, async (rel) => {
    tried.push(rel.torrent_id)
    throw new DeadTorrentLinkError('Failed to download .torrent (HTTP 404)', true)
  }), (e: any) => {
    assert.match(e.message, /Every copy of this episode that BTN lists is gone/)
    assert.match(e.message, /3 tried/)
    assert.doesNotMatch(e.message, /HTTP|undefined|\[object/) // the message a viewer sees, not a stack
    return true
  })
  assert.deepEqual(tried, [21, 22, 23]) // it tried everything it had before giving up
  assert.ok(alive(21) && alive(22) && alive(23))
})

test('a 403 is skipped for this play but never written down', async () => {
  const seriesId = 9003
  release(31, { seriesId, seeders: 30 })
  release(32, { seriesId, seeders: 20 })
  const tried: number[] = []
  await withSourceFallback(31, undefined, async (rel) => {
    tried.push(rel.torrent_id)
    if (rel.torrent_id === 31) throw new DeadTorrentLinkError('Failed to download .torrent (HTTP 403)', false)
    return { torrentId: rel.torrent_id }
  })
  assert.deepEqual(tried, [31, 32])
  assert.equal(alive(31), null, 'a refused address must not empty the library')
})

test('a failure that is not about the link does not move the play', async () => {
  const seriesId = 9004
  release(41, { seriesId, seeders: 30 })
  release(42, { seriesId, seeders: 20 })
  const tried: number[] = []
  await assert.rejects(() => withSourceFallback(41, undefined, async (rel) => {
    tried.push(rel.torrent_id)
    throw new Error('Timed out waiting for torrent metadata from the tracker')
  }), /Timed out/)
  assert.deepEqual(tried, [41], 'a slow swarm on one release is not the next release\'s problem to fix')
  assert.equal(alive(41), null)
})
