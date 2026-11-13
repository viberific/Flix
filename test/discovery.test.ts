// The three services the person watches in their own apps. Netflix, Disney+ and Prime Video: a show that is ONLY on one
// of them is not listed anywhere a person browses -- not the home screen, not Discover, not search -- while a show on HBO
// stays. A show of theirs that is in My List stays there, because that is their own choice and a show vanishing out of
// their own row would read as a bug. Measured against the endpoints themselves, not against the rule they share, so a
// surface that forgets to apply the rule fails here.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'flix-discovery-'))
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
const { normalizeStreamer } = await import('../src/networks.ts')

const HIDDEN = {
  netflix: 90001,
  disney: 90002,
  prime: 90003,
} as const
const HBO = 90004
const NAMES: Record<number, string> = {
  [HIDDEN.netflix]: 'Only Nights',
  [HIDDEN.disney]: 'Castle And Sons',
  [HIDDEN.prime]: 'Warehouse Deal',
  [HBO]: 'Harbour Lights',
}

/** One show Flix can list: a season 1 of one episode, seeded, H.264 1080p, English, with the service it is carried on. */
function addShow(id: number, streamer: string | null, genre: string) {
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, series_poster, group_name, release_name, season, episode, label, is_pack,
      resolution, codec, size, seeders, time, info_hash, genres, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, id, NAMES[id], '/poster.jpg', `Show.S01.1080p`, `${NAMES[id]}.S01E01`, 1, 1, 'S01E01', 0,
    '1080p', 'x264', 1_000_000_000, 5, now(), `hash-${id}`, JSON.stringify([genre]), now())
  db.prepare('INSERT OR REPLACE INTO series_sync (series_id, synced_at) VALUES (?,?)').run(id, now())
  db.prepare(`INSERT OR REPLACE INTO series_net (series_id, tmdb_id, streamer, network, first_air, popularity, notable, fetched_at, lang, season_counts, ver)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, streamer, streamer, '2024-01-01', 50, 1, now(), 'en', JSON.stringify({ 1: 1 }), 4)
}

let cookie = ''
test('signing in creates the admin account this test speaks as', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/signup', payload: { name: 'admin', password: 'password123' } })
  assert.equal(r.statusCode, 200)
  cookie = String(r.headers['set-cookie']).split(';')[0]
  for (const [id, streamer] of [[HIDDEN.netflix, 'Netflix'], [HIDDEN.disney, 'Disney+'], [HIDDEN.prime, 'Prime Video']] as const) addShow(id, streamer, 'Drama')
  addShow(HBO, 'HBO', 'Drama')
})

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { cookie } })
  assert.equal(r.statusCode, 200, `${url} answered ${r.statusCode}: ${r.body}`)
  return r.json() as any
}
const ids = (list: any[]) => new Set<number>((list ?? []).map((r) => r.id))

test('Amazon and Prime Video are one service, and Amazon Freevee is not it', () => {
  for (const name of ['Amazon', 'Amazon Prime Video', 'Prime Video', 'prime video']) assert.equal(normalizeStreamer(name), 'Prime Video', name)
  for (const name of ['Amazon Freevee', 'Freevee', 'Amazon Studios']) assert.equal(normalizeStreamer(name), null, name)
  assert.equal(normalizeStreamer('HBO'), 'HBO')
})

test('the home screen lists the HBO show and none of the three hidden services', async () => {
  const body = await get('/api/home')
  const seen = new Set<number>([...(body.hero ? [body.hero.id] : []), ...(body.sections ?? []).flatMap((s: any) => s.series.map((x: any) => x.id))])
  assert.ok(seen.has(HBO), 'the HBO show is on the home screen')
  for (const [id, name] of [[HIDDEN.netflix, 'Netflix'], [HIDDEN.disney, 'Disney+'], [HIDDEN.prime, 'Prime Video']] as const)
    assert.ok(!seen.has(id), `the ${name}-only show is not on the home screen`)
})

test('Discover lists the HBO show and none of the three hidden services', async () => {
  const body = await get('/api/discover')
  const listed = ids(body.series)
  assert.ok(listed.has(HBO), 'the HBO show is in Discover')
  for (const [id, name] of [[HIDDEN.netflix, 'Netflix'], [HIDDEN.disney, 'Disney+'], [HIDDEN.prime, 'Prime Video']] as const)
    assert.ok(!listed.has(id), `the ${name}-only show is not in Discover`)
  // A genre only a hidden service's shows fill would be a pill leading to an empty grid.
  assert.ok(body.genres.includes('Drama'))
})

test('search finds the HBO show and none of the three hidden services', async () => {
  const all = await get('/api/series?q=')
  const listed = ids(all.series)
  assert.ok(listed.has(HBO), 'the HBO show comes back from search')
  for (const [id, name] of [[HIDDEN.netflix, 'Netflix'], [HIDDEN.disney, 'Disney+'], [HIDDEN.prime, 'Prime Video']] as const)
    assert.ok(!listed.has(id), `the ${name}-only show does not come back from search`)
  // The same by name, which is the way a person actually searches.
  for (const id of [HIDDEN.netflix, HIDDEN.disney, HIDDEN.prime]) {
    const one = await get(`/api/series?q=${encodeURIComponent(NAMES[id])}`)
    assert.ok(!ids(one.series).has(id), `searching for “${NAMES[id]}” does not list it`)
  }
})

test('Discover no longer takes a service filter', async () => {
  const plain = await get('/api/discover')
  const asked = await get('/api/discover?service=HBO')
  assert.equal(asked.total, plain.total, 'the service parameter changes nothing')
  assert.ok(!('service' in asked), 'the answer no longer carries a chosen service')
  assert.ok(!('services' in asked), 'the answer no longer offers a list of services')
  assert.deepEqual(ids(asked.series), ids(plain.series))
})

test('a hidden service’s show that the person put in My List stays in My List', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/mylist', headers: { cookie }, payload: { seriesId: HIDDEN.netflix, on: true } })
  assert.equal(r.statusCode, 200)
  const body = await get('/api/home')
  assert.ok(ids(body.myList).has(HIDDEN.netflix), 'the show is still in My List, where the person put it')
  // And it is still not recommended anywhere the home screen picks for them.
  const seen = new Set<number>([...(body.hero ? [body.hero.id] : []), ...(body.sections ?? []).flatMap((s: any) => s.series.map((x: any) => x.id))])
  assert.ok(!seen.has(HIDDEN.netflix))
  // Opening it still works: the show itself is not taken away, only its listing.
  const page = await app.inject({ method: 'GET', url: `/api/series/${HIDDEN.netflix}`, headers: { cookie } })
  assert.equal(page.statusCode, 200, 'the show page still opens')
  assert.equal(page.json().series.name, NAMES[HIDDEN.netflix])
})

after(async () => { await app.close() })
