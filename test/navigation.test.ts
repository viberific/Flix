// Back, as the person presses it. Brian: "When I try to 'go back' the app doesn't 'remember' where you were and load the
// previous page. It just closes the app." Two faults made that: the app opened on a page (a TV's last-used shortcut, a
// resumed PWA still on its episode) read location.hash AFTER the replaceState that clears it, so the page it was opened
// on was thrown away and replaced by the home screen; and the home screen -- the root of the app -- had nothing behind it,
// so a Back press there was the press that finished the Android activity.
//
// The player runs for real in Chromium against a stubbed server, and Back is pressed the way MainActivity.onBackPressed
// presses it: window.__flixBack first, then the WebView's own history, and if there is nothing left, the app closes (in
// Chromium, history behind the page's first entry is about:blank -- that is the "closed" this test watches for).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'

const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH, '/usr/bin/chromium'].find((p) => p && existsSync(p))
const skip = !EXE ? 'needs a Chromium (CHROMIUM_PATH or /usr/bin/chromium)' : false
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url))
// The Android app's own user agent (MainActivity appends this), which is how the page knows it is in a shell with no
// browser bar -- the case where Back must never be allowed to fall out of the app.
const UA = 'Mozilla/5.0 (Linux; Android 12; AFTKA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Android TV FlixApp'

const MEDIA = `(() => {
  const S = new WeakMap()
  const st = (el) => { let x = S.get(el); if (!x) { x = { paused: true, t: 0, dur: 1400, rs: 4, src: '' }; S.set(el, x) } return x }
  const P = HTMLMediaElement.prototype
  const def = (k, o) => Object.defineProperty(P, k, Object.assign({ configurable: true }, o))
  def('paused', { get() { return st(this).paused } })
  def('currentTime', { get() { return st(this).t }, set(v) { st(this).t = Number(v) || 0 } })
  def('duration', { get() { return st(this).dur } })
  def('readyState', { get() { return st(this).rs } })
  def('seeking', { get() { return this.seeking } })
  def('src', { get() { return st(this).src }, set(v) { st(this).src = String(v) } })
  def('currentSrc', { get() { return st(this).src } })
  def('videoWidth', { get() { return 1920 } })
  def('videoHeight', { get() { return 1080 } })
  def('buffered', { get() { return { length: 0, start() { return 0 }, end() { return 0 } } } })
  P.play = function () { const x = st(this); if (x.paused) { x.paused = false; this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')) } return Promise.resolve() }
  P.pause = function () { const x = st(this); if (!x.paused) { x.paused = true; this.dispatchEvent(new Event('pause')) } }
  P.load = function () { const el = this, x = st(this); x.t = 0; this.dispatchEvent(new Event('loadstart')); setTimeout(() => { el.dispatchEvent(new Event('loadedmetadata')); el.dispatchEvent(new Event('durationchange')); el.dispatchEvent(new Event('canplay')) }, 0) }
  setInterval(() => { for (const el of document.querySelectorAll('video')) { const x = st(el); if (x.paused) continue; x.t += 0.5; el.dispatchEvent(new Event('timeupdate')) } }, 500)
})()`

const WATCH = { torrentId: 9001, fileIndex: 1, seriesName: 'Test Show', episodeTitle: 'Pilot', label: 'S01E01', quality: '1080p', position: 0, next: null }
const INFO = {
  url: '/media.mp4', mode: 'direct', duration: 1400, seekable: true, castUrl: null,
  audio: [{ n: 0, label: 'English', lang: 'en' }], audioIndex: 0, subs: [], qualities: [1080], quality: 1080,
}
const SERIES = {
  series: { id: 5, name: 'Test Show', rating: 'TV-MA', ratingSource: 'imdb', overview: 'A show.', poster: null, banner: null, genres: [], inList: false, cast: [], score: 7.5, year: 2024, vote: 0, trailerId: null, source: 'imdb' },
  seasons: [{ season: 1, episodes: 1 }], leavesAt: null,
  episodes: [{ season: 1, episode: 1, label: 'S01E01', title: 'Pilot', available: true, onServer: true, quality: '1080p', watched: false, position: 0, duration: 1400, isPack: false, torrentId: 9001, fileIndex: 1 }],
  current: { season: 1, label: 'S01E01' },
}
/** Enough home rows that the screen is taller than the window: "remember where you were" means the scroll as well. */
const tile = (id: number) => ({ id, name: `Show ${id}`, poster: null, banner: null, genres: ['Drama'], latest: 1 })
const HOME = {
  hero: tile(4),
  sections: [
    { title: 'Row 5', series: [tile(5), ...Array.from({ length: 9 }, (_, i) => tile(500 + i))] },
    ...[6, 7, 8, 9, 10].map((base) => ({ title: `Row ${base}`, series: Array.from({ length: 10 }, (_, i) => tile(base * 100 + i)) })),
  ],
  myList: [], ready: [], picked: [], because: null, grab: [], listIds: [], checking: 0,
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
      if (p === '/api/me') return json({ user: { id: 1, name: 'Viewer', is_admin: 0, avatar: null, cast: false }, needsSetup: false, profiles: [] })
      if (p === '/api/device-token') return json({ token: 'stub' })
      if (p === '/api/home') return json(HOME)
      if (p === '/api/discover') return json({ total: 0, page: 0, per: 60, sort: 'trending', genre: null, genres: [], series: [] })
      if (p === '/api/watch') return json(WATCH)
      if (p === '/api/series/5') return json(SERIES)
      if (/^\/api\/stream\/\d+\/\d+\/info/.test(p)) return json(INFO)
      if (/^\/api\/stream\/\d+\/\d+\/status$/.test(p)) return json({ fileProgress: 1, dlspeed: 0, seeds: 9, peers: 2, downloaded: 1, size: 1 })
      return json({ items: [] })
    }
    const files: Record<string, [string, string]> = {
      '/': ['public/index.html', 'text/html'], '/index.html': ['public/index.html', 'text/html'],
      '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'],
      '/downloads.js': ['public/downloads.js', 'text/javascript'], '/playclock.js': ['public/playclock.js', 'text/javascript'],
      '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
    }
    const f = files[p]
    if (f) return send(f[1], read(f[0]))
    if (p === '/sw.js') return send('text/javascript', '')
    if (p.endsWith('.png') || p.endsWith('.svg') || p.endsWith('.jpg')) { res.writeHead(404); return res.end() }
    if (p.startsWith('/vendor/')) return send('text/javascript', '')
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as any).port}`
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
})
after(async () => { await browser?.close(); await new Promise<void>((r) => (server ? server.close(() => r()) : r())) })

/** A fresh page in the Android shell: its own user agent, the media element stubbed, nothing inherited. */
async function shellPage(path = '/'): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 }, userAgent: UA })
  await page.addInitScript({ content: MEDIA })
  await page.goto(base + path)
  // The first drawn page (a television's top bar has no avatar, so the page itself is what is waited for).
  await page.waitForFunction(() => (document.querySelector('#app') as HTMLElement | null)?.innerHTML.trim().length! > 0, null, { timeout: 20_000 })
  await page.waitForTimeout(400)
  return page
}
/** Where the app is: the address it is showing, and how long its history is. */
const here = (page: Page) => page.evaluate(() => ({ hash: location.hash, len: history.length }))
/**
 * MainActivity.onBackPressed, exactly. The page is asked first (window.__flixBack: the player closes a list or leaves for
 * the show, and answers true when it used the press); then the WebView goes back; with nothing behind it the activity
 * finishes. In Chromium the entry behind the page's own is about:blank, so leaving the app is a URL that is not Flix's.
 */
async function back(page: Page): Promise<'page' | 'closed'> {
  const used = await page.evaluate(() => { const f = (window as any).__flixBack; return !!(f && f()) })
  if (used) { await page.waitForTimeout(300); return 'page' }
  await page.goBack({ timeout: 5000 }).catch(() => { /* nothing behind: about:blank */ })
  await page.waitForTimeout(400)
  return page.url().startsWith(base) ? 'page' : 'closed'
}

test('player, then the show it came from, then the home screen -- and Back there never closes the app', { skip }, async () => {
  const page = await shellPage()
  try {
    // Where the person was on the home screen: how far down, which tile.
    await page.evaluate(() => window.scrollTo(0, 260))
    const scrolled = await page.evaluate(() => window.scrollY)
    const home = await here(page)
    assert.equal(home.hash, '#/', 'the app is at the home screen, at a hash like any other page')

    await page.click('a.tile[href="#/series/5"]')
    await page.waitForFunction(() => location.hash === '#/series/5', null, { timeout: 10_000 })
    const show = await here(page)
    assert.equal(show.len, home.len + 1, 'opening a show is one history entry, so Back has somewhere to go')

    await page.click('#hp')
    await page.waitForSelector('#pl video', { timeout: 20_000 })
    assert.equal((await here(page)).hash, '#/play/5/1/S01E01')
    const play = await here(page)
    assert.equal(play.len, show.len + 1, 'and the episode is one more')

    // Back from the player is the show, not the app closing and not the episode before it.
    assert.equal(await back(page), 'page')
    assert.equal((await here(page)).hash, '#/series/5', 'Back from the player lands on the show')
    assert.equal((await here(page)).len, play.len, 'and it walks the entries that are already there rather than adding one')

    // Back from the show is the home screen it was opened from -- the page, not a fresh copy of it.
    assert.equal(await back(page), 'page')
    assert.equal((await here(page)).hash, '#/', 'Back from the show lands on the home screen')
    assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'and the home screen is where it was left, not at the top')

    // Back at the root: the app stays. Pressing it again must not walk copies of the same page either.
    for (const press of [1, 2, 3]) {
      assert.equal(await back(page), 'page', `Back at the root (press ${press}) does not close the app`)
      const now = await here(page)
      assert.equal(now.hash, '#/', 'and stays on the home screen')
      assert.equal(now.len, home.len, 'the history does not grow with each press')
    }
  } finally { await page.close() }
})

test('a page the app is opened straight into is kept, and Back goes home from it', { skip }, async () => {
  // A television's last-used shortcut, or a PWA resumed on the episode it was playing.
  const page = await shellPage('/#/play/5/1/S01E01')
  try {
    await page.waitForSelector('#pl video', { timeout: 20_000 })
    assert.equal((await here(page)).hash, '#/play/5/1/S01E01', 'the app opens on the episode it was opened on, not on the home screen')
    assert.equal(await back(page), 'page')
    assert.equal((await here(page)).hash, '#/series/5', 'Back from it is the show')
    assert.equal(await back(page), 'page')
    assert.equal((await here(page)).hash, '#/', 'Back from the show is the home screen the app put behind it')
    assert.equal(await back(page), 'page', 'and Back at the root does not close the app')
    assert.equal((await here(page)).hash, '#/')
  } finally { await page.close() }
})

test('a show opened straight into goes back to the home screen, not out of the app', { skip }, async () => {
  const page = await shellPage('/#/series/5')
  try {
    await page.waitForFunction(() => location.hash === '#/series/5', null, { timeout: 10_000 })
    const deep = await here(page)
    assert.equal(await back(page), 'page', 'Back does not close the app')
    const home = await here(page)
    assert.equal(home.hash, '#/')
    assert.equal(home.len, deep.len, 'the home screen was already behind it')
    assert.equal(await back(page), 'page', 'and Back at the root stays in the app too')
  } finally { await page.close() }
})
