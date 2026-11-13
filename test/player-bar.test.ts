// The player's controls must go away five seconds after the viewer stops touching them (Brian: "sometimes the controls
// that show over the video playing don't disappear. It's annoying."). The player runs for real here -- public/app.js in
// Chromium against a stubbed server and a stubbed media element -- because the defect is in the code that decides, not in
// a function that can be called on its own: `menuOpen()` reads the live DOM, and a list left under `.p-menu` is what
// holds the bar up for ever (the stylesheet pins `.p-top:has(.menu)` and `.p-ctl:has(.menu)` visible).
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
const WATCH = { torrentId: 9001, fileIndex: 1, seriesName: 'Test Show', episodeTitle: 'Pilot', label: 'S01E01', quality: '1080p', position: 0, next: null }
const INFO = {
  url: '/media.mp4', mode: 'direct', duration: 1400, seekable: true, castUrl: null,
  audio: [{ n: 0, label: 'English', lang: 'en' }, { n: 1, label: 'French', lang: 'fr' }], audioIndex: 0,
  subs: [], qualities: [1080, 720], quality: 1080,
}

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
      if (p === '/api/series/5') return json({ series: { rating: 'TV-MA', ratingSource: 'imdb' }, seasons: [], episodes: [] })
      if (/^\/api\/stream\/\d+\/\d+\/info/.test(p)) return json(INFO)
      if (/^\/api\/stream\/\d+\/\d+\/status$/.test(p)) return json({ fileProgress: 1, dlspeed: 0, seeds: 9, peers: 2, downloaded: 1, size: 1 })
      return json({})
    }
    const files: Record<string, [string, string]> = {
      '/': ['public/index.html', 'text/html'],
      '/app.js': ['public/app.js', 'text/javascript'],
      '/style.css': ['public/style.css', 'text/css'],
      '/downloads.js': ['public/downloads.js', 'text/javascript'],
      '/playclock.js': ['public/playclock.js', 'text/javascript'],
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
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript({ content: MEDIA })
  // Home first, then the episode: opening the app straight onto a deep page is a separate path (the app puts Home behind it
  // in the history), and this test is about the player, not the router.
  await page.goto(`${base}/`)
  await page.waitForFunction(() => !!document.getElementById('av'), null, { timeout: 15_000 })
  await page.evaluate(() => { location.hash = '#/play/5/1/Pilot' })
  await page.waitForSelector('#pl video', { timeout: 15_000 })
  await page.waitForFunction(() => { const v = document.querySelector('#pl video') as HTMLVideoElement | null; return !!v && !v.paused }, null, { timeout: 20_000 })
  return page
}

/** Where the bar is now: up, or gone. */
const quiet = (page: Page) => page.evaluate(() => !!document.querySelector('#pl.player')?.classList.contains('p-quiet'))
/** The lists open over the picture right now -- any `.menu` under the player that is not on its way out. */
const openLists = (page: Page) => page.$$eval('#pl .p-menu .menu:not(.out)', (els) => els.length)
/** The viewer's hand: a mouse really moving over the picture, which brings the bar back and starts its five seconds. */
async function touch(page: Page) {
  await page.mouse.move(320, 240)
  await page.mouse.move(340, 250)
  await page.waitForFunction(() => !document.querySelector('#pl.player')?.classList.contains('p-quiet'), null, { timeout: 3000 })
}

test('the bar goes away five seconds after the viewer stops touching it', { skip }, async () => {
  const page = await playing()
  try {
    assert.equal(await page.waitForFunction(() => !!document.querySelector('#pl.player')?.classList.contains('p-quiet'), null, { timeout: 12_000 }).then(() => true).catch(() => false), true,
      'with the picture running and nobody touching it, the bar and the cursor go')
    // ...and one touch brings it back, without the bar then sticking.
    await touch(page)
    assert.equal(await quiet(page), false, 'a moving mouse brings the bar back')
    await page.waitForTimeout(6500)
    assert.equal(await quiet(page), true, 'and it goes again five seconds after the last movement')
  } finally { await page.close() }
})

test('a second list opened over the picture closes the first, and the bar still goes once one is picked', { skip }, async () => {
  const page = await playing()
  try {
    await page.waitForFunction(() => !!document.querySelector('#pl.player')?.classList.contains('p-quiet'), null, { timeout: 12_000 })
    await touch(page)
    await page.click('#aud') // the audio list, in the top bar
    await page.waitForSelector('#pl .p-menu .menu button[data-n]')
    await page.click('#pq') // and now the quality list, in the control bar
    await page.waitForTimeout(300)
    assert.equal(await openLists(page), 1, 'the quality list takes the place of the audio list instead of sitting beside it')
    await page.click('#pl .p-menu .menu button[data-q="auto"]')
    await page.waitForTimeout(300)
    assert.equal(await openLists(page), 0, 'picking from the list closes it')
    // Nothing is left holding the bar up: five seconds of nobody touching it and it goes.
    assert.equal(await page.waitForFunction(() => !!document.querySelector('#pl.player')?.classList.contains('p-quiet'), null, { timeout: 9000 }).then(() => true).catch(() => false), true,
      'after a pick from a list the bar goes again')
  } finally { await page.close() }
})
