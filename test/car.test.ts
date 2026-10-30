// Android Auto (the car screen of the Android app). The car itself cannot be tried here, so these hold the shape of the
// three fixes: the player never asks the car's WebView for fullscreen (a second window it sized wrongly), a wide car
// screen gets the picture at 16:9 with Flix's panel beside it, and the picture is held back for the car's late sound.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const app = read('public/app.js')
const css = read('public/style.css')
const screen = read('android/app/src/main/java/com/viberific/flix/car/FlixScreen.java')

test('the car screen is told apart by its user agent and never asks for fullscreen', () => {
  assert.match(screen, /FlixApp FlixCar/)
  assert.match(app, /const isCar = \/FlixCar\/\.test\(navigator\.userAgent\)/)
  assert.match(app, /const goLandscape = async \(\) => \{[\s\S]{0,200}?if \(!touchy \|\| landscape \|\| isCar\) return/)
})

test('a wide car screen puts the picture at 16:9 beside a panel, and the page and the car agree on the bridge', () => {
  assert.match(css, /@media \(min-aspect-ratio: 2\/1\) \{\s*html\.car \.player \{ --side:[^}]*16 \/ 9/)
  assert.match(css, /html\.car \.player:not\(\.car-max\) #vw \{ right: var\(--side\)/)
  assert.match(app, /window\.FlixCar\?\.immersive\(true\)/)
  assert.match(app, /window\.FlixCar\?\.immersive\(false\)/)
  assert.match(screen, /addJavascriptInterface\(new Bridge\(\), "FlixCar"\)/)
  assert.match(screen, /@JavascriptInterface\s+public void immersive\(boolean on\)/)
})

test('the car strip is Flix\'s header on pages and only the Flix mark in the player, with no band padded off the page', () => {
  // NavigationTemplate will not build without a button, so the strip is never empty: the logo, search and the avatar on
  // pages, handed to the page's own (window.__flixCar), and the mark alone while an episode plays.
  assert.doesNotMatch(screen, /setTitle\("(Back|Home|Reload)"\)/)
  assert.match(screen, /if \(immersive\) return new NavigationTemplate[^\n]*ic_car_flix[^\n]*\n[^\n]*ic_car_back[^\n]*header\("back"\)/)
  assert.match(screen, /header\("home"\)[\s\S]*header\("search"\)[\s\S]*header\("menu"\)/)
  assert.doesNotMatch(screen, /root\.setPadding\(l, t, r, b\)/)
  for (const what of ['back', 'home', 'search', 'menu']) assert.match(app, new RegExp(`what === '${what}'`))
  assert.match(app, /if \(isCar\) window\.__flixCar = /)
  assert.match(app, /me\.cast && !isTv && !isCar/)
  // The player: maximize takes the picture to the whole screen, and Back there returns to the panel.
  assert.match(app, /\$\('#pfull'\)\.onclick = \(\) => \{ if \(carWide\(\)\) setCarMax\(!carMax\)/)
  assert.match(app, /\$\('#pback'\)\.onclick = \(\) => \{ if \(carMax && carWide\(\)\) setCarMax\(false\); else leavePlayer\(\) \}/)
  assert.match(css, /html\.car \.player #cast, html\.car \.player #rep \{ display: none; \}/)
})

test('the car picture shows a frame only once the sound delay has passed', async () => {
  const executablePath = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH, '/usr/bin/chromium'].find((p) => p && existsSync(p))
  if (!executablePath) return
  const fn = app.slice(app.indexOf('function carPicture('), app.indexOf('function playView('))
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } })
    await page.setContent('<div id="vw" style="position:relative;width:160px;height:90px"></div>')
    // A canvas standing in for the <video>: createImageBitmap takes either, and the clock is set by hand.
    // Written as a string: tsx would otherwise wrap the named helpers in a __name() the page does not have.
    const colour = await page.evaluate(`(async () => {
      ${fn}
      const v = Object.assign(document.createElement('canvas'), { width: 16, height: 9 })
      Object.defineProperties(v, { videoWidth: { value: 16 }, videoHeight: { value: 9 }, readyState: { value: 4 }, textTracks: { value: [] } })
      const paint = (c, t) => { const g = v.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 16, 9); v.currentTime = t }
      const pic = carPicture(() => v)
      pic.mount(document.getElementById('vw'))
      pic.set(400)
      const cv = document.querySelector('.p-delay')
      const at = () => { const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data; return d[3] ? d[0] + ',' + d[1] + ',' + d[2] : 'none' }
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      paint('#f00', 1)
      await wait(150); const early = at()
      await wait(500); const late = at()
      paint('#00f', 2)
      await wait(150); const stillRed = at()
      await wait(500); const blue = at()
      pic.stop()
      return { early, late, stillRed, blue }
    })()`)
    assert.deepEqual(colour, { early: 'none', late: '255,0,0', stillRed: '255,0,0', blue: '0,0,255' })
  } finally {
    await browser.close()
  }
})
