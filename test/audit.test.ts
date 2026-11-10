// The bugs found by reading the whole app in one sitting (0.3.99), each held still by the smallest test that fails without
// its fix: a watch report with no length, a half-applied account change, a dead season pack counted as alive, a trending
// lookup that hammered TMDB, and an app shell that could not start offline.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const tmp = mkdtempSync(join(tmpdir(), 'flix-audit-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'

// A TMDB that is down: every call answers 500, and is counted.
let tmdbCalls = 0
const tmdb = createServer((_req, res) => { tmdbCalls++; res.statusCode = 500; res.end('{}') })
await new Promise<void>((r) => tmdb.listen(0, '127.0.0.1', r))
process.env.TMDB_API_URL = `http://127.0.0.1:${(tmdb.address() as AddressInfo).port}`
process.env.TMDB_API_KEY = 'k'

const { app } = await import('../src/server.ts')
const { db, now } = await import('../src/db.ts')
const { createUser, newSession } = await import('../src/auth.ts')
after(async () => { await app.close(); tmdb.close() })

const admin = createUser('Parent', 'a password', true)
const kid = createUser('Sam', '', false, ['TV-Y', 'TV-G'])
const cookie = `flix_session=${newSession(admin.id)}`
const post = (url: string, payload: unknown, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })

const rel = db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, label, season, episode, episode_end, is_pack, resolution, codec, seeders, info_hash, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,'1080p','H.264',?,?,0)`)

test('a watch report with no length is still kept, and still ends the episode', async () => {
  rel.run(900, 90, 'Show', 'Show - S01E01', 'S01E01', 1, 1, 1, 0, 5, 'h900')
  db.prepare('INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, position, duration) VALUES (?,?,?,?,?,?,?)').run(admin.id, 900, 0, now(), now(), 10, 1320)
  const row = () => db.prepare('SELECT position, duration, watched_at FROM interests WHERE user_id = ? AND torrent_id = 900').get(admin.id) as any
  // JSON has no NaN: a player that does not know the length yet sends null.
  const res = await post('/api/progress', { torrentId: 900, fileIndex: 0, position: 55, duration: null, ended: false })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(row().position, 55, 'the position is kept')
  assert.equal(row().duration, 1320, 'and the length already known is not thrown away for an unknown one')
  assert.equal(row().watched_at, null)
  const end = await post('/api/progress', { torrentId: 900, fileIndex: 0, position: 1300, ended: true })
  assert.equal(end.statusCode, 200, end.body)
  assert.ok(row().watched_at, 'ended counts as watched whatever the length said')
  // Nonsense names no row; it is not a server error.
  for (const body of [{}, { torrentId: 'x', fileIndex: null, position: 'soon' }]) {
    assert.equal((await post('/api/progress', body)).statusCode, 200)
    assert.equal((await post('/api/watched', body)).statusCode, 200)
    assert.equal((await post('/api/release', body)).statusCode, 200)
  }
})

test('an account change that is refused changes nothing at all', async () => {
  const before = db.prepare('SELECT allowed_ratings, is_admin, pin_hash FROM users WHERE id = ?').get(kid.id) as any
  // A good ratings list and a bad PIN in one request: the PIN refuses it, so the ratings must not have been saved.
  const bad = await post(`/api/admin/users/${kid.id}`, { allowedRatings: ['TV-Y'], pin: '12' }, 'PATCH')
  assert.equal(bad.statusCode, 400, bad.body)
  assert.deepEqual(db.prepare('SELECT allowed_ratings, is_admin, pin_hash FROM users WHERE id = ?').get(kid.id), before)
  // The only admin cannot be demoted, and the ratings sent along with that are not applied either.
  const last = await post(`/api/admin/users/${admin.id}`, { allowedRatings: ['TV-Y'], isAdmin: false }, 'PATCH')
  assert.equal(last.statusCode, 400, last.body)
  const me = db.prepare('SELECT allowed_ratings, is_admin FROM users WHERE id = ?').get(admin.id) as any
  assert.equal(me.is_admin, 1)
  assert.equal(me.allowed_ratings, null)
  const ok = await post(`/api/admin/users/${kid.id}`, { allowedRatings: ['TV-Y'], pin: '1234' }, 'PATCH')
  assert.equal(ok.statusCode, 200, ok.body)
  assert.deepEqual(JSON.parse(ok.body).allowed, ['TV-Y'])
  assert.equal(JSON.parse(ok.body).hasPin, true)
})

test('a season pack BTN no longer serves gives way to whole single episodes', async () => {
  const { listable, catalogChanged } = await import('../src/seasons.ts')
  const { buildEpisodes } = await import('../src/episodes.ts')
  // Three singles that are alive, and a pack whose listing still says 40 seeders but whose .torrent is gone.
  for (const e of [1, 2, 3]) rel.run(1000 + e, 100, 'Gone', `Gone - S01E0${e}`, `S01E0${e}`, 1, e, e, 0, 7, `h100${e}`)
  rel.run(1010, 100, 'Gone', 'Gone - Season 1', 'Season 1', 1, null, null, 1, 40, 'h1010')
  db.prepare('INSERT INTO series_sync VALUES (100, 0)').run()
  db.prepare(`INSERT INTO series_net (series_id, fetched_at, lang, season_counts, ver) VALUES (100, 0, 'en', '{"1":3}', 3)`).run()
  catalogChanged()
  assert.equal(listable().get(100)!.get(1), 'pack', 'a living pack leads, as it always has')
  db.prepare('UPDATE releases SET dead_at = ? WHERE torrent_id = 1010').run(now())
  catalogChanged()
  assert.equal(listable().get(100)!.get(1), 'episodes', 'a dead one does not, whatever its stale seeder count says')
  const eps = buildEpisodes(100, admin.id)
  assert.deepEqual(eps.map((e) => [e.label, e.available, e.isPack]), [['S01E01', true, false], ['S01E02', true, false], ['S01E03', true, false]])
})

test('a TMDB that is down is not asked for the trending shows again on every tick', async () => {
  const { refreshTrending } = await import('../src/networks.ts')
  tmdbCalls = 0
  await assert.rejects(refreshTrending())
  const first = tmdbCalls
  assert.ok(first >= 1)
  // The crawler calls this every two seconds. Until the retry time has passed it must not touch the network.
  for (let i = 0; i < 5; i++) assert.equal(await refreshTrending(), 0)
  assert.equal(tmdbCalls, first)
})

test('the app shell the service worker keeps holds every module the app imports', () => {
  const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
  const shell = /const SHELL = \[([^\]]*)\]/.exec(read('sw.js'))![1]
  const modules = ['app.js', 'downloads.js', 'playclock.js'].flatMap((f) => [...read(f).matchAll(/^import .* from '(\/[^']+)'/gm)].map((m) => m[1]))
  assert.ok(modules.includes('/playclock.js'))
  for (const m of modules) assert.ok(shell.includes(`'${m}'`), `${m} is imported by the app and must be in SHELL, or the app cannot start offline`)
})
