// The ratings backlog. Measured on the box's own database on 2026-11-12: 1,843 of 2,425 shows had no IMDb score, 1,352 rows
// said source 'imdb' with nothing in them (written while OMDb was rate limited, then treated as fresh for a week), and 724
// shows carried no IMDb id on any release so nothing was ever asked about them. The sweep is tested here on what it did
// wrong: its budget, its retry, and the shows it had nothing to ask OMDb about.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const seen = { omdb: [] as string[], tvmaze: [] as string[] }
const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  const json = (v: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  const p = u.pathname.replace(/\/$/, '')
  if (p === '/omdb') {
    const q = u.searchParams.toString().replace(/&apikey=[^&]*/, '')
    seen.omdb.push(q)
    const i = u.searchParams.get('i'), t = u.searchParams.get('t')
    if (i === 'tt1000001') return json({ Response: 'True', Rated: 'TV-MA', imdbRating: '8.5' })
    if (i === 'tt1000002') return json({ Response: 'True', Rated: 'TV-14', imdbRating: '8.1' })
    if (i === 'tt1000003') return json({ Response: 'True', Rated: 'TV-PG', imdbRating: '7.7' })
    if (i === 'tt1000009') return json({ Response: 'True', Rated: 'TV-PG' }) // a certificate, no score: the row that used to stick
    if (i === 'tt7777777') return json({ Response: 'True', Rated: 'TV-MA', imdbRating: '9.1' }) // found back from a title
    if (t === 'Unknown Show') return json({ Response: 'True', Rated: 'TV-14', imdbRating: '7.5' })
    return json({ Response: 'False', Error: 'Incorrect IMDb ID.' })
  }
  if (p === '/tvmaze/lookup/shows' || p === '/tvmaze/singlesearch/shows') {
    seen.tvmaze.push(u.search)
    return json(u.searchParams.get('q') === 'No Id Show' ? { externals: { imdb: 'tt7777777', thetvdb: 5555 } } : {})
  }
  res.writeHead(404); res.end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as any).port}`

const dir = mkdtempSync(join(tmpdir(), 'flix-ratings-'))
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = dir
process.env.OMDB_API_KEY = 'testkey'
process.env.OMDB_API_URL = `${base}/omdb`
process.env.TVMAZE_URL = `${base}/tvmaze`
process.env.TMDB_API_KEY = ''
process.env.OMDB_DAILY_CAP = '2' // two lookups a day, so a handful of shows is the whole backlog
process.env.PLAY_HOLD_MS = '120000'

const r = await import('../src/ratings.ts')
const { db, now } = await import('../src/db.ts')
// Nothing is left listening: the fake OMDb/TVmaze server would hold the test process open long after the last assertion.
after(() => new Promise<void>((done) => server.close(() => done())))

let torrent = 1000
/** A show in the catalog: `imdb`/`tvdb` are what BTN gave (either may be missing, as 724 of them are). */
function addSeries(seriesId: number, title: string, imdb: string | null = null, tvdb: number | null = null) {
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, tvdb_id, imdb_id, group_name, info_hash, fetched_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(++torrent, seriesId, title, tvdb, imdb, 'Test', `hash${torrent}`, now())
}
const meta = (id: number) => db.prepare('SELECT rating, source, imdb_score FROM series_meta WHERE series_id = ?').get(id) as any
const DAY = 86_400
const t0 = now()

test('the day\'s lookups are a hard cap: the sweep stops at it and does not ask twice the same day', async () => {
  for (const n of [1, 2, 3]) addSeries(n, `Show ${n}`, `tt100000${n}`)
  const first = await r.sweepRatings({ limit: 10, at: t0 })
  assert.ok(first, 'the sweep ran')
  assert.equal(first!.cap, 2)
  assert.equal(seen.omdb.length, 2, 'two of the three shows were asked about, and no more')
  assert.equal(first!.tried, 2)
  assert.equal(first!.filled, 2)
  assert.equal(meta(1).imdb_score, 8.5)
  assert.equal(meta(2).rating, 'TV-14')
  assert.equal(meta(3), undefined, 'the show past the cap was not looked up')
  // The same day again: nothing left to spend, and nothing asked.
  const again = await r.sweepRatings({ limit: 10, at: t0 + 3600 })
  assert.equal(again!.tried, 0)
  assert.equal(seen.omdb.length, 2, 'no lookups past the cap')
  assert.equal(r.omdbBudgetLeft(t0 + 3600), 0)
})

test('a show OMDb has no score for is tried again later, not never', async () => {
  addSeries(9, 'Show 9', 'tt1000009')
  const day = t0 + 2 * DAY // a fresh day's budget
  await r.sweepRatings({ limit: 10, at: day })
  // Its certificate came back, its score did not. That row is what used to look "fetched" and never be asked again.
  assert.equal(meta(9)?.rating, 'TV-PG')
  assert.equal(meta(9)?.imdb_score, null)
  const ids = (at: number) => r.nextRatingCandidates(50, at).map((c: any) => c.id)
  assert.ok(!ids(day + 3600).includes(9), 'not asked again an hour later')
  assert.ok(ids(day + DAY + 60).includes(9), 'asked again the next day')
  const before = seen.omdb.filter((q) => q.includes('tt1000009')).length
  await r.sweepRatings({ limit: 10, at: day + DAY + 60 })
  assert.equal(seen.omdb.filter((q) => q.includes('tt1000009')).length, before + 1, 'the retry really went out')
  // Two answers that say "no score" and the show is left alone for two days, then four: a hopeless title must not eat
  // the daily budget every day for ever.
  assert.ok(!ids(day + 2 * DAY + 60).includes(9), 'having answered twice, it is left for two days')
  assert.ok(ids(day + 3 * DAY + 120).includes(9))
})

test('a show with no IMDb id on any release is resolved by title and by TVDB, instead of never being asked', async () => {
  addSeries(20, 'No Id Show') // no imdb_id, no tvdb_id: 195 shows on the box are like this
  addSeries(21, 'Unknown Show', null, 4242) // a TVDB id, and TVmaze knows nothing about it
  const day = t0 + 4 * DAY
  await r.sweepRatings({ limit: 10, at: day })
  assert.ok(seen.tvmaze.some((q) => q.includes('No+Id+Show') || q.includes('No%20Id%20Show')), 'the title was looked up for free first')
  assert.equal(meta(20)?.imdb_score, 9.1, 'the id TVmaze found was asked about, and the score kept')
  assert.ok(seen.omdb.some((q) => q.includes('t=Unknown+Show') || q.includes('t=Unknown%20Show')), 'OMDb was asked about the title itself when nothing else resolved it')
  assert.equal(meta(21)?.imdb_score, 7.5)
})

test('the sweep stands down while somebody is watching', async () => {
  const { beginPlayback } = await import('../src/transcode.ts')
  beginPlayback(999_001, 1)
  const before = seen.omdb.length
  const ran = await r.sweepRatings({ limit: 10, at: t0 + 8 * DAY })
  assert.equal(ran, null, 'nothing runs while a play has the box')
  assert.equal(seen.omdb.length, before)
})
