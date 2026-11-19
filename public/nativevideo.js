/**
 * The TV app's own player, under the web app's controls.
 *
 * A browser has no AC-3 / E-AC-3 decoder, so in a WebView every 5.1 WEB-DL had to be played as a playlist with its sound
 * converted on the box (folded to stereo, and slow to start from a cold drive: 34-70 s on 2026-11-18). The Android TV app
 * has ExoPlayer instead (android/.../NativeVideo.java), which hands the untouched Dolby track to the television. So in the
 * app on a TV, /info is told the device takes ac3 and eac3 (nativeAudio below), the box serves the file as it is, and the
 * episode is played by the native player on a surface BEHIND the page, which is made transparent over it.
 *
 * Nothing in the player was rewritten for it. makeNative() takes the ordinary <video> element the player already made and
 * answers the parts of HTMLMediaElement the player uses -- src, currentTime, paused, play(), buffered, readyState, the
 * events -- from the native player, dispatching the same events on the same element. Subtitles are the <track> elements the
 * player already adds, read here and drawn over the picture, since the element's own renderer runs off a clock that never
 * moves. If the native player fails, it says so once (nativeAudio() then reports nothing for the rest of the page's life)
 * and the player's ordinary error path asks /info again, which this time answers with the converted playlist.
 */

const bridge = () => (typeof window !== 'undefined' && window.FlixNative) || null
let broken = false
let codecs = null

/** The sound codecs this device's own player takes as they are, for /info's `cv`. Empty in a browser and after a failure. */
export function nativeAudio() {
  if (broken) return []
  if (codecs) return codecs
  const b = bridge()
  try { codecs = b ? (JSON.parse(b.caps()).audio || []).filter((c) => typeof c === 'string') : [] } catch { codecs = [] }
  return codecs
}

/** Whether a play the box marked `native` can go to the device's player now. */
export const nativeOk = () => nativeAudio().length > 0

let current = null
window.__flixNative = (snap) => { try { current?.onSnap(snap) } catch { /* a bad message must not take the page down */ } }

/** WebVTT as [{ start, end, text }], seconds. Only what the player shows: the timing line and the text under it. */
export function parseVtt(text) {
  const out = []
  const t = (s) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1] }
  for (const block of String(text).replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = lines[i].split('-->')
    const start = t(a), end = t(b.trim().split(/\s+/)[0])
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end, text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim() })
  }
  return out
}

/** Make `el` play through the device's own player. Returns false when there is none. */
export function makeNative(el) {
  const b = bridge()
  if (!b || el.__native) return false
  current?.el.__unnative?.()
  const s = { src: '', pos: 0, at: performance.now(), dur: NaN, buf: 0, playing: false, pwr: !!el.autoplay, st: 1, w: 0, h: 0, err: null,
    seeking: false, seekTo: 0, seekId: 0, ended: false, metaSaid: false, dataSaid: false, ready: false, vol: 1, muted: false, lastPwr: undefined }
  const fire = (type) => el.dispatchEvent(new Event(type))
  const clock = () => {
    if (s.seeking) return s.seekTo
    const t = s.pos + (s.playing ? (performance.now() - s.at) / 1000 : 0)
    return Number.isFinite(s.dur) && s.dur > 0 ? Math.min(t, s.dur) : t
  }
  const def = (name, get, set) => Object.defineProperty(el, name, { configurable: true, get, ...(set ? { set } : {}) })
  const val = (name, value) => Object.defineProperty(el, name, { configurable: true, writable: true, value })
  const reset = () => Object.assign(s, { lastPwr: undefined, pos: 0, at: performance.now(), dur: NaN, buf: 0, playing: false, st: 1, w: 0, h: 0, err: null, seeking: false, ended: false, metaSaid: false, dataSaid: false, ready: false })

  def('src', () => s.src, (u) => {
    const url = u ? new URL(String(u), location.href).href : ''
    reset()
    s.src = url
    if (!url) { b.stop(); document.documentElement.classList.remove('native-video'); return }
    s.pwr = !!el.autoplay
    document.documentElement.classList.add('native-video')
    b.load(url, 0, s.pwr)
    fire('loadstart')
  })
  def('currentSrc', () => s.src)
  def('srcObject', () => null, () => {})
  def('currentTime', clock, (t) => {
    const at = Math.max(0, Number(t) || 0)
    s.seekTo = at; s.seeking = true; s.seekId++; s.ended = false
    fire('seeking')
    b.seek(at, s.seekId)
  })
  def('duration', () => s.dur)
  def('paused', () => !s.pwr)
  def('ended', () => s.ended)
  def('seeking', () => s.seeking)
  def('readyState', () => (!s.src ? 0 : s.st === 3 || s.st === 4 ? 4 : s.ready ? 2 : s.metaSaid ? 1 : 0))
  def('networkState', () => (s.src ? 2 : 0))
  def('videoWidth', () => s.w)
  def('videoHeight', () => s.h)
  def('error', () => s.err)
  def('buffered', () => { const end = Math.max(s.buf, s.playing ? clock() : 0); return { length: s.src && end > 0 ? 1 : 0, start: () => 0, end: () => end } })
  def('volume', () => s.vol, (x) => { s.vol = Number(x); fire('volumechange') })
  def('muted', () => s.muted, (x) => { s.muted = !!x; fire('volumechange') })
  val('fastSeek', undefined)
  val('requestVideoFrameCallback', undefined)
  val('play', () => { if (!s.pwr) { s.pwr = true; fire('play') } if (s.ended) { s.ended = false; b.seek(0, ++s.seekId) } b.play(); return Promise.resolve() })
  val('pause', () => { if (s.pwr) { s.pwr = false; fire('pause') } b.pause() })
  val('load', () => { if (!s.src) { b.stop(); fire('emptied') } })
  const getAttr = HTMLElement.prototype.getAttribute, rmAttr = HTMLElement.prototype.removeAttribute
  val('getAttribute', (n) => (n === 'src' ? s.src || null : getAttr.call(el, n)))
  val('removeAttribute', (n) => { if (n === 'src') { s.src = ''; reset(); b.stop(); document.documentElement.classList.remove('native-video') } else rmAttr.call(el, n) })
  el.classList.add('n-native')

  // Subtitles: the player's own <track> elements, read here and drawn in a layer over the picture.
  const layer = document.createElement('div')
  layer.className = 'n-cues'
  el.parentElement?.appendChild(layer)
  const read = (t) => {
    if (t.__cues || !t.src) return
    t.__cues = []
    fetch(t.src, { cache: 'no-store' }).then((r) => r.text()).then((x) => { t.__cues = parseVtt(x); paintCues() }).catch(() => {})
  }
  let painted = ''
  const paintCues = () => {
    const now = clock()
    const lines = []
    for (const t of el.querySelectorAll('track')) {
      if (t.track?.mode !== 'showing' || !t.__cues) continue
      for (const c of t.__cues) if (c.start <= now && now < c.end) lines.push(c.text)
    }
    const html = lines.map((l) => l.split('\n').map((x) => `<span>${x.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch])}</span>`).join('<br>')).join('<br>')
    if (html !== painted) { painted = html; layer.innerHTML = html }
  }
  const watch = new MutationObserver(() => { for (const t of el.querySelectorAll('track')) read(t) })
  watch.observe(el, { childList: true })
  for (const t of el.querySelectorAll('track')) read(t)
  el.textTracks?.addEventListener?.('change', paintCues)

  const tick = setInterval(() => { if (s.playing && !s.seeking) fire('timeupdate'); paintCues() }, 250)

  // What the native player said. Transitions become the events an element would have fired.
  const onSnap = (n) => {
    if (!s.src) return
    const was = { ...s }
    if (n.pwr !== undefined) s.lastPwr = !!n.pwr
    s.pos = Number(n.pos) || 0; s.at = performance.now()
    if (Number(n.dur) > 0) s.dur = Number(n.dur)
    s.buf = Number(n.buf) || 0
    s.st = Number(n.st) || 1
    s.playing = !!n.playing
    if (n.w && n.h) { s.w = n.w; s.h = n.h }
    if (n.err) {
      broken = true
      // Not "cannot decode" (3): that asks the box to convert the PICTURE, which this file does not need. A network-kind
      // error takes the player's ordinary retry, which asks /info again, and /info now answers with the playlist.
      s.err = { code: 2, message: 'native: ' + String(n.err).slice(0, 200) }
      fire('error')
      return
    }
    if (!was.metaSaid && Number.isFinite(s.dur) && s.dur > 0) { s.metaSaid = true; fire('durationchange'); fire('loadedmetadata') }
    if ((was.w !== s.w || was.h !== s.h) && s.w) fire('resize')
    if (s.st === 3 && !s.dataSaid) { s.dataSaid = true; s.ready = true; fire('loadeddata') }
    if (s.st === 3 && was.st !== 3) { fire('canplay'); fire('canplaythrough') }
    if (s.seeking && Number(n.seekDone) >= s.seekId && s.st === 3) { s.seeking = false; fire('seeked'); fire('timeupdate') }
    if (s.st === 2 && was.st === 3 && s.pwr) fire('waiting')
    if (s.playing && !was.playing) fire('playing')
    // Play/pause is the page's to say, and a snapshot can be older than the page's last word (it was in flight, or a listener
    // above paused the element while this one was being read). Only a change the native side itself made -- the episode
    // ended, the TV took the sound away -- is followed: a pwr that differs from the last one it reported.
    if (n.pwr !== undefined && !!n.pwr !== was.lastPwr && was.lastPwr !== undefined && !!n.pwr !== s.pwr) { s.pwr = !!n.pwr; fire(s.pwr ? 'play' : 'pause') }
    if (s.st === 4 && was.st !== 4) { s.ended = true; if (s.pwr) { s.pwr = false; fire('pause') } fire('ended') }
    if (s.buf !== was.buf) fire('progress')
    paintCues()
  }

  el.__native = true
  el.__unnative = () => {
    clearInterval(tick); watch.disconnect(); layer.remove(); el.textTracks?.removeEventListener?.('change', paintCues)
    for (const k of ['src', 'currentSrc', 'srcObject', 'currentTime', 'duration', 'paused', 'ended', 'seeking', 'readyState', 'networkState', 'videoWidth', 'videoHeight', 'error', 'buffered', 'volume', 'muted', 'fastSeek', 'requestVideoFrameCallback', 'play', 'pause', 'load', 'getAttribute', 'removeAttribute']) delete el[k]
    el.classList.remove('n-native')
    document.documentElement.classList.remove('native-video')
    try { b.stop() } catch { /* the app is going */ }
    el.__native = false
    if (current?.el === el) current = null
  }
  current = { el, onSnap }
  return true
}

/** Leaving the player: whatever the native player holds is let go, and the page is opaque again. */
export function dropNative() { current?.el.__unnative?.() }
