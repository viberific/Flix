// End-to-end: mock BTN API + local tracker + WebTorrent seeder + real qbittorrent-nox + real ffmpeg.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import WebTorrent from 'webtorrent'
import { Server as Tracker } from 'bittorrent-tracker'


const tmp = mkdtempSync(join(tmpdir(), 'flix-e2e-'))
const P = { tracker: 18881, btn: 18882, qb: 18883, app: 18884, qbPeer: 18885 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** SQL LIKE, the way BTN's string filters behave: `%` is any run, `_` one character, \% literal. */
function likeMatch(value: string, pattern: string) {
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) { rx += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue }
    if (c === '%') { rx += '.*'; continue }
    if (c === '_') { rx += '.'; continue }
    rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${rx}$`, 'i').test(value)
}

// ---- environment for the app (must be set before importing it) ----
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.PORT = String(P.app)
process.env.HOST = '127.0.0.1'
process.env.LOG_LEVEL = 'warn'
process.env.PROBE_TIMEOUT_MS = '30000'
process.env.BTN_API_KEY = 'testkey'
process.env.TMDB_API_KEY = 'tmdbkey'
process.env.TMDB_API_URL = `http://127.0.0.1:${P.btn}/tmdb`
process.env.TVMAZE_URL = '' // no outbound lookups from tests
process.env.TMDB_IMAGE_URL = `http://127.0.0.1:${P.btn}/tmdbimg`
process.env.ART_ALLOW_PRIVATE_HOSTS = 'true' // test artwork is served from localhost
process.env.BTN_API_URL = `http://127.0.0.1:${P.btn}/`
process.env.QB_URL = `http://127.0.0.1:${P.qb}`
process.env.SWEEP_INTERVAL_SEC = '3600'
process.env.SWEEP_GRACE_SEC = '0'
process.env.MIN_FREE_GB = '0'

let tracker: any, seeder: WebTorrent.Instance, btn: Server, qbProc: ChildProcess
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
let posterFetches = 0
const media: Record<string, { path: string; torrent: Buffer; hash: string; data: Buffer }> = {}
let cookie = ''

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`http://127.0.0.1:${P.app}${path}`, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as any) } })
  return res
}
const jget = async (path: string) => { const r = await api(path); assert.equal(r.status, 200, `${path} -> ${r.status} ${await r.clone().text()}`); return r.json() as Promise<any> }
const jpost = async (path: string, body: any) => api(path, { method: 'POST', body: JSON.stringify(body) })

before(async () => {
  // 1. test media: mp4 (browser-direct) and mkv/hevc-free h264+ac3-ish (forces HLS path)
  const mdir = join(tmp, 'media'); mkdirSync(mdir)
  const mk = (name: string, extra: string[]) => {
    const out = join(mdir, name)
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=duration=20',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '50', ...extra, out])
    return out
  }
  const files = { 'direct.mp4': mk('Test.Show.S01E01.mp4', ['-c:a', 'aac', '-movflags', '+faststart']), 'hls.mkv': mk('Test.Show.S01E02.mkv', ['-c:a', 'ac3']) }

  // 2. tracker + seeder
  tracker = new Tracker({ udp: false, ws: false, http: true, stats: false })
  await new Promise<void>((r) => tracker.listen(P.tracker, '127.0.0.1', r))
  const announce = `http://127.0.0.1:${P.tracker}/announce`
  seeder = new WebTorrent({ dht: false, lsd: false, tracker: true, utp: false })
  for (const [k, path] of Object.entries(files)) {
    const t: any = await new Promise((r) => seeder.seed(path, { announce: [announce], private: true, comment: 'e2e' } as any, r))
    const torrent = Buffer.from(t.torrentFile)
    const hash: string = t.infoHash
    const data = readFileSync(path)
    media[k] = { path, torrent, hash, data }
  }

  // 3. mock BTN
  const torrents = Object.entries(media).map(([k, m], i) => ({
    GroupName: `Test Show - S01E0${i + 1}`, GroupID: String(100 + i), TorrentID: String(1000 + i), SeriesID: '77', Series: 'Test Show',
    SeriesPoster: `http://127.0.0.1:${P.btn}/img/poster.png`, ReleaseName: m.path.split('/').pop(), Category: 'Episode', Codec: 'H.264', Container: k.split('.')[1].toUpperCase(),
    Source: 'WEB-DL', Resolution: '360p', Origin: 'P2P', Size: String(m.data.length), Time: String(1700000000 + i), InfoHash: m.hash.toUpperCase(),
    TvdbID: '555', Seeders: '1', Leechers: '0', Genres: ['Test'], DownloadURL: `http://127.0.0.1:${P.btn}/dl/${1000 + i}?torrent_pass=SECRETPASSKEY`,
  }))
  btn = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/tmdb/')) {
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/tmdb/find/555')) return void res.end(JSON.stringify({ tv_results: [{ id: 9001, backdrop_path: '/bd.png' }] }))
      if (req.url.startsWith('/tmdb/tv/9001/content_ratings')) return void res.end(JSON.stringify({ results: [{ iso_3166_1: 'GB', rating: '15' }, { iso_3166_1: 'US', rating: 'TV-14' }] }))
      res.statusCode = 404; return void res.end('{}')
    }
    if (req.method === 'GET' && req.url === '/tmdbimg/w1280/bd.png') { res.setHeader('content-type', 'image/png'); res.end(PNG); return }
    if (req.method === 'GET' && req.url === '/img/poster.png') { posterFetches++; res.setHeader('content-type', 'application/octet-stream'); res.end(PNG); return }
    if (req.method === 'GET' && req.url?.startsWith('/dl/')) {
      const i = Number(req.url.split('/')[2].split('?')[0]) - 1000
      res.end(Object.values(media)[i].torrent); return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const rpc = JSON.parse(body)
      // BTN v1: id present and non-empty, no jsonrpc field, auth in params.key.
      assert.equal(rpc.jsonrpc, undefined)
      assert.ok(rpc.id)
      assert.equal(rpc.params?.key, 'testkey')
      // ...and a getTorrents call without `search` is refused before dispatch, with an empty 500.
      if (!('search' in (rpc.params ?? {}))) { res.statusCode = 500; return void res.end() }
      const s = rpc.params.search
      const filter = s && typeof s === 'object' && !Array.isArray(s) ? (s as any).series : undefined
      const matched = filter === undefined ? torrents : torrents.filter((t) => likeMatch(t.Series, String(filter)))
      const offset = Number(rpc.params.offset ?? 0), limit = Number(rpc.params.results ?? 10)
      const obj = Object.fromEntries(matched.slice(offset, offset + limit).map((t) => [t.TorrentID, t]))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: rpc.id, result: { results: String(matched.length), torrents: obj } }))
    })
  })
  await new Promise<void>((r) => btn.listen(P.btn, '127.0.0.1', r))

  // 4. qBittorrent-nox with no auth on localhost
  const profile = join(tmp, 'qb'); const cfgDir = join(profile, 'qBittorrent', 'config'); mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'qBittorrent.conf'), [
    '[LegalNotice]', 'Accepted=true', '', '[Preferences]', `WebUI\\Port=${P.qb}`, 'WebUI\\Address=127.0.0.1', 'WebUI\\LocalHostAuth=false', 'WebUI\\CSRFProtection=false',
    'WebUI\\HostHeaderValidation=false', `Connection\\PortRangeMin=${P.qbPeer}`, 'Connection\\UPnP=false', 'Bittorrent\\DHT=false', 'Bittorrent\\LSD=false', 'Bittorrent\\PeX=false',
    'Bittorrent\\Encryption=0', 'Advanced\\AnnounceToAllTrackers=true', '',
  ].join('\n'))
  qbProc = spawn('qbittorrent-nox', [`--profile=${profile}`], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${P.qb}/api/v2/app/version`).then((r) => r.ok).catch(() => false)) break; await sleep(500) }

  // 5. the app
  const { start } = await import('../src/server.ts')
  await start()
  const r = await jpost('/api/signup', { name: 'admin', password: 'password123' })
  assert.equal(r.status, 200)
  cookie = r.headers.get('set-cookie')!.split(';')[0]
})

after(async () => {
  qbProc?.kill('SIGKILL'); await seeder?.destroy(); tracker?.close(); btn?.close()
  const { app } = await import('../src/server.ts'); await app.close()
  process.exit(0)
})

test('catalog: search stores BTN data and never leaks the passkey', async () => {
  const { series } = await jget('/api/series?q=Test')
  assert.equal(series.length, 1)
  const s = await jget('/api/series/77')
  assert.equal(s.episodes.length, 2)
  assert.ok(s.episodes.every((e: any) => e.available && e.quality && !('torrent_link' in e)))
  assert.ok(!JSON.stringify(s).includes('SECRETPASSKEY'))
})

test('artwork: cached on the server, served locally, BTN image URL never reaches the browser', async () => {
  const list = await jget('/api/series?q=Test')
  assert.equal(list.series[0].poster, '/api/art/77/poster')
  assert.equal(list.series[0].banner, '/api/art/77/banner') // BTN gave no banner; the path is always given and the server finds a backup
  const s = await jget('/api/series/77')
  assert.ok(!JSON.stringify([list, s]).includes('127.0.0.1:' + P.btn), 'remote artwork URL leaked')
  const anon = await fetch(`http://127.0.0.1:${P.app}/api/art/77/poster`)
  assert.equal(anon.status, 401)
  const a = await api('/api/art/77/poster'), b = await api('/api/art/77/poster')
  assert.equal(a.status, 200)
  assert.equal(a.headers.get('content-type'), 'image/png') // sniffed, not the upstream octet-stream
  assert.ok(Buffer.from(await a.arrayBuffer()).equals(PNG))
  assert.equal(b.status, 200); await b.arrayBuffer()
  assert.equal(posterFetches, 1, 'second view must come from the cache')
  // BTN has no banner, so the backup source (TMDB's backdrop) fills in; kinds nobody can supply are a plain 404.
  const bn = await api('/api/art/77/banner')
  assert.equal(bn.status, 200); assert.ok(Buffer.from(await bn.arrayBuffer()).equals(PNG))
  assert.equal((await api('/api/art/77/trailer')).status, 404)
  assert.equal((await api('/api/art/77/nonsense')).status, 404)
})

async function playAndFetch(torrentId: number) {
  const r = await jpost('/api/play', { torrentId })
  assert.equal(r.status, 200, await r.clone().text())
  // libtorrent is unreliable at discovering loopback peers via the tracker; keep offering it the seeder directly
  const hash = Object.values(media)[torrentId - 1000].hash
  const offer = () => fetch(`http://127.0.0.1:${P.qb}/api/v2/torrents/addPeers`, { method: 'POST', body: new URLSearchParams({ hashes: hash, peers: `127.0.0.1:${seeder.torrentPort}` }) }).catch(() => {})
  await offer()
  const iv = setInterval(offer, 1500); iv.unref(); setTimeout(() => clearInterval(iv), 60_000).unref()
  return r.json() as Promise<any>
}

test('direct play: ranged reads of a partly-downloaded file match the original bytes', async () => {
  const play = await playAndFetch(1000)
  const info = await jget(`/api/stream/1000/${play.fileIndex}/info`)
  assert.equal(info.mode, 'direct')
  const m = media['direct.mp4']
  const res = await api(`/api/stream/1000/${play.fileIndex}/raw`, { headers: { range: 'bytes=0-1023' } })
  assert.equal(res.status, 206)
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(m.data.subarray(0, 1024)))
  const full = await api(`/api/stream/1000/${play.fileIndex}/raw`)
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), sha(m.data))
})

test('one tap: /api/watch picks the source and starts playback with no release choice', async () => {
  const r = await jpost('/api/watch', { seriesId: 77, season: 1, label: 'S01E01' })
  assert.equal(r.status, 200, await r.clone().text())
  const j: any = await r.json()
  assert.equal(j.torrentId, 1000)
  assert.equal(j.next.label, 'S01E02')
  const bad = await jpost('/api/watch', { seriesId: 77, season: 1, label: 'S09E99' })
  assert.equal(bad.status, 404)
})

test('transcode path: mkv/ac3 is served as HLS', async () => {
  const play = await playAndFetch(1001)
  const info = await jget(`/api/stream/1001/${play.fileIndex}/info`)
  assert.equal(info.mode, 'hls')
  const pl = await api(info.url)
  assert.equal(pl.status, 200)
  const text = await pl.text()
  assert.match(text, /#EXTM3U/)
  const seg = text.split('\n').find((l) => l.endsWith('.ts'))!
  const sr = await api(`/api/stream/1001/${play.fileIndex}/hls/${seg}`)
  assert.equal(sr.status, 200)
  assert.ok((await sr.arrayBuffer()).byteLength > 1000)
})

test('retention: kept until watched AND seeded; force-remove refused; removed once both hold', async () => {
  const { sweep } = await import('../src/retention.ts')
  const { config } = await import('../src/config.ts')
  const { qb } = await import('../src/qb.ts')
  const hash = media['direct.mp4'].hash

  // unwatched -> kept
  assert.deepEqual(await sweep(), [])
  assert.ok(await qb.info(hash))

  // watched, but BTN seeding requirement (130h / 1:1) not met -> kept
  const dl = await (await jget('/api/admin/downloads')).downloads.find((d: any) => d.torrent_id === 1000)
  await jpost('/api/watched', { torrentId: 1000, fileIndex: 0, watched: true })
  assert.deepEqual(await sweep(), [])
  assert.ok(await qb.info(hash), 'must not delete before seeding requirement is met')
  assert.ok(dl)

  // admin cannot override it
  const del = await api('/api/admin/downloads/1000', { method: 'DELETE' })
  assert.equal(del.status, 409)

  // simulate the requirement being met (130h) -> now it goes
  const orig = config.seed.minHours
  config.seed.minHours = 0
  try {
    assert.deepEqual(await sweep(), [hash])
  } finally { config.seed.minHours = orig }
  assert.equal(await qb.info(hash), undefined)
  assert.ok(!existsSync(join(process.env.DOWNLOAD_DIR!, hash, 'Test.Show.S01E01.mp4')), 'files should be deleted')
})

test('pending viewer blocks deletion even when seeding is met', async () => {
  const { sweep } = await import('../src/retention.ts')
  const { config } = await import('../src/config.ts')
  const { db } = await import('../src/db.ts')
  const { qb } = await import('../src/qb.ts')
  // second user also starts the mkv; admin watches it; second user has not
  await jpost('/api/admin/users', { name: 'bob', password: 'password123' })
  const login = await fetch(`http://127.0.0.1:${P.app}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bob', password: 'password123' }) })
  const bob = login.headers.get('set-cookie')!.split(';')[0]
  const adminCookie = cookie
  cookie = bob; await playAndFetch(1001); cookie = adminCookie
  await jpost('/api/watched', { torrentId: 1001, fileIndex: 0, watched: true })
  const orig = config.seed.minHours; config.seed.minHours = 0
  try {
    assert.deepEqual(await sweep(), [], 'bob has not watched it yet')
    assert.ok(await qb.info(media['hls.mkv'].hash))
    db.prepare(`UPDATE interests SET watched_at = 1 WHERE torrent_id = 1001`).run()
    assert.deepEqual(await sweep(), [media['hls.mkv'].hash])
  } finally { config.seed.minHours = orig }
})

// ---- multi-user: admin-only accounts and per-user content ratings ----
async function as<T>(c: string, fn: () => Promise<T>): Promise<T> { const prev = cookie; cookie = c; try { return await fn() } finally { cookie = prev } }
async function loginAs(name: string, password: string) {
  const r = await fetch(`http://127.0.0.1:${P.app}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) })
  return r.status === 200 ? r.headers.get('set-cookie')!.split(';')[0] : null
}

test('ratings: looked up automatically from TMDB (US rating, by TVDB id)', async () => {
  let got: any
  for (let i = 0; i < 40; i++) { got = (await jget('/api/series/77')).series; if (got.source === 'tmdb') break; await sleep(250) }
  assert.equal(got.rating, 'TV-14'); assert.equal(got.source, 'tmdb')
})

test('accounts: only the admin can create users; public signup is closed', async () => {
  const anon = await fetch(`http://127.0.0.1:${P.app}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sneaky', password: 'password123' }) })
  assert.equal(anon.status, 403)
  const mk = await jpost('/api/admin/users', { name: 'kid', password: 'password123', allowedRatings: ['TV-Y', 'TV-G'] })
  assert.equal(mk.status, 200)
  assert.equal((await jpost('/api/admin/users', { name: 'KID', password: 'password123' })).status, 409) // names are case-insensitive unique
  const kid = (await loginAs('kid', 'password123'))!
  assert.ok(kid)
  for (const [m, path] of [['GET', '/api/admin/users'], ['GET', '/api/admin/downloads']] as const) assert.equal((await as(kid, () => api(path, { method: m }))).status, 403, path)
  assert.equal((await as(kid, () => jpost('/api/admin/users', { name: 'x1', password: 'password123' }))).status, 403)
  assert.equal((await as(kid, () => api('/api/admin/series/77/rating', { method: 'PUT', body: JSON.stringify({ rating: 'TV-G' }) }))).status, 403)
})

test('ratings: a restricted user cannot see or reach a show above their level', async () => {
  const kid = (await loginAs('kid', 'password123'))!
  await as(kid, async () => {
    const list = await jget('/api/series')
    assert.equal(list.series.length, 0, 'TV-14 show must be hidden from a TV-Y/TV-G user')
    assert.equal((await jget('/api/series?q=Test')).series.length, 0)
    for (const path of ['/api/series/77', '/api/art/77/poster', '/api/stream/1000/0/info', '/api/stream/1000/0/raw', '/api/stream/1000/0/status', '/api/stream/1000/0/hls/index.m3u8'])
      assert.equal((await api(path)).status, 404, path)
    assert.equal((await jpost('/api/watch', { seriesId: 77, season: 1, label: 'S01E01' })).status, 404)
    assert.equal((await jpost('/api/play', { torrentId: 1000 })).status, 404)
    assert.equal((await jget('/api/continue')).items.length, 0)
  })
  // the admin still sees everything
  assert.equal((await jget('/api/series')).series.length, 1)
})

test('ratings: admin can override a rating, and Unrated is blocked unless allowed', async () => {
  const kid = (await loginAs('kid', 'password123'))!
  const put = (rating: string | null) => api('/api/admin/series/77/rating', { method: 'PUT', body: JSON.stringify({ rating }) })
  assert.equal((await put('TV-G')).status, 200)
  await as(kid, async () => {
    const l = await jget('/api/series'); assert.equal(l.series.length, 1); assert.equal(l.series[0].rating, 'TV-G')
    const s = await jget('/api/series/77'); assert.equal(s.series.rating, 'TV-G'); assert.equal(s.series.source, 'admin')
    assert.equal((await api('/api/art/77/poster')).status, 200)
  })
  assert.equal((await put('Unrated')).status, 200)
  await as(kid, async () => assert.equal((await jget('/api/series')).series.length, 0, 'unknown rating must not be shown to a restricted user'))
  assert.equal((await put('PG-13')).status, 400)
  // allow Unrated for the kid -> visible again
  const users = (await jget('/api/admin/users')).users
  const kidId = users.find((u: any) => u.name === 'kid').id
  const patch = (body: any) => api(`/api/admin/users/${kidId}`, { method: 'PATCH', body: JSON.stringify(body) })
  assert.equal((await patch({ allowedRatings: ['Unrated'] })).status, 200)
  await as(kid, async () => assert.equal((await jget('/api/series')).series.length, 1))
  // ticking every box == unrestricted
  const all = await (await patch({ allowedRatings: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Unrated'] })).json() as any
  assert.equal(all.allowed, null)
  // back to automatic -> TMDB again
  assert.equal((await put(null)).status, 200)
  assert.equal((await patch({ allowedRatings: [] })).status, 200) // nothing allowed
  await as(kid, async () => assert.equal((await jget('/api/series')).series.length, 0))
  assert.equal((await patch({ allowedRatings: ['TV-MA'] })).status, 200)
})

test('accounts: guards for last admin / self, password reset signs the user out, removal works', async () => {
  const users = (await jget('/api/admin/users')).users
  const me = users.find((u: any) => u.name === 'admin').id, kidId = users.find((u: any) => u.name === 'kid').id
  assert.equal((await api(`/api/admin/users/${me}`, { method: 'DELETE' })).status, 400) // not yourself
  assert.equal((await api(`/api/admin/users/${me}`, { method: 'PATCH', body: JSON.stringify({ isAdmin: false }) })).status, 400) // last admin
  const kid = (await loginAs('kid', 'password123'))!
  assert.equal((await as(kid, () => jget('/api/me'))).user.name, 'kid')
  assert.equal((await api(`/api/admin/users/${kidId}`, { method: 'PATCH', body: JSON.stringify({ password: 'short' }) })).status, 400)
  assert.equal((await api(`/api/admin/users/${kidId}`, { method: 'PATCH', body: JSON.stringify({ password: 'brandnewpass1' }) })).status, 200)
  assert.equal((await as(kid, () => jget('/api/me'))).user, null, 'old session must be invalidated')
  assert.equal(await loginAs('kid', 'password123'), null)
  assert.ok(await loginAs('kid', 'brandnewpass1'))
  assert.equal((await api(`/api/admin/users/${kidId}`, { method: 'DELETE' })).status, 200)
  assert.equal(await loginAs('kid', 'brandnewpass1'), null)
})
