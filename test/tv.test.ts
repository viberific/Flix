// A television is the one client that cannot be tried by hand easily, and 0.3.23-0.3.26 got it wrong in three ways at
// once: the page was laid out at 1920 CSS pixels with an initial-scale, so a WebView drew it one-for-one instead of
// fitting it to the panel (half off-screen) and the .tv zoom rule made every control a third bigger again; the remote's
// arrow keys could not reach the search field, because the focus list only held links and buttons; and the adaptive
// launcher icon drew the mark at the web tile's proportions, so a launcher's crop made it 82% of the visible height.
// These assertions hold the fixed shape of all three, since none of it can be seen without the hardware.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const index = read('public/index.html')
const css = read('public/style.css')
const app = read('public/app.js')
const fg = read('android/app/src/main/res/drawable/ic_launcher_foreground.xml')

test('a television lays the page out at 1280 CSS pixels and never with an initial-scale', () => {
  const at = index.indexOf('/Android TV FlixApp/')
  const script = index.slice(index.lastIndexOf('<script>', at), index.indexOf('</script>', at))
  assert.match(script, /width=1280/)
  // initial-scale forced 1280 pixels to be drawn at their own size rather than fitted to the panel: that is the bug.
  assert.doesNotMatch(script, /initial-scale/)
})

test('nothing zooms the page again on a television, and the layout width is under the zoom breakpoints', () => {
  assert.doesNotMatch(css, /html\.tv\s*\{[^}]*zoom/)
  const breakpoints = [...css.matchAll(/@media \(min-width: (\d+)px\) \{ html \{ zoom:/g)].map((m) => Number(m[1]))
  assert.ok(breakpoints.length > 0, 'the desktop zoom breakpoints are still there')
  // The TV's own layout width must stay below them, or a 4K panel would get both the fit-to-panel scale and a zoom.
  assert.ok(Math.min(...breakpoints) > 1280, `smallest zoom breakpoint ${Math.min(...breakpoints)} is above the TV width`)
})

test('a remote can reach text fields: the arrow-key focus list holds inputs', () => {
  const list = app.match(/const FOCUSABLE = '([^']+)'/)?.[1]
  assert.ok(list, 'FOCUSABLE is declared')
  for (const sel of ['input:not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])']) {
    assert.ok(list.includes(sel), `focus list has ${sel}`)
  }
  assert.match(app, /querySelectorAll\(FOCUSABLE\)/, 'the arrow-key navigation uses that list')
})

test('the adaptive launcher icon is scaled to a launcher\'s crop, not the web tile', () => {
  const scale = Number(fg.match(/android:scaleX="([\d.]+)"\s*\n\s*android:scaleY="([\d.]+)"/)?.[1])
  assert.ok(scale > 0 && scale < 1, `the mark is wrapped in a scaling group, found ${scale}`)
  // The mark in a 512 viewport: x 140..372, y 116..396. A launcher shows the inner 72dp of the 108dp canvas.
  const VISIBLE = 72, CANVAS = 108, VIEW = 512
  const heightShare = (280 * scale) / VIEW / (VISIBLE / CANVAS)
  assert.ok(heightShare > 0.5 && heightShare < 0.7, `mark is ${Math.round(heightShare * 100)}% of the visible height`)
  const corner = Math.hypot(116, 140) * scale            // furthest point from the mark's centre
  const safe = (VISIBLE / 2 - 3) * (VIEW / CANVAS)       // Android's 66dp safe circle
  assert.ok(corner < safe, `corner ${Math.round(corner)} stays inside the ${Math.round(safe)} safe circle`)
})

test('TV playback settles the wait layer only after the picture advances', () => {
  assert.match(css, /\.p-wait\.settled\s*\{\s*visibility:\s*hidden;\s*transition:\s*none;/)
  assert.match(app, /function revealWait\(settled = false\)\s*\{[\s\S]*?if \(settled\) layer\.classList\.add\('settled'\)/)
  assert.match(app, /if \(started && !holding && !castingOnly && !v\.paused && \(moving \|\| v\.currentTime > 0\.5\)\) revealWait\(true\)/)
  // A WebView that never fires 'playing' still gets the show: the clock moving starts it.
  assert.match(app, /v\.addEventListener\('playing', firstFrame, \{ once: true \}\)/)
  assert.match(app, /if \(moving && !castingOnly\) firstFrame\(\)/)
  assert.match(app, /const firstFrame = \(\) => \{\s*if \(started\) return/)
  assert.match(app, /function restoreWait\(\)\s*\{[\s\S]*?remove\('gone', 'settled'\)/)
  assert.doesNotMatch(app, /waitHideT/)
  assert.match(app, /const reveal = \(\) => \{ holding = false; if \(castingOnly\) return; revealWait\(\);/)
})

test('settling cancels the delayed visibility transition in Chromium', { skip: !existsSync(process.env.CHROMIUM_PATH ?? '/usr/bin/chromium') }, async () => {
  const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css}</style><div id="wait" class="p-wait"></div>`)
    const initial = await page.$eval('#wait', (element) => getComputedStyle(element).visibility)
    assert.equal(initial, 'visible', 'the wait layer starts visible')
    await page.$eval('#wait', (element) => element.classList.add('gone'))
    await page.waitForTimeout(500)
    const waiting = await page.$eval('#wait', (element) => {
      const style = getComputedStyle(element)
      return { visibility: style.visibility, transition: style.transition }
    })
    assert.equal(waiting.visibility, 'visible', 'the delayed visibility transition is still pending at 500ms')
    assert.match(waiting.transition, /visibility 0s linear 1\.25s/)
    const settled = await page.$eval('#wait', (element) => {
      element.classList.add('settled')
      const style = getComputedStyle(element)
      return { visibility: style.visibility, transition: style.transition }
    })
    assert.deepEqual(settled, { visibility: 'hidden', transition: 'none' })
  } finally {
    await browser.close()
  }
})

test('the Flix logo leaves the player with the wait screen, so it never sits over the show', async () => {
  // Revealing the picture marks the player live; the wait screen coming back takes that away again.
  assert.match(app, /function revealWait\(settled = false\)\s*\{[\s\S]*?pl\.classList\.add\('live'\)/)
  assert.match(app, /function restoreWait\(\)\s*\{[\s\S]*?pl\.classList\.remove\('live'\)/)
  // The big mark on the wait screen dissolves on reveal.
  assert.match(css, /\.p-wait\.gone \.mark \{ animation: markOut/)
  const executablePath = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].find((p) => p && existsSync(p))
  if (!executablePath) return
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css}</style><div class="player" id="pl"><div class="p-top"><span class="p-mark"><svg></svg></span></div></div>`)
    assert.equal(await page.$eval('.p-mark', (e) => getComputedStyle(e).opacity), '1', 'the logo is up while the episode loads')
    await page.$eval('#pl', (e) => e.classList.add('live'))
    await page.waitForTimeout(1200)
    const after = await page.$eval('.p-mark', (e) => ({ opacity: getComputedStyle(e).opacity, width: getComputedStyle(e).width }))
    assert.deepEqual(after, { opacity: '0', width: '0px' }, 'the logo has faded out of the top bar once the show is playing')
  } finally { await browser.close() }
})

test('Downloads lists only what is saved on this device, and the phone download button keeps its size', () => {
  const view = app.slice(app.indexOf('async function downloadsView'), app.indexOf('async function offlinePlayView'))
  assert.doesNotMatch(view, /dl\.active\.entries\(\)|dl-active|Downloading on the server/, 'nothing in progress is listed on Downloads')
  assert.doesNotMatch(read('public/downloads.js'), /on the server/, 'progress never mentions the server fetching the episode')
  // A max-width in ch is zero at font-size 0, which shrank the phone button to a hairline.
  assert.match(css, /\.ep \.eside \.dlb \{[^}]*max-width: none;[^}]*font-size: 0;/)
})

test('the logo glides up when the line and the bar arrive under it, instead of jumping', () => {
  assert.match(app, /function glideWait\(\)/)
  assert.match(app, /\n    glideWait\(\)\n/)
  // Moves from where it was (FLIP), picks up a glide already running, and steps aside for the mark's exit.
  assert.match(app, /const from = was \+ at - now/)
  assert.match(app, /if \(layer\.classList\.contains\('gone'\)\) \{ for \(const el of kids\(\)\) glides\(el\)\.forEach\(\(a\) => a\.cancel\(\)\)/)
})

test('a television has no downloads: no page, no buttons, nothing kept in its storage', () => {
  assert.match(app, /const canDownload = !isTv && dl\.supported\(\)/)
  assert.match(app, /if \(isTv\) dl\.clear\(\)/)
  assert.match(app, /\$\{canDownload \? '<a href="#\/downloads">Downloads<\/a>' : ''\}/)
  assert.match(app, /const canSave = \(e\) => canDownload && /)
  assert.match(app, /\(parts\[0\] === 'downloads' \|\| parts\[0\] === 'offplay'\) && !canDownload\) \{ clearTimeout\(slow\); go\('#\/'\); return \}/)
  assert.match(app, /if \(!e\.gate && canDownload && \(await dl\.list\(\)\)\.length\)/)
  assert.match(read('public/downloads.js'), /export async function clear\(\)/)
})
