// A show with nothing left to watch must not be offered. Brian: "Some shows that aren't available yet show up, and they
// shouldn't." A show counts as available when `isAlive` in pick.ts says so of at least one of its releases: somebody is
// seeding it, or Flix already holds the file. A show where every copy is one BTN no longer serves (dead_at), or one
// nobody is seeding (seeders 0), opens onto a page where every episode says it cannot be played -- so it comes off the
// home rows and off Discover.
//
// What it must NOT do is take away the person's own things: a show already downloaded or seeding, one in My List, and one
// they are part-way through all stay exactly where they are. Measured against the endpoints themselves, so a surface that
// forgets to apply the rule fails here.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'flix-available-'))
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = dir
process.env.DOWNLOAD_DIR = join(dir, 'downloads')
process.env.LOG_LEVEL = 'fatal'
process.env.BTN_API_KEY = ''
process.env.TMDB_API_KEY = '' // nothing is looked up: the fixtures are what the test is about
process.env.OMDB_API_KEY = ''
process.env.TVMAZE_URL = ''
process.env.YOUTUBE_SEARCH_URL = ''
process.env.YOUTUBE_OEMBED_URL = ''

const { app } = await import('../src/server.ts')
const { db, now } = await import('../src/db.ts')
const { isAlive } = await import('../src/pick.ts')
const { candidatesFor } = await import('../src/candidates.ts')

// The shows this test is about, and eight ordinary ones so the home screen has rows to fill.
const DEAD = 91001 // every copy dead: BTN no longer serves it
const UNSOWN = 91002 // every copy visible, nobody seeding it
const LIVE = 91003 // a copy with seeders: available
const LOCAL = 91004 // dead, but the file is on the box: available, and it plays
const OURS = 91005 // dead, but in My List: theirs, so it stays there
const WATCHING = 91006 // dead, but half watched: theirs, so Continue watching keeps it
const FILLER = [91101, 91102, 91103, 91104, 91105, 91106, 91107, 91108]
const NAMES: Record<number, string> = {
  [DEAD]: 'Gone Show', [UNSOWN]: 'Unseeded Show', [LIVE]: 'Seeded Show', [LOCAL]: 'Downloaded Show',
  [OURS]: 'My List Show', [WATCHING]: 'Half Watched Show',
}
const ALL = [DEAD, UNSOWN, LIVE, LOCAL, OURS, WATCHING, ...FILLER]

/** One release, the way the catalog stores an episode: 1080p H.264, English, one episode in season 1. */
function release(id: number, seriesId: number, o: { seeders?: number; dead?: boolean }) {
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, series_poster, group_name, release_name, season, episode, label, is_pack,
      resolution, codec, size, seeders, time, info_hash, genres, dead_at, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, seriesId, NAMES[seriesId] ?? `Show ${seriesId}`, '/poster.jpg', `Show.S01.1080p`, `${NAMES[seriesId] ?? seriesId}.S01E01`, 1, 1, 'S01E01', 0,
    '1080p', 'x264', 1_000_000_000, o.seeders ?? 0, now(), `hash-${id}`, JSON.stringify(['Drama']), o.dead ? now() : null, now())
}

function show(id: number, o: { seeders?: number; dead?: boolean; onBox?: boolean } = {}) {
  release(id, id, { seeders: o.seeders ?? 0, dead: o.dead ?? false })
  db.prepare('INSERT OR REPLACE INTO series_sync (series_id, synced_at) VALUES (?,?)').run(id, now())
  db.prepare(`INSERT OR REPLACE INTO series_net (series_id, tmdb_id, streamer, network, first_air, popularity, notable, fetched_at, lang, season_counts, ver)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, 'HBO', 'HBO', '2024-01-01', 50, 1, now(), 'en', JSON.stringify({ 1: 1 }), 4)
  if (o.onBox) db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (?,?,'active',?)`).run(id, `hash-${id}`, now())
  return id
}

let cookie = ''
const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { cookie } })
  assert.equal(r.statusCode, 200, `${url} answered ${r.statusCode}: ${r.body}`)
  return r.json() as any
}
const ids = (list: any[]) => new Set<number>((list ?? []).map((r) => r.id))
/** Everything the home screen draws from its own picks: the billboard and every row under it. */
const homeRows = (body: any) => new Set<number>([...(body.hero ? [body.hero.id] : []), ...(body.sections ?? []).flatMap((s: any) => s.series.map((x: any) => x.id))])

test('signing in creates the admin account this test speaks as, and the library is set up', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/signup', payload: { name: 'admin', password: 'password123' } })
  assert.equal(r.statusCode, 200)
  cookie = String(r.headers['set-cookie']).split(';')[0]
  show(DEAD, { dead: true })
  show(UNSOWN, { seeders: 0 })
  show(LIVE, { seeders: 12 })
  show(LOCAL, { dead: true, onBox: true })
  show(OURS, { dead: true })
  show(WATCHING, { dead: true })
  FILLER.forEach((id) => show(id, { seeders: 5 }))
  // The person's own two: one on My List, one they are part-way through.
  db.prepare('INSERT INTO my_list (user_id, series_id, added_at) VALUES (1,?,?)').run(OURS, now())
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, file_name, created_at, updated_at, position, duration)
    VALUES (1,?,0,'Half.Watched.Show.S01E01.mkv',?,?,400,1400)`).run(WATCHING, now(), now())
  // A show becomes listable only once Flix knows its seasons, which is what a catalog change marks.
  const { catalogChanged } = await import('../src/seasons.ts')
  catalogChanged()
})

test('the rule itself: what counts as alive is exactly what the app calls available', () => {
  // isAlive is the one definition everything here follows: seeded, or already on the box.
  assert.equal(isAlive({ torrent_id: 1, resolution: '1080p', codec: 'x264', seeders: 12, size: 1, on_server: false }), true)
  assert.equal(isAlive({ torrent_id: 2, resolution: '1080p', codec: 'x264', seeders: 0, size: 1, on_server: false }), false)
  assert.equal(isAlive({ torrent_id: 3, resolution: '1080p', codec: 'x264', seeders: 0, size: 1, on_server: true }), true)
  assert.equal(isAlive({ torrent_id: 4, resolution: '1080p', codec: 'x264', seeders: 40, size: 1, on_server: false, dead: 1 }), false)
  // And the fixture says what this test thinks it says: the dead show has no living release, the live one has.
  assert.equal(candidatesFor(DEAD).filter(isAlive).length, 0, 'Gone Show has nothing alive')
  assert.equal(candidatesFor(UNSOWN).filter(isAlive).length, 0, 'Unseeded Show has nothing alive')
  assert.equal(candidatesFor(LIVE).filter(isAlive).length, 1)
  assert.equal(candidatesFor(LOCAL).filter(isAlive).length, 1, 'a copy on the box is alive whatever the tracker says')
})

test('the home screen offers a show with something to play and never one with nothing', async () => {
  const body = await get('/api/home')
  const seen = homeRows(body)
  assert.ok(seen.has(LIVE), 'a show with a seeded release is a recommendation')
  assert.ok(seen.has(LOCAL), 'and so is one whose download is on the box')
  assert.ok(!seen.has(DEAD), 'the show whose every copy is dead is not on the home screen')
  assert.ok(!seen.has(UNSOWN), 'nor the one whose every copy has nobody seeding it')
  assert.ok(seen.size >= 8, `the rows still fill up (${seen.size} shows drawn)`)
})

test('Discover lists what can be watched, and nothing else', async () => {
  const body = await get('/api/discover')
  const listed = ids(body.series)
  assert.ok(listed.has(LIVE), 'the seeded show is in Discover')
  assert.ok(listed.has(LOCAL), 'the downloaded show is in Discover')
  assert.ok(!listed.has(DEAD), 'the dead show is not in Discover')
  assert.ok(!listed.has(UNSOWN), 'the unseeded show is not in Discover')
})

test('a dead show on My List stays on My List, though it is recommended nowhere', async () => {
  const body = await get('/api/home')
  assert.ok(ids(body.myList).has(OURS), 'the show the person added is still in My List')
  assert.ok(!homeRows(body).has(OURS), 'and it is not offered as a pick at the same time')
})

test('a dead show the person is part-way through stays in Continue watching', async () => {
  const body = await get('/api/continue')
  const watching = new Set<number>(body.items.map((c: any) => c.seriesId))
  assert.ok(watching.has(WATCHING), 'Continue watching is the person\'s own history, not a recommendation')
})

test('the show itself is not taken away, only its listing', async () => {
  // A poster is not a dead end for the person who searches for the name: the page opens and says so plainly.
  const page = await app.inject({ method: 'GET', url: `/api/series/${DEAD}`, headers: { cookie } })
  assert.equal(page.statusCode, 200)
  assert.equal(page.json().series.name, NAMES[DEAD])
})

test('a download starting puts the show back on the listings', async () => {
  // The one thing that makes a dead show available again: its file arrives. streaming.ts says the catalog changed when a
  // download starts, which is what the listing caches key on.
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (?,?,'active',?)`).run(DEAD, `hash-${DEAD}`, now())
  const { catalogChanged } = await import('../src/seasons.ts')
  catalogChanged()
  const body = await get('/api/home')
  assert.ok(homeRows(body).has(DEAD) || ids(body.ready).has(DEAD), 'the show is back once its file is on the box')
})

after(async () => { await app.close() })
