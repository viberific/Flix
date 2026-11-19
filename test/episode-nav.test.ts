// Two things a family hit on the TV: the previous/next episode pills could not be reached with the remote, and "Up next"
// moved on to the next episode while the credits had barely begun (or a reality show was still playing under them).
// The player runs for real, as in player-bar.test.ts, with a television's user agent.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'

const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH, '/usr/bin/chromium'].find((p) => p && existsSync(p))
const skip = !EXE ? 'needs a Chromium (CHROMIUM_PATH or /usr/bin/chromium)' : false
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url))

/** A media element that is really "playing" without a file: the player reads paused/readyState/currentTime and listens
    for `playing` and `timeupdate`, and every one of them is what decides whether the bar may go. */
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

// What the stubbed server answers. One episode, two audio tracks (so the audio list is offered) and two picture sizes (so
// the quality list is), which together are the two lists a viewer opens over the picture.
const WATCH = { torrentId: 9001, fileIndex: 1, seriesName: 'Test Show', episodeTitle: 'Middle', title: 'S01E02', label: 'S01E02', quality: '1080p', position: 0, next: { label: 'S01E03', season: 1, title: 'Last' } }
const INFO = {
  url: '/media.mp4', mode: 'direct', duration: 1400, seekable: true, castUrl: null,
  audio: [{ n: 0, label: 'English', lang: 'en' }, { n: 1, label: 'French', lang: 'fr' }], audioIndex: 0,
  subs: [], qualities: [1080, 720], quality: 1080, creditsAt: 1200,
}

// Which /info answer is given, and the audio track each ask was for.
let info: Record<string, unknown> = INFO
const asked: number[] = []

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
      if (p === '/api/continue') return json({ items: [] })
      if (p === '/api/leaving') return json({ items: [] })
      if (p === '/api/watch') return json(WATCH)
      if (p === '/api/series/5') return json({ series: { rating: 'TV-MA', ratingSource: 'imdb' }, seasons: [], episodes: ['S01E01', 'S01E02', 'S01E03'].map((label) => ({ label, season: 1, available: true })) })
      if (/^\/api\/stream\/\d+\/\d+\/info/.test(p)) { const a = Number(url.searchParams.get('a') ?? 0); asked.push(a); return json({ ...info, audioIndex: a }) }
      if (/^\/api\/stream\/\d+\/\d+\/status$/.test(p)) return json({ fileProgress: 1, dlspeed: 0, seeds: 9, peers: 2, downloaded: 1, size: 1 })
      return json({})
    }
    const files: Record<string, [string, string]> = {
      '/': ['public/index.html', 'text/html'],
      '/app.js': ['public/app.js', 'text/javascript'],
      '/style.css': ['public/style.css', 'text/css'],
      '/downloads.js': ['public/downloads.js', 'text/javascript'],
      '/playclock.js': ['public/playclock.js', 'text/javascript'], '/nativevideo.js': ['public/nativevideo.js', 'text/javascript'],
      '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
    }
    const f = files[p]
    if (f) return send(f[1], read(f[0]))
    if (p === '/sw.js') return send('text/javascript', '')
    if (p.endsWith('.png') || p.endsWith('.svg')) { res.writeHead(404); return res.end() }
    if (p.startsWith('/vendor/')) return send('text/javascript', '') // no hls.js: this episode is a plain file
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as any).port}`
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
})
after(async () => { await browser?.close(); await new Promise<void>((r) => (server ? server.close(() => r()) : r())) })

/** Open the player and wait until the episode is really playing (the intro holds the picture for four seconds first). */
async function playing(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1920, height: 1080 }, userAgent: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' })
  await page.addInitScript({ content: MEDIA })
  // Home first, then the episode: opening the app straight onto a deep page is a separate path (the app puts Home behind it
  // in the history), and this test is about the player, not the router.
  await page.goto(`${base}/`)
  await page.waitForFunction(() => !!document.getElementById('av'), null, { timeout: 15_000 })
  await page.evaluate(() => { location.hash = '#/play/5/1/S01E02' })
  await page.waitForSelector('#pl video', { timeout: 15_000 })
  await page.waitForFunction(() => { const v = document.querySelector('#pl video') as HTMLVideoElement | null; return !!v && !v.paused }, null, { timeout: 20_000 })
  return page
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
async function press(page: Page, k: string) { await page.keyboard.press(k); await page.waitForTimeout(120) }

test('a remote reaches the previous and next episode pills', { skip }, async () => {
  const page = await playing()
  try {
    await page.waitForFunction(() => !document.getElementById('peps')?.hidden, null, { timeout: 10_000 })
    await press(page, 'ArrowUp')
    assert.equal(await focused(page), 'ppp', 'up from the picture lands on play/pause')
    await press(page, 'ArrowUp')
    assert.equal(await focused(page), 'pnext', 'up again reaches the next-episode pill')
    await press(page, 'ArrowLeft')
    assert.equal(await focused(page), 'pprev', 'left walks to the previous-episode pill')
    await press(page, 'ArrowRight')
    assert.equal(await focused(page), 'pnext')
    await press(page, 'ArrowDown')
    assert.equal(await focused(page), 'ppp', 'down comes back to play/pause')
    await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft')
    assert.equal(await focused(page), 'pbw', 'left along the bar stops at back-10, not inside the pills')
    await press(page, 'ArrowUp'); await press(page, 'ArrowLeft'); await press(page, 'Enter')
    await page.waitForFunction(() => location.hash === '#/play/5/1/S01E01', null, { timeout: 5000 })
  } finally { await page.close() }
})

const seek = (page: Page, t: number) => page.evaluate((t) => { (document.querySelector('#pl video') as HTMLVideoElement).currentTime = t }, t)

test('up next comes with the credits, but only moves on as the file runs out', { skip }, async () => {
  const page = await playing()
  try {
    await seek(page, 1210) // in the credits, three minutes before the end of the file
    await page.waitForSelector('#pl .p-next', { timeout: 5000 })
    assert.equal(await page.$eval('#pl .p-next', (b) => b.classList.contains('counting')), false, 'no countdown while the file has minutes left')
    await page.waitForTimeout(17_000)
    assert.equal(await page.evaluate(() => location.hash), '#/play/5/1/S01E02', 'still on this episode after more than fifteen seconds')
    await seek(page, 1390) // ten seconds of file left
    await page.waitForFunction(() => document.querySelector('#pl .p-next')?.classList.contains('counting'), null, { timeout: 3000 })
    await page.waitForFunction(() => location.hash === '#/play/5/1/S01E03', null, { timeout: 15_000 })
  } finally { await page.close() }
})

test('Play now still moves on at once during the credits', { skip }, async () => {
  const page = await playing()
  try {
    await seek(page, 1210)
    await page.waitForSelector('#pl .p-next #nn', { timeout: 5000 })
    assert.equal(await focused(page), 'nn', 'on a television Play now has the focus')
    await press(page, 'Enter')
    await page.waitForFunction(() => location.hash === '#/play/5/1/S01E03', null, { timeout: 5000 })
  } finally { await page.close() }
})
