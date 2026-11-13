// Grouping what has finished seeding, by show and season, and what may be removed as a group.
//
// The rule Brian asked for, in his words: only episodes that have finished seeding go in these groups, and a whole show or
// season may go only when every episode in it has finished. That is what these hold still, against a qBittorrent that
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

test('a season is removable only when every episode in it has finished seeding', () => {
  const rows = [
    row({ id: 11, seriesId: 201, series: 'Cold Coast', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 12, seriesId: 201, series: 'Cold Coast', season: 1, episode: 2, sizeGb: 2, finished: false }),
  ] as any[]
  const refused = groupDeletePlan(rows, { seriesId: 201, season: 1 })
  assert.equal(refused.ok, false, 'one episode still seeding refuses the whole season')
  assert.deepEqual(refused.torrentIds, [], 'and removes nothing')
  assert.match(refused.why, /S01E02/, 'the refusal names what is still seeding')
  assert.equal(refused.still.length, 1)

  rows[1].seedMet = true
  const allowed = groupDeletePlan(rows, { seriesId: 201, season: 1 })
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.torrentIds.sort(), [11, 12])
})

test('a show is removable only when every season in it has finished seeding', () => {
  const rows = [
    row({ id: 21, seriesId: 301, series: 'Iron Valley', season: 1, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 22, seriesId: 301, series: 'Iron Valley', season: 2, episode: 1, sizeGb: 2, finished: true }),
    row({ id: 23, seriesId: 301, series: 'Iron Valley', season: 2, episode: 2, sizeGb: 2, finished: false }),
  ] as any[]
  const refused = groupDeletePlan(rows, { seriesId: 301 })
  assert.equal(refused.ok, false, 'something in season 2 is still seeding, so the show cannot go as one')
  assert.deepEqual(refused.torrentIds, [])
  assert.match(refused.why, /S02E02/)

  rows[2].seedMet = true
  const allowed = groupDeletePlan(rows, { seriesId: 301 })
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.torrentIds.sort(), [21, 22, 23])
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

test('a season removal is refused by the route while anything in it is still seeding, and removes nothing', async () => {
  const before = deleted.length
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901, season: 1 })
  assert.equal(r.statusCode, 409, r.body)
  assert.match(r.body, /S01E02/)
  assert.equal(deleted.length, before, 'the engine was not asked to delete anything')
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 502`).get() as any).state, 'active')
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 501`).get() as any).state, 'active')
})

test('a show removal is refused by the route while anything in it is still seeding', async () => {
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901 })
  assert.equal(r.statusCode, 409, r.body)
  assert.equal((db.prepare(`SELECT state FROM downloads WHERE torrent_id = 501`).get() as any).state, 'active')
})

test('once every episode has finished seeding the season goes in one action, through the same delete', async () => {
  state['h502'] = { ...state['h502'], seeding_time: 131 * 3600, uploaded: 3 * GB, ratio: 1 }
  const before = deleted.length
  const r = await post('/api/admin/downloads/group-delete', { seriesId: 901, season: 1 })
  assert.equal(r.statusCode, 200, r.body)
  const out = r.json() as any
  assert.equal(out.removed, 2)
  assert.deepEqual(deleted.slice(before).sort(), ['h501', 'h502'], 'both torrents were removed from the engine')
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE state = 'active' AND torrent_id IN (501,502)`).get() as any).n, 0)
  assert.equal((db.prepare(`SELECT remove_reason FROM downloads WHERE torrent_id = 501`).get() as any).remove_reason, 'removed by admin, season 1')
})
