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

// ---- environment for the app (must be set before importing it) ----
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.PORT = String(P.app)
process.env.HOST = '127.0.0.1'
process.env.LOG_LEVEL = 'warn'
process.env.PROBE_TIMEOUT_MS = '30000'
process.env.BTN_API_KEY = 'testkey'
process.env.BTN_API_URL = `http://127.0.0.1:${P.btn}/`
process.env.QB_URL = `http://127.0.0.1:${P.qb}`
process.env.SWEEP_INTERVAL_SEC = '3600'

let tracker: any, seeder: WebTorrent.Instance, btn: Server, qbProc: ChildProcess
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
    SeriesPoster: '', ReleaseName: m.path.split('/').pop(), Category: 'Episode', Codec: 'H.264', Container: k.split('.')[1].toUpperCase(),
    Source: 'WEB-DL', Resolution: '360p', Origin: 'P2P', Size: String(m.data.length), Time: String(1700000000 + i), InfoHash: m.hash.toUpperCase(),
    Seeders: '1', Leechers: '0', Genres: ['Test'], TorrentLink: `http://127.0.0.1:${P.btn}/dl/${1000 + i}?torrent_pass=SECRETPASSKEY`,
  }))
  btn = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/dl/')) {
      const i = Number(req.url.split('/')[2].split('?')[0]) - 1000
      res.end(Object.values(media)[i].torrent); return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const rpc = JSON.parse(body)
      assert.equal(rpc.params[0], 'testkey')
      const obj = Object.fromEntries(torrents.map((t) => [t.TorrentID, t]))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { results: String(torrents.length), torrents: obj } }))
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
  assert.equal(s.releases.length, 2)
  assert.ok(!JSON.stringify(s).includes('SECRETPASSKEY'))
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
