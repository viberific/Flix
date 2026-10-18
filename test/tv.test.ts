// A television is the one client that cannot be tried by hand easily, and 0.3.23-0.3.26 got it wrong in three ways at
// once: the page was laid out at 1920 CSS pixels with an initial-scale, so a WebView drew it one-for-one instead of
// fitting it to the panel (half off-screen) and the .tv zoom rule made every control a third bigger again; the remote's
// arrow keys could not reach the search field, because the focus list only held links and buttons; and the adaptive
// launcher icon drew the mark at the web tile's proportions, so a launcher's crop made it 82% of the visible height.
// These assertions hold the fixed shape of all three, since none of it can be seen without the hardware.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
