// The TV app plays AC-3 / E-AC-3 episodes with its own player (android/.../NativeVideo.java) under the web app's controls.
// public/nativevideo.js makes the page's <video> drive that player, so the player code is unchanged. This runs the real
// player (public/app.js) in Chromium against a stubbed server and a stubbed native bridge, and checks what the TV relies on:
// the box is told the device takes the sound, the native player is handed the file and plays, seeks and subtitles go
// through it, a failure falls back to the converted playlist, and closing the player lets it go.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'

const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH, '/usr/bin/chromium'].find((p) => p && existsSync(p))
const skip = !EXE ? 'needs a Chromium (CHROMIUM_PATH or /usr/bin/chromium)' : false
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url))

/** The page's own media element, stubbed as in player-bar.test.ts: used only when the play falls back to the web path. */
const MEDIA = `(() => {
  const S = new WeakMap()
  const st = (el) => { let x = S.get(el); if (!x) { x = { paused: true, t: 0, dur: 1400, rs: 4, seeking: false, src: '' }; S.set(el, x) } return x }
  const P = HTMLMediaElement.prototype
  const def = (k, o) => Object.defineProperty(P, k, Object.assign({ configurable: true }, o))
  def('paused', { get() { return st(this).paused } })
  def('currentTime', { get() { return st(this).t }, set(v) { st(this).t = Number(v) || 0 } })
  def('duration', { get() { return st(this).dur } })
  def('readyState', { get() { return st(this).rs } })
  def('seeking', { get() { return st(this).seeking } })
  def('src', { get() { return st(this).src }, set(v) { st(this).src = String(v) } })
  def('currentSrc', { get() { return st(this).src } })
  def('videoWidth', { get() { return 1920 } })
  def('videoHeight', { get() { return 1080 } })
  def('buffered', { get() { return { length: 0, start() { return 0 }, end() { return 0 } } } })
  P.play = function () { const x = st(this); if (x.paused) { x.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')) } return Promise.resolve() }
  P.pause = function () { const x = st(this); if (!x.paused) { x.paused = true; this.dispatchEvent(new Event('pause')) } }
  P.load = function () { const el = this, x = st(this); x.t = 0; this.dispatchEvent(new Event('loadstart')); setTimeout(() => { el.dispatchEvent(new Event('loadedmetadata')); el.dispatchEvent(new Event('durationchange')); el.dispatchEvent(new Event('canplay')) }, 0) }
  P.fastSeek = function (t) { st(this).t = Number(t) || 0 }
  setInterval(() => {
    for (const el of document.querySelectorAll('video')) { const x = st(el); if (x.paused) continue; x.t += 0.5; el.dispatchEvent(new Event('timeupdate')) }
  }, 500)
})()`

/** The app's bridge to ExoPlayer, faked: it loads, plays, seeks and reports the way NativeVideo.java does. */
const BRIDGE = `(() => {
  window.__calls = []
  let st = null
  const push = () => { if (!st) return; window.__flixNative && window.__flixNative({ pos: st.pos, dur: 1400, buf: st.pos + 30, st: st.st, playing: st.pwr && st.st === 3, pwr: st.pwr, w: 1920, h: 1080, seekDone: st.seekDone, ...(window.__failNative ? { err: 'ERROR_CODE_DECODING_FAILED: boom' } : {}) }) }
  window.FlixNative = {
    caps: () => JSON.stringify({ audio: ['ac3', 'eac3'] }),
    load(url, start, play) { __calls.push(['load', url, start, play]); st = { pos: start, pwr: play, st: 2, seekDone: 0 }; setTimeout(() => { if (st) { st.st = 3; push() } }, 100) },
    play() { __calls.push(['play']); if (st) { st.pwr = true; push() } },
    pause() { __calls.push(['pause']); if (st) { st.pwr = false; push() } },
    seek(t, id) { __calls.push(['seek', t, id]); if (st) { st.pos = t; st.seekDone = id; push() } },
    stop() { __calls.push(['stop']); st = null },
  }
  setInterval(() => { if (st && st.pwr && st.st === 3) { st.pos += 0.5; push() } }, 500)
})()`

const WATCH = { torrentId: 9001, fileIndex: 1, seriesName: 'Test Show', episodeTitle: 'Pilot', label: 'S01E01', quality: '1080p', position: 0, next: null }
const SUB = { n: 0, lang: 'eng', label: 'English', forced: false, default: true, url: '/api/stream/9001/1/subs/0.vtt', sync: 'embedded:0', offset: 0 }
const NATIVE = { url: '/api/stream/9001/1/raw', tvUrl: '/api/tv/tok/9001/1/raw', mode: 'direct', native: true, duration: 1400, seekable: true, castUrl: null,
  audio: [{ n: 0, label: 'English · 5.1', lang: 'eng', channels: 6 }], audioIndex: 0, subs: [SUB], qualities: [], quality: null }
const WEB = { ...NATIVE, native: false, mode: 'file', url: '/api/stream/9001/1/offline/file', tvUrl: '/api/tv/tok/9001/1/offline/file' }
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:50.000\nHello from the native layer.\n\n00:10:00.000 --> 00:10:05.000\nLater line.\n'

const asked: string[] = []
let server: Server | null = null, base = '', browser: Browser | null = null

before(async () => {
  if (skip) return
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    const send = (type: string, body: string | Buffer) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    const json = (v: unknown) => send('application/json', JSON.stringify(v))
    if (p.startsWith('/api/')) {
      if (p === '/api/me') return json({ user: { id: 1, name: 'Viewer', is_admin: 0, avatar: null, cast: false }, needsSetup: false })
      if (p === '/api/device-token') return json({ token: 'stub' })
      if (p === '/api/home') return json({ sections: [], myList: [], ready: [], picked: [], because: null, hero: null, listIds: [] })
      if (p === '/api/continue' || p === '/api/leaving') return json({ items: [] })
      if (p === '/api/watch') return json(WATCH)
      if (p === '/api/series/5') return json({ series: { rating: 'TV-MA', ratingSource: 'imdb' }, seasons: [], episodes: [] })
      if (/^\/api\/stream\/\d+\/\d+\/info/.test(p)) {
        const cv = url.searchParams.get('cv') ?? ''
        asked.push(cv)
        return json(cv.split(',').includes('eac3') ? NATIVE : WEB)
      }
      if (p === SUB.url) { res.writeHead(200, { 'content-type': 'text/vtt', 'x-flix-complete': '1', 'x-flix-sync': 'done' }); return res.end(VTT) }
      if (/^\/api\/stream\/\d+\/\d+\/status$/.test(p)) return json({ fileProgress: 1, dlspeed: 0, seeds: 9, peers: 2, downloaded: 1, size: 1 })
      return json({})
    }
    const files: Record<string, [string, string]> = {
      '/': ['public/index.html', 'text/html'],
      '/app.js': ['public/app.js', 'text/javascript'],
      '/style.css': ['public/style.css', 'text/css'],
      '/downloads.js': ['public/downloads.js', 'text/javascript'],
      '/playclock.js': ['public/playclock.js', 'text/javascript'],
      '/nativevideo.js': ['public/nativevideo.js', 'text/javascript'],
      '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
    }
    const f = files[p]
    if (f) return send(f[1], read(f[0]))
    if (p === '/sw.js' || p.startsWith('/vendor/')) return send('text/javascript', '')
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as any).port}`
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
})
after(async () => { await browser?.close(); await new Promise<void>((r) => (server ? server.close(() => r()) : r())) })

async function open(fail = false): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 720 } })
  await page.addInitScript({ content: MEDIA })
  await page.addInitScript({ content: BRIDGE + (fail ? ';window.__failNative = true' : '') })
  await page.goto(`${base}/`)
  await page.waitForFunction(() => !!document.getElementById('av'), null, { timeout: 15_000 })
  await page.evaluate(() => { location.hash = '#/play/5/1/Pilot' })
  await page.waitForSelector('#pl video', { timeout: 15_000 })
  return page
}
const calls = (page: Page) => page.evaluate(() => (window as any).__calls as any[][])

test('an AC-3 episode in the TV app plays through the native player, under the same controls', { skip }, async () => {
  asked.length = 0
  const page = await open()
  try {
    await page.waitForFunction(() => (window as any).__calls.some((c: any[]) => c[0] === 'load'), null, { timeout: 15_000 })
    assert.ok(asked[0].split(',').includes('eac3') && asked[0].split(',').includes('ac3'), `the box is told the device takes the sound (cv=${asked[0]})`)
    const load = (await calls(page)).find((c) => c[0] === 'load')!
    assert.equal(load[1], `${base}/api/tv/tok/9001/1/raw`, 'the native player gets the signed file link, made absolute')
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('native-video')), true, 'the page is see-through over the picture')
    // It plays: the element the player listens to says so, and the clock moves.
    await page.waitForFunction(() => { const v = document.querySelector('#pl video') as HTMLVideoElement; return !v.paused && v.readyState >= 2 && v.currentTime > 0.4 }, null, { timeout: 15_000 })
    assert.equal(await page.evaluate(() => (document.querySelector('#pl video') as HTMLVideoElement).duration), 1400)
    // The subtitle is the player's own <track>, drawn by the native layer.
    await page.waitForFunction(() => /Hello from the native layer/.test(document.querySelector('#pl .n-cues')?.textContent ?? ''), null, { timeout: 15_000 })
    // A seek goes to the native player and lands.
    await page.evaluate(() => { (document.querySelector('#pl video') as HTMLVideoElement).currentTime = 600 })
    await page.waitForFunction(() => (window as any).__calls.some((c: any[]) => c[0] === 'seek' && Math.abs(c[1] - 600) < 0.01), null, { timeout: 5000 })
    await page.waitForFunction(() => { const v = document.querySelector('#pl video') as HTMLVideoElement; return !v.seeking && v.currentTime >= 600 }, null, { timeout: 5000 })
    await page.waitForFunction(() => /Later line/.test(document.querySelector('#pl .n-cues')?.textContent ?? ''), null, { timeout: 5000 })
    // Pause and play are the native player's.
    await page.evaluate(() => (document.querySelector('#pl video') as HTMLVideoElement).pause())
    assert.ok((await calls(page)).some((c) => c[0] === 'pause'))
    assert.equal(await page.evaluate(() => (document.querySelector('#pl video') as HTMLVideoElement).paused), true)
    // Leaving the player lets the native player go and makes the page opaque again.
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForFunction(() => (window as any).__calls.some((c: any[]) => c[0] === 'stop') && !document.documentElement.classList.contains('native-video'), null, { timeout: 10_000 })
  } finally { await page.close() }
})

test('a native player that fails falls back to the web path, and is not asked again', { skip }, async () => {
  asked.length = 0
  const page = await open(true)
  try {
    await page.waitForFunction(() => (window as any).__calls.some((c: any[]) => c[0] === 'load'), null, { timeout: 15_000 })
    // The failure asks /info again without the Dolby codecs, and that answer is played by the page's own element.
    await page.waitForFunction(() => String((document.querySelector('#pl video') as HTMLVideoElement | null)?.src ?? '').includes('/offline/file'), null, { timeout: 20_000 })
    assert.ok(asked.length >= 2, 'asked again')
    assert.ok(!asked[asked.length - 1].split(',').includes('eac3'), `the second ask no longer claims the sound (cv=${asked[asked.length - 1]})`)
    assert.equal(await page.evaluate(() => !!(document.querySelector('#pl video') as any).__native), false, 'the element is the page\'s own again')
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('native-video')), false)
  } finally { await page.close() }
})
