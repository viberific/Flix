// Grouping what has finished seeding, by show and season, and what may be removed as a group.
//
// Only episodes that have finished seeding go in these groups. Remove watched takes only what everybody has watched; Delete show
// takes the lot but never breaks the seeding goal. That is what these hold still, against a qBittorrent that
// reports exactly the numbers each test gives it -- the seeding goal is measured from those numbers, so the page's state
// and the group's removal have to be this and nothing else.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const tmp = mkdtempSync(join(tmpdir(), 'flix-groups-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'

/** A qBittorrent that says what the test tells it to, and records what it was asked to delete. */
const state: Record<string, any> = {}
const deleted: string[] = []
const fake = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname === '/api/v2/auth/login') { res.writeHead(200, { 'set-cookie': 'SID=1' }); return res.end('Ok.') }
  if (u.pathname === '/api/v2/torrents/info') {
    const hash = u.searchParams.get('hashes')
    const list = hash ? (state[hash] ? [state[hash]] : []) : Object.values(state)
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(list))
  }
  if (u.pathname === '/api/v2/torrents/delete') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { for (const h of new URLSearchParams(body).getAll('hashes')) deleted.push(h); res.writeHead(200); res.end('') })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
process.env.QB_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

const { groupFinished, groupDeletePlan, seedNote } = await import('../src/seeding-groups.ts')
const { app } = await import('../src/server.ts')
const { db, now } = await import('../src/db.ts')
const { createUser, newSession } = await import('../src/auth.ts')
after(async () => { await app.close(); fake.close() })

const admin = createUser('Parent', 'a password', true)
const cookie = `flix_session=${newSession(admin.id)}`
const GB = 1e9

const rel = db.prepare(`INSERT INTO releases (torrent_id, series_id, series, series_poster, group_name, label, season, episode, episode_end, is_pack, resolution, codec, seeders, info_hash, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?, '1080p','H.264',5,?,0)`)
const down = db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (?,?,'active',?)`)

/** One torrent in the engine. `hours` and `ratio` are what BTN's rule is measured from. */
function engine(hash: string, o: { sizeGb: number; hours: number; ratio: number; left?: number }) {
  const size = o.sizeGb * GB
  state[hash] = {
    hash, name: hash, state: (o.left ?? 0) > 0 ? 'downloading' : 'stalledUP', progress: o.left ? 1 - o.left / size : 1,
    size, total_size: size, amount_left: o.left ?? 0, uploaded: o.ratio * size, downloaded: o.left ? size - o.left : size,
    ratio: o.ratio, seeding_time: o.hours * 3600, dlspeed: 0, upspeed: 0, eta: 0, num_seeds: 2, num_leechs: 0,
    save_path: join(tmp, 'downloads'), added_on: 0, tags: 'flix',
  }
}

/** A row as GET /api/admin/downloads hands it to the page. */
function row(o: { id: number; seriesId: number; series: string; season: number; episode: number | null; sizeGb: number; finished: boolean; pack?: boolean; notWatched?: string[] }) {
  return {
    torrent_id: o.id, series_id: o.seriesId, series: o.series, season: o.season, episode: o.episode, episode_end: o.episode,
    is_pack: o.pack ?? false, label: o.pack ? `Season ${o.season}` : `S0${o.season}E0${o.episode}`, state: 'active', missing: false,
    left: 0, size: o.sizeGb * GB, seedMet: o.finished, ratio: o.finished ? 1.4 : 0.3, seedHours: o.finished ? 140 : 20,
    notWatched: o.notWatched ?? [],
  }
}

// ---- what is in the grouping ------------------------------------------------------------------------------------

test('only episodes that have finished seeding are grouped, never one still seeding', () => {
  const rows = [
    row({ id: 1, seriesId: 101, series: 'Northern Lights', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 2, seriesId: 101, series: 'Northern Lights', season: 1, episode: 2, sizeGb: 2, finished: false }),
    row({ id: 3, seriesId: 101, series: 'Northern Lights', season: 1, episode: 3, sizeGb: 2, finished: true }),
    row({ id: 4, seriesId: 101, series: 'Northern Lights', season: 2, episode: 1, sizeGb: 3, finished: false }),
    row({ id: 5, seriesId: 102, series: 'Harbour Road', season: 1, episode: null, sizeGb: 9, finished: true, pack: true }),
  ] as any[]
  const shows = groupFinished(rows)
  assert.equal(shows.length, 2, 'each show with something finished is listed once')
  const lights = shows.find((s) => s.series === 'Northern Lights')!
  assert.equal(lights.seasons.length, 1, 'season 2 has nothing finished, so it is not a season in the view')
  assert.equal(lights.seasons[0].items.length + lights.still.length, 4, 'nothing is lost: all four torrents of the show are accounted for')
  assert.deepEqual(lights.seasons[0].items.map((i) => i.label), ['S01E01', 'S01E03'])
  assert.deepEqual(lights.seasons[0].still.map((s) => s.label), ['S01E02'], 'what is still seeding in that season')
  assert.deepEqual(lights.still.map((s) => s.label).sort(), ['S01E02', 'S02E01'], 'and what is still seeding anywhere in the show')
  assert.equal(lights.finished, false, 'a show with anything still seeding is not finished')
  assert.equal(lights.seasons[0].finished, false)
  assert.equal(lights.size, 4 * GB, 'only what is finished counts toward the size')
  assert.equal(shows.find((s) => s.series === 'Harbour Road')!.finished, true)
  assert.ok(!shows.some((s) => s.seasons.some((x) => x.items.some((i) => i.torrentId === 2))), 'the still-seeding episode is in no group')
})

test('Remove watched takes only what everybody has watched and has finished seeding, and leaves the rest', () => {
  const rows = [
    row({ id: 11, seriesId: 201, series: 'Cold Coast', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 12, seriesId: 201, series: 'Cold Coast', season: 1, episode: 2, sizeGb: 2, finished: false }),
    row({ id: 13, seriesId: 201, series: 'Cold Coast', season: 1, episode: 3, sizeGb: 2, finished: true, notWatched: ['Kid'] }),
    { ...row({ id: 14, seriesId: 201, series: 'Cold Coast', season: 1, episode: 4, sizeGb: 2, finished: true }), watching: ['Kid'] },
  ] as any[]
  const plan = groupDeletePlan(rows, { seriesId: 201, season: 1 })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.torrentIds, [11], 'only the watched, seeded episode nobody is partway through')
  assert.deepEqual(plan.kept.map((k) => k.torrentId).sort(), [12, 13, 14], 'the rest are left, and named')
  assert.deepEqual(plan.queued, [])

  const none = groupDeletePlan(rows.filter((r) => r.torrent_id !== 11), { seriesId: 201, season: 1 })
  assert.equal(none.ok, false, 'nothing watched by everyone: nothing to do, and it says why')
  assert.match(none.why, /S01E03 \(not watched yet by Kid\)/)
})

test('Delete show takes everything, watched or not, and queues what is still owed to BTN', () => {
  const rows = [
    row({ id: 21, seriesId: 301, series: 'Iron Valley', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 22, seriesId: 301, series: 'Iron Valley', season: 2, episode: 1, sizeGb: 2, finished: true, notWatched: ['Kid'] }),
    row({ id: 23, seriesId: 301, series: 'Iron Valley', season: 2, episode: 2, sizeGb: 2, finished: false }),
  ] as any[]
  const plan = groupDeletePlan(rows, { seriesId: 301 }, 'all')
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.torrentIds.sort(), [21, 22], 'unwatched goes too')
  assert.deepEqual(plan.queued, [23], 'still seeding is never removed now, only marked to go once seeded')
})

test('the grouping counts what Remove watched would take', () => {
  const shows = groupFinished([
    row({ id: 41, seriesId: 501, series: 'Low Tide', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 42, seriesId: 501, series: 'Low Tide', season: 1, episode: 2, sizeGb: 3, finished: true, notWatched: ['Kid'] }),
  ] as any[])
  assert.equal(shows[0].watched, 1)
  assert.equal(shows[0].watchedSize, 2 * GB)
  assert.equal(shows[0].seasons[0].watched, 1)
})

test('a group of another show is never touched', () => {
  const rows = [
    row({ id: 31, seriesId: 401, series: 'A Show', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 32, seriesId: 402, series: 'B Show', season: 1, episode: 1, sizeGb: 2, finished: true }),
  ] as any[]
  assert.deepEqual(groupDeletePlan(rows, { seriesId: 401, season: 1 }).torrentIds, [31])
})

test('the words under a torrent say exactly what is left of the seeding goal', () => {
  assert.equal(seedNote({ ratio: 0.2, hours: 130, ratioMet: false, hoursMet: true, met: true }), 'Seeding goal met')
  assert.equal(seedNote({ ratio: 0.5, hours: 100, ratioMet: false, hoursMet: false, met: false }), '30 h more seeding or ratio 0.50 of 1:1')
})

// ---- what the page is handed, and what the route will do ---------------------------------------------------------

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })

/** Two episodes of one season: one past BTN's goal, one an hour short of it. */
function seedSeason() {
  rel.run(501, 901, 'Deep Water', null, 'Deep Water - S01E01', 'S01E01', 1, 1, 1, 0, 'h501')
  rel.run(502, 901, 'Deep Water', null, 'Deep Water - S01E02', 'S01E02', 1, 2, 2, 0, 'h502')
  down.run(501, 'h501', now()); down.run(502, 'h502', now())
  engine('h501', { sizeGb: 3, hours: 131, ratio: 0.4 })
  engine('h502', { sizeGb: 3, hours: 90, ratio: 0.2 })
}

test('the state shown for a download is the torrent’s real state', async () => {
  seedSeason()
  const body = (await get('/api/admin/downloads')).json() as any
  const byId = (id: number) => body.downloads.find((x: any) => x.torrent_id === id)
  assert.equal(byId(501).seedMet, true, '131 hours past the 130-hour goal')
  assert.equal(byId(501).seedNote, 'Seeding goal met')
  assert.equal(byId(502).seedMet, false, '90 hours is not')
  assert.match(byId(502).seedNote, /^40 h more seeding or ratio 0\.20 of 1:1$/)
  // The finished-seeding view is built from those same rows, so it cannot disagree with them.
  const show = body.finished.find((s: any) => s.seriesId === 901)
  assert.deepEqual(show.seasons[0].items.map((i: any) => i.torrentId), [501])
  assert.deepEqual(show.still.map((s: any) => s.label), ['S01E02'])
  // "Using the most space" reads the same row: size, what is on disk and what is left are the engine's numbers.
  assert.equal(byId(502).left, 0)
  assert.equal(byId(502).size, 3 * GB)
})

test('Remove watched on a season is refused while nobody has watched anything in it, and removes nothing', async () => {
  const before = deleted.length
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901, season: 1 })
  assert.equal(r.statusCode, 409, r.body)
  assert.match(r.body, /not watched yet by Parent/)
  assert.equal(deleted.length, before, 'the engine was not asked to delete anything')
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 501`).get() as any).state, 'active')
})

test('Remove watched takes the watched, seeded episode and leaves the one still seeding', async () => {
  for (const id of [501, 502]) db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?,?,0,?,?,?)`).run(admin.id, id, now(), now(), now())
  const before = deleted.length
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901, season: 1 })
  assert.equal(r.statusCode, 200, r.body)
  const out = r.json() as any
  assert.equal(out.removed, 1)
  assert.deepEqual(out.kept.map((k: any) => k.label), ['S01E02'])
  assert.deepEqual(deleted.slice(before), ['h501'])
  assert.equal((db.prepare(`SELECT remove_reason FROM downloads WHERE torrent_id = 501`).get() as any).remove_reason, 'removed by admin, watched episodes of season 1')
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 502`).get() as any).state, 'active', 'still seeding: never removed')
})

test('Delete show never breaks the seeding goal: what is still owed is marked to go once seeded', async () => {
  rel.run(503, 901, 'Deep Water', null, 'Deep Water - S01E03', 'S01E03', 1, 3, 3, 0, 'h503')
  down.run(503, 'h503', now())
  engine('h503', { sizeGb: 3, hours: 140, ratio: 0.4 }) // seeded, and nobody has watched it
  const before = deleted.length
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901, mode: 'all' })
  assert.equal(r.statusCode, 200, r.body)
  const out = r.json() as any
  assert.equal(out.removed, 1)
  assert.equal(out.queued, 1)
  assert.deepEqual(deleted.slice(before), ['h503'], 'the unwatched one goes')
  assert.equal((db.prepare(`SELECT state, remove_when_seeded FROM downloads WHERE torrent_id = 502`).get() as any).remove_when_seeded, 1)
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 502`).get() as any).state, 'active')
})
