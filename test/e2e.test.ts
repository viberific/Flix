// End-to-end: mock BTN API + local tracker + WebTorrent seeder + real qbittorrent-nox + real ffmpeg.
import * as nodeTest from 'node:test'
import { execFileSync as probe } from 'node:child_process'

// These need the real tools. Without them every test would fail the same way and hide a real breakage, so they are skipped
// instead. Each tool is asked with the flag it actually has: ffmpeg answers -version (and exits 8 on --version, which
// made every one of these skip on a machine that has it), while qbittorrent-nox reads -version as "start the server" and
// never returns -- so the probe gets a timeout as well.
const lacking = [['qbittorrent-nox', '--version'], ['ffmpeg', '-version']]
  .filter(([bin, flag]) => { try { probe(bin, [flag], { stdio: 'ignore', timeout: 15_000 }); return false } catch { return true } })
  .map(([bin]) => bin)
const skip = lacking.length ? `needs ${lacking.join(' and ')} installed` : false
const test = (name: string, fn: (...a: any[]) => any) => nodeTest.test(name, { skip }, fn)
const before = (fn: () => any) => { if (!skip) nodeTest.before(fn) }
const after = (fn: () => any) => { if (!skip) nodeTest.after(fn) }
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
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
process.env.OMDB_API_KEY = 'omdbkey'
process.env.OMDB_API_URL = `http://127.0.0.1:${P.btn}/omdb`
process.env.YOUTUBE_SEARCH_URL = '' // no trailer search, and nothing else, leaves the machine
process.env.YOUTUBE_OEMBED_URL = ''
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
// A backdrop wide enough to pass the server's check for a usable banner (at least 900px wide and 1.5x wider than tall).
const BACKDROP = (() => {
  const w = 1280, h = 360
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0 // 8-bit greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w + 1) * h))), chunk('IEND', Buffer.alloc(0))])
})()
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
  const files = {
    'direct.mp4': mk('Test.Show.S01E01.mp4', ['-c:a', 'aac', '-movflags', '+faststart']),
    'hls.mkv': mk('Test.Show.S01E02.mkv', ['-c:a', 'ac3']),
    // A picture the remux cannot put in an MP4 (MPEG-4 part 2 in Matroska, which is neither direct nor remuxable), so a
    // play of it is HLS however much of anything else on disk is finished: this test does not depend on another test's
    // remux, and it is its own show so it does not change the episode count of series 77 either.
    'mpeg4.mkv': mk('Second.Show.S01E01.mkv', ['-c:v', 'mpeg4', '-c:a', 'ac3']),
  }

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
    GroupName: i < 2 ? `Test Show - S01E0${i + 1}` : 'Second Show - S01E01', GroupID: String(100 + i), TorrentID: String(1000 + i),
    SeriesID: i < 2 ? '77' : '78', Series: i < 2 ? 'Test Show' : 'Second Show',
    SeriesPoster: `http://127.0.0.1:${P.btn}/img/poster.png`, ReleaseName: m.path.split('/').pop(), Category: 'Episode', Codec: i < 2 ? 'H.264' : 'MPEG-4', Container: k.split('.')[1].toUpperCase(),
    Source: 'WEB-DL', Resolution: '360p', Origin: 'P2P', Size: String(m.data.length), Time: String(1700000000 + i), InfoHash: m.hash.toUpperCase(),
    TvdbID: '555', ImdbID: 'tt0903747', Seeders: '1', Leechers: '0', Genres: ['Test'], DownloadURL: `http://127.0.0.1:${P.btn}/dl/${1000 + i}?torrent_pass=SECRETPASSKEY`,
  }))
  btn = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/tmdb/')) {
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/tmdb/find/555')) return void res.end(JSON.stringify({ tv_results: [{ id: 9001, backdrop_path: '/bd.png' }] }))
      // English, two episodes in season 1 (the show's real length: what lets both single episodes count as a whole season)
      if (/^\/tmdb\/tv\/9001(\?|$)/.test(req.url)) return void res.end(JSON.stringify({ original_language: 'en', networks: [{ name: 'HBO' }], first_air_date: '2020-01-01', popularity: 50, seasons: [{ season_number: 1, episode_count: 2 }] }))
      if (req.url.startsWith('/tmdb/tv/9001/content_ratings')) return void res.end(JSON.stringify({ results: [{ iso_3166_1: 'GB', rating: '15' }, { iso_3166_1: 'US', rating: 'TV-14' }] }))
      res.statusCode = 404; return void res.end('{}')
    }
    if (req.method === 'GET' && req.url?.startsWith('/omdb/')) {
      res.setHeader('content-type', 'application/json')
      return void res.end(JSON.stringify(req.url.includes('i=tt0903747') && req.url.includes('apikey=omdbkey') ? { Response: 'True', Rated: 'TV-14', imdbRating: '8.1' } : { Response: 'False', Error: 'Incorrect IMDb ID.' }))
    }
    if (req.method === 'GET' && req.url === '/tmdbimg/w1280/bd.png') { res.setHeader('content-type', 'image/png'); res.end(BACKDROP); return }
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

/**
 * Stop a child and wait for it to be gone: SIGTERM, then SIGKILL once the grace period is up. Polling the handle
 * instead would answer for a process whose exit has not been delivered yet; the 'exit' event is the real moment.
 */
async function stopChild(child: ChildProcess | undefined, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const hard = setTimeout(() => child.kill('SIGKILL'), graceMs)
  hard.unref()
  await exited
  clearTimeout(hard)
  if (child.exitCode === null && child.signalCode === null) throw new Error(`child ${pid} would not stop`)
}

// Teardown returns; it never calls process.exit. The runner reports a file's results as each test finishes but only
// prints its totals once every test has reported, so an exit() here threw away the report of whatever had not been
// counted yet -- in 0.3.26 that was this file's last test, which ran and passed and was never counted (16 declared,
// 15 reported). A status still gets out: anything left running is a failure, so it is thrown (the runner reports the
// hook as failed) and process.exitCode carries it rather than ending the process early.
after(async () => {
  let stuck: Error | undefined
  const { app } = await import('../src/server.ts')
  await app.close() // stop answering first, so nothing new is queued against the tracker, the seeder or qBittorrent
  try { await stopChild(qbProc) } catch (e) { stuck = e as Error }
  await seeder?.destroy()
  tracker?.close(); btn?.close()
  if (stuck) { process.exitCode = 1; throw stuck }
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
  assert.equal(bn.status, 200); assert.ok(Buffer.from(await bn.arrayBuffer()).equals(BACKDROP))
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

/** Wait for the server to have the whole file (and, for a conversion, to finish it); the device does the same by asking again. */
async function offlineReady(t: number, f: number) {
  for (let i = 0; i < 240; i++) {
    const s: any = await jget(`/api/stream/${t}/${f}/offline`)
    if (s.state === 'ready') return s
    assert.notEqual(s.state, 'error', s.message)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('offline copy never became ready')
}

test('downloads: a finished MP4 is sent as it is, with byte ranges', async () => {
  const play = await playAndFetch(1000)
  const s = await offlineReady(1000, play.fileIndex)
  const m = media['direct.mp4']
  assert.equal(s.size, m.data.length)
  const part = await api(`/api/stream/1000/${play.fileIndex}/offline/file`, { headers: { range: 'bytes=100-199' } })
  assert.equal(part.status, 206)
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(m.data.subarray(100, 200)))
  const full = await api(`/api/stream/1000/${play.fileIndex}/offline/file`)
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), sha(m.data))
})

test('downloads: an MKV is converted to one MP4 for the device', async () => {
  const play = await playAndFetch(1001)
  await offlineReady(1001, play.fileIndex)
  const res = await api(`/api/stream/1001/${play.fileIndex}/offline/file`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/mp4')
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(body.subarray(4, 8).toString(), 'ftyp')
})

test('casting: a finished episode goes to the TV as one seekable file, not a playlist built forwards', async () => {
  // A plain MP4 as it is: the whole length is known from the first byte.
  const one = await playAndFetch(1000)
  const direct: any = await jget(`/api/stream/1000/${one.fileIndex}/info?cast=1`)
  assert.equal(direct.seekable, true)
  assert.match(direct.tvUrl, /\/raw$/)
  assert.equal(direct.tvType, 'video/mp4')
  // An MKV goes over as the single remuxed MP4. This is the whole point: the playlist for a passed-through picture is built
  // forwards and a cast receiver never re-reads it, so the TV would only ever have the part converted so far to drag in.
  const two = await playAndFetch(1001)
  await offlineReady(1001, two.fileIndex)
  const info: any = await jget(`/api/stream/1001/${two.fileIndex}/info?cast=1`)
  assert.equal(info.seekable, true)
  assert.match(info.tvUrl, /\/offline\/file$/)
  assert.equal(info.tvType, 'video/mp4')
  assert.match(info.castFallbackUrl ?? '/hls/index.m3u8', /\/hls\/index\.m3u8$/)
  // Fetched the way the TV does -- the token in the path, no cookie -- a range comes back with the whole episode's length
  // in it, which is what the scrubber is drawn from.
  const part = await api(info.tvUrl, { headers: { range: 'bytes=0-1023' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-type'), 'video/mp4')
  const cr = part.headers.get('content-range') ?? ''
  assert.match(cr, /^bytes 0-1023\/[1-9]\d+$/, `content-range ${cr}`)
  const s: any = await jget(`/api/stream/1001/${two.fileIndex}/offline`)
  assert.equal(Number(/(\d+)$/.exec(cr)![1]), s.size)
})

test('transcode path: mkv/ac3 is served as HLS', async () => {
  // Torrent 1002: its own show, and a picture no remux can put in an MP4, so the mode is HLS whatever ran before this.
  const play = await playAndFetch(1002)
  const info = await jget(`/api/stream/1002/${play.fileIndex}/info`)
  assert.equal(info.mode, 'hls')
  // Nothing finished can be handed over as a file, so the TV is given the playlist and told that is what it is.
  assert.equal(info.seekable, false)
  assert.equal(info.tvType, 'application/vnd.apple.mpegurl')
  assert.match(info.tvUrl, /hls\/index\.m3u8$/)
  const pl = await api(info.url)
  assert.equal(pl.status, 200)
  const text = await pl.text()
  assert.match(text, /#EXTM3U/)
  const seg = text.split('\n').find((l) => l.endsWith('.ts'))!
  const sr = await api(`/api/stream/1002/${play.fileIndex}/hls/${seg}`)
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
  assert.ok(!existsSync(join(process.env.DOWNLOAD_DIR!, 'Test.Show.S01E01.mp4')), 'files should be deleted')
  assert.ok(!existsSync(join(process.env.DOWNLOAD_DIR!, hash)), 'and no per-torrent folder is left behind')
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

test('ratings: looked up automatically from IMDb (through OMDb, by IMDb id), with the IMDb score', async () => {
  let got: any
  for (let i = 0; i < 40; i++) { got = (await jget('/api/series/77')).series; if (got.source === 'imdb') break; await sleep(250) }
  assert.equal(got.rating, 'TV-14'); assert.equal(got.source, 'imdb'); assert.equal(got.score, 8.1)
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
})

test('accounts: a child (not admin, no TV-MA) needs no password; anyone else does', async () => {
  assert.equal((await jpost('/api/admin/users', { name: 'grown', password: '' })).status, 400) // unrestricted needs one
  assert.equal((await jpost('/api/admin/users', { name: 'grown', password: '', allowedRatings: ['TV-14', 'TV-MA'] })).status, 400)
  assert.equal((await jpost('/api/admin/users', { name: 'tot', password: '', allowedRatings: ['TV-Y', 'TV-G'] })).status, 200)
  const tot = (await loginAs('tot', ''))!
  assert.ok(tot, 'a child signs in by name alone')
  assert.equal((await as(tot, () => jget('/api/me'))).user.hasPassword, false)
  const totId = (await jget('/api/admin/users')).users.find((u: any) => u.name === 'tot').id
  const patch = (body: any) => api(`/api/admin/users/${totId}`, { method: 'PATCH', body: JSON.stringify(body) })
  assert.equal((await patch({ allowedRatings: ['TV-Y', 'TV-MA'] })).status, 400, 'TV-MA needs a password first')
  assert.equal((await patch({ isAdmin: true })).status, 400, 'so does admin')
  assert.equal((await patch({ allowedRatings: ['TV-Y', 'TV-MA'], password: 'grownupnow1' })).status, 200)
  assert.equal(await loginAs('tot', ''), null, 'no longer a child, so the password is needed')
  assert.ok(await loginAs('tot', 'grownupnow1'))
  assert.equal((await api(`/api/admin/users/${totId}`, { method: 'DELETE' })).status, 200)
})

test('ratings: a restricted user cannot see or reach a show above their level', async () => {
  const kid = (await loginAs('kid', 'password123'))!
  await as(kid, async () => {
    const list = await jget('/api/series')
    assert.equal(list.series.length, 0, 'TV-14 show must be hidden from a TV-Y/TV-G user')
    assert.equal((await jget('/api/series?q=Test')).series.length, 0)
    for (const path of ['/api/series/77', '/api/art/77/poster', '/api/stream/1000/0/info', '/api/stream/1000/0/raw', '/api/stream/1000/0/status', '/api/stream/1000/0/offline', '/api/stream/1000/0/offline/file', '/api/stream/1000/0/hls/index.m3u8'])
      assert.equal((await api(path)).status, 404, path)
    assert.equal((await jpost('/api/watch', { seriesId: 77, season: 1, label: 'S01E01' })).status, 404)
    assert.equal((await jpost('/api/play', { torrentId: 1000 })).status, 404)
    assert.equal((await jget('/api/continue')).items.length, 0)
  })
  // the admin still sees everything
  assert.equal((await jget('/api/series')).series.length, 1)
})

test('ratings: there is no way to set one by hand; the viewer\'s allowed list decides, and Unrated is blocked unless allowed', async () => {
  const kid = (await loginAs('kid', 'password123'))!
  assert.notEqual((await api('/api/admin/series/77/rating', { method: 'PUT', body: JSON.stringify({ rating: 'TV-G' }) })).status, 200)
  assert.equal((await jget('/api/series/77')).series.rating, 'TV-14') // unchanged
  const users = (await jget('/api/admin/users')).users
  const kidId = users.find((u: any) => u.name === 'kid').id
  const patch = (body: any) => api(`/api/admin/users/${kidId}`, { method: 'PATCH', body: JSON.stringify(body) })
  assert.equal((await patch({ allowedRatings: ['Unrated'] })).status, 200)
  await as(kid, async () => assert.equal((await jget('/api/series')).series.length, 0, 'a TV-14 show is not Unrated'))
  assert.equal((await patch({ allowedRatings: ['TV-14'] })).status, 200)
  await as(kid, async () => {
    const l = await jget('/api/series'); assert.equal(l.series.length, 1); assert.equal(l.series[0].rating, 'TV-14')
    assert.equal((await api('/api/art/77/poster')).status, 200)
  })
  // ticking every box == unrestricted
  const all = await (await patch({ allowedRatings: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Unrated'] })).json() as any
  assert.equal(all.allowed, null)
  assert.equal((await patch({ allowedRatings: [] })).status, 200) // nothing allowed
  await as(kid, async () => assert.equal((await jget('/api/series')).series.length, 0))
  assert.equal((await patch({ allowedRatings: ['TV-MA'] })).status, 200)
})

test('profile: a person picks their own creature, renames themselves and changes their own password', async () => {
  await jpost('/api/admin/users', { name: 'prof', password: 'password123' })
  const c = (await loginAs('prof', 'password123'))!
  const patch = (body: any) => as(c, () => api('/api/me', { method: 'PATCH', body: JSON.stringify(body) }))
  // the picture has to be one we draw
  assert.equal((await patch({ avatar: 'not-a-creature' })).status, 400)
  const picked = await (await patch({ avatar: 'owl' })).json() as any
  assert.equal(picked.user.avatar, 'owl')
  await as(c, async () => assert.equal((await jget('/api/me')).user.avatar, 'owl'))
  // the name is the one shown everywhere, and nobody else may take it
  assert.equal((await patch({ name: 'kid' })).status, 400) // already taken
  assert.equal((await (await patch({ name: 'prof2' })).json() as any).user.name, 'prof2')
  await as(c, async () => assert.equal((await jget('/api/me')).user.name, 'prof2'))
  // a password needs the current one, and 8+ characters
  assert.equal((await patch({ currentPassword: 'wrong', newPassword: 'anotherpass1' })).status, 400)
  assert.equal((await patch({ currentPassword: 'password123', newPassword: 'short' })).status, 400)
  const changed = await patch({ currentPassword: 'password123', newPassword: 'anotherpass1' })
  assert.equal(changed.status, 200, await changed.clone().text())
  // the browser that changed it is kept signed in, on a fresh session; the old cookie is dead
  const c2 = changed.headers.get('set-cookie')!.split(';')[0]
  await as(c2, async () => assert.equal((await jget('/api/me')).user.name, 'prof2'))
  await as(c, async () => assert.equal((await jget('/api/me')).user, null, 'the session it was changed from is signed out'))
  assert.equal(await loginAs('prof2', 'password123'), null)
  assert.ok(await loginAs('prof2', 'anotherpass1'))
  // and a picture can be given up again
  assert.equal((await (await as(c2, () => api('/api/me', { method: 'PATCH', body: JSON.stringify({ avatar: null }) }))).json() as any).user.avatar, null)
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
