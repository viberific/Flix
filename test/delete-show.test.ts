// Delete show in Settings did nothing when tapped: no dialog, nothing deleted. Its handler used a helper that lived inside
// another function, so it threw before the dialog opened and the async error went nowhere. The page runs for real here,
// public/app.js in Chromium against a stubbed server, because the defect was in how the page's code is put together.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright-core'
import { groupFinished } from '../src/seeding-groups.ts'

const EXE = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH, '/usr/bin/chromium'].find((p) => p && existsSync(p))
const skip = !EXE ? 'needs a Chromium (CHROMIUM_PATH or /usr/bin/chromium)' : false
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url))
const GB = 1e9

const row = (id: number, episode: number) => ({
  torrent_id: id, series_id: 301, series: 'Quiet Harbour', season: 1, episode, episode_end: episode, is_pack: false,
  label: `S01E0${episode}`, state: 'active', missing: false, left: 0, progress: 1, size: 2 * GB, seedMet: true, deletable: true,
  ratio: 1.4, seedHours: 140, notWatched: [], group_name: 'Quiet.Harbour.S01 - GRP', added_at: 0, holders: [], reasons: [],
})
const rows = [row(1, 1), row(2, 2)]
const DOWNLOADS = { requirements: { minHours: 120, minRatio: 1 }, minFreePct: 10, autoPausePct: 15, downloads: rows, finished: groupFinished(rows as any), hidden: [] }

// What the server keeps once a show has been deleted: the downloads are gone, the show is off every screen, and Settings
// is the only place it can be seen until a new episode turns up in it.
let hiddenRows: { seriesId: number; series: string; hiddenAt: number }[] = []

const posted: any[] = []
let server: Server | null = null, base = '', browser: Browser | null = null

before(async () => {
  if (skip) return
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    const send = (type: string, body: string | Buffer) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    const json = (v: unknown) => send('application/json', JSON.stringify(v))
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; posted.push({ path: p, body: b ? JSON.parse(b) : null }) }
      if (p === '/api/me') return json({ user: { id: 1, name: 'Admin', is_admin: 1, avatar: null, cast: false }, needsSetup: false })
      if (p === '/api/device-token') return json({ token: 'stub' })
      if (p === '/api/home') return json({ sections: [], myList: [], ready: [], picked: [], because: null, hero: null, listIds: [] })
      if (p === '/api/continue' || p === '/api/leaving') return json({ items: [] })
      if (p === '/api/admin/downloads/group-delete') { hiddenRows = [{ seriesId: 301, series: 'Quiet Harbour', hiddenAt: Math.floor(Date.now() / 1000) }]; return json({ removed: 2, queued: 0, failed: [], hidden: true }) }
      if (p === '/api/admin/hidden/restore') { hiddenRows = []; return json({ hidden: false }) }
      if (p === '/api/admin/downloads') return json({ ...DOWNLOADS, hidden: hiddenRows })
      if (p === '/api/admin/health') return json({ issues: [] })
      if (p === '/api/admin/reports') return json({ reports: [] })
      if (p === '/api/admin/storage') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"no chart in this test"}') }
      if (p === '/api/admin/users') return json({ users: [], ratings: [] })
      return json({})
    }
    const files: Record<string, [string, string]> = {
      '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'],
      '/downloads.js': ['public/downloads.js', 'text/javascript'], '/playclock.js': ['public/playclock.js', 'text/javascript'],
      '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
    }
    const f = files[p]
    if (f) return send(f[1], read(f[0]))
    if (p === '/sw.js' || p.startsWith('/vendor/')) return send('text/javascript', '')
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as any).port}`
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); await new Promise<void>((r) => (server ? server.close(() => r()) : r())) })

test('Delete show in Settings asks first, then deletes the show', { skip }, async () => {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message + ' @ ' + (e.stack ?? '').split('\n')[1]))
  try {
    await page.goto(`${base}/#/settings/torrents`)
    const btn = await page.waitForSelector('[data-gall="301"]', { timeout: 15_000 })
    errors.length = 0 // the other Settings panels get thin stubs; only what the button does is under test
    await btn.click()
    await page.waitForSelector('.confirm-box', { timeout: 3000 })
    assert.match(await page.$eval('#cft', (e) => e.textContent ?? ''), /Delete Quiet Harbour\?/)
    assert.match(await page.$eval('.confirm-body', (e) => e.textContent ?? ''), /all 2 episodes/)
    // Cancel deletes nothing.
    await page.click('#pc')
    await page.waitForTimeout(200)
    assert.equal(posted.filter((x) => x.path.endsWith('group-delete')).length, 0, 'cancel leaves the show alone')
    await page.click('[data-gall="301"]')
    await page.waitForSelector('.confirm-box')
    await page.click('#pok')
    await page.waitForFunction(() => !document.querySelector('.confirm-box'))
    await page.waitForTimeout(300)
    const del = posted.filter((x) => x.path.endsWith('group-delete'))
    assert.deepEqual(del.map((x) => x.body), [{ seriesId: 301, season: null, mode: 'all' }], 'confirming deletes the whole show')
    assert.deepEqual(errors, [], 'nothing threw once the button was pressed')
    // The person is told the show is hidden rather than deleted outright, and where to undo it.
    await page.waitForSelector('.note-flash', { timeout: 3000 })
    assert.match(await page.$eval('.note-flash', (e) => e.textContent ?? ''), /hidden until a new episode/i)
    assert.match(await page.$eval('.note-flash', (e) => e.textContent ?? ''), /Settings → Torrents → Hidden shows/)
    } finally { await page.close() }
  })

  test('Settings lists a deleted show under Hidden shows, and Restore brings it back', { skip }, async () => {
    hiddenRows = [{ seriesId: 301, series: 'Quiet Harbour', hiddenAt: Math.floor(Date.now() / 1000) }]
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
    await page.goto(`${base}/#/settings/torrents`)
    const restore = await page.waitForSelector('[data-resh="301"]', { timeout: 15_000 })
    const block = await page.$eval('#thidden', (e) => e.textContent ?? '')
    assert.match(block, /Hidden shows/, 'the list has a heading')
    assert.match(block, /Quiet Harbour/, 'the deleted show is named there')
    errors.length = 0 // the other Settings panels get thin stubs; only what Restore does is under test
    await restore.click()
    await page.waitForFunction(() => !document.querySelector('[data-resh="301"]'), null, { timeout: 5000 })
    assert.deepEqual(posted.filter((x) => x.path === '/api/admin/hidden/restore').map((x) => x.body), [{ seriesId: 301 }], 'Restore is what brings it back')
    assert.deepEqual(errors, [], 'nothing threw')
    } finally { await page.close() }
  })
