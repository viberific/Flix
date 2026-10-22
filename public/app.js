import * as dl from '/downloads.js'
const $ = (s, el = document) => el.querySelector(s)
const app = $('#app'), top = $('#top')
const rmq = matchMedia('(prefers-reduced-motion: reduce)')
const smooth = () => (rmq.matches ? 'auto' : 'smooth')
let me = null, cleanup = null, navToken = 0, retryT = null
// The last /api/me answer, kept for views that render outside the router: addressHint reads its addresses, and a
// variable local to route() left Settings throwing "st is not defined" before the page could draw.
let myState = null
window.__flixBooted = true

/**
 * Did this request end up at Umbrel's sign-in instead of at Flix?
 * Umbrel puts every installed app behind its own login on another port, so when that
 * session has lapsed the fetch is redirected to a different origin -- which the browser
 * refuses, and all the app sees is a failed request. A second look with redirect:'manual'
 * turns that refusal into something readable: an opaqueredirect.
 */
async function wentThroughGate() {
  try {
    const r = await fetch('/api/me', { redirect: 'manual', cache: 'no-store' })
    return r.type === 'opaqueredirect' || (r.redirected && !String(r.url).endsWith('/api/me'))
  } catch { return false }
}

const gated = (msg) => Object.assign(new Error(msg), { gate: true })
const GATE_MSG = 'Umbrel signed you out. This app sits behind Umbrel’s own login; sign in to Umbrel, then open Flix again.'

async function api(path, body, method, timeoutMs) {
  let res
  try {
    res = await fetch(path, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined })
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('The Flix server took too long to answer.')
    if (await wentThroughGate()) throw gated(GATE_MSG)
    if (!navigator.onLine) throw new Error('This device looks offline.')
    throw new Error('The Flix server did not answer.')
  }
  // A page came back where JSON was expected. If the answer was a success (or a redirect we
  // followed), it is Umbrel's sign-in page rather than Flix; a plain error stays an error.
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('json')) {
    if (res.ok || res.redirected) throw gated(GATE_MSG)
    throw new Error(`Flix answered ${res.status}${res.statusText ? ' ' + res.statusText : ''}.`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, pin: !!data.pin, gated: !!data.gated, after: data.after ?? null })
  return data
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const gb = (n) => (n / 1073741824).toFixed(2) + ' GB'
const mbps = (n) => (n / 1048576).toFixed(1) + ' MB/s'
const go = (h) => { location.hash = h }
const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
const pct = (p, d) => Math.min(100, Math.round((p / (d || 1)) * 100))

/* ---------- little creatures ---------- */
// The pictures a person can choose for their own profile. Drawn here as flat shapes so there is nothing to download,
// they stay sharp at any size, and the whole set costs a few hundred bytes. Each one is a round badge that fills the slot.
const AVATARS = ['fox', 'owl', 'cat', 'bunny', 'frog', 'whale', 'octopus', 'bee', 'panda', 'axolotl', 'raccoon', 'hedgehog']
const AV_ART = {
  fox: '<circle cx="24" cy="24" r="24" fill="#ffbb85"/><path d="M12 17 9 6l11 5Z" fill="#e2703a"/><path d="M36 17l3-11-11 5Z" fill="#e2703a"/><path d="M24 13c8 0 13 6 13 13s-6 13-13 13-13-5-13-13 5-13 13-13Z" fill="#f2843b"/><path d="M24 39c-5 0-9-4-9-9 0-3 2-5 5-5h8c3 0 5 2 5 5 0 5-4 9-9 9Z" fill="#fff3e6"/><circle cx="18.5" cy="23" r="2" fill="#3a2418"/><circle cx="29.5" cy="23" r="2" fill="#3a2418"/><path d="m24 29 2.2 2.4h-4.4Z" fill="#3a2418"/>',
  owl: '<circle cx="24" cy="24" r="24" fill="#9b8ce0"/><path d="M13 15l-1-6 7 3ZM35 15l1-6-7 3Z" fill="#c3b6f5"/><path d="M24 11c9 0 15 7 15 16s-6 14-15 14-15-5-15-14 6-16 15-16Z" fill="#bfb1f7"/><circle cx="17.5" cy="25" r="5" fill="#fff"/><circle cx="30.5" cy="25" r="5" fill="#fff"/><circle cx="17.5" cy="25" r="2.4" fill="#3b2f5c"/><circle cx="30.5" cy="25" r="2.4" fill="#3b2f5c"/><path d="m24 27 3 4h-6Z" fill="#ffb020"/><path d="M19 38h10" stroke="#8a76d8" stroke-width="2" stroke-linecap="round"/>',
  cat: '<circle cx="24" cy="24" r="24" fill="#b6c6d6"/><path d="M12 18 11 8l9 5ZM36 18l1-10-9 5Z" fill="#dbe6f0"/><path d="M24 12c8 0 14 6 14 14s-6 14-14 14-14-6-14-14 6-14 14-14Z" fill="#e7eff7"/><path d="M17 23c1.4-2 4-2 5.4 0M25.6 23c1.4-2 4-2 5.4 0" stroke="#41525f" stroke-width="1.9" stroke-linecap="round" fill="none"/><path d="m24 27 1.8 2h-3.6Z" fill="#e0778f"/><path d="M8 27h5M8 31h5M40 27h-5M40 31h-5" stroke="#8496a6" stroke-width="1.4" stroke-linecap="round"/>',
  bunny: '<circle cx="24" cy="24" r="24" fill="#ffd3e3"/><path d="M17 20c-2-6-1-13 2-13s4 8 3 13ZM31 20c2-6 1-13-2-13s-4 8-3 13Z" fill="#fff5f9"/><path d="M17 19c-1-5 0-10 2-10s3 6 2 10ZM31 19c1-5 0-10-2-10s-3 6-2 10Z" fill="#ffb8d0"/><circle cx="24" cy="28" r="12" fill="#fff5f9"/><circle cx="19.5" cy="26" r="1.8" fill="#4a3a42"/><circle cx="28.5" cy="26" r="1.8" fill="#4a3a42"/><path d="m24 30 1.8 1.8h-3.6Z" fill="#f08ba8"/>',
  frog: '<circle cx="24" cy="24" r="24" fill="#8ddf7a"/><circle cx="16" cy="17" r="6" fill="#7ed957"/><circle cx="32" cy="17" r="6" fill="#7ed957"/><circle cx="16" cy="17" r="3" fill="#2f4a2a"/><circle cx="32" cy="17" r="3" fill="#2f4a2a"/><path d="M12 25c0-5 5-8 12-8s12 3 12 8c0 7-5 12-12 12s-12-5-12-12Z" fill="#9ee98a"/><path d="M16 29c3 4 13 4 16 0" stroke="#3f7a35" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  whale: '<circle cx="24" cy="24" r="24" fill="#6cc4f7"/><path d="M14 18c0-2 1-4 3-4s2 3 0 4Z" fill="#bfe9ff"/><path d="M12 26c0-7 6-11 14-11s13 5 13 12-6 10-14 10-13-4-13-11Z" fill="#8fd8ff"/><path d="M39 27c3-2 5 1 3 4-1 2-4 2-5 0Z" fill="#5fb0e0"/><circle cx="19" cy="25" r="2.2" fill="#123a52"/><path d="M17 32c5 3 11 2 14-1" stroke="#3f9ecc" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  octopus: '<circle cx="24" cy="24" r="24" fill="#c084f5"/><path d="M24 11c7 0 12 6 12 13v9H12v-9c0-7 5-13 12-13Z" fill="#d6a4ff"/><path d="M13 33c-2 2-2 5 0 6M19 33c-2 3-1 6 1 7M29 33c2 3 1 6-1 7M35 33c2 2 2 5 0 6" stroke="#a967e0" stroke-width="3" stroke-linecap="round" fill="none"/><circle cx="19" cy="24" r="2.2" fill="#3d1f5c"/><circle cx="29" cy="24" r="2.2" fill="#3d1f5c"/><path d="M21 29c2 1.6 4 1.6 6 0" stroke="#3d1f5c" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  bee: '<circle cx="24" cy="24" r="24" fill="#ffd66b"/><ellipse cx="16" cy="17" rx="7" ry="5" fill="#fff" opacity=".8" transform="rotate(-20 16 17)"/><ellipse cx="32" cy="17" rx="7" ry="5" fill="#fff" opacity=".8" transform="rotate(20 32 17)"/><ellipse cx="24" cy="28" rx="13" ry="12" fill="#ffc63d"/><path d="M12 24h24M13 31h22" stroke="#3a2f14" stroke-width="3.4" stroke-linecap="round"/><circle cx="19" cy="20" r="2" fill="#3a2f14"/><circle cx="29" cy="20" r="2" fill="#3a2f14"/>',
  panda: '<circle cx="24" cy="24" r="24" fill="#eef3f8"/><circle cx="13" cy="14" r="6" fill="#2f3439"/><circle cx="35" cy="14" r="6" fill="#2f3439"/><circle cx="24" cy="26" r="15" fill="#fff"/><ellipse cx="17" cy="24" rx="5" ry="6" fill="#2f3439" transform="rotate(-15 17 24)"/><ellipse cx="31" cy="24" rx="5" ry="6" fill="#2f3439" transform="rotate(15 31 24)"/><circle cx="17.5" cy="24" r="1.8" fill="#fff"/><circle cx="30.5" cy="24" r="1.8" fill="#fff"/><path d="m24 29 2 2h-4Z" fill="#2f3439"/>',
  axolotl: '<circle cx="24" cy="24" r="24" fill="#ffb3c9"/><path d="M9 16h6M8 22h7M10 28h6" stroke="#ff7ba6" stroke-width="2.6" stroke-linecap="round"/><path d="M39 16h-6M40 22h-7M38 28h-6" stroke="#ff7ba6" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="26" r="13" fill="#ffc9d9"/><circle cx="24" cy="10" r="4" fill="#ffd7e3"/><circle cx="19" cy="25" r="2" fill="#5c2739"/><circle cx="29" cy="25" r="2" fill="#5c2739"/><path d="M20 31c2.5 2 5.5 2 8 0" stroke="#b5517a" stroke-width="2" stroke-linecap="round" fill="none"/>',
  raccoon: '<circle cx="24" cy="24" r="24" fill="#a9b7c4"/><path d="M11 16 10 7l8 4ZM37 16l1-9-8 4Z" fill="#cfdae4"/><path d="M24 12c9 0 15 6 15 14s-6 14-15 14S9 34 9 26s6-14 15-14Z" fill="#dde6ee"/><path d="M11 22c4-3 9-4 13-4s9 1 13 4c-1 4-6 6-13 6s-12-2-13-6Z" fill="#454f59"/><circle cx="18" cy="22" r="2.2" fill="#fff"/><circle cx="30" cy="22" r="2.2" fill="#fff"/><path d="m24 29 2 2.2h-4Z" fill="#2f3740"/>',
  hedgehog: '<circle cx="24" cy="24" r="24" fill="#e0b378"/><path d="M10 27c2-10 7-16 14-16s12 6 14 16Z" fill="#8a5a33"/><path d="M13 26l3-5 3 5 3-6 3 6 3-6 3 6 3-5 3 5" stroke="#6d4526" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 28c0-4 4-6 10-6s10 2 10 6-4 8-10 8-10-4-10-8Z" fill="#f3d3a8"/><circle cx="20" cy="28" r="1.9" fill="#3f2a1a"/><circle cx="28" cy="28" r="1.9" fill="#3f2a1a"/><circle cx="24" cy="32" r="2" fill="#3f2a1a"/>',
}
/** One creature as inline SVG. Nothing is returned for an id this build does not know, so callers fall back to the initial. */
function avSvg(id, cls = '') { const a = AV_ART[id]; return a ? `<svg class="avsvg ${cls}" viewBox="0 0 48 48" aria-hidden="true">${a}</svg>` : '' }

const I = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:scaleY(-1)"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  // The F's middle arm is a play button. Same artwork as /icon.svg.
  logo: '<svg viewBox="0 0 512 512" aria-hidden="true"><defs><linearGradient id="fxl-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset=".5" stop-color="#ff3d6e"/><stop offset="1" stop-color="#b8155a"/></linearGradient><radialGradient id="fxl-hl" cx=".25" cy="0" r="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" rx="118" fill="url(#fxl-bg)"/><rect width="512" height="512" rx="118" fill="url(#fxl-hl)"/><g fill="#fff"><rect x="140" y="116" width="76" height="280" rx="38"/><rect x="140" y="116" width="232" height="76" rx="38"/><path transform="translate(242 287) scale(.906) translate(-242 -287)" d="M242 228c0-16 17-26 31-18l102 59c14 8 14 28 0 36l-102 59c-14 8-31-2-31-18z"/></g></svg>',
}

/** A poster-shaped block: generated colour + title underneath, real artwork fades in over it once loaded. */
const art = (url, name) => `<div class="poster ph" style="--h:${hue(name)}"><span class="ph-t">${esc(name)}</span>${url ? `<img class="fade" loading="lazy" src="${esc(url)}" alt="" onload="this.classList.add('in')" onerror="this.remove()">` : ''}</div>`

/** Set a hero backdrop: banner if it exists, then the trailer's still frame, otherwise a blurred poster. */
function backdrop(el, banner, poster, still) {
  const load = (u, cls) => new Promise((ok, no) => { if (!u) return no(); const i = new Image(); i.onload = () => ok(u); i.onerror = no; i.src = u }).then((u) => { el.style.backgroundImage = `url("${u}")`; el.className = 'bd ' + cls; requestAnimationFrame(() => el.classList.add('in')) })
  load(banner, '').catch(() => load(still, '')).catch(() => load(poster, 'blur')).catch(() => {})
}

/** Swap the page with a cross-fade when the browser supports View Transitions. */
async function swap(fn) {
  window.scrollTo({ top: 0, behavior: 'instant' }) // html has smooth scrolling; a jump here must not animate
  let ran = false
  const once = () => { if (!ran) { ran = true; fn() } }
  if (!rmq.matches && document.startViewTransition) {
    // A view transition can stall (the new page is built but never painted until something else happens), so never wait on one for long.
    const guard = setTimeout(once, 400)
    try { await document.startViewTransition(once).updateCallbackDone } catch { /* fall through */ }
    clearTimeout(guard)
  }
  once()
}

function skeleton() {
  return `<div class="pad page-top"><div class="skel" style="height:min(46vh,380px);margin-bottom:28px"></div><div style="display:flex;gap:18px;overflow:hidden">${'<div class="skel" style="flex:none;width:168px;aspect-ratio:2/3"></div>'.repeat(8)}</div></div>`
}

/* ---------- casting ----------
   The phone only picks the TV and hands it a link. A Chromecast or Google TV fetches the video itself, so what it
   gets is the signed HLS URL built on the box's LAN address (castUrl, made in the player), never the tailnet name
   the page itself was loaded from: a TV cannot resolve that. Tap the cast button once to pick the TV, then
   anything started plays there. */
const CAST_APP = 'CC1AD845' // Google's Default Media Receiver: plays an HLS link without an app of its own
const casting = { connected: false, device: '', headerOff: null }
const castSubs = new Set()
function castEmit() { for (const fn of castSubs) { try { fn() } catch { /* one stale header bar is not worth a crash */ } } }
/** Run fn now and on every casting change; the returned function stops it (the header replaces its bar on each render). */
function onCast(fn) { castSubs.add(fn); fn(); return () => castSubs.delete(fn) }
function castCtx() { return window.cast?.framework ? cast.framework.CastContext.getInstance() : null }
function castNote(msg) {
  const n = document.createElement('div')
  n.className = 'castnote'; n.textContent = msg; n.setAttribute('role', 'status')
  ;(document.querySelector('.player') || document.body).append(n)
  setTimeout(() => n.remove(), 7000)
}

let castSdk = null
/** The sender SDK comes from Google's CDN (not bundled), so it is fetched the first time casting is asked for. */
function loadCastSdk() {
  if (window.cast?.framework) return Promise.resolve()
  if (!castSdk) castSdk = new Promise((ok, no) => {
    const fail = () => no(new Error('cast unavailable'))
    window.__onGCastApiAvailable = (yes) => {
      if (!yes || !window.cast?.framework) return fail()
      const ctx = cast.framework.CastContext.getInstance()
      ctx.setOptions({ receiverApplicationId: CAST_APP, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED })
      ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (e) => {
        const live = e.castState === cast.framework.CastState.CONNECTED
        casting.connected = live
        casting.device = live ? (ctx.getCurrentSession()?.getCastDevice()?.friendlyName || 'the TV') : ''
        if (!live) clearInterval(castTick)
        castEmit()
      })
      ok()
    }
    const s = document.createElement('script')
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
    s.onerror = fail
    document.head.append(s)
    setTimeout(fail, 12000) // gstatic blocked: the button must say so rather than do nothing
  })
  return castSdk
}
// Chrome (the only browser that casts) rejoins a TV it was casting to as soon as the SDK is up, so load it at the start, not when the cast button is first tapped.
if (/Chrome\//.test(navigator.userAgent)) loadCastSdk().catch(() => {})

/** Connect to a TV (asking which one when none is picked yet). Rejects with code 'cancel' if they close the picker. */
async function castConnect() {
  await loadCastSdk()
  const ctx = castCtx()
  if (!ctx) throw new Error('cast unavailable')
  let session = ctx.getCurrentSession()
  if (!session) session = await ctx.requestSession()
  if (!session) throw new Error('no TV picked')
  casting.connected = true
  casting.device = session.getCastDevice()?.friendlyName || 'the TV'
  castEmit()
  return session
}

let castTick = null
/** Put one episode on the TV, from `at` seconds in. Rejects when the TV cannot open the link. */
async function castSend(url, title, at = 0, torrentId, fileIndex, duration, type = 'application/vnd.apple.mpegurl', fallbackUrl = null) {
  if (!url) throw new Error('no LAN address for the TV')
  const session = await castConnect()
  const media = new chrome.cast.media.MediaInfo(url, type)
  media.streamType = chrome.cast.media.StreamType.BUFFERED
  if (duration) media.duration = duration
  const md = new chrome.cast.media.GenericMediaMetadata()
  md.title = title || 'Flix'
  media.metadata = md
  const req = new chrome.cast.media.LoadRequest(media)
  req.currentTime = Math.max(0, (at || 0) - 3) // a few seconds back, so it does not open mid-sentence
  let player
  try {
    player = await session.loadMedia(req)
  } catch (e) {
    // The receiver would not take the file. The playlist plays forwards, which is worse than a timeline and better than
    // nothing on the TV; anything else is a real failure and is reported as one.
    if (!fallbackUrl || url === fallbackUrl) throw e
    return castSend(fallbackUrl, title, at, torrentId, fileIndex, duration, 'application/vnd.apple.mpegurl', null)
  }
  castTrack(player, { torrentId, fileIndex, duration })
  return player
}

/** The TV is playing it now, so the phone stops counting: watch state (and the 60% next-episode rule) comes from the TV. */
function castTrack(player, ids) {
  clearInterval(castTick)
  const report = (ended) => {
    const duration = player.media?.duration || ids.duration || 0
    const position = ended ? duration : (player.getCurrentTime?.() || 0)
    if (!(position > 0) && !ended) return
    api('/api/progress', { torrentId: ids.torrentId, fileIndex: ids.fileIndex, position, duration, ended }).catch(() => {})
  }
  report(false) // straight away, so the show is under continue-watching on the phone
  castTick = setInterval(() => {
    if (!castCtx()?.getCurrentSession()) { clearInterval(castTick); return }
    const idle = player.playerState === chrome.cast.media.PlayerState.IDLE
    if (idle && player.idleReason === 'ERROR') { clearInterval(castTick); castNote('The TV could not play it. Check the TV is on the same network as this box.'); return }
    const done = idle && player.idleReason === 'FINISHED'
    report(done)
    if (done) clearInterval(castTick)
  }, 30000)
}

/* ---------- top bar ---------- */
function renderTop() {
  if (!me) { top.hidden = true; return }
  top.hidden = false
  top.innerHTML = `<a class="brand" href="#/" aria-label="Flix home">${I.logo}<span>Flix</span></a>
    <form class="search" id="sf" role="search">${I.search}<input id="q" type="search" placeholder="Search shows" aria-label="Search shows" autocomplete="off" enterkeyhint="search"></form>
    <div class="hact">${me.cast && !isTv ? `<button class="cast-btn" id="tc" aria-label="Cast to a TV" aria-pressed="false" title="Cast to a TV">${ICON.cast}</button>` : ''}<button class="avatar${me.avatar ? ' has-art' : ''}" id="av" aria-label="Account menu" aria-haspopup="true">${avSvg(me.avatar) || esc(me.name[0].toUpperCase())}</button></div>`
    // The cast button sits between the search bar and the profile: tap it once to pick the TV, then anything
    // started plays there. Tapping it again stops the session.
    casting.headerOff?.()
    casting.headerOff = onCast(() => {
      const tb = $('#tc')
      if (!tb) return
      tb.classList.toggle('on', casting.connected)
      tb.setAttribute('aria-pressed', casting.connected ? 'true' : 'false')
      tb.title = casting.connected ? `Casting to ${casting.device} · tap to stop` : 'Cast to a TV'
    })
    const tc = $('#tc')
    if (tc) tc.onclick = async () => {
      if (casting.connected) { try { castCtx().getCurrentSession()?.endSession(true) } catch { /* already gone */ } return }
      try { await castConnect(); castNote(`Casting to ${casting.device}`) } catch (err) {
        if (err?.code === 'cancel') return // they closed the device picker
        castNote('No TV found. Check the TV is on and on the same network as this box.')
      }
    }
  const q = $('#q'), sf = $('#sf')
  const cur = new URLSearchParams((location.hash.split('?')[1]) || '').get('q')
  if (cur) q.value = cur
  // Live search: what Flix already knows lands almost at once, then BTN's results fill in. Neither navigates or swaps the
  // page, so the field keeps focus and the caret, and a slow answer never overwrites a newer one.
  let liveT = 0, liveN = 0
  const show = (render, v) => { if (!/^#?\/?(\?|$)/.test(location.hash)) return; history.replaceState(null, '', v ? '#/?q=' + encodeURIComponent(v) : '#/'); render() }
  q.oninput = () => {
    clearTimeout(liveT)
    const v = q.value.trim(), mine = ++liveN
    liveT = setTimeout(async () => {
      if (!v) { const r = await homeView('').catch(() => null); if (r && mine === liveN) { show(r, v); window.scrollTo({ top: 0, behavior: 'instant' }) } return }
      const quick = await homeView(v, true).catch(() => null)
      if (quick && mine === liveN) show(quick, v)
      if (v.length < 2) return
      const full = await homeView(v).catch(() => null)
      if (full && mine === liveN) show(full, v)
    }, 120)
  }
  sf.onsubmit = (e) => { e.preventDefault(); const t = q.value.trim(); go(t ? '#/?q=' + encodeURIComponent(t) : '#/'); q.blur() }
  $('#av').onclick = (e) => {
    e.stopPropagation()
    const old = $('.menu'); if (old) return closeMenu(old)
    const m = document.createElement('div'); m.className = 'menu'
    const many = profiles().length > 1 || (profiles().length === 1 && profiles()[0].name !== me.name)
    m.innerHTML = `<div class="who">Signed in as <b>${esc(me.name)}</b></div><a href="#/profile">Profile</a>${many ? '<button id="sw">Switch profile</button>' : ''}<a href="#/downloads">Downloads</a>${me.is_admin ? '<a href="#/settings">Settings</a>' : ''}<button id="lo">Sign out</button>`
    top.appendChild(m)
    $('#lo').onclick = async () => {
      await api('/api/logout', {}).catch(() => {})
      store.set('profiles', profiles().filter((p) => p.name !== me.name)); me = null
      if (profiles().length) go('#/profiles'); else route()
    }
    const sw = $('#sw'); if (sw) sw.onclick = () => { try { sessionStorage.removeItem('flix.picked') } catch { /* ignore */ } go('#/profiles') }
    m.querySelectorAll('a').forEach((a) => a.onclick = () => closeMenu(m))
  }
}
/* ---------- the Flix sound ---------- */
/**
 * Flix's own sound, made entirely in the browser (Web Audio) so there is no sound file to ship: two soft, rounded mallet notes rising
 * a fourth, and a warm, slightly detuned add9 pad that blooms under the second one and settles away, all through a gentle low-pass
 * and a small synthetic room reverb so nothing is bright or sharp. Played as the player opens, which happens on a tap, so the
 * browser allows it. It never throws: no audio support, or a browser that insists on a tap first, is just a silent intro.
 */
let audioCtx = null, roomIR = null
function flixSting() {
  try {
    if (store.get('sting', true) === false) return
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx ??= new AC()
    const c = audioCtx
    if (c.state === 'suspended') c.resume().catch(() => {})
    const t = c.currentTime + 0.05
    // Master: a soft overall level, a low-pass that rounds off any edge, and a gentle compressor.
    const out = c.createGain(); out.gain.value = 0.55
    const tone = c.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 3200; tone.Q.value = 0.5
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.02
    out.connect(tone); tone.connect(comp); comp.connect(c.destination)
    // A small room: decaying stereo noise as the impulse response, mixed in quietly so the notes have air around them.
    if (!roomIR) {
      const len = Math.floor(c.sampleRate * 2.4); roomIR = c.createBuffer(2, len, c.sampleRate)
      for (let ch = 0; ch < 2; ch++) { const d = roomIR.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2 }
    }
    const verb = c.createConvolver(); verb.buffer = roomIR
    const wet = c.createGain(); wet.gain.value = 0.42
    verb.connect(wet); wet.connect(tone)
    const send = (node) => { node.connect(out); node.connect(verb) }
    // 1. Mallet notes: a sine with faint upper partials, a soft (not instant) attack and a long, smooth decay.
    const mallet = (f, at, peak, ring) => {
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(peak, at + 0.018); g.gain.exponentialRampToValueAtTime(0.0001, at + ring)
      send(g)
      for (const [mul, lvl, len] of [[1, 1, 1], [2, 0.12, 0.45], [3.98, 0.03, 0.18]]) {
        const o = c.createOscillator(), pg = c.createGain(); o.type = 'sine'; o.frequency.value = f * mul
        pg.gain.setValueAtTime(lvl, at); pg.gain.exponentialRampToValueAtTime(lvl * 0.001, at + ring * len)
        o.connect(pg); pg.connect(g); o.start(at); o.stop(at + ring + 0.05)
      }
    }
    const n1 = t + 0.18, n2 = n1 + 0.3
    mallet(440.0, n1, 0.32, 1.4)    // A4
    mallet(587.33, n2, 0.36, 2.4)   // D5
    // 2. A warm D add9 pad: pairs of slightly detuned sines through a low-pass that opens as it swells and closes as it fades.
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7
    lp.frequency.setValueAtTime(500, n2); lp.frequency.exponentialRampToValueAtTime(2200, n2 + 0.7); lp.frequency.exponentialRampToValueAtTime(600, n2 + 2.8)
    const pad = c.createGain(); pad.gain.setValueAtTime(0.0001, n2)
    pad.gain.exponentialRampToValueAtTime(0.22, n2 + 0.6); pad.gain.setTargetAtTime(0.0001, n2 + 1.1, 0.55)
    lp.connect(pad); send(pad)
    for (const [f, lvl] of [[146.83, 0.5], [220.0, 0.38], [369.99, 0.3], [659.25, 0.16]]) {
      for (const cents of [-7, 7]) {
        const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = f; o.detune.value = cents
        g.gain.value = lvl; o.connect(g); g.connect(lp); o.start(n2); o.stop(n2 + 4)
      }
    }
  } catch { /* silent intro */ }
}
/* ---------- platform ---------- */
// Declared before anything can render, because the header and the account menu both ask "is this a television?"
// (a TV is the one place with no install button and no cast button: it is the thing a phone casts to).
const isTv = /SMART-?TV|Tizen|Web0S|WebOS|AFT[A-Z]|Android TV|GoogleTV|BRAVIA|CrKey/i.test(navigator.userAgent)
if (isTv) document.documentElement.classList.add('tv')
// What this player can decode, asked once of the player itself. Only the device knows whether the screen behind it has an
// HEVC or AV1 decoder, and the box used to assume nobody did above 1080p -- which refused 4K files that play perfectly as
// they are and told the viewer they would need converting.
const CAN_PLAY = (() => {
  const el = document.createElement('video')
  const t = { h264: 'video/mp4; codecs="avc1.640028"', hevc: 'video/mp4; codecs="hvc1.1.6.L153.B0"', av1: 'video/mp4; codecs="av01.0.08M.08"', vp9: 'video/mp4; codecs="vp09.00.10.08"', vp8: 'video/webm; codecs="vp8"' }
  try { return Object.keys(t).filter((c) => !!el.canPlayType(t[c])) } catch { return [] }
})()

function closeMenu(m) { if (!m || m.classList.contains('out')) return; m.classList.add('out'); setTimeout(() => m.remove(), 150) }
addEventListener('click', () => closeMenu($('.menu')))
addEventListener('scroll', () => top.classList.toggle('solid', scrollY > 30), { passive: true })

/* ---------- profiles ("Who's watching?") ---------- */
// Each profile used on this device keeps its own long-lived sign-in in local storage, so switching never asks for a password.
const profiles = () => store.get('profiles', [])
async function rememberProfile(drop) {
  if (!me) return
  try {
    const { token } = await api('/api/device-token', {})
    store.set('profiles', [...profiles().filter((p) => p.name !== me.name && p.name !== drop), { name: me.name, token }])
  } catch { /* the picker just won't list them */ }
}
const picked = () => { try { return sessionStorage.getItem('flix.picked') === '1' } catch { return true } }
const markPicked = () => { try { sessionStorage.setItem('flix.picked', '1') } catch { /* ignore */ } }
const goHome = () => { history.replaceState(null, '', '#/'); route() }
let signinHint = ''

function profilesView() {
  return () => {
    top.hidden = true
    const ps = profiles()
    app.innerHTML = `<div class="who-wrap"><h1>Who’s watching?</h1><div class="who-grid">${ps.map((p, i) => `<button class="who-tile rise" style="--i:${i}" data-n="${esc(p.name)}"><span class="who-av" style="--h:${hue(p.name)}">${esc(p.name[0].toUpperCase())}</span><span>${esc(p.name)}</span></button>`).join('')}
      <a class="who-tile rise" style="--i:${ps.length}" href="#/signin"><span class="who-av add">+</span><span>Add profile</span></a></div></div>`
    app.querySelectorAll('.who-tile[data-n]').forEach((b) => b.onclick = async () => {
      const p = ps.find((x) => x.name === b.dataset.n)
      let pin, msg = ''
      for (;;) {
        try { const r = await api('/api/switch', { token: p.token, pin }); me = r.user; markPicked(); return goHome() }
        catch (e) {
          if (!e.pin) { store.set('profiles', profiles().filter((x) => x.name !== p.name)); signinHint = p.name; return go('#/signin') }
          if (e.status === 429) { msg = e.message; pin = await askPin(p.name, msg, true); if (pin === null) return; continue }
          pin = await askPin(p.name, pin ? e.message : ''); if (pin === null) return
        }
      }
    })
    const f = $('.who-tile'); if (f) f.focus()
  }
}

/** A small "enter your PIN" box. Resolves with the digits, or null when cancelled. */
function askPin(name, error = '', locked = false) {
  return new Promise((done) => {
    const m = document.createElement('div'); m.className = 'pin-modal'
    m.innerHTML = `<form class="pin-box" role="dialog" aria-label="PIN for ${esc(name)}"><b>${esc(name)}’s PIN</b><input class="field" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" aria-label="PIN" ${locked ? 'disabled' : ''}>
      <div class="err" role="alert">${esc(error)}</div><div class="row-form"><button type="button" class="btn" id="pc">Cancel</button><button class="btn primary" ${locked ? 'disabled' : ''}>OK</button></div></form>`
    document.body.appendChild(m)
    const f = $('input', m); f.focus()
    const end = (v) => { m.remove(); done(v) }
    m.querySelector('form').onsubmit = (e) => { e.preventDefault(); if (f.value.length >= 4) end(f.value) }
    $('#pc', m).onclick = () => end(null)
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(null) })
  })
}

function joinView(token) {
  return () => {
    top.hidden = true
    app.innerHTML = `<div class="auth-wrap"><div class="auth"><div class="brand">${I.logo}<span>Flix</span></div><h1 style="text-align:center">Signing you in…</h1><p class="dim" style="text-align:center;margin:0" id="jm">One moment.</p></div></div>`
    api('/api/join', { token }).then(async (r) => { me = r.user; await rememberProfile(); markPicked(); goHome() })
      .catch((e) => { $('.auth h1').textContent = 'That link didn’t work'; $('#jm').textContent = e.message; $('.auth').insertAdjacentHTML('beforeend', '<a class="btn primary" style="width:100%;display:block;text-align:center;box-sizing:border-box" href="#/signin">Sign in with a password</a>') })
  }
}

/* ---------- auth ---------- */
function authView(needsSetup) {
  return () => {
    app.innerHTML = `<div class="auth-wrap"><form class="auth"><div class="brand">${I.logo}<span>Flix</span></div>
      <h1 style="text-align:center">${needsSetup ? 'Create the admin account' : 'Welcome back'}</h1>
      <input class="field" name="name" placeholder="Username" autocomplete="username" value="${esc(signinHint)}" required>
      <input class="field" name="password" type="password" placeholder="${needsSetup ? 'Password (8+ characters)' : 'Password (kids leave this empty)'}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" ${needsSetup ? 'required' : ''}>
      <button class="btn primary" style="width:100%">${needsSetup ? 'Create account' : 'Sign in'}</button><div class="err" id="err" role="alert"></div></form></div>`
    $('form').onsubmit = async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      try {
        await api(needsSetup ? '/api/signup' : '/api/login', { name: f.get('name'), password: f.get('password') })
        me = (await api('/api/me')).user; await rememberProfile(); markPicked(); goHome()
      } catch (err) { $('#err').textContent = err.message; const f = $('form.auth'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake') }
    }
  }
}

/* ---------- home ---------- */
const tile = (s, i) => `<a class="tile rise" style="--i:${Math.min(i, 12)}" href="#/series/${s.id}">${art(s.poster, s.name)}${s.hasNew ? '<span class="new-badge ep">New episode</span>' : s.isNew ? '<span class="new-badge">New</span>' : ''}<div class="tt">${esc(s.name)}</div></a>`
const contTile = (c, i) => `<button class="tile rise" style="--i:${Math.min(i, 12)}" data-s="${c.seriesId}" data-season="${c.season ?? ''}" data-label="${esc(c.label)}">
  <div style="position:relative">${art(c.poster, c.series)}${c.next ? '' : `<div class="prog"><b style="width:${pct(c.position, c.duration)}%"></b></div>`}</div><div class="tt">${esc(c.series)}</div><div class="ts">${c.next ? 'Up next · ' : ''}${esc(c.label)}</div></button>`

/** A season pack others have finished that will be removed in a few days unless someone keeps it. */
const leavingTile = (l, i) => {
  const days = Math.max(1, Math.ceil((l.leavesAt - Date.now() / 1000) / 86400))
  return `<a class="tile rise" style="--i:${Math.min(i, 12)}" href="#/series/${l.seriesId}">${art(l.poster, l.series)}<div class="tt">${esc(l.series)}</div><div class="ts">${esc(l.label)} · leaves in ${days} day${days === 1 ? '' : 's'}</div></a>`
}
function rowOf(items, html) {
  return `<div class="rowwrap"><button class="arrow l" aria-label="Scroll left">${I.back}</button><div class="row-scroll">${items.map(html).join('')}</div><button class="arrow r" aria-label="Scroll right">${I.next}</button></div>`
}
function wireRows(root) {
  const io = 'IntersectionObserver' in window && !rmq.matches ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { rootMargin: '0px 0px -8% 0px' }) : null
  root.querySelectorAll('.rowwrap').forEach((w) => {
    const sc = $('.row-scroll', w), l = $('.arrow.l', w), r = $('.arrow.r', w)
    l.onclick = () => sc.scrollBy({ left: -sc.clientWidth * 0.85, behavior: smooth() })
    r.onclick = () => sc.scrollBy({ left: sc.clientWidth * 0.85, behavior: smooth() })
    const edges = () => { l.classList.toggle('off', sc.scrollLeft < 8); r.classList.toggle('off', sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 8) }
    sc.addEventListener('scroll', edges, { passive: true }); edges()
    // Rows already on screen use the normal rise; rows further down cascade in when scrolled to.
    if (io && w.getBoundingClientRect().top > innerHeight * 0.9) { w.classList.add('reveal'); io.observe(w); const h = w.previousElementSibling; if (h?.matches('h2.sec')) { h.classList.add('rv'); io.observe(h) } }
  })
  root.querySelectorAll('.tile[data-s]').forEach((b) => b.onclick = () => go(`#/play/${b.dataset.s}/${b.dataset.season || 'x'}/${encodeURIComponent(b.dataset.label)}`))
}

/* ---------- the soft "Leaving soon" prompt ---------- */
const LP_KEY = 'flix.leaving.asked'
const lpAsked = () => { try { return new Set(JSON.parse(sessionStorage.getItem(LP_KEY) || '[]')) } catch { return new Set() } }
/** Remember which downloads were already put to this person, for this session only: it asks once, then keeps quiet. */
function lpMark(ids) { try { const s = lpAsked(); ids.forEach((i) => s.add(i)); sessionStorage.setItem(LP_KEY, JSON.stringify([...s])) } catch { /* ignore */ } }
const lpDays = (l) => { const d = Math.max(1, Math.ceil((l.leavesAt - Date.now() / 1000) / 86400)); return d === 1 ? 'gone tomorrow' : `${d} days left` }

/**
 * A card at the top of Home that asks, once a session, about downloads on their way out: keep one, or say it can go.
 * Deliberately not a modal -- no backdrop, no focus trap, the rest of Home stays usable -- because a jarring dialog in
 * front of the interface is what makes people dismiss it without reading. "Not now" and Escape quiet it until tomorrow.
 */
function leavingPromptPick(items) {
  const asked = lpAsked()
  return items.filter((l) => !asked.has(l.torrentId)).slice(0, 3)
}

function leavingPrompt(show) {
  if (!show.length) return ''
  return `<section class="lp rise" id="lp" role="group" aria-labelledby="lp-t">
    <div class="lp-head"><h2 id="lp-t">Leaving soon</h2><button class="lp-x" id="lp-x" aria-label="Not now">×</button></div>
    <p class="lp-sub">Finished and seeded, but ${show.length === 1 ? 'nobody has' : 'nobody here has'} opened ${show.length === 1 ? 'it' : 'them'} yet. Say what you want and it is remembered.</p>
    <ul class="lp-list">${show.map((l) => `<li data-t="${l.torrentId}">
      <a class="lp-name" href="#/series/${l.seriesId}">${esc(l.series || l.label || 'This download')}${l.season ? ' · S' + l.season : ''}</a>
      <span class="lp-when">${lpDays(l)}</span>
      <button class="btn lp-keep" data-t="${l.torrentId}">Keep it</button>
      <button class="btn lp-go" data-t="${l.torrentId}">Let it go</button>
    </li>`).join('')}</ul>
  </section>`
}

/** The Leaving soon card's buttons: one tap records the answer and the line then says what happened. */
function wireLeavingPrompt() {
  const lp = $('#lp')
  if (!lp) return
  const ids = [...lp.querySelectorAll('li[data-t]')].map((li) => Number(li.dataset.t))
  const say = (li, text) => { li.className = 'lp-done'; li.innerHTML = `<span class="lp-name">${esc(text)}</span>` }
  const act = async (btn, path, done) => {
    const li = btn.closest('li'), t = Number(li.dataset.t)
    btn.disabled = true
    try { await api(path, { torrentId: t }); lpMark([t]); done(li) } catch (e) { btn.disabled = false; say(li, e.message || 'That did not work') }
  }
  lp.querySelectorAll('.lp-keep').forEach((b) => { b.onclick = () => act(b, '/api/leaving/keep', (li) => say(li, 'Kept — it stays while you are watching it')) })
  lp.querySelectorAll('.lp-go').forEach((b) => { b.onclick = () => act(b, '/api/leaving/let-go', (li) => say(li, 'Noted — it goes once everyone is done and it has seeded')) })
  const close = () => { lpMark(ids); lp.remove() }
  const x = $('#lp-x')
  if (x) x.onclick = close
  lp.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
}

async function homeView(q, local = false) {
  const [list, cont, home, leaving] = await Promise.all([
    q ? api('/api/series?q=' + encodeURIComponent(q) + (local ? '&local=1' : '')) : { series: [] },
    q ? { items: [] } : api('/api/continue'),
    q ? { hero: null, sections: [] } : api('/api/home'),
    q ? { items: [] } : api('/api/leaving').catch(() => ({ items: [] })),
  ])
  const series = q ? list.series : []
  const featured = q ? null : home.hero // the billboard: top trending show, else the newest streaming original
  const items = cont.items
  const listIds = new Set(home.listIds ?? [])
  return () => {
    let html = ''
    // Titles the card asks about are not repeated as a row beneath it.
    const lpShow = q ? [] : leavingPromptPick(leaving.items)
    const lpIds = new Set(lpShow.map((l) => l.torrentId))
    if (!q && featured) {
      const s = featured
      html += `<section class="hero"><div class="bd" id="hbd"></div><div class="hero-in pad"><div class="eyebrow rise">Featured</div>
        <h1 class="rise" style="--i:1">${esc(s.name)}</h1><p class="sub rise" style="--i:2">Tap to see episodes</p>
        <div class="actions rise" style="--i:3"><a class="btn primary" href="#/series/${s.id}">${I.play} Watch now</a>
        <button class="btn" id="hml" aria-pressed="${listIds.has(s.id)}">${listIds.has(s.id) ? '✓ In My List' : '+ My List'}</button>
        <a class="btn" href="#/series/${s.id}">${I.info} Details</a></div></div></section>`
    } else html += '<div class="page-top"></div>'
    html += '<div class="pad">'
    if (lpShow.length) html += leavingPrompt(lpShow)
    // The featured show is never one being resumed (the server keeps it out), so every show to resume is in this row.
    if (items.length) html += `<h2 class="sec">Continue watching</h2>${rowOf(items, contTile)}`
    if (!q && leaving.items.some((l) => !lpIds.has(l.torrentId))) html += `<h2 class="sec">Leaving soon</h2>${rowOf(leaving.items.filter((l) => !lpIds.has(l.torrentId)), leavingTile)}`
    if (!q && home.myList?.length) html += `<h2 class="sec">My List</h2>${rowOf(home.myList, tile)}`
    if (!q && home.picked) html += `<h2 class="sec">Picked for you</h2>${rowOf(home.picked, tile)}`
    if (!q && home.because) html += `<h2 class="sec">Because you ${home.because.liked ? 'liked' : 'watched'} ${esc(home.because.name)}</h2>${rowOf(home.because.series, tile)}`
    if (q) html += `<h2 class="sec" style="margin-top:0">Results for “${esc(q)}”</h2>` + (series.length ? `<div class="grid">${series.map(tile).join('')}</div>` : '<div class="empty">No shows found. Try a different spelling.</div>')
    else {
      for (const sec of home.sections) html += `<h2 class="sec">${esc(sec.title)}</h2>${rowOf(sec.series, tile)}`
      if (!home.sections.length && !home.myList?.length && !home.because && !home.picked) html += `<div class="empty">${home.checking ? `Checking ${home.checking} show${home.checking === 1 ? '' : 's'} with BroadcasTheNet. Only English-language shows whose whole first season is available are listed, so this fills in over the next few minutes.` : 'Nothing here yet. The home screen shows rows of ten from HBO, Crave, Showcase, Netflix, Disney+, Apple TV+ and Paramount+ as Flix learns which service each show is on; search finds everything else.'}</div>`
    }
    html += '</div>'
    app.innerHTML = html
    wireRows(app)
    wireLeavingPrompt()
    // A television left alone on the home screen shows the top shows' artwork after a while, one at a time, instead of
    // rows of stills for ever. Any input ends it; it never runs at all with reduced motion turned on.
    artShow?.stop?.()
    const art = (artShow = artSlideshow([...(featured ? [featured] : []), ...(home.sections || []).flatMap((sec) => sec.series), ...(home.picked?.series ?? []), ...(home.myList ?? [])]))
    const beforeCleanup = cleanup
    cleanup = () => { beforeCleanup?.(); art?.stop?.(); if (artShow === art) artShow = null }
    const hs = !q && featured
    if (hs) backdrop($('#hbd'), `/api/art/${hs.id}/banner`, `/api/art/${hs.id}/poster`)
    const hml = $('#hml'); if (hml) hml.onclick = async () => {
      const on = hml.getAttribute('aria-pressed') !== 'true'
      try { await api('/api/mylist', { seriesId: hs.id, on }); hml.setAttribute('aria-pressed', String(on)); hml.textContent = on ? '✓ In My List' : '+ My List' } catch (e) { alert(e.message) }
    }
  }
}

/* ---------- the idle sit-back slideshow ---------- */
/** Where a slideshow of artwork belongs: a television, or a window big enough to be watched from a sofa. A phone never shows it. */
const bigScreen = () => isTv || matchMedia('(min-width: 1100px)').matches
/** Long enough that nobody reading the page sees it appear under them. */
const ART_IDLE_MS = 45_000
/** How long one picture stays up before the next fades over it: fifteen seconds, then a slow cross-fade (ART_FADE_S in
    style.css, 4 s) -- a picture you can look at, not a carousel. */
const ART_HOLD_MS = 15_000
let artShow = null

/**
 * The top shows' posters, one at a time, fading in and out on a screen nobody has touched for a while -- what a television
 * left on the home screen does. The next poster is fetched while the one before it is still up, so there is never a burst
 * of requests, and any input at all takes it away at once. Returns its stop(), or null when it must not run.
 */
/** `opts.manual`: the caller starts and stops it (the player's idle timer), so it never arms itself on input;
    `opts.parent`: where the overlay lives (inside the player, above the picture, instead of on the body). */
function artSlideshow(items, opts = {}) {
  if (rmq.matches || !bigScreen()) return null
  const show = [...new Map((items || []).filter((s) => s && s.id != null).map((s) => [s.id, s])).values()].slice(0, 12)
  if (show.length < 2) return null
  const box = document.createElement('div')
  box.className = 'arts'
  box.setAttribute('aria-hidden', 'true')
  box.innerHTML = [0, 1].map(() => '<div class="arts-l"><i class="arts-bg"></i><img class="arts-p" alt=""><b class="arts-t"></b></div>').join('')
  const lay = [...box.querySelectorAll('.arts-l')]
  const warm = new Map()
  let n = 0, front = 1, idle = null, hold = null, on = false, stopped = false, armedAt = 0, misses = 0

  /** The next picture, fetched now: the change is then only a fade, and the server sees one request per slide. */
  const preload = (s) => {
    if (warm.has(s.id)) return
    const im = new Image()
    im.src = `/api/art/${s.id}/poster`
    warm.set(s.id, im)
    if (warm.size > 4) { const [oldest] = warm.keys(); if (oldest !== s.id) warm.delete(oldest) }
  }
  const draw = () => {
    const s = show[n], back = 1 - front, el = lay[back], img = $('img', el)
    const wide = `/api/art/${s.id}/banner`
    $('.arts-bg', el).style.backgroundImage = `url("/api/art/${s.id}/poster")`
    $('b', el).textContent = s.name || ''
    // Wide art first, filling the screen and drifting from right to left the way a television idles. A show with no wide
    // picture of its own falls back to its poster, held in the middle as before -- a portrait poster stretched across the
    // whole screen is a smear, so the two look deliberately different rather than one being a bad copy of the other.
    img.dataset.fb = '0'
    img.className = 'arts-p'
    // One picture that 404s (a show with no artwork) or 401s (a session that has expired on a television left idle) must
    // not walk the whole list at network speed for ever: a run of failures with no picture in between takes the
    // slideshow away. A poster that does arrive clears the count, so one missing poster among the others is not a run.
    // The count is NOT reset here, in draw(): that reset was what made the run impossible to complete.
    img.onload = () => { misses = 0 }
    img.onerror = () => {
      if (!on) return
      // The wide picture is missing: the poster is still worth showing, in the middle of the screen.
      if (img.dataset.fb === '0') { img.dataset.fb = '1'; img.className = 'arts-p contain'; img.src = `/api/art/${s.id}/poster`; return }
      clearTimeout(hold)
      n = (n + 1) % show.length
      if (++misses > show.length) { misses = 0; hide(); return } // nothing to show at all: leave the page alone
      draw()
    }
    img.src = wide
    // The two layers are reused, so the drift has to be started again for each slide: without this the picture arrives
    // already part-way through the pan it did last time, or not moving at all. The read of offsetWidth is what makes the
    // browser settle the plain class before the drifting one goes on, so the animation really does begin here.
    void img.offsetWidth
    img.className = 'arts-p cover'
    el.classList.add('on')
    lay[front].classList.remove('on')
    front = back
    preload(show[(n + 1) % show.length])
    hold = setTimeout(() => { n = (n + 1) % show.length; draw() }, ART_HOLD_MS)
  }
  const start = () => {
    if (stopped || on || document.hidden) return
    on = true
    misses = 0
    box.classList.add('on')
    draw()
  }
  const hide = () => {
    if (!on) return
    on = false
    clearTimeout(hold)
    box.classList.remove('on')
    lay.forEach((e) => e.classList.remove('on'))
  }
  const arm = () => { clearTimeout(idle); if (!stopped) idle = setTimeout(start, ART_IDLE_MS) }
  // Any input at all: a remote's arrow key, a finger, a mouse, a wheel. The overlay goes at once, and the count starts
  // again. Re-arming at most once a second, because a drag is thousands of pointer moves.
  const touched = () => {
    if (on) hide()
    if (opts.manual) return // manual mode: the owner (the player) decides when it may come back
    const now = Date.now()
    if (now - armedAt > 1000) { armedAt = now; arm() }
  }
  const seen = () => { if (document.hidden) hide(); else if (!opts.manual) arm() }
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']
  ;(opts.parent || document.body).appendChild(box)
  events.forEach((e) => addEventListener(e, touched, true))
  addEventListener('visibilitychange', seen)
  if (!opts.manual) arm()
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(idle)
    clearTimeout(hold)
    events.forEach((e) => removeEventListener(e, touched, true))
    removeEventListener('visibilitychange', seen)
    box.remove()
  }
  return { stop, start, hide }
}

/* ---------- series ---------- */
let ytLoading
/** YouTube's player script (its error events tell us a video is private or unavailable), fetched the first time a trailer is played. */
const ytApi = () => ytLoading ??= new Promise((ok, no) => {
  if (window.YT?.Player) return ok()
  const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api'
  sc.onerror = () => { ytLoading = null; no(new Error('blocked')) }
  window.onYouTubeIframeAPIReady = ok
  document.head.append(sc)
})
async function seriesView(id) {
  const { series, episodes, leavesAt, current } = await api('/api/series/' + id)
  const seasons = new Map()
  for (const e of episodes) { const k = e.season ?? 'x'; if (!seasons.has(k)) seasons.set(k, []); seasons.get(k).push(e) }
  // The episode this person is on, as the server worked it out: the one played last, or the one after it once that is
  // finished. Not "the first episode with some progress", which brought back an episode abandoned in its credits weeks
  // ago after the ones that followed it had been watched.
  const resume = current ? episodes.find((e) => e.season === current.season && e.label === current.label && e.available && (!e.locked || e.position > 30)) : null
  // The hero never offers something the order rule forbids. A resume is always allowed (that episode was started);
  // otherwise it is the first episode that may be started and has not been watched, so Play Now cannot dead-end.
  const hero = resume ?? episodes.find((e) => !e.watched && e.available && !e.locked)
  const firstLocked = episodes.find((e) => e.locked && e.available)
  const started = episodes.some((e) => e.watched || e.position > 30) // anything already played: Resume (from the episode in progress, else the next unwatched)
  const keys = [...seasons.keys()]
  let cur = hero ? (hero.season ?? 'x') : keys[keys.length - 1]
  const go1 = (e) => go(`#/play/${id}/${e.season ?? 'x'}/${encodeURIComponent(e.label)}`)
  const saved = new Set((await dl.list()).map((m) => m.id))
  return () => {
    let gone = false, seasonRun = 0
    app.innerHTML = `<section class="s-hero"><div class="bd" id="sbd"></div><div class="s-in pad">${art(series.poster, series.name)}
      <div class="s-meta"><h1 class="rise">${esc(series.name)}</h1>
      <div class="line rise" style="--i:1"><span class="chip" id="rchip" title="${series.source === 'imdb' ? 'From IMDb' : series.source === 'tmdb' ? 'From TMDB' : 'No rating known'}">${esc(series.rating || 'Unrated')}</span>${series.score ? `<span title="IMDb rating">★ ${esc(series.score.toFixed(1))}</span>` : ''}${series.year ? `<span>${series.year}</span>` : ''}<span>${episodes.length} episode${episodes.length === 1 ? '' : 's'}</span>${keys.length > 1 ? `<span>${keys.length} seasons</span>` : ''}${series.genres.length ? `<span>${esc(series.genres.slice(0, 3).join(' · '))}</span>` : ''}${leavesAt ? `<span class="chip" title="Others have finished it; it is removed from the server unless you press play">Leaving in ${Math.max(1, Math.ceil((leavesAt - Date.now() / 1000) / 86400))} day${Math.ceil((leavesAt - Date.now() / 1000) / 86400) <= 1 ? '' : 's'}</span>` : ''}
        </div>
      <div class="rise" style="--i:2;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        ${hero ? `<button class="btn primary" id="hp">${I.play} ${started ? 'Resume' : 'Play Now'}</button>` : `<span class="dim">${firstLocked ? `Watch ${shortEp(firstLocked.after)} first` : 'Nothing is available to play right now.'}</span>`}
        <button class="btn" id="ml" aria-pressed="${!!series.inList}">${series.inList ? '✓ In My List' : '+ My List'}</button>
        <span class="thumbs" role="group" aria-label="Rate this show"><button class="btn icon-thumb" id="tu" aria-label="Thumbs up" title="I like this" aria-pressed="${series.vote === 1}">${I.up}</button><button class="btn icon-thumb" id="td" aria-label="Thumbs down" title="Not for me" aria-pressed="${series.vote === -1}">${I.down}</button></span>
        </div></div></div></section>
      <div class="pad">${series.overview ? `<p class="summary">${esc(series.overview)}</p>` : ''}
      ${series.trailerId ? `<h2 class="sec">Trailer</h2><div class="trailer" id="tr"><button class="tr-play" id="trb" aria-label="Play trailer on YouTube">${series.trailerThumb ? `<img class="tr-thumb fade" src="${esc(series.trailerThumb)}" alt="" onload="this.classList.add('in')" onerror="this.remove()">` : ''}${I.play}<span>Watch trailer</span></button></div>` : ''}
      ${series.cast.length ? `<h2 class="sec">Cast</h2><div class="cast">${series.cast.map((c) => `<div class="actor"${isTv ? ' tabindex="0"' : ''}><span class="ph" style="--h:${hue(c.name)}">${esc(c.name[0])}${c.photo ? `<img class="fade" loading="lazy" src="${esc(c.photo)}" alt="" onload="this.classList.add('in')" onerror="this.remove()">` : ''}</span><b>${esc(c.name)}</b><small>${esc(c.role)}</small></div>`).join('')}</div>` : ''}
      <div class="eps-head"><h2 class="sec">Episodes</h2><span id="sdls"></span></div><div class="pills" role="tablist" aria-label="Seasons">${keys.map((k) => `<button class="pill" role="tab" data-k="${k}" aria-selected="${k === cur}">${k === 'x' ? 'Episodes' : 'Season ' + k}</button>`).join('')}</div><div class="eps" id="eps"></div></div>`
    backdrop($('#sbd'), `/api/art/${id}/banner`, `/api/art/${id}/poster`, series.trailerThumb)
    const dlButton = (e) => {
      if (!dl.supported() || !e.available || (e.isPack && e.episode === null)) return ''
      const did = dl.idOf(id, e.season, e.label), a = dl.active.get(did)
      if (a) return `<span class="dlb busy${a.error ? ' err' : ''}" role="button" tabindex="0" title="${esc(a.text)}">${a.error ? esc(a.text) : esc(a.text)}</span>`
      return saved.has(did) ? `<span class="dlb done" role="button" tabindex="0" title="Saved on this device. Open Downloads">${I.check} Saved</span>` : `<span class="dlb" role="button" tabindex="0" title="Save a 1080p copy on this device to watch offline" aria-label="Download for offline">${I.dl}</span>`
    }
    // The whole season saved to this device, one episode at a time: the server is never asked for several at once,
    // so the one-episode-at-a-time rule still holds and nothing extra ends up on disk unasked.
    const seasonList = () => (seasons.get(cur) ?? []).filter((e) => e.available && !(e.isPack && e.episode === null))
    const saveEp = (e) => dl.start({ seriesId: +id, season: e.season, label: e.label, title: e.title, seriesName: series.name },
      () => api('/api/watch', { seriesId: +id, season: e.season ?? null, label: e.label }))
    const paintSeason = () => {
      const box = $('#sdls'); if (!box) return
      const list = seasonList()
      if (!dl.supported() || !list.length) { box.innerHTML = ''; return }
      const left = list.filter((e) => !saved.has(dl.idOf(id, e.season, e.label)))
      const done = list.length - left.length
      const label = seasonRun ? `Stop · ${done} of ${list.length} saved`
        : !left.length ? `${I.check} Season saved`
        : done ? `${I.dl} Save the rest · ${left.length} left`
        : `${I.dl} Download season`
      box.innerHTML = `<button class="btn dls${!left.length && !seasonRun ? ' done' : ''}${seasonRun ? ' run' : ''}" id="sdl" aria-label="${!left.length ? 'This season is saved on this device' : seasonRun ? 'Stop saving this season' : 'Save every episode of this season on this device'}">${label}</button>`
      $('#sdl').onclick = () => {
        if (seasonRun) { seasonRun++; paintSeason(); return } // a second tap stops it after the episode in flight
        if (!left.length) return go('#/downloads')
        const job = ++seasonRun
        paintSeason()
        ;(async () => {
          for (const e of left) {
            if (gone || job !== seasonRun) break
            saveEp(e)
            // stop the run on a failure: if one episode will not save, the rest will not either
            if (!(await dl.whenDone(dl.idOf(id, e.season, e.label)))) break
          }
          if (job === seasonRun) seasonRun = 0
          if (!gone) paint()
        })()
      }
    }
    const paint = () => {
      $('#eps').innerHTML = (seasons.get(cur) ?? []).map((e, i) => `<button class="ep rise${e.locked ? ' locked' : ''}" style="--i:${Math.min(i, 14)}" data-i="${i}" ${e.available ? '' : 'disabled'}>
        <span class="thumb">${e.still ? `<img class="fade" loading="lazy" src="${esc(e.still)}" alt="" onload="this.classList.add('in')" onerror="this.remove()">` : ''}<span class="play">${I.play}</span>${e.position > 30 && !e.watched ? `<span class="bar"><b style="width:${pct(e.position, e.duration)}%"></b></span>` : ''}</span>
        <span class="etxt"><span class="en">${e.title ? `${e.episode ?? ''}${e.episode !== null ? '. ' : ''}${esc(e.title)}` : esc(e.label)}</span>
          <span class="es">${[e.title ? esc(e.label) : '', e.runtime ? e.runtime + ' min' : '', epState(e)].filter(Boolean).join(' · ')}</span>
          ${e.overview ? `<span class="eo">${esc(e.overview)}</span>` : ''}</span>
        <span class="eside">${e.locked ? `<span class="lock" aria-label="Watch ${esc(shortEp(e.after))} first" title="Watch ${esc(shortEp(e.after))} first">${I.lock}</span>` : ''}${e.watched ? `<span class="tick">${I.check} Watched</span>` : ''}${dlButton(e)}</span></button>`).join('')
      // A locked episode is not a dead end: it says which episode comes first, in one line, and stays where it is.
      $('#eps').querySelectorAll('.ep').forEach((b) => b.onclick = () => {
        const e = seasons.get(cur)[+b.dataset.i]
        if (e.locked) return flashNote(`Watch ${shortEp(e.after)} first`)
        go1(e)
      })
      $('#eps').querySelectorAll('.dlb').forEach((b) => {
        const act = (ev) => {
          ev.stopPropagation(); ev.preventDefault()
          const e = seasons.get(cur)[+b.closest('.ep').dataset.i], did = dl.idOf(id, e.season, e.label)
          if (saved.has(did) || dl.active.has(did)) return go('#/downloads')
          dl.start({ seriesId: +id, season: e.season, label: e.label, title: e.title, seriesName: series.name },
            () => api('/api/watch', { seriesId: +id, season: e.season ?? null, label: e.label }))
        }
        b.onclick = act; b.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') act(ev) }
      })
      paintSeason()
    }
    paint()
    const onDl = async () => { for (const m of await dl.list()) saved.add(m.id); if (alive) paint() }
    let alive = true
    // A page a person flicks past is not intent, and the catalogue is browsed by opening pages and leaving them, so the
    // first episode starts only once this show has actually been on screen for a while. The server fetches one episode
    // and only one, under the ordinary automatic-download limits; leaving the page cancels it before it is ever sent.
    const openTimer = hero && !hero.locked && !hero.watched
      ? setTimeout(() => { if (alive && !document.hidden) api('/api/opened', { seriesId: +id }).catch(() => {}) }, 10_000)
      : 0
    addEventListener('flix-dl', onDl)
    cleanup = () => { alive = false; gone = true; seasonRun++; clearTimeout(openTimer); removeEventListener('flix-dl', onDl) }
    app.querySelectorAll('.pill').forEach((p) => p.onclick = () => {
      cur = p.dataset.k === 'x' ? 'x' : +p.dataset.k
      app.querySelectorAll('.pill').forEach((x) => x.setAttribute('aria-selected', String(x === p)))
      paint()
    })
    const hp = $('#hp'); if (hp) hp.onclick = () => go1(hero)
    // A remote has nothing to point at on a page that has just drawn, so Play (else My List) is already highlighted: one
    // press of OK starts the show, and the first arrow press moves from somewhere real rather than from a guess.
    if (isTv && !document.activeElement?.closest?.('#app, main')) (hp || $('#ml'))?.focus({ preventScroll: true })
    const ml = $('#ml'); if (ml) ml.onclick = async () => {
      const on = ml.getAttribute('aria-pressed') !== 'true'
      try { await api('/api/mylist', { seriesId: +id, on }); ml.setAttribute('aria-pressed', String(on)); ml.textContent = on ? '✓ In My List' : '+ My List' } catch (e) { alert(e.message) }
    }
    const tu = $('#tu'), td = $('#td')
    const vote = async (b, v) => {
      const next = b.getAttribute('aria-pressed') === 'true' ? 0 : v // tapping the same thumb again takes it back
      try { await api('/api/vote', { seriesId: +id, vote: next }); tu.setAttribute('aria-pressed', String(next === 1)); td.setAttribute('aria-pressed', String(next === -1)) } catch (e) { alert(e.message) }
    }
    if (tu) tu.onclick = () => vote(tu, 1)
    if (td) td.onclick = () => vote(td, -1)
    const ids = series.trailerIds?.length ? series.trailerIds : series.trailerId ? [series.trailerId] : []
    const loadTrailer = async () => {
      const tr = $('#tr'); if (!tr || tr.querySelector('iframe') || tr.dataset.busy) return
      tr.dataset.busy = '1'
      // Loaded only on tap, so Flix never contacts YouTube until someone asks for the trailer.
      const search = `https://www.youtube.com/results?search_query=${encodeURIComponent(series.name + ' official trailer')}`
      const giveUp = () => { tr.innerHTML = `<div class="tr-fail">This trailer can’t be played here. <a href="${search}" target="_blank" rel="noopener noreferrer">Find it on YouTube</a></div>` }
      try {
        await ytApi()
        tr.innerHTML = '<div id="ytp"></div>'
        let n = 0, player
        // 1080p is a request, not an order: YouTube lowers it when the connection or the video can't do it.
        const hd = () => { try { player.setPlaybackQuality('hd1080') } catch { /* not offered */ } }
        const next = () => { if (++n < ids.length) player.loadVideoById({ videoId: ids[n], suggestedQuality: 'hd1080' }); else giveUp() } // private, removed or not embeddable: the next link
        player = new YT.Player('ytp', { videoId: ids[0], host: 'https://www.youtube-nocookie.com',
          playerVars: { autoplay: 1, rel: 0, playsinline: 1, vq: 'hd1080' },
          events: { onReady: hd, onStateChange: (e) => { if (e.data === 1) hd() }, onError: next } })
      } catch { // YouTube's player script is blocked: a plain embed of the first link
        tr.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(ids[0])}?autoplay=1&rel=0&playsinline=1&vq=hd1080" title="${esc(series.name)} trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
      }
    }
    const trb = $('#trb'); if (trb) trb.onclick = loadTrailer
    // Arrived here because a locked episode was asked for by its address: the reason the player turned it away belongs on
    // this page, once, where the episode it names is on screen.
    if (pendingSeriesNote) { const n = pendingSeriesNote; pendingSeriesNote = null; flashNote(n) }
  }
}

/* ---------- player ---------- */
/** Per-device preferences (volume, subtitle and audio language). Quietly does nothing when storage is blocked. */
const store = {
  get(k, d) { try { const v = localStorage.getItem('flix.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('flix.' + k, JSON.stringify(v)) } catch { /* private mode */ } },
}

/**
 * Say what the family needs to hear; the technical text is kept for the admin. "Isn't ready yet" is only ever said about
 * an episode that really is still on its way: it used to be the answer to every failure, the picture dropping on an
 * episode that had been on the disk for a week included, which sent people off to wait for something already there.
 */
function friendly(msg, onDisk = false) {
  if (/out of storage|low on storage/i.test(msg)) return 'The server is out of storage right now. Ask whoever runs Flix to free up some space.'
  if (/went wrong playing this/i.test(msg)) return 'This episode stopped playing. Try again and it carries on from where it stopped.'
  if (!onDisk && /nobody is sharing|no other source|timed out|seeders|metadata|swarm|not downloading/i.test(msg)) return 'This episode isn’t ready to play yet. Try again in a little while, or pick something else.'
  if (/ffmpeg|ffprobe|transcode|timed out|not downloading|did not answer|took too long|segment/i.test(msg)) return 'Flix couldn’t open this episode just now. Try again.'
  return msg
}

/** A short line that says why something did not happen, in place, and goes away by itself. One at a time. */
let noteTimer
function flashNote(text) {
  if (!text) return
  document.querySelector('.note-flash')?.remove()
  const el = document.createElement('div')
  el.className = 'note-flash'
  el.setAttribute('role', 'status')
  el.textContent = text
  document.body.appendChild(el)
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400) }, 2400)
}

let pendingSeriesNote = null

/**
 * Picture size. Saved per device: 'auto', 'orig', or a height (720, 480) the server converts to on the fly. Auto plays the
 * original and steps down a size when the picture keeps stalling (see watchQuality); the size it stepped to is kept while
 * the app stays open, so the next episode on the same slow connection does not start by stalling all over again.
 */
const qSetting = () => store.get('quality', 'auto')
let autoQuality = 0
const qAsk = () => { const s = qSetting(); return s === 'auto' ? autoQuality : s === 'orig' ? 0 : Number(s) || 0 }

/** "S01E03" reads as "E03" in a short note, the way it is said out loud; anything else is left alone. */
const shortEp = (label) => { const m = /^S\d+\s*E(\d+)/i.exec(String(label ?? '')); return m ? `E${m[1]}` : String(label ?? '') }
const ICON = {
  back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>',
  cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/><path d="M3 12a9 9 0 0 1 9 9M3 16a5 5 0 0 1 5 5M3 20h.01"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a.9.9 0 0 0 1.37.77l10.6-6.8a.9.9 0 0 0 0-1.54L9.37 4.43A.9.9 0 0 0 8 5.2Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.4" y="4.8" width="4" height="14.4" rx="1.5"/><rect x="13.6" y="4.8" width="4" height="14.4" rx="1.5"/></svg>',
  fill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3.5H3.5V9M15 3.5h5.5V9M9 20.5H3.5V15M15 20.5h5.5V15"/></svg>',
}

function playView(seriesId, season, label) {
  label = decodeURIComponent(label)
  return () => {
    app.innerHTML = `<div class="player" id="pl">
      <div class="p-top"><button class="icon-btn" id="pback" aria-label="Back">${I.back}</button>
        <span class="p-mark" aria-hidden="true">${I.logo}</span><span class="p-rate" id="prate" hidden></span>
        <div class="p-title"><b id="pt">${esc(label)}</b><span id="pe"></span></div><span class="sp"></span>
        <div class="p-menu"><button class="icon-btn" id="aud" aria-label="Audio language" aria-haspopup="true" hidden>${ICON.audio}</button></div>
        <button class="icon-btn" id="cast" aria-label="Play on a TV" hidden>${ICON.cast}</button>
        <button class="icon-btn p-report" id="rep" aria-label="Something’s wrong with this" title="Something’s wrong? Try another source" hidden>${ICON.flag}</button>
        <span class="chip" id="q" style="color:#fff;border-color:rgba(255,255,255,.3)" hidden></span></div>
      <div id="vw"></div>
        <div class="p-info" id="pinfo" hidden><div class="p-info-h"><b id="pit"></b><span class="p-info-rate" id="pir" hidden></span></div><p class="p-info-m" id="pim" hidden></p><p class="p-info-o" id="pio" hidden></p><div class="p-info-c" id="pic" hidden></div></div>
        <div class="p-spin" id="pspin" hidden aria-hidden="true"><i class="ring"></i></div>
        <div class="p-ctl" id="pctl">
          <div class="p-seek" id="pseek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="p-tip" id="ptip" hidden><i class="p-tipshot" id="ptipimg" aria-hidden="true"></i><b id="ptipt">0:00</b></div><div class="p-rail"><i class="p-have" id="phave"></i><i class="p-buf" id="pbuf"></i><i class="p-fill" id="pprog"></i><i class="p-dot" id="pdot"></i></div></div>
          <div class="p-row"><div class="p-l"><span class="p-time" id="ptime">0:00</span></div>
            <div class="p-c"><button class="p-btn" id="pbw" aria-label="Back 10 seconds">${ICON.back10}</button><button class="p-btn big" id="ppp" aria-label="Play">${ICON.play}</button><button class="p-btn" id="pfw" aria-label="Forward 10 seconds">${ICON.fwd10}</button></div>
            <div class="p-r"><span class="p-time" id="pdur">0:00</span>
              <div class="p-menu"><button class="p-btn cc" id="pq" aria-label="Quality" aria-haspopup="true" hidden></button></div>
              <div class="p-menu"><button class="p-btn cc" id="pcc" aria-label="Subtitles" aria-haspopup="true" hidden>CC</button></div>
              <button class="p-btn" id="pfull" aria-label="Fill the screen">${ICON.fill}</button></div></div>
        </div>
      <div class="p-wait" id="wait"><div class="mark" aria-hidden="true"><i class="aura"></i><i class="ripple"></i><i class="ripple r2"></i><span class="mark-lift">${I.logo.replace(/fxl-/g, 'fxp-')}<i class="sweep"></i><svg class="tracer" viewBox="0 0 112 112"><rect x="1" y="1" width="110" height="110" rx="26" ry="26" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" pathLength="100" stroke-dasharray="18 82"/></svg></span></div><div id="msg" role="status"></div><div class="p-now" id="pnow" hidden><div class="p-bar" id="pbar"><i id="pfill"></i></div><div class="p-eta"><span id="peta"></span><button class="p-more" id="pmore" type="button" aria-expanded="false" hidden>Details</button></div><div class="p-stats" id="pstats" hidden></div></div><button class="btn" id="cnc" hidden>Cancel</button></div></div>`
    flixSting()
    const INTRO_MS = 4000, introAt = Date.now()
    let holding = false, holdT = null
    top.hidden = true
    const pl = $('#pl')
    // After the rest of this view's declarations (fill, wake) exist, so paint() can read them.
    Promise.resolve().then(() => { wirePlayer(); loadMeta() })
    let alive = true, hls = null, timer = null, haveT = null, idleT = null, cdT = null, subT = null, v = null
    let meta = null
    let play = null, info = null, t0 = Date.now(), tries = 0, started = false, prefetched = false, lastSave = 0
    let fileRetry = false
    // A play that never starts on a file that is all here: asked again once (see attach).
    let stuckT = null, stuckRetried = false
    // An element whose source is taken away on purpose reports an error for it: that one is ours, not playback's.
    let ignoreError = false
    // While the TV has the show the phone must stay silent: no local player, no local play keys.
    let castingOnly = false
    const avoid = []
    // A television playing with nobody touching it: after the idle moment the picture gives way to the top shows'
    // artwork, panning right to left, one fading into the next -- the same slideshow the home screen idles into, but
    // started only by the player's own idle timer (manual mode), and any input at all brings the film back at once.
    let idleArt = null, artRun = 0
    // The list of shows is asked for as soon as the show is paused, so that 30 seconds later the artwork is already
    // on its way rather than only then starting a request.
    let homeP = null
    const warmArt = () => (homeP ??= api('/api/home').catch(() => { homeP = null; return null }))
    const startIdleArt = async () => {
      const run = ++artRun
      if (idleArt) { if (run === artRun) idleArt.start(); return }
      const home = await warmArt()
      if (!home || !alive || run !== artRun) return
      idleArt = artSlideshow([...(home.sections || []).flatMap((sec) => sec.series), ...(home.picked?.series ?? []), ...(home.myList ?? [])], { manual: true, parent: pl })
      if (run === artRun) idleArt?.start()
    }
    // The idle timer is for the show being stopped, not merely untouched: the artwork only belongs up while nothing is
    // playing (paused, or cast to the TV with the phone just the remote). The old check asked the opposite -- "is it
    // playing?" -- so the artwork slid over a show that was playing and had simply not been touched for three seconds.
    // `started` keeps it away during the loading screen, and paint() (which wakes while paused) keeps re-arming this
    // timer for as long as the show is stopped, so the artwork still arrives on a paused show left alone.
    const wake = () => { pl.classList.remove('idle'); artRun++; idleArt?.hide(); clearTimeout(idleT); idleT = setTimeout(() => { if (v && (v.paused || castingOnly)) { pl.classList.add('idle'); startIdleArt() } }, 30000); armQuiet() }
    // The bar goes away while the show plays: five seconds with no input and the top bar and the control bar fade out with
    // the cursor, and any pointer move, tap, key or remote press brings them straight back and starts the five again.
    // A class of its own -- NOT `idle`, whose timer arms the paused-state artwork slideshow: hiding the bar in the middle
    // of an episode must never start that.
    let quietT = null
    const menuOpen = () => !!pl.querySelector('.p-menu .menu:not(.out)')
    /** Nothing in the bar keeps the focus once it should be gone: the bar stays up for as long as something in it has the
        focus (so a remote can see what it is on), which used to leave it stuck on screen after a tap on CC or a pick from
        the captions list, until the viewer left the episode and came back. */
    const dropFocus = () => { const a = document.activeElement; if (a && a !== document.body && pl.contains(a)) a.blur() }
    const hideBar = () => { dropFocus(); pl.classList.add('p-quiet') }
    const armQuiet = () => {
      clearTimeout(quietT)
      pl.classList.remove('p-quiet')
      quietT = setTimeout(function fade() {
        if (!alive) return
        // Paused is a menu to read, and nothing fades before the picture has started: leave the bar where it is (play
        // arms this again). An open list is waited out rather than given up on: the old check simply stopped here, and
        // nothing armed it again once the list closed, so the bar stayed up over the episode.
        if (!v || v.paused || castingOnly || !started) return
        if (menuOpen()) { quietT = setTimeout(fade, 1500); return }
        hideBar()
      }, 5000)
    }
    /** A list in the bar (captions, audio) closes: the bar starts its five seconds again, and nothing in it keeps the focus
        on a touch screen, where a tapped button holds it and with it the whole bar. A remote is put back on the button that
        opened the list, so the next press goes somewhere visible. */
    const closePlayerMenu = (m, refocus) => {
      if (!m) return
      closeMenu(m)
      if (refocus && isTv) refocus.focus({ preventScroll: true }); else dropFocus()
      armQuiet()
    }
    /** Leave the player for the show's page. Replaced, not pushed: Back from the show must not reopen the episode, and an
        episode reached through "Up next" must not leave the one before it in the history for Back to start playing again. */
    const leavePlayer = () => {
      const show = `#/series/${seriesId}`
      // Came from this show's page: step back to it, so the history is just as it was before the episode opened (one
      // episode replaces the next through Up next, so this is the same step however many have played).
      if (playerOrigin === show && history.length > 1) history.back()
      else location.replace(show)
    }
    // Mouse movement wakes the bar. Touch must not: a tap fires touchstart, then click, and waking on one and toggling on the other made the bar flash.
    pl.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake() })
    // Touching the bar itself only restarts the hide timer.
    $('#pctl').addEventListener('pointerdown', wake)
    wake()
    // On a phone, play in landscape: fullscreen is what lets the browser lock the orientation. Needs a tap, so it is retried on the first one.
    const touchy = matchMedia('(pointer: coarse)').matches
    let landscape = false
    const goLandscape = async () => {
      if (!touchy || landscape) return
      try { if (!document.fullscreenElement) await pl.requestFullscreen?.({ navigationUI: 'hide' }) } catch { /* not allowed without a tap */ }
      try { await screen.orientation?.lock?.('landscape') } catch { /* unsupported (iOS) or refused */ }
      landscape = !!document.fullscreenElement // done once truly fullscreen; until then every tap tries again
    }
    goLandscape()
    pl.addEventListener('pointerup', goLandscape)

    // A list opened from the remote: the button opens it, then the focus is put on the entry already chosen (or the first),
    // because a d-pad cannot point at anything that is not focused.
    const openFromKey = (btn) => {
      if (!btn || btn.hidden) return false
      btn.click()
      const m = btn.parentElement.querySelector('.menu')
      const first = m?.querySelector('button[aria-current]') || m?.querySelector('button')
      first?.focus()
      return !!m
    }
    const key = (e) => {
      if (!v || castingOnly || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return
      const k = e.key
      // While the up-next box is up its two buttons are what a remote is pointed at, so left and right walk between them
      // instead of seeking the picture. Enter and OK already work, because the button has the focus.
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.target.closest?.('.p-next')) {
        e.preventDefault()
        const b = [...e.target.closest('.p-next').querySelectorAll('button')]
        const i = b.indexOf(e.target)
        if (b.length) b[(Math.max(0, i) + (k === 'ArrowRight' ? 1 : -1) + b.length) % b.length].focus()
        return
      }
      // A remote with a captions list open walks the list rather than seeking the picture underneath it. Enter picks the
      // focused entry on its own (it is a real button), and Escape or the back key closes the list again; left and right
      // still skip 10 seconds, which is what a viewer expects from them whatever has the focus.
      const open = pl.querySelector('.p-menu .menu')
      if (open && k !== 'Enter') {
        const items = [...open.querySelectorAll('button')]
        if (items.length && (k === 'ArrowDown' || k === 'ArrowUp')) {
          e.preventDefault()
          const i = items.indexOf(document.activeElement)
          const n = i < 0 ? (k === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))
          items[n].focus()
          wake()
          return
        }
        if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack') {
          e.preventDefault()
          closePlayerMenu(open, open.parentElement.querySelector('button'))
          return
        }
      }
      // The bar's buttons are walked with the arrow keys, like on any TV: up from the picture lands on play/pause, left and
      // right move along the row (back 10, play/pause, forward 10, quality, captions, fill), down returns to the picture.
      // Enter presses the highlighted button. With nothing highlighted, left and right still skip 10 seconds.
      const inBar = e.target.closest?.('#pctl .p-btn') && !e.target.closest('.menu')
      if (inBar && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        e.preventDefault()
        const b = [...pl.querySelectorAll('#pctl .p-btn')].filter((x) => !x.hidden && !x.closest('.menu'))
        const i = b.indexOf(e.target.closest('.p-btn'))
        const n = i + (k === 'ArrowRight' ? 1 : -1)
        if (n >= 0 && n < b.length) b[n].focus()
        wake()
        return
      }
      if (inBar && k === 'ArrowDown') { e.preventDefault(); e.target.blur(); wake(); return }
      if (k === 'ArrowUp' && !inBar && !e.target.closest?.('a, button')) { e.preventDefault(); $('#ppp')?.focus(); wake(); return }
      // TV remotes: OK (when no button has focus) and the play/pause, rewind and fast-forward keys work too.
      if (k === ' ' || k === 'k' || k === 'MediaPlayPause' || (k === 'Enter' && !e.target.closest?.('a, button'))) { e.preventDefault(); v.paused ? v.play() : v.pause() }
      else if (k === 'MediaPlay') { e.preventDefault(); v.play() }
      else if (k === 'MediaPause') { e.preventDefault(); v.pause() }
      // Held or pressed again and again, a skip key moves a marker along the bar with the picture for that moment over it,
      // and the picture itself jumps once, where the presses stop: one seek, not one per press.
      else if (k === 'MediaRewind' || k === 'ArrowLeft' || k === 'j') { e.preventDefault(); nudge(-10) }
      else if (k === 'MediaFastForward' || k === 'ArrowRight' || k === 'l') { e.preventDefault(); nudge(10) }
      else if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey && totalT()) { e.preventDefault(); setT(totalT() * Number(k) / 10) }
      else if (k === 'Home') { e.preventDefault(); setT(0) }
      else if (k === 'End') { e.preventDefault(); setT(Math.max(0, totalT() - 5)) }
      // The volume is the phone's or the television's own, from its buttons or its remote: Flix has no volume of its own.
      // On a television, up opens the captions list instead (up and down walk it once it is open, above).
      else if (k === 'z') setFill(!fill)
      else if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : pl.requestFullscreen?.()
      else if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack') { e.preventDefault(); return leavePlayer() }
      wake()
    }
    // Pinch out to fill the screen (the edges are cropped a little), pinch in to fit it again; Z does the same on a keyboard. Remembered on this device.
    // object-fit rather than a zoom, so the captions stay inside the screen.
    let fill = touchy ? false : store.get('fill', false), pinch = null // phones always open fitted (nothing cropped); the button or a pinch zooms to fill
    const setFill = (on) => { fill = on; if (!touchy) store.set('fill', on); if (v) v.style.objectFit = on ? 'cover' : '' }
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    pl.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: spread(e.touches), done: false } }, { passive: true, capture: true })
    pl.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault() // not the page's own pinch-zoom
      const k = spread(e.touches) / pinch.d
      if (!pinch.done && (k > 1.15 || k < 0.87)) { pinch.done = true; setFill(k > 1) }
    }, { passive: false, capture: true })
    pl.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null }, { passive: true, capture: true })
    /* ---- Flix's own player bar: the native <video controls> let the TV's WebView draw its own bar, with the scrubber off centre and no room for a caption menu ---- */
    const fmtT = (s) => {
      s = Math.max(0, Math.floor(Number(s) || 0))
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
      return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0')
    }
    // While the TV has the show, the phone is only its remote: the bar shows and drives the TV's player (see enterCastMode).
    let rem = null, haveFrac = 0
    const remoteOn = () => castingOnly && !!rem
    // A playlist's own length can be only the part made so far (a copy still being remuxed as it downloads), so the
    // episode's length as the server probed it wins there: the bar is the whole episode, and half of it is half of it.
    const totalT = () => (remoteOn() && rem.p.duration > 0 ? rem.p.duration
      : info?.mode === 'hls' && Number(info?.duration) > 0 ? Number(info.duration)
      : v && isFinite(v.duration) && v.duration > 0 ? v.duration : Number(info?.duration) || 0)
    const nowT = () => (remoteOn() ? rem.p.currentTime || 0 : v?.currentTime || 0)
    // The viewer moved the picture on purpose: from here on its position is theirs, resume point or not (see report()).
    let userSeeked = false
    const setT = (t) => {
      t = Math.max(0, Math.min(totalT() || 1e9, t))
      userSeeked = true
      if (remoteOn()) { rem.p.currentTime = t; rem.c.seek() } else if (v) v.currentTime = t
    }
    // Skip presses not yet sent to the picture (see wirePlayer, where the picture over the bar is drawn for them).
    let pendingT = null
    let nudge = (d) => setT(nowT() + d)
    function syncBar() {
      // While a finger is down the bar shows where the finger is, not where the film is: without this the timeupdate tick
      // would drag the bar back to the playback position under the finger four times a second. The same while skip
      // presses are being gathered.
      if ($('#pseek')?.classList.contains('on') || pendingT != null) return
      const d = totalT(), t = nowT(), pct = d ? Math.min(100, (t / d) * 100) : 0
      if (!$('#pprog')) return
      $('#pprog').style.width = pct + '%'; $('#pdot').style.left = pct + '%'
      $('#ptime').textContent = fmtT(t); $('#pdur').textContent = fmtT(d)
      $('#pseek').setAttribute('aria-valuenow', String(Math.round(pct)))
      // The range the playhead is in, not the last one: after a seek the last range is somewhere else entirely.
      try {
        const b = remoteOn() ? null : v?.buffered
        if (b?.length && d) { let end = t; for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= end) end = b.end(i); $('#pbuf').style.width = Math.min(100, (end / d) * 100) + '%' }
      } catch { /* nothing buffered yet */ }
      // How much of the file is on the box. A finished episode has all of it, so the whole bar is open to seek in.
      $('#phave').style.width = Math.round(haveFrac * 1000) / 10 + '%'
      pl.classList.toggle('whole', haveFrac >= 1)
    }
    /** Playing or paused: which button to show, and whether the pause panel and the dimmed frame are up. */
    function paint() {
      const paused = remoteOn() ? rem.p.isPaused : (!v || v.paused) && !holding
      pl.classList.toggle('paused', paused && !castingOnly) // the paused art would sit under the "playing on the TV" card
      pl.classList.toggle('casting', castingOnly)
      $('#ppp').innerHTML = paused ? ICON.play : ICON.pause
      $('#ppp').setAttribute('aria-label', paused ? 'Play' : 'Pause')
      $('#pfull').setAttribute('aria-pressed', String(fill))
      if (paused || castingOnly) { wake(); if (bigScreen()) warmArt() }
      fillPause()
      syncBar()
    }
    /** What you are watching, centre-left over the dimmed frame while paused: the episode's title with its age
        rating beside it, the episode's own description under that, then the cast. Only once playback has really
        started -- the loading screen and the cast handshake must never show it. */
    function fillPause() {
      const card = $('#pinfo')
      if (!card) return
      const paused = remoteOn() ? rem.p.isPaused : (!v || v.paused) && !holding
      const show = paused && !castingOnly && started
      card.hidden = !show
      if (!show) return
      const s = meta?.series
      const head = play?.episodeTitle ? `${play.title} · ${play.episodeTitle}` : (play?.seriesName || play?.title || '')
      if ($('#pit').textContent !== head) $('#pit').textContent = head
      const rate = s?.rating && s.rating !== 'Unrated' ? s.rating : ''
      const r = $('#pir'); r.hidden = !rate; r.textContent = rate
      const ep = meta?.episodes?.find((e) => e.label === play?.title && e.season === (season === 'x' ? null : +season))
      const desc = ep?.overview || s?.overview || ''
      $('#pio').textContent = desc; $('#pio').hidden = !desc
      // Score, year and genres, then how long is left and when it would finish if resumed now.
      const left = totalT() - nowT()
      const bits = [s?.score ? `★ ${s.score.toFixed(1)}` : '', s?.year || '', (s?.genres ?? []).slice(0, 3).join(' · '),
        left > 30 ? `${Math.round(left / 60)} min left · ends ${new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''].filter(Boolean)
      $('#pim').textContent = bits.join('  ·  '); $('#pim').hidden = !bits.length
      const cast = (s?.cast ?? []).filter((c) => c.photo).slice(0, 8)
      $('#pic').innerHTML = cast.map((c) => `<span class="p-cast"><img src="${c.photo}" alt="" loading="lazy" onerror="this.closest('.p-cast').style.display='none'"><b>${esc(c.name)}</b>${c.role ? `<em>${esc(c.role)}</em>` : ''}</span>`).join('')
      $('#pic').hidden = !cast.length
    }
    function wirePlayer() {
      const bar = $('#pseek')
      // The picture above the bar is one tile of a sheet the server cut in the background once the download finished
      // (/api/stream/<t>/<f>/sprite); the geometry in its metadata is the same arithmetic as src/sprites.ts. Nothing is
      // generated while somebody scrubs -- cropping a still that is already on disk costs one image and no requests,
      // which is what the old per-second ffmpeg cut got wrong. No sheet (still downloading, or the cut not finished yet)
      // means the bar on its own, with no picture and nothing moving.
      const tip = $('#ptip'), tipShot = $('#ptipimg'), tipLab = $('#ptipt')
      let shot = null, shotFor = '', shotAsked = false, tipHide = 0
      // The sheet's tiles are 160 px wide; the preview is drawn bigger than that (up to 400 px, a fifth of a wide screen),
      // with the sheet scaled to match.
      const tipW = () => Math.round(Math.max(240, Math.min(400, innerWidth * 0.22, (bar.clientWidth || 300) - 8)))
      async function loadSheet(forWhat) {
        if (!play) return
        const m = await api(`/api/stream/${play.torrentId}/${play.fileIndex}/sprite/meta`).catch(() => null)
        // Not cut yet (the file finished a moment ago, and the sheet is made in the background): ask again in a minute
        // rather than never again for the rest of the episode.
        if (!m || !m.cols || !m.tileW) { setTimeout(() => { if (shotFor === forWhat && !shot) shotAsked = false }, 60_000); return }
        if (!alive || forWhat !== `${play.torrentId}:${play.fileIndex}`) return
        shot = m
        tipShot.style.backgroundImage = `url("/api/stream/${play.torrentId}/${play.fileIndex}/sprite")`
        tipShot.classList.add('has')
      }
      function hideTip() { clearTimeout(tipHide); tip.hidden = true }
      function showTip(t, hold) {
        const d = totalT()
        if (!d || !play) return
        // A new source is a new file, so a sheet belonging to the old one is dropped rather than shown over it.
        const forWhat = `${play.torrentId}:${play.fileIndex}`
        if (shotFor !== forWhat) {
          shotFor = forWhat; shot = null; shotAsked = false
          tipShot.classList.remove('has'); tipShot.style.backgroundImage = ''
        }
        if (!shot && !shotAsked) { shotAsked = true; void loadSheet(forWhat) }
        const pct = Math.max(0, Math.min(100, (t / d) * 100))
        // Kept inside the bar's own width, so the picture never hangs off the edge of a narrow screen.
        const w = bar.clientWidth || 1
        const half = Math.min(tipW() / 2 + 4, w / 2)
        tip.style.left = Math.max(half, Math.min(w - half, (pct / 100) * w)) + 'px'
        tip.hidden = false
        tipLab.textContent = fmtT(Math.max(0, t))
        clearTimeout(tipHide)
        if (hold) tipHide = setTimeout(hideTip, 1600)
        if (!shot) return
        const i = Math.max(0, Math.min(shot.count - 1, Math.floor(Math.max(0, t) / Math.max(0.5, shot.interval))))
        // The element is exactly one tile, so the sheet is laid out at its full size and shifted to the tile asked for.
        const k = tipW() / shot.tileW
        tipShot.style.width = tipW() + 'px'
        tipShot.style.backgroundSize = `${shot.cols * shot.tileW * k}px ${shot.rows * shot.tileH * k}px`
        tipShot.style.backgroundPosition = `${-((i % shot.cols) * shot.tileW * k)}px ${-(Math.floor(i / shot.cols) * shot.tileH * k)}px`
      }
      // Dragging paints the bar and the picture over it. A source that is all here (a finished file, or its single-file
      // copy) also moves the picture itself as the finger goes -- one seek at a time, the next only once the last has
      // landed, so a drag is never a hundred seeks in flight each interrupting the last. A playlist does not: every jump
      // there is a piece fetched (and, for a converted picture, made), so it gets the picture over the bar and one seek
      // where the finger lets go.
      let dragT = 0, liveAt = 0
      const liveSeek = (t) => {
        if (!v || remoteOn() || v.seeking || Date.now() - liveAt < 120) return
        if (!(info?.mode === 'file' || (info?.mode === 'direct' && haveFrac >= 1))) return
        liveAt = Date.now()
        if (typeof v.fastSeek === 'function') v.fastSeek(t); else v.currentTime = t
      }
      const at = (e) => {
        const d = totalT() || 0, r = bar.getBoundingClientRect()
        return Math.min(Math.max(0, d - 0.4), ((e.clientX - r.left) / Math.max(1, r.width)) * d)
      }
      const paintDrag = () => {
        const d = totalT(); if (!d || !$('#pprog')) return
        const pct = Math.max(0, Math.min(100, (dragT / d) * 100))
        $('#pprog').style.width = pct + '%'; $('#pdot').style.left = pct + '%'
        $('#ptime').textContent = fmtT(dragT)
        bar.setAttribute('aria-valuenow', String(Math.round(pct)))
      }
      const onMove = (e) => { dragT = at(e); showTip(dragT); paintDrag(); if (bar.classList.contains('on')) liveSeek(dragT) }
      const endDrag = (commit) => {
        const was = bar.classList.contains('on')
        bar.classList.remove('on')
        if (was && commit) { setT(dragT); syncBar() }
        hideTip()
      }
      bar.addEventListener('pointerdown', (e) => {
        if (!v && !remoteOn()) return
        e.preventDefault(); bar.classList.add('on')
        try { bar.setPointerCapture(e.pointerId) } catch { /* older webview */ }
        onMove(e)
      })
      bar.addEventListener('pointermove', (e) => {
        if (bar.classList.contains('on')) return onMove(e)
        // Hovering with a mouse shows where a click would land, and its picture, as a scrubber on a desktop does.
        if (e.pointerType === 'mouse' && (v || remoteOn())) showTip(at(e))
      })
      bar.addEventListener('pointerleave', () => { if (!bar.classList.contains('on')) hideTip() })
      bar.addEventListener('pointerup', () => endDrag(true))
      bar.addEventListener('pointercancel', () => endDrag(false))
      // Skips gathered while the presses keep coming: the marker and the picture over the bar move at once, and the seek is
      // made 450 ms after the last press. A remote held on right walks the bar like a scrubber instead of firing a seek
      // (and, on a playlist, a fetch) for every repeat.
      let nudgeT = 0
      nudge = (d) => {
        if (!v && !remoteOn()) return
        const d0 = totalT() || 1e9
        pendingT = Math.max(0, Math.min(d0 - 0.4, (pendingT ?? nowT()) + d))
        dragT = pendingT
        paintDrag()
        showTip(pendingT, true)
        clearTimeout(nudgeT)
        nudgeT = setTimeout(() => { const t = pendingT; pendingT = null; if (t != null) setT(t); syncBar() }, 450)
      }
      bar.addEventListener('keydown', (e) => {
        if ((!v && !remoteOn()) || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault(); e.stopPropagation() // the window handler would move the same skip twice
        nudge(e.key === 'ArrowRight' ? 15 : -15)
        wake()
      })
      $('#ppp').onclick = () => { if (remoteOn()) rem.c.playOrPause(); else if (v && !castingOnly) { if (v.paused) v.play().catch(() => {}); else v.pause() }; wake() }
      $('#pbw').onclick = () => { nudge(-10); wake() }
      $('#pfw').onclick = () => { nudge(10); wake() }
      $('#pfull').onclick = () => { setFill(!fill); paint() }
      $('#pback').onclick = leavePlayer
      // A tap on the picture shows or hides the bar, as every other player does. While paused it only brings it back.
      // Hiding takes the focus off whatever was last tapped in the bar: a focused button keeps the bar on screen.
      $('#vw').addEventListener('click', () => { if (!v) return; if (v.paused) return wake(); if (pl.classList.contains('p-quiet') || menuOpen()) wake(); else { armQuiet(); hideBar() } })
      paint()
    }
    /** The certificate beside the title in the top bar -- and the same answer feeds the pause card: the show's
        overview and cast come back with the rating, so pausing needs no second call. The rating lives on the
        `series` object this endpoint returns, not on the envelope. */
    async function loadMeta() {
      const s = await api(`/api/series/${seriesId}`).catch(() => null)
      if (!s || !alive) return
      const el = $('#prate'), rate = s.series?.rating && s.series.rating !== 'Unrated' ? s.series.rating : ''
      if (el) { el.hidden = !rate; el.textContent = rate }
      meta = s
      fillPause()
    }
    addEventListener('keydown', key)
    // The app was in the background and has been brought back to the front. Android keeps the page exactly as it was, and
    // a source that stopped while it was away -- a TV link whose token ran out, a socket that dropped, the decoder released
    // with the surface -- stays stopped: nothing in here ever asked for it again, so the only way back was force-closing
    // the app. If the picture is in an error state, or has a source and no data at all, ask /info again and carry on from
    // where the viewer was. A fresh answer also carries a fresh link.
    const revive = () => {
      if (!alive || !v || !info || castingOnly) return
      if (!v.error && !(v.currentSrc && v.readyState === 0 && !v.paused)) return
      fileRetry = false
      loadInfo(info.audioIndex ?? 0, v.currentTime || 0).catch((e) => fail(e.message))
    }
    // Named, so leaving the player really removes it: the old arrow function could never be taken off again, and every
    // episode ever opened left one more listener behind.
    const onVisible = () => { if (!document.hidden) revive() }
    addEventListener('visibilitychange', onVisible)
    /**
     * Let go of the picture for good. Taking a <video> off the page does NOT stop it: it keeps its decoder and its open
     * request to the server until the browser gets round to collecting it, and an Android WebView has only a handful of
     * each. A few episodes opened and left that way and the next one would not play at all -- its request queued behind
     * the dead ones, or no decoder left to give it -- until the app was force-closed, which is what freed them. Emptying
     * the source and calling load() releases both at once.
     */
    const releaseVideo = (el) => {
      if (!el) return
      ignoreError = true
      try { el.pause(); el.querySelectorAll('track').forEach((t) => t.remove()); el.removeAttribute('src'); el.load() } catch { /* already gone */ }
    }
    cleanup = () => {
      // Where the viewer stopped, written now rather than at the next ten-second tick that will never come. Left in the
      // credits, the episode is finished, and the show moves on to the next one.
      if (v && play && !castingOnly && canReport()) report(creditAt != null && v.currentTime >= creditAt)
      alive = false; removeEventListener('visibilitychange', onVisible); if (play && info?.mode === 'hls') fetch(`/api/stream/${play.torrentId}/${play.fileIndex}/stop`, { method: 'POST', keepalive: true }).catch(() => {}); clearInterval(timer); clearInterval(haveT); clearInterval(cdT); clearInterval(subT); clearTimeout(idleT); clearTimeout(quietT); clearTimeout(holdT); clearTimeout(stuckT); idleArt?.stop(); stopOff?.(); hls?.destroy(); hls = null; releaseVideo(v); removeEventListener('keydown', key); top.hidden = !me; try { screen.orientation?.unlock?.() } catch { /* unsupported */ } if (document.fullscreenElement) document.exitFullscreen?.()
      if (window.__flixBack === onBack) window.__flixBack = null
    }
    /** Android's Back button (see MainActivity): an open list closes first; otherwise Back leaves for the show's page. */
    const onBack = () => {
      const open = pl.querySelector('.p-menu .menu:not(.out)')
      if (open) { closePlayerMenu(open, open.parentElement.querySelector('button')); return true }
      leavePlayer()
      return true
    }
    window.__flixBack = onBack

    function fail(msg) {
      if (!alive) return
      api('/api/report', { torrentId: play?.torrentId, seriesId: +seriesId, label, kind: 'auto', message: msg }).catch(() => {})
      clearInterval(timer); clearInterval(subT); hls?.destroy(); hls = null
      $('.mark')?.remove(); $('#wait').classList.remove('gone')
      const said = friendly(msg, haveFrac >= 1)
      $('#msg').innerHTML = `<div style="max-width:34ch;line-height:1.5">${esc(said)}</div>${me?.is_admin && said !== msg ? `<div class="dim" style="font-size:12px;margin-top:8px;color:rgba(255,255,255,.55)">${esc(msg)}</div>` : ''}
        <div style="display:flex;gap:10px;justify-content:center;margin-top:18px"><button class="btn primary" id="again">Try again</button><button class="btn" id="fback">Back</button></div>`
      $('#again').onclick = () => route()
      $('#fback').onclick = leavePlayer
      $('#again').focus({ preventScroll: true })
    }

    const sendReport = (kind, message) => api('/api/report', { torrentId: play?.torrentId, seriesId: +seriesId, label, kind, message }).catch(() => {})

    /** Drop a source that is not delivering and ask for the next-best one, without the viewer noticing more than a longer wait. */
    function switchSource(why = 'No data arrived, so another source was tried') {
      sendReport('auto', why)
      report()
      avoid.push(play.torrentId); tries++; started = false
      clearInterval(timer); clearInterval(subT); clearTimeout(stuckT); hls?.destroy(); hls = null; if (v) { releaseVideo(v); v.remove(); v = null }
      // A new source is a new file, so the box goes and its countdown with it: leaving the interval running would send the
      // viewer to the next episode while the episode they are watching is still being fetched.
      clearInterval(cdT); upNextBox = null
      $('.p-next')?.remove()
      $('#wait').classList.remove('gone'); $('#msg').textContent = 'Finding a faster source…'
      t0 = Date.now(); begin()
    }
    $('#rep').onclick = () => {
      if (tries >= 3) { sendReport('manual', 'Reported with no other source left'); $('#rep').hidden = true; return }
      sendReport('manual', 'Viewer tapped Something’s wrong'); switchSource('Viewer tapped Something’s wrong')
    }

    /**
     * The file is not on disk yet, so the screen would otherwise be black and silent. Say what is actually happening --
     * how much of THIS file, how fast, from how many people, and how long that leaves -- and keep waiting. After 20 s
     * with nothing playable it says so in plain words and offers a way out, rather than giving up on its own: a slow
     * 2021 season pack with two seeders is not a failure, it is a wait.
     */
    let msgNow = '', detOpen = false
    // A wait said the way a person says it: no seconds counted out, no bitrates, nothing that sounds like a torrent client.
    function niceLeft(ms) {
      const s = Math.round(ms / 1000)
      if (s < 50) return 'Almost ready'
      if (s < 95) return 'About a minute to go'
      const m = Math.round(s / 60)
      if (m < 55) return `About ${m} minutes to go`
      const h = Math.floor(m / 60), r = m % 60
      return r >= 5 ? `About ${h} hour${h > 1 ? 's' : ''} ${r} minutes to go` : `About ${h} hour${h > 1 ? 's' : ''} to go`
    }
    // The same numbers Settings shows, one tap away. They are the only way to tell a slow wait from a stuck one, so they are
    // never thrown away -- they are just not what plays on the television in the front room.
    $('#pmore').onclick = () => {
      detOpen = !detOpen
      $('#pmore').setAttribute('aria-expanded', String(detOpen))
      $('#pmore').textContent = detOpen ? 'Hide details' : 'Details'
      $('#pstats').hidden = !detOpen
    }
    function showWaiting(s, waited) {
      const frac = Math.max(0, Math.min(1, s.fileProgress ?? 0)), pct = Math.round(frac * 100)
      const left = s.dlspeed > 0 ? (1 - frac) * (s.size ?? 0) / s.dlspeed : 0
      // What the viewer reads: what is happening, then how long. A bar frozen at nothing reads as broken, so until bytes
      // arrive it drifts instead of sitting still.
      let head
      if (frac >= 1) head = 'Ready — opening it now'
      else if (pct >= 92) head = 'Almost there'
      else if (frac === 0 && waited > 20000) head = 'Still finding this one — fewer people are sharing it, so it is slower than usual'
      else if (frac === 0 && waited > 6000) head = 'Looking for a source'
      else head = 'Getting your episode ready'
      if (head !== msgNow) { $('#msg').textContent = head; msgNow = head }
      $('#pnow').hidden = false
      $('#pbar').classList.toggle('wait', frac <= 0)
      $('#pfill').style.width = pct + '%'
      $('#peta').textContent = frac >= 1 ? '' : left > 0 ? niceLeft(left) : frac > 0 ? 'Just a moment' : ''
      $('#pmore').hidden = frac >= 1
      const stats = [`${pct}%`]
      if (s.dlspeed > 0) stats.push(mbps(s.dlspeed))
      stats.push(s.seeds > 0 ? `${s.seeds} ${s.seeds === 1 ? 'person' : 'people'} sharing it` : 'nobody sharing it right now')
      $('#pstats').textContent = stats.join(' · ')
      $('#pstats').hidden = !detOpen
      $('#cnc').hidden = waited < 20000
    }
    // Leaving while it downloads is allowed and is not a fault: the download carries on and the episode is here next time.
    $('#cnc').onclick = () => { clearInterval(timer); leavePlayer() }

    async function begin() {
      try {
        play = await api('/api/watch', { seriesId: +seriesId, season: season === 'x' ? null : +season, label, avoid, play: true })
        if (!alive) return
        $('#pt').textContent = play.seriesName || label; $('#pe').textContent = label + (play.episodeTitle ? ' · ' + play.episodeTitle : '')
        $('#rep').hidden = false
        const qc = $('#q'); qc.textContent = play.quality; qc.hidden = false
        const base = `/api/stream/${play.torrentId}/${play.fileIndex}`
        // The wait screen's numbers, once a second until the picture starts -- and then no more: this used to keep asking
        // every second for the whole episode, a request (and a call into qBittorrent) a second spent on a screen nobody
        // could see any more.
        timer = setInterval(async () => {
          if (started) { clearInterval(timer); return }
          const s = await api(base + '/status').catch(() => null)
          if (!alive || !s || s.error || started) return
          showWaiting(s, Date.now() - t0)
        }, 1000)
        await loadInfo(0, play.position)
      } catch (e) {
        // The order rule refused this episode: go to the show with the one line that says which episode comes first, rather
        // than leaving a dead player behind. A direct #/play address ends up here too.
        if (e.gated) { pendingSeriesNote = e.message; go(`#/series/${seriesId}`); return }
        fail(e.message)
      }
    }

    async function loadInfo(a, startAt) {
      const base = `/api/stream/${play.torrentId}/${play.fileIndex}`
      const q = [a ? 'a=' + a : '', qAsk() ? 'q=' + qAsk() : '', 'cv=' + CAN_PLAY.join(',')].filter(Boolean).join('&')
      info = await api(`${base}/info${q ? '?' + q : ''}`)
      if (!alive) return
      // A saved audio-language choice (on this device) wins over the file's default track.
      if (!a) {
        const want = store.get('audio', null)
        const i = want ? info.audio.findIndex((t) => t.lang === want) : -1
        if (i > 0 && info.audio[0].lang !== want) return loadInfo(i, startAt)
      }
      // A TV that is already connected gets the episode: casting stays on until it is stopped, so every
      // show tapped from now on follows it there.
      if (!casting.connected && info.castUrl) await Promise.race([loadCastSdk().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]) // a TV from earlier is only known once the SDK has rejoined it
      if (!alive) return
      if (casting.connected && info.castUrl) return castInstead(startAt)
      attach(startAt)
      wireSubs(); wireSubMenu(); wireAudio(); wireQuality(); wireExtras()
    }

    function attach(startAt) {
      if (castingOnly) return // the TV has it; nothing plays here
      hls?.destroy(); hls = null
      if (!v) {
        $('#vw').innerHTML = '<video autoplay playsinline></video>'
        v = $('video')
        if (fill) v.style.objectFit = 'cover'
        // Flix has no volume of its own: the phone's buttons and the television's remote are the volume. Full and unmuted
        // always, which also undoes a level an older version saved on this device (a muted episode reads as broken).
        v.volume = 1; v.muted = false
        v.addEventListener('playing', () => {
          started = true
          startedAt = Date.now()
          clearTimeout(stuckT)
          // The picture waits on its first frame behind the logo; the show starts at the moment the logo begins to fade (4 seconds after opening).
          const left = INTRO_MS - (Date.now() - introAt)
          const reveal = () => { holding = false; if (castingOnly) return; $('#wait').classList.add('gone'); v.play().catch(() => {}); wake() }
          if (left > 0 && !castingOnly) { holding = true; v.pause(); holdT = setTimeout(reveal, left) } else reveal()
        }, { once: true })
        // A play that gets going clears the one-retry latch, so a later failure on the same episode is not swallowed: the
        // retry above was only ever allowed once, for the life of the element.
        v.addEventListener('playing', () => { fileRetry = false })
        watchQuality(v)
        for (const ev of ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'canplay']) v.addEventListener(ev, syncBar)
        for (const ev of ['play', 'pause', 'volumechange', 'waiting']) v.addEventListener(ev, paint)
        // A seek into a part of the file that has not arrived yet leaves the picture frozen with nothing to say why. The ring
        // is shown while the element is waiting for data (and not before the first frame, where the loading mark is up).
        const spin = (on) => { const el = $('#pspin'); if (el) el.hidden = !(on && started) }
        for (const ev of ['waiting', 'seeking']) v.addEventListener(ev, () => spin(v.readyState < 3))
        for (const ev of ['playing', 'seeked', 'canplay', 'pause', 'emptied']) v.addEventListener(ev, () => spin(false))
        const haveStatus = async () => {
          const st = await api(`/api/stream/${play.torrentId}/${play.fileIndex}/status`).catch(() => null)
          if (!alive || !st || st.error) return
          haveFrac = Math.max(haveFrac, Math.min(1, Number(st.fileProgress) || 0))
          syncBar()
          if (haveFrac >= 1) { clearInterval(haveT); haveT = null }
        }
        haveT = setInterval(haveStatus, 4000); haveStatus()
        // What the player itself felt: a stall, a seek, a picture that dropped to a lower resolution. The server only sees its
        // side of a gap, and the two timestamps together say which end was slow.
        watchStalls(v, () => play)
        // The picture coming back must always take the artwork with it: paint() runs on play and pause and wakes while
        // paused, but a play event that finds no pause in between (a resume after a stall, a source swap) would
        // otherwise leave the artwork sitting over a show that is playing again.
        v.addEventListener('play', () => { artRun++; idleArt?.hide(); pl.classList.remove('idle'); armQuiet() })
        v.ontimeupdate = () => {
          // The logo comes down when the first frame is revealed, but that happens once per element. If anything put it
          // back up since (a hand-over from the TV, a source swap) and the picture is now plainly playing, take it down.
          if (started && !holding && !castingOnly && !v.paused && v.currentTime > 0.5) $('#wait')?.classList.add('gone')
          if (Date.now() - lastSave > 10000) { lastSave = Date.now(); report() }
          // Is this the credits? Reading a chapter list once a second is enough -- timeupdate fires four times a second on a
          // desktop and the moment is a whole minute wide, so this is answered on a throttle rather than on every tick.
          const now = Date.now()
          if (now - creditChecked > 1000) {
            creditChecked = now
            const m = creditMoment(info, v)
            // Again whenever the answer could have changed: a runtime that has only just become known, one that moved, or a
            // better source (a measured marker arriving where the estimate stood in). Otherwise it is kept.
            if (m.at != null && (creditAt == null || Math.abs(m.dur - creditDur) > 1 || CREDIT_RANK[m.from] > CREDIT_RANK[creditFrom])) {
              creditAt = m.at; creditDur = m.dur; creditFrom = m.from
            }
            if (creditAt != null && v.currentTime >= creditAt) showUpNext()
          }
          const dur = knownDuration(info, v)
          if (!prefetched && dur && v.currentTime / dur >= 0.6) {
            prefetched = true // watched past 60%: line up the next episode, so "Up next" is instant
            api('/api/prefetch', { seriesId: +seriesId, season: season === 'x' ? null : +season, label }).catch(() => {})
          }
        }
        v.onpause = report
        v.onended = onEnded
        // Attached once, for the whole player, and it must be able to fire more than once. Nothing else listens for an
        // error on the <video>, so any play the server refuses or the device drops (a 409 while the repack is still being
        // written, a 404, a 5xx, a TV link whose token ran out, a socket that went nowhere) gets one more ask of /info --
        // by then the repack has finished or been given up on, and the ask carries a fresh link -- and plays that instead.
        // With { once: true } a second failure called nothing at all and left a black screen with the loading mark turning
        // over for ever. A play that gets going clears the latch again, so a later failure retries too. The error the
        // unload below causes on purpose is skipped; attach() clears that again as soon as a source is set.
        v.addEventListener('error', () => {
          if (!alive) return
          if (ignoreError) { ignoreError = false; return }
          if (!v.currentSrc && !v.getAttribute('src') && !v.srcObject) return // no source at all is not playback going wrong
          if (!fileRetry) {
            fileRetry = true
            $('#msg').textContent = 'Trying that again…'
            const at = v.currentTime || 0 // read first: emptying the element puts it back at zero
            v.removeAttribute('src')
            ignoreError = true
            try { v.load() } catch { /* nothing to unload */ }
            loadInfo(info.audioIndex ?? 0, at).catch((e) => fail(e.message))
            return
          }
          fail('Something went wrong playing this. Go back and try again.')
        })
      }
      const viaHls = info.mode === 'hls' && window.Hls?.isSupported()
      // HDR: the source's HEVC stream copied through untouched looks better than any downconvert to 8-bit, but only
      // a device that decodes HEVC main10 in MP4 can show it. Ask the browser, and fall back to the 1080p HLS cut.
      let canHdr = !!(info.hdrUrl && !info.useHdrOff && window.MediaSource && ['hvc1.2.4.L153.B0', 'hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0', 'hvc1.1.6.L150.B0']
        .some((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)))
      info.useHdr = canHdr
      // Casting needs a link the TV can open on its own (no cookie), so plain playback uses the signed one where the browser can cast.
      const src = canHdr ? info.hdrUrl : info.url
      // A single-file ("file") play is the page's own origin, so a TV's WebView already carries the session cookie the
      // signed path in a cast link stands in for: it gets the same URL as everyone else.
      const url = viaHls || info.mode === 'file' ? src : 'remote' in v ? (canHdr ? info.hdrTvUrl : info.tvUrl) : src
      ignoreError = false // a source is about to be set: from here on an error is a real one
      resumeAt = startAt > 5 ? startAt : 0
      if (viaHls) {
        // startPosition: open straight at the resume point instead of loading the first piece and jumping.
        // No CEA-608 captions from inside the picture: they arrived as a second, unlabelled captions track of their own,
        // which is how the CC list ended up with two entries ticked at once.
        hls = new Hls({ maxBufferLength: 90, backBufferLength: 60, startFragPrefetch: true, enableCEA708Captions: false, renderTextTracksNatively: true, ...(startAt > 5 ? { startPosition: startAt } : {}) })
        hls.loadSource(url); hls.attachMedia(v)
        let mediaFixes = 0
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return
          // A dropped request or a decoder hiccup is not the end of the episode: hls.js can pick up from both, which is
          // what it is asked to do (twice) before anything is said to the viewer.
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR && mediaFixes < 2) { mediaFixes++; hls.startLoad(); return }
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaFixes < 2) { mediaFixes++; hls.recoverMediaError(); return }
          hls?.destroy(); hls = null
          // An HDR copy the device cannot decode (or a source that turned out not to be HDR) drops back to the 1080p cut rather than failing.
          if (canHdr) { info.useHdrOff = true; canHdr = false; attach(v.currentTime || startAt) } else fail('Something went wrong playing this. Go back and try again.')
        })
      } else v.src = url
      if (startAt > 5 && !(viaHls)) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt }, { once: true })
      v.play?.().catch(() => {})
      // A finished file that has not started playing half a minute after it was handed over is stuck, not slow: nothing
      // is being waited for. Ask /info once more (a fresh link, and the box's fresh view of the file) and play that.
      clearTimeout(stuckT)
      stuckT = setTimeout(() => {
        if (!alive || started || castingOnly || stuckRetried || !v || haveFrac < 1) return
        stuckRetried = true
        hls?.destroy(); hls = null
        releaseVideo(v)
        loadInfo(info.audioIndex ?? 0, startAt).catch((e) => fail(e.message))
      }, 30_000)
    }

    /**
     * Where the viewer is, written to the server. Not before the picture has reached the place it was resumed from: the
     * first tick of a resumed episode reports 0:00 -- the element is still at the start while the jump to the resume
     * point is under way -- and that 0:00 overwrote the real place, so the next open began from the start or the show
     * looked like it was on another episode altogether.
     */
    let resumeAt = 0
    let startedAt = 0
    const canReport = () => started && !!v && (userSeeked || !resumeAt || Math.abs(v.currentTime - resumeAt) < 30 || v.currentTime > resumeAt || Date.now() - startedAt > 120_000)
    function report(ended) {
      if (!v || !play) return
      if (!isFinite(v.duration) && !info?.duration) return
      if (ended !== true && !canReport()) return
      return api('/api/progress', { torrentId: play.torrentId, fileIndex: play.fileIndex, position: ended === true ? (Number(info?.duration) || v.currentTime) : v.currentTime, duration: info?.duration || v.duration, ended: ended === true }).catch(() => {})
    }

    /* ---------- up next ----------
       The next episode is offered while the credits are still running, not after the file has stopped, so the handover is
       like a streaming service's rather than a wait on a black screen. One function draws the box for every trigger: the
       credits check on timeupdate, the video's own `ended`, and the cast finishing on the TV. */

    /** When the credits begin, in seconds, or null while nothing at all is known about the runtime.
        Three answers, in order of trust: a chapter named for the credits is exact; then the moment Flix measured with
        ffmpeg when the file finished downloading; with neither, the closing stretch of the episode. The whole of it is
        kept to its own arguments, and between the two markers below, so a test can lift this code out of the file and run
        the real thing (test/credits.test.ts) rather than a copy of it. */
    /* credits-begin */
    // A chapter named for the end of the episode. Whoever made the file names it "Credits", "End Credits" or "Outro"; the
    // extra words cover the closing ones the most common muxers write, and nothing here matches "Closing Time", a chapter
    // title a file may carry for other reasons, because the whole word has to be there.
    const CREDITS_RE = /\b(credits|end credits|outro|closing|closing credits)\b/i
    /** The runtime to work from: what the server probed, else what the player itself knows. 0 while neither does. */
    function knownDuration(info, el) {
      const d = info?.duration || el?.duration || 0
      return Number.isFinite(d) && d > 0 ? d : 0
    }
    /** Where the credits begin, and which of the three answers it came from. `at` is null only while nothing is known at
        all: no runtime and no chapter list. That is the case this used to give up in -- a probe that reported no duration
        over HLS, with no chapters, left no moment to wait for, so only the end of the file ever brought the box up. */
    function creditMoment(info, el) {
      const dur = knownDuration(info, el)
      const chapters = info?.chapters
      if (!dur && !chapters?.length) return { at: null, dur: 0, from: null }
      const ch = chapters?.find((c) => CREDITS_RE.test(c.title) && c.start > 0 && (!dur || c.start < dur - 5))
      if (ch) return { at: ch.start, dur, from: 'chapter' }
      const m = info?.creditsAt
      if (m > 0 && (!dur || m < dur - 3)) return { at: m, dur, from: 'marker' }
      // With nothing measured yet, the closing 3.5% of the runtime, held between 25 seconds and a minute: a half-hour
      // sitcom gets its last 46 seconds, an hour-long drama its last minute. The old 8% (45 s to 2.5 min) put the box up
      // over the last scene of most episodes; arriving a little after the credits begin is the lesser mistake.
      return { at: dur > 0 ? Math.max(0, dur - Math.min(60, Math.max(25, dur * 0.035))) : null, dur, from: 'estimate' }
    }
    /* credits-end */

    // Where that moment is for this file, which answer it came from, and the runtime it was worked out against. Worked out
    // again whenever the answer could have changed -- a runtime that has only just become known, one that moved, or a
    // measured marker arriving where the estimate stood in for it -- and never on every tick: once a second at most.
    const CREDIT_RANK = { estimate: 0, marker: 1, chapter: 2 }
    let creditAt = null, creditDur = -1, creditFrom = null, creditChecked = 0
    // One showing per play. Not now sets `upNextMuted` for the rest of the episode: neither the credits check nor the end
    // of the file brings the box back, and navigating away does not need to because the whole view goes with it.
    let upNextMuted = false, upNextBox = null

    function showUpNext() {
      // Nothing to offer, already offered, or already declined: no box. A countdown that is already running is left alone
      // rather than restarted, so the `ended` path does not give the viewer a second helping of the same 15 seconds.
      if (!alive || upNextMuted || upNextBox || !play?.next || play.next.locked) return
      // The countdown is fifteen seconds and the next episode's bytes start right here: the server starts the fetch, the
      // probe and the first piece now, so pressing "Play now" (or letting it run) lands on a warm episode instead of the
      // twelve seconds a cold one spends waiting for its first bytes. Fire and forget: this box must never wait on it.
      api('/api/warm', { seriesId: +seriesId, season: season === 'x' ? null : +season, label }).catch(() => {})
      const nx = play.next, target = `#/play/${seriesId}/${nx.season ?? 'x'}/${encodeURIComponent(nx.label)}`
      const box = document.createElement('div'); box.className = 'p-next'
      box.innerHTML = `<small>Up next</small><b>${esc(nx.label)}${nx.title ? ' · ' + esc(nx.title) : ''}</b><div class="actions"><button class="btn primary" id="nn">${I.play} Play now</button><button class="btn" id="nc">Not now</button></div><div class="cd"><i id="cdb"></i></div>`
      pl.appendChild(box)
      upNextBox = box
      // The bar starts empty and fills over the countdown, so it reads as time running out rather than time left.
      const bar = $('#cdb'), LEFT = 15
      clearInterval(cdT)
      let left = LEFT
      bar.style.transition = 'none'; bar.style.transform = 'scaleX(0)'
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `transform ${left}s linear`; bar.style.transform = 'scaleX(1)' }))
      // On to the next one: this episode is finished (the credits are all that is left), so it is written as watched before
      // the next one opens -- otherwise the show stayed "on" this episode at 97% and Resume brought the viewer back to its
      // credits. The move replaces this episode in the history, so Back goes to the show, not into the episode before.
      let moving = false
      const onward = async () => {
        if (moving) return
        moving = true
        clearInterval(cdT)
        await Promise.race([report(true), new Promise((r) => setTimeout(r, 1500))])
        location.replace(target)
      }
      cdT = setInterval(() => { if (--left <= 0) onward() }, 1000)
      const dismiss = () => { upNextMuted = true; clearInterval(cdT); upNextBox = null; box.classList.add('out'); setTimeout(() => box.remove(), 350) }
      $('#nn').onclick = onward
      $('#nc').onclick = dismiss
      // A remote needs something to land on, so on a television Play now takes the focus. A computer keeps what it was
      // doing: taking the focus off the seek bar, a field being typed into or a button already pressed would drop it.
      const a = document.activeElement
      if (isTv || !a || a === document.body || a === pl) $('#nn').focus({ preventScroll: true })
    }

    function onEnded() {
      report(true)
      if (!play.next || play.next.locked) return leavePlayer()
      showUpNext()
    }

    /* captions: ONE choice at a time, held here by the subtitle's own number, never read back from the browser's tracks.
       The old menu was built from the element's text tracks and matched them up again by label: two subtitles with the
       same label (two "English" tracks), a refresh that swapped the wrong one back in, or a captions track hls.js added
       for itself could each leave two ticked and two drawn at once. Now every track that is not the choice is switched
       off -- including any the player or the browser adds on its own -- whenever anything changes. */
    let subPick = null // the chosen subtitle's `n`, or null for off
    const trackEls = () => [...v.querySelectorAll('track[data-n]')]
    function applySubs() {
      if (!v) return
      for (const t of v.textTracks) {
        const el = trackEls().find((x) => x.track === t)
        const want = el && subPick != null && el.dataset.n === String(subPick) ? 'showing' : 'disabled'
        if (t.mode !== want) t.mode = want
      }
      const btn = $('#pcc')
      if (btn) { btn.hidden = !info?.subs?.length; btn.classList.toggle('on', subPick != null) }
    }
    function setSubs(n) {
      subPick = n
      const s = n == null ? null : info.subs.find((x) => String(x.n) === String(n))
      store.set('subs', s ? { lang: s.lang } : 'off')
      applySubs()
    }
    function wireSubs() {
      v.querySelectorAll('track').forEach((t) => t.remove())
      clearInterval(subT)
      subPick = null
      const pref = store.get('subs', null) // 'off' | { lang } | null (never chosen)
      const audioLang = info.audio[info.audioIndex]?.lang
      let pick = null
      if (!info.subs.length || pref === 'off') pick = null
      else if (pref?.lang) pick = info.subs.find((s) => s.lang === pref.lang && !s.forced) ?? info.subs.find((s) => s.lang === pref.lang)
      else if (audioLang && audioLang !== 'eng' && audioLang !== 'und') pick = info.subs.find((s) => s.lang === 'eng' && !s.forced) // foreign audio: English subtitles
      else pick = info.subs.find((s) => s.forced && s.lang === audioLang) ?? null
      subPick = pick ? pick.n : null
      for (const s of info.subs) mountTrack(s)
      // Whatever adds a track of its own, or turns one on, is put back to the one choice. Idempotent, so it cannot loop.
      v.textTracks.onaddtrack = applySubs
      v.textTracks.onchange = applySubs
      applySubs()
      if (!info.subs.length) return
      // The file is still arriving, so a track only covers what has downloaded; refresh the chosen one as it grows.
      subT = setInterval(async () => {
        if (subPick == null) return
        const s = info.subs.find((x) => String(x.n) === String(subPick))
        const st = await api(`/api/stream/${play.torrentId}/${play.fileIndex}/status`).catch(() => null)
        if (!s || !st || !alive) return
        mountTrack(s)
        applySubs()
        if (st.fileProgress >= 1) clearInterval(subT)
      }, 90000)
    }
    function mountTrack(s) {
      v.querySelector(`track[data-n="${s.n}"]`)?.remove()
      const t = document.createElement('track')
      t.kind = 'subtitles'; t.label = s.label; t.dataset.n = s.n; t.src = s.url + '?r=' + Date.now()
      if (s.lang && s.lang !== 'und') t.srclang = s.lang.length === 2 ? s.lang : ''
      v.appendChild(t)
      t.track.mode = 'disabled' // applySubs turns on the one that is chosen
    }

    /* audio language: more than one track means a small menu; picking one restarts the picture at the same spot */
    function wireAudio() {
      const btn = $('#aud')
      btn.hidden = info.audio.length < 2
      btn.onclick = (e) => {
        e.stopPropagation()
        const old = $('.p-menu .menu'); if (old) return closePlayerMenu(old, btn)
        const m = document.createElement('div'); m.className = 'menu'
        m.innerHTML = `<div class="who">Audio</div>${info.audio.map((t) => `<button data-n="${t.n}" ${t.n === info.audioIndex ? 'aria-current="true"' : ''}>${t.n === info.audioIndex ? '✓ ' : ''}${esc(t.label || 'Track ' + (t.n + 1))}</button>`).join('')}`
        $('.p-menu').appendChild(m)
        m.querySelectorAll('button[data-n]').forEach((b) => b.onclick = async () => {
          const n = +b.dataset.n; closePlayerMenu(m, btn)
          if (n === info.audioIndex) return
          store.set('audio', info.audio[n].lang)
          const at = v.currentTime
          try { await loadInfo(n, at) } catch (err) { fail(err.message) }
        })
      }
    }

    /* picture size: Auto, the original, or a smaller converted cut for a slow connection. Picking one carries on at the same spot. */
    function wireQuality() {
      const btn = $('#pq')
      const sizes = info.qualities || []
      btn.hidden = !sizes.length
      btn.textContent = info.quality ? info.quality + 'p' : qSetting() === 'auto' ? 'AUTO' : 'HD'
      btn.onclick = (e) => {
        e.stopPropagation()
        const old = btn.parentElement.querySelector('.menu'); if (old) return closePlayerMenu(old, btn)
        const pick = qSetting()
        const row = (val, label) => {
          const on = String(pick) === String(val)
          return `<button role="menuitemradio" aria-checked="${on}" data-q="${val}"${on ? ' aria-current="true"' : ''}>${on ? '\u2713 ' : ''}${esc(label)}</button>`
        }
        const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu')
        m.innerHTML = `<div class="who">Quality</div>` + row('auto', 'Auto' + (pick === 'auto' && info.quality ? ` (${info.quality}p now)` : '')) + row('orig', 'Original') +
          sizes.map((h) => row(h, `${h}p \u00b7 slow connection`)).join('')
        btn.parentElement.appendChild(m)
        m.querySelectorAll('button[data-q]').forEach((b) => b.onclick = async (ev) => {
          ev.stopPropagation(); closePlayerMenu(m, btn)
          const val = b.dataset.q === 'auto' || b.dataset.q === 'orig' ? b.dataset.q : Number(b.dataset.q)
          if (val === 'auto') autoQuality = 0 // a fresh start: the original first, stepping down again only if it stalls
          store.set('quality', val)
          if (qAsk() === (info.quality || 0)) { btn.textContent = info.quality ? info.quality + 'p' : val === 'auto' ? 'AUTO' : 'HD'; return }
          switchQuality()
        })
      }
    }
    /** Load the size qAsk() names at the spot the viewer is at. Stalls right after the switch are the new stream starting. */
    let qQuietUntil = 0
    async function switchQuality() {
      qQuietUntil = Date.now() + 15_000
      const at = v?.currentTime || 0
      try { await loadInfo(info.audioIndex ?? 0, at) } catch (err) { fail(err.message) }
    }
    /**
     * Auto: the picture ran dry three times in a minute and a half, or once for ten seconds, while nobody was seeking. That
     * is a connection slower than the file -- what the logs showed on a 10.8 Mbit/s episode over Tailscale -- so the next
     * size down is asked for. Never stepped back up mid-episode: a size that flips back and forth stalls more than either.
     */
    function watchQuality(v) {
      let stalls = [], longT = null
      const stepDown = () => {
        clearTimeout(longT); stalls = []
        if (qSetting() !== 'auto' || castingOnly || !alive) return
        const next = (info.qualities || []).find((h) => h < (info.quality || Infinity))
        if (!next) return
        autoQuality = next
        flashNote(`Slow connection: switched to ${next}p`)
        switchQuality()
      }
      v.addEventListener('seeking', () => { qQuietUntil = Math.max(qQuietUntil, Date.now() + 4000) })
      v.addEventListener('waiting', () => {
        if (!started || v.paused || Date.now() < qQuietUntil || qSetting() !== 'auto') return
        const now = Date.now()
        stalls = stalls.filter((t) => now - t < 90_000).concat(now)
        if (stalls.length >= 3) return stepDown()
        clearTimeout(longT)
        longT = setTimeout(() => { if (v.readyState < 3 && !v.paused && Date.now() >= qQuietUntil) stepDown() }, 10_000)
      })
      for (const ev of ['playing', 'emptied']) v.addEventListener(ev, () => clearTimeout(longT))
    }

    /* captions: a menu of our own, because the bar is ours now and the TV's WebView draws no CC button. A list where one
       entry is ticked: picking one unticks the rest, and Off is one of them. */
    function wireSubMenu() {
      const btn = $('#pcc')
      applySubs()
      btn.onclick = (e) => {
        e.stopPropagation()
        const old = btn.parentElement.querySelector('.menu'); if (old) return closePlayerMenu(old, btn)
        if (!info.subs.length) return
        // Two subtitles with the same name are told apart by number rather than shown as two identical lines.
        const seen = new Map()
        const names = info.subs.map((s) => { const base = s.label || 'Subtitles'; const k = (seen.get(base) ?? 0) + 1; seen.set(base, k); return k > 1 ? `${base} (${k})` : base })
        const row = (n, label) => {
          const on = n === null ? subPick == null : String(subPick) === String(n)
          return `<button role="menuitemradio" aria-checked="${on}" data-n="${n === null ? '' : esc(String(n))}"${on ? ' aria-current="true"' : ''}>${on ? '\u2713 ' : ''}${esc(label)}</button>`
        }
        const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu')
        m.innerHTML = `<div class="who">Captions</div>` + row(null, 'Off') + info.subs.map((s, i) => row(s.n, names[i])).join('')
        btn.parentElement.appendChild(m)
        m.querySelectorAll('button[role="menuitemradio"]').forEach((b) => b.onclick = (ev) => {
          ev.stopPropagation()
          const n = b.dataset.n === '' ? null : info.subs.find((s) => String(s.n) === b.dataset.n)?.n ?? null
          setSubs(n)
          closePlayerMenu(m, btn)
        })
      }
    }

    let castWired = false
    const castTitle = () => `${play?.seriesName || label}${play?.episodeTitle ? ' · ' + play.episodeTitle : ''}`
    /** Send this episode to the connected TV; its progress is reported from there (see castTrack). */
    async function castHere(at) {
      // A TV keeps whatever timeline it was handed when it loaded, so an episode that is not yet one file is worth waiting
      // for: this asks the server to finish the single MP4 first. The cast splash is already on screen, so it reads as the
      // TV taking a moment. If it still cannot be had, the playlist is cast and plays forwards as before.
      if (!info.seekable) {
        const where = $('#msg .cs-where')
        if (where) where.textContent = `Getting the whole episode for ${casting.device}…`
        try {
          const q = `cast=1${info.audioIndex ? '&a=' + info.audioIndex : ''}`
          const fresh = await api(`/api/stream/${play.torrentId}/${play.fileIndex}/info?${q}`)
          if (fresh) info = { ...info, ...fresh }
        } catch { /* keep what we have */ }
      }
      await castSend(info.castUrl, castTitle(), at || 0, play.torrentId, play.fileIndex, info.duration, info.castType, info.castFallbackUrl)
    }
    function wireExtras() {
      if (castWired) return
      castWired = true
      // No LAN address configured means the TV could not reach the media anyway,
      // so the button stays away rather than failing at the last step.
      // A television is the thing being cast to, so the button is for phones and computers only.
      if (!info?.castUrl || isTv) return
      $('#cast').hidden = false
      $('#cast').onclick = async () => {
        try {
          if (!casting.connected) await castConnect()
          await castHere(v?.currentTime || 0)
          enterCastMode()
        } catch (err) {
          if (err?.code === 'cancel') return // they closed the device picker
          castNote('Could not start on the TV. Check the TV is on the same network as this box.')
        }
      }
    }
    /**
     * The TV has the show. The phone stops loading and playing it and becomes the TV's remote: the same bar, driving the TV's player,
     * until the cast is stopped (from here or from the TV), when "Play on this phone" carries on from where the TV got to.
     */
    function enterCastMode() {
      castingOnly = true
      clearTimeout(holdT); clearInterval(timer); clearInterval(subT); clearInterval(cdT)
      holding = false
      hls?.destroy(); hls = null
      if (v) { v.onpause = null; v.pause(); v.removeAttribute('src'); v.load() }
      $('#wait').classList.remove('gone'); $('.mark')?.remove()
      pl.classList.remove('idle')
      try {
        const p = new cast.framework.RemotePlayer(), c = new cast.framework.RemotePlayerController(p)
        rem = { p, c }
        let finished = false
        c.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, () => {
          if (!castingOnly) return
          paint()
          const ms = castCtx()?.getCurrentSession()?.getMediaSession?.()
          if (!finished && ms?.playerState === 'IDLE' && ms.idleReason === 'FINISHED') { finished = true; onEnded() }
        })
      } catch { rem = null }
      paint()
      showCastCard('Playing on ' + casting.device, true)
      castNote(`Playing on ${casting.device}`)
      stopOff = onCast(() => { if (castingOnly && !casting.connected) { saveRemote(); rem = null; showCastCard('Casting stopped', true, true); paint() } })
    }
    let stopOff = null
    const saveRemote = () => {
      const t = rem?.p.currentTime
      if (t > 0 && play) api('/api/progress', { torrentId: play.torrentId, fileIndex: play.fileIndex, position: t, duration: totalT(), ended: false }).catch(() => {})
    }
    function showCastCard(where, withButtons, stopped) {
      $('#msg').innerHTML = `<div class="cast-splash done"><span class="cs-mark"></span><span class="cs-where">${esc(where)}</span><div style="display:flex;gap:10px;justify-content:center;margin-top:18px"><button class="btn" id="cstop">${stopped ? 'Play on this phone' : 'Stop casting'}</button><a class="btn" href="#/series/${seriesId}">Back</a></div></div>`
      // Stopping the cast brings the show back on the phone, from where the TV was.
      $('#cstop').onclick = () => {
        saveRemote()
        if (!stopped) { try { castCtx().getCurrentSession()?.endSession(true) } catch { /* already gone */ } }
        stopOff?.()
        casting.connected = false; casting.device = ''
        setTimeout(route, 350)
      }
    }
    /** A connected TV gets the episode instead of the phone; if that fails it plays here as usual. */
    async function castInstead(at) {
      try {
        castingOnly = true // from here the phone shows the hand-over, never the episode
        clearInterval(timer) // no local progress polling, the TV reports its own
        $('#wait').classList.remove('gone'); $('.mark')?.remove()
        // The Flix mark, then the show starts on the TV.
        $('#msg').innerHTML = `<div class="cast-splash"><span class="cs-mark"></span><span class="cs-where">Casting to ${esc(casting.device)}</span></div>`
        await castHere(at)
        await new Promise((r) => setTimeout(r, 1600))
        if (!alive) return
        enterCastMode()
      } catch { castingOnly = false; attach(at) }
    }

    begin()
  }
}

/* ---------- admin ---------- */
const PRESETS = { Kids: ['TV-Y', 'TV-Y7', 'TV-G'], Teens: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'], Everything: null }
const RATING_HELP = { 'TV-Y': 'All children', 'TV-Y7': 'Ages 7+', 'TV-G': 'General audience', 'TV-PG': 'Parental guidance', 'TV-14': 'Ages 14+', 'TV-MA': 'Mature, 17+', Unrated: 'No rating known' }

function ratingPills(all, on, attrs = '') {
  return `<div class="rpills" ${attrs}>${all.map((r) => `<button type="button" class="rpill" data-r="${esc(r)}" aria-pressed="${on.includes(r)}" title="${esc(RATING_HELP[r] || '')}">${esc(r)}</button>`).join('')}</div>`
}

const SETTINGS_PILLS = [['torrents', 'Torrents'], ['family', 'Family'], ['playback', 'Playback'], ['btn', 'BTN'], ['ratings', 'Ratings'], ['tmdb', 'TMDB'], ['qb', 'qBittorrent']]
const LEGACY_SECTION = { '': 'torrents', family: 'family', settings: 'btn' } // the old #/admin, #/admin/family and #/admin/settings addresses

/** One page for everything an admin manages: sections stacked under a row of pills that stays put while the page scrolls. */
/** Where this server answers, so the address for a TV is on the page rather than in someone's head: the home-network
 *  address (works without Tailscale) and the tailnet one (real certificate). The one you are reading this on is left out. */
function addressHint() {
  const a = myState?.addresses ?? {}
  const parts = []
  if (a.lan && a.lan !== location.origin) parts.push(`<b>${esc(a.lan)}</b> on the home network`)
  if (a.tailnet && a.tailnet !== location.origin) parts.push(`<b>${esc(a.tailnet)}</b> over Tailscale`)
  if (!parts.length) return ''
  return `<p class="dim sm" style="margin:8px 0 0;max-width:70ch">Flix answers at ${parts.join(' &middot; ')}. A TV that cannot install Tailscale uses the home-network address.</p>`
}

async function settingsView(section = 'torrents') {
  const [downloads, health, reports, family, conns] = await Promise.all([
    api('/api/admin/downloads'), api('/api/admin/health').catch(() => ({ issues: [] })), api('/api/admin/reports').catch(() => ({ reports: [] })),
    api('/api/admin/users'), api('/api/admin/settings'),
  ])
  downloads.health = health; downloads.reports = reports.reports
  return () => {
    app.innerHTML = `<div class="pad page-top"><h1 class="stitle">Settings</h1>${addressHint()}
      <nav class="snav" aria-label="Settings sections"><div class="pills">${SETTINGS_PILLS.map(([id, l]) => `<a class="pill" href="#/settings/${id}" data-s="${id}">${l}</a>`).join('')}</div></nav>
      <section class="ssec" id="s-torrents"></section><section class="ssec" id="s-family"></section><section class="ssec" id="s-conn"></section></div>`
    downloadsPanel(downloads, $('#s-torrents')); familyPanel(family, $('#s-family')); settingsPanel(conns, $('#s-conn'))
    const pills = [...app.querySelectorAll('.snav .pill')]
    const jump = (id, smoothly) => { const el = document.getElementById('s-' + id); if (el) el.scrollIntoView({ block: 'start', behavior: smoothly ? 'smooth' : 'instant' }) }
    pills.forEach((p) => p.onclick = (e) => { e.preventDefault(); history.replaceState(null, '', '#/settings/' + p.dataset.s); jump(p.dataset.s, !rmq.matches) })
    // Highlight the section being read: the last one whose top has scrolled up under the pills.
    const onScroll = () => {
      let cur = SETTINGS_PILLS[0][0]
      for (const [id] of SETTINGS_PILLS) { const el = document.getElementById('s-' + id); if (el && el.getBoundingClientRect().top <= 150) cur = id }
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = SETTINGS_PILLS[SETTINGS_PILLS.length - 1][0]
      pills.forEach((p) => { const on = p.dataset.s === cur; p.setAttribute('aria-selected', String(on)); if (on && p.scrollIntoView) { const box = p.parentElement; box.scrollTo({ left: p.offsetLeft - (box.clientWidth - p.offsetWidth) / 2, behavior: 'auto' }) } })
    }
    addEventListener('scroll', onScroll, { passive: true })
    const prev = cleanup; cleanup = () => { prev?.(); removeEventListener('scroll', onScroll) }
    if (section !== 'torrents') requestAnimationFrame(() => jump(section, false))
    onScroll()
  }
}

const dur = (sec) => { if (sec == null || sec < 0 || sec >= 8640000) return ''; const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + m + 'm' : Math.max(1, m) + 'm' }
/**
 * What an episode's OWN file is, in the words shown under it. "Ready to watch" is a claim about bytes on disk, so it is
 * only said when qBittorrent reports that file at 1: a release that merely exists -- or a pack that has just started --
 * is downloading, and a file in the pack nobody has asked for is waiting in the pack.
 */
const epState = (e) => {
  if (!e.available) return 'Not available right now'
  if (e.onServer) return 'Ready to watch'
  const p = e.fileProgress
  if (p != null && p > 0) return `Downloading ${Math.min(99, Math.max(1, Math.floor(p * 100)))}%`
  if (e.inPack) return 'In the season pack'
  if (e.isPack) return 'Part of the full season download'
  return 'Not downloaded yet'
}
const ago = (t) => { const d = Math.floor(Date.now() / 1000) - t; return d < 3600 ? Math.max(1, Math.round(d / 60)) + ' min ago' : d < 86400 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' d ago' }

/** Twelve months of the space Flix's downloads take: an SVG line with a hover crosshair, and the same numbers as a table. */
function storageChart(el, h) {
  const pts = h.points
  const W = Math.max(300, el.clientWidth || 720), H = 220, L = 46, R = 14, T = 14, B = 26 // drawn at the real width, so text is never stretched
  const max = Math.max(...pts.map((p) => p[1]), 1)
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].map((g) => g * 1e9).find((s) => max * 1.08 / s <= 4) ?? 1e13
  const top = Math.max(step, Math.ceil((max * 1.05) / step) * step)
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0]
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R)
  const y = (b) => T + (1 - b / top) * (H - T - B)
  const unit = (b) => (top >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : Math.round(b / 1e9) + ' GB')
  const line = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('')
  // Before real measuring began the line is an estimate (from when downloads were added and removed): drawn dashed.
  const cut = h.since ? pts.findIndex((p) => p[0] >= h.since) : -1
  const est = cut === -1 ? pts : pts.slice(0, cut + 1), real = cut === -1 ? [] : pts.slice(cut)
  const yTicks = []; for (let v = 0; v <= top + 1; v += step) yTicks.push(v)
  const months = []
  for (let d = new Date(t0 * 1000), m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); m.getTime() / 1000 < t1; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) months.push(m)
  const narrow = W < 520
  const fmt = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const first = pts.findIndex((p) => p[1] > 0)
  const summary = first === -1 ? 'Nothing has been downloaded in the last 12 months.' : `Now ${unit(pts[pts.length - 1][1])}; the most was ${unit(max)} over the last 12 months.`
  el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Space used by downloads over the last 12 months. ${esc(summary)}">
      ${yTicks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${unit(v)}</text>`).join('')}
      ${months.map((m, i) => (narrow && i % 2 ? '' : `<text class="ax" x="${x(m.getTime() / 1000).toFixed(1)}" y="${H - 6}" text-anchor="middle">${m.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}</text>`)).join('')}
      <path class="area" d="${line(pts)}L${x(t1).toFixed(1)} ${y(0)}L${x(t0).toFixed(1)} ${y(0)}Z"/>
      ${est.length > 1 ? `<path class="ln est" d="${line(est)}"/>` : ''}${real.length > 1 ? `<path class="ln" d="${line(real)}"/>` : ''}
      <g id="cx" hidden><line class="cross" y1="${T}" y2="${H - B}"/><circle r="5" class="dot"/></g>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></svg><div class="tip" id="ctip" hidden></div></div>
    <div class="dim chart-note">${esc(summary)}${!h.since ? ' Estimated from when downloads were added and removed.' : h.since > t0 ? ` Dashed: estimated from when downloads were added and removed, before ${esc(fmt(h.since))}.` : ''}</div>
    <details class="hist"><summary>View as a table</summary><div class="card-box"><table class="plain"><thead><tr><th>Month end</th><th>Space used</th></tr></thead><tbody>${months.concat([new Date(t1 * 1000)]).slice(-13).map((m, i, a) => {
      const at = i === a.length - 1 ? t1 : m.getTime() / 1000 - 1, p = [...pts].reverse().find((q) => q[0] <= at) ?? pts[0]
      return `<tr><td>${i === a.length - 1 ? 'Now' : m.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })}</td><td>${gb(p[1])}</td></tr>`
    }).join('')}</tbody></table></div></details>`
  const svg = $('svg', el), cx = $('#cx', el), tip = $('#ctip', el), box = $('.chart', el)
  const move = (e) => {
    const r = svg.getBoundingClientRect(), t = t0 + (((e.clientX - r.left) / r.width) * W - L) / (W - L - R) * (t1 - t0)
    const p = pts.reduce((best, q) => (Math.abs(q[0] - t) < Math.abs(best[0] - t) ? q : best), pts[0])
    cx.hidden = false; $('.cross', cx).setAttribute('x1', x(p[0])); $('.cross', cx).setAttribute('x2', x(p[0]))
    const dot = $('.dot', cx); dot.setAttribute('cx', x(p[0])); dot.setAttribute('cy', y(p[1]))
    tip.hidden = false; tip.innerHTML = `<b>${gb(p[1])}</b><span>${esc(fmt(p[0]))}${!h.since || p[0] < h.since ? ' · estimated' : ''}</span>`
    const px = (x(p[0]) / W) * box.clientWidth
    tip.style.left = Math.min(Math.max(px, 70), box.clientWidth - 70) + 'px'
  }
  const hide = () => { cx.hidden = true; tip.hidden = true }
  const hit = $('.hit', el); hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', hide)
}

function downloadsPanel(data, root) {
  const req = data.requirements
  root.innerHTML = `<h2 class="stitle2">Torrents &amp; seeding</h2>
    <p class="dim lead">Everything Flix has pulled from BroadcasTheNet. BTN wants each torrent seeded until its <b>seeding goal</b> is met: <b>${req.minHours} hours or a ${req.minRatio}:1 ratio</b>, whichever comes first. Flix will not delete one before that, even if you ask. After that it is removed once everyone who started it has watched it to the end. Whole-season downloads finish even if you only watch part of them, so they can be seeded.</p>
    <h2 class="sec">Storage</h2><div class="panel" id="tstorage"><div id="tmeter"></div><div id="tchart" class="chart-wrap"></div><div id="tinfo"></div></div>
    <div id="trep"></div>
    <h2 class="sec">Downloads</h2><div class="tsum" id="tsum"></div><div id="tlist"></div><div id="thist"></div>`
  const shortName = (x) => esc(x.group_name.includes(' - ') ? x.group_name.slice(x.group_name.lastIndexOf(' - ') + 3) : x.group_name)
  const storage = (d, h) => {
    const disk = d.disk, pct = disk ? Math.round((disk.free / disk.total) * 100) : 100
    const state = !disk ? '' : disk.free < Math.max(d.minFreeGb * 1e9, (d.minFreePct / 100) * disk.total) ? ['bad', 'Almost full'] : pct < d.warnFreePct ? ['warn', 'Getting low'] : ['ok', 'Healthy']
    const issues = (h?.issues ?? []).map((i) => `<li class="iss ${i.level}"><b>${esc(i.title)}</b><span>${esc(i.detail)}</span>${i.link ? `<a href="${esc(i.link)}">Fix</a>` : ''}</li>`).join('')
    // Everything finished that could go, biggest first. Torrents still short of their seeding goal are listed but cannot be removed (BTN's rule).
    const fin = disk && state[0] !== 'ok' ? d.downloads.filter((x) => x.state === 'active' && !x.missing && x.left === 0).sort((a, b) => b.size - a.size) : []
    const ok = fin.filter((x) => x.seedMet), wait = fin.filter((x) => !x.seedMet)
    const row = (x, action) => `<li class="trow"><div><b>${esc(x.series)}</b> <span class="dim">${shortName(x)}${x.is_pack ? ' · whole season' : ''}</span><div class="dim sm">${action.note}</div></div><span class="size">${gb(x.size)}</span>${action.btn ?? '<span></span>'}</li>`
    const space = fin.length ? `<div class="sub-h">Free up space</div>
      <p class="dim sm" style="margin:0 0 8px;max-width:66ch">${pct}% is free. Below ${d.minFreePct}% new shows are refused; below ${d.autoPausePct}% nothing is fetched ahead of time. ${ok.length ? `Removing everything under “Ready to remove” frees ${gb(ok.reduce((s, x) => s + x.size, 0))}.` : 'Nothing can be removed right now.'}</p>
      ${ok.length ? `<div class="dim sm cap">Ready to remove</div><ul class="trows">${ok.map((x) => row(x, { note: x.waitingFor?.length ? `Seeding goal met · ${esc(x.waitingFor.join(', '))} hasn’t finished it` : 'Seeding goal met · everyone is done', btn: `<button class="btn sm-btn" data-rm="${x.torrent_id}">${x.waitingFor?.length ? 'Remove anyway' : 'Remove'}</button>` })).join('')}</ul>` : ''}
      ${wait.length ? `<div class="dim sm cap">Still seeding (can’t be removed yet)</div><ul class="trows">${wait.map((x) => row(x, { note: `${Math.max(0, req.minHours - x.seedHours).toFixed(0)} h more seeding, or ratio ${x.ratio.toFixed(2)} of ${req.minRatio}:1` })).join('')}</ul>` : ''}` : ''
    $('#tmeter').innerHTML = disk ? `<div class="meter wide ${state[0] === 'ok' ? 'met' : ''}"><span><b>${gb(disk.free)}</b> free of ${gb(disk.total)} (${pct}%) <em class="state ${state[0]}">${state[1]}</em></span><div class="m"><i style="width:${100 - pct}%"></i></div></div>` : ''
    // What is using the disk, biggest first, and who is keeping it, so it is clear what to ask about when space runs short.
    const big = d.downloads.filter((x) => x.state === 'active' && !x.missing).map((x) => ({ ...x, held: x.size * (x.progress ?? 0) })).sort((a, b) => b.held - a.held).slice(0, 5)
    const using = big.length ? `<div class="sub-h">Using the most space</div><ul class="trows">${big.map((x) => `<li class="trow"><div><b>${esc(x.series)}</b> <span class="dim">${shortName(x)}${x.is_pack ? ' · season pack' : ''}</span><div class="dim sm">${x.deletable ? 'Done: goes on the next sweep' : x.holders?.length ? 'Kept for ' + esc(x.holders.map((h) => h.name).join(', ')) : esc((x.reasons || [])[0] || '')}${x.leaving_at ? ' · leaving soon' : ''}</div></div><span class="size">${gb(x.held)}</span><span></span></li>`).join('')}</ul>` : ''
    const fc = chartData?.fullInDays
    const forecast = fc == null ? '' : `<div class="dim sm" style="margin:6px 0">At the pace of the last two weeks, there is room for about <b>${fc} more day${fc === 1 ? '' : 's'}</b> of downloads before new shows are refused.</div>`
    $('#tinfo').innerHTML = `${forecast}${space}${using}${issues ? `<ul class="issues">${issues}</ul>` : '<div class="dim sm">Everything looks healthy.</div>'}
      <div class="dim sm">${d.folder ? `Downloads folder: <code>${esc(d.folder)}</code>. Flix keeps its torrents here, takes over matching ones you download here yourself, and removes only what it put here.` : ''}${h?.backup ? `<br>Latest backup of accounts and watch history: ${esc(h.backup.replace(/^flix-|\.db$/g, ''))}` : ''}</div>`
  }
  let chartData = null, lastHealth = data.health
  const meter = (label, v, max, met) => `<div class="meter wide${met ? ' met' : ''}"><span>${label}</span><div class="m"><i style="width:${Math.min(100, (v / max) * 100)}%"></i></div></div>`
  const card = (x, kind) => {
    const sub = shortName(x) + (x.resolution ? ' · ' + esc(x.resolution) : '') + (x.is_pack ? ' · whole season' : '') + (x.origin === 'auto' ? ' · fetched ahead of time' : x.origin === 'adopted' ? ' · from your Downloads folder' : '')
    let badge, body = ''
    if (x.missing) { badge = '<span class="badge warn">Missing</span>'; body = '<div class="dim sm">Flix lost track of this torrent in the download engine; it will be tidied up shortly.</div>' }
    else if (kind === 'dl') {
      badge = `<span class="badge info">Downloading ${Math.round(x.progress * 100)}%</span>`
      body = `<div class="meter wide met"><span>${gb(x.size * x.progress)} of ${gb(x.size)}${x.dlspeed ? ' · ' + mbps(x.dlspeed) : ''}${x.eta && x.dlspeed ? ' · ' + dur(x.eta) + ' left' : ''}${!x.dlspeed ? ' · waiting for peers (' + x.seeds + ' seeders)' : ''}</span><div class="m"><i style="width:${x.progress * 100}%"></i></div></div>`
    } else {
      badge = x.seedMet ? '<span class="badge ok">Goal met</span>' : '<span class="badge warn">Seeding</span>'
      body = `<div class="meters">${meter(`Ratio ${x.ratio.toFixed(2)} of ${req.minRatio}:1`, x.ratio, req.minRatio, x.ratio >= req.minRatio)}${meter(`${x.seedHours.toFixed(1)} h of ${req.minHours} h seeded`, x.seedHours, req.minHours, x.seedHours >= req.minHours)}</div>
        <div class="dim sm">${x.seedMet ? 'Either one is enough, so BTN is satisfied.' : 'Either one is enough. Uploaded ' + gb(x.uploaded) + (x.upspeed ? ' · now sending ' + mbps(x.upspeed) : '') + '.'}</div>`
    }
    const rs = (x.reasons || []).filter((r) => !/^BTN seeding|^waiting for|^not yet watched by/.test(r) && r !== 'still downloading')
    const when = (h) => ({ partway: 'partway through', queued: 'lined up to watch', ahead: 'fetched ahead of time', unwatched: 'can watch it, hasn’t yet' }[h.state]) + (h.lapsesAt ? `, lapses in ${dur(h.lapsesAt - Date.now() / 1000)}` : '')
    // Who is keeping it on disk. Anyone allowed to watch it who hasn't yet holds it too. A hold from starting it lapses if they never come back to it.
    const held = (x.holders || []).length ? `<div class="sm"><span class="dim">Held by</span> ${x.holders.map((h) => `<b>${esc(h.name)}</b> <span class="dim">(${when(h)})</span>`).join(', ')}</div>` : x.deletable ? '' : '<div class="dim sm">Held by nobody.</div>'
    const leaving = x.leaving_at && !x.deletable ? `<div class="dim sm">Leaving soon: removed in ${dur(Math.max(0, x.leaving_at - Date.now() / 1000))} unless someone presses play.</div>` : ''
    const asked = x.remove_when_seeded ? `<div class="dim sm">Goes as soon as the seeding goal is met${x.waitingFor?.length ? ` and ${esc(x.waitingFor.join(', '))} finishes` : ''}.</div>` : ''
    const why = (x.deletable ? '<div class="dim sm">Done: will be removed on the next sweep.</div>' : '') + held + leaving + asked + (!x.deletable && rs.length ? `<div class="dim sm">Kept: ${esc(rs.join(' · '))}</div>` : '')
    return `<div class="tcard"><div class="thead"><div><b>${esc(x.series)}</b><div class="dim sm">${sub}</div></div>${badge}</div>${body}${why}
      <div class="tfoot"><span class="dim sm">Added ${ago(x.added_at)} · ${gb(x.size * (x.progress ?? 0))} on disk</span><span>${x.missing || x.deletable ? '' : `<button class="btn sm-btn" data-ws="${x.torrent_id}" aria-pressed="${!!x.remove_when_seeded}">${x.remove_when_seeded ? '✓ Remove when seeded' : 'Remove when seeded'}</button> `}<button class="btn sm-btn" data-rm="${x.torrent_id}">Remove</button></span></div></div>`
  }
  let lastData = data
  const draw = (d) => {
    lastData = d
    const act = d.downloads.filter((x) => x.state === 'active'), gone = d.downloads.filter((x) => x.state !== 'active')
    const dl = act.filter((x) => !x.missing && x.left > 0), seed = act.filter((x) => !x.missing && x.left === 0 && !x.seedMet), done = act.filter((x) => !x.missing && x.left === 0 && x.seedMet), miss = act.filter((x) => x.missing)
    storage(d, lastHealth)
    $('#tsum').innerHTML = [[dl.length, 'downloading'], [seed.length, 'seeding'], [done.length, 'goal met']].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('')
    const sec = (title, list, kind) => list.length ? `<div class="sub-h">${title}</div><div class="tgrid">${list.map((x) => card(x, kind)).join('')}</div>` : ''
    $('#tlist').innerHTML = (act.length ? '' : '<div class="empty">Nothing downloaded yet. Press play on an episode and it will show up here.</div>')
      + sec('Downloading', dl, 'dl') + sec('Seeding · goal not met yet', seed, 'seed') + sec('Seeding goal met', done, 'seed') + sec('Needs attention', miss, 'dl')
    $('#thist').innerHTML = gone.length ? `<details class="hist"><summary>Removed (${gone.length})</summary><ul class="trows">${gone.slice(0, 50).map((x) => `<li class="trow"><div><b>${esc(x.series)}</b> <span class="dim">${shortName(x)}</span><div class="dim sm">${esc(x.remove_reason || '')}</div></div><span class="size dim">${x.removed_at ? ago(x.removed_at) : ''}</span><span></span></li>`).join('')}</ul></details>` : ''
    root.querySelectorAll('[data-ws]').forEach((b) => b.onclick = async () => {
      try { await api(`/api/admin/downloads/${b.dataset.ws}/when-seeded`, { on: b.getAttribute('aria-pressed') !== 'true' }); draw(await api('/api/admin/downloads')) } catch (e) { alert(e.message) }
    })
    root.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
      try { await api('/api/admin/downloads/' + b.dataset.rm, null, 'DELETE'); draw(await api('/api/admin/downloads')); loadChart() } catch (e) { b.textContent = e.message.includes('requirement') ? 'Not until goal met' : 'Failed'; b.disabled = true }
    })
  }
  const reports = (list) => {
    $('#trep').innerHTML = list.length ? `<h2 class="sec">Reported problems</h2><ul class="trows">${list.map((r) => `<li class="trow"><div><b>${esc(r.series || 'Unknown show')}</b> <span class="dim">${esc(r.label || '')}</span>
        <div class="dim sm">${esc(r.user || '?')} · ${ago(r.created_at)} · ${r.kind === 'auto' ? 'failed on its own' : 'reported by a viewer'}${r.group_name ? ' · ' + esc(r.group_name) + ' · ' + esc(r.resolution || '') + ' · ' + (r.seeders ?? 0) + ' seeders' : ''}${r.message ? ' · ' + esc(r.message) : ''}</div></div><span></span>
        <button class="btn sm-btn" data-dis="${r.id}">Dismiss</button></li>`).join('')}</ul>
      <button class="btn sm-btn" data-dis="all" style="margin-top:10px">Dismiss all</button>` : ''
    $('#trep').querySelectorAll('[data-dis]').forEach((b) => b.onclick = async () => {
      await api('/api/admin/reports/resolve', { id: b.dataset.dis === 'all' ? 'all' : +b.dataset.dis }).catch(() => {})
      reports((await api('/api/admin/reports').catch(() => ({ reports: [] }))).reports)
    })
  }
  const loadChart = async () => { chartData = await api('/api/admin/storage').catch(() => chartData); if (chartData) { storageChart($('#tchart'), chartData); storage(lastData, lastHealth) } }
  draw(data); reports(data.reports ?? []); loadChart()
  const t = setInterval(async () => {
    const d = await api('/api/admin/downloads').catch(() => data)
    lastHealth = await api('/api/admin/health').catch(() => lastHealth); draw(d)
    reports((await api('/api/admin/reports').catch(() => ({ reports: [] }))).reports)
  }, 15000)
  const t2 = setInterval(loadChart, 300000)
  let rz; const onResize = () => { clearTimeout(rz); rz = setTimeout(() => chartData && storageChart($('#tchart'), chartData), 150) }
  addEventListener('resize', onResize)
  cleanup = () => { clearInterval(t); clearInterval(t2); clearTimeout(rz); removeEventListener('resize', onResize) }
}

function familyPanel(data, root) {
  const all = data.ratings
  let users = data.users
  const onList = (u) => u.allowed ?? all
  const paint = () => {
    root.innerHTML = `<h2 class="stitle2">Family</h2>
      <p class="dim" style="max-width:66ch">Only you can add people. Choose which ratings each person can watch; anything above their level is hidden completely. Shows with no known rating count as <b style="color:var(--fg)">Unrated</b>, so turn that off for kids.</p>
      ${data.ratingLookup ? '' : '<p class="notice">Ratings are not looked up yet. Add an OMDb key under Settings → Ratings (IMDb ratings are looked up automatically) or a TMDB key.</p>'}
      <div class="people">${users.map((u) => `<div class="person rise" data-id="${u.id}">
        <div class="who"><span class="avatar" style="width:44px;height:44px;cursor:default">${esc(u.name[0].toUpperCase())}</span><div><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="chip">You</span>' : ''}${u.is_admin ? ' <span class="chip">Admin</span>' : ''}
        <div class="dim" style="font-size:13px">${u.is_admin ? 'Admins can watch everything' : u.allowed ? 'Limited' : 'Everything'}${u.hasPassword ? '' : ' · No password'}</div></div></div>
        <div class="rcell">${u.is_admin ? '<span class="dim">All ratings</span>' : ratingPills(all, onList(u))}</div>
        <div class="pact"><button class="btn" data-act="pw" style="padding:8px 14px">${u.hasPassword ? 'Reset password' : 'Set password'}</button>
        <button class="btn" data-act="invite" style="padding:8px 14px">Sign-in link</button>
        <button class="btn" data-act="pin" style="padding:8px 14px">${u.hasPin ? 'Change PIN' : 'Set PIN'}</button>
        ${u.id === me.id ? '' : `<button class="btn" data-act="role" style="padding:8px 14px">${u.is_admin ? 'Remove admin' : 'Make admin'}</button><button class="btn" data-act="rm" style="padding:8px 14px">Remove</button>`}</div>
        <div class="pwrow" hidden><input class="field" type="password" placeholder="New password (8+ characters)" autocomplete="new-password"><button class="btn primary" data-act="pwsave" style="padding:10px 16px">Save</button><span class="dim msg"></span></div>
        <div class="pwrow pinrow" hidden><input class="field" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="4 to 8 digits" autocomplete="off"><button class="btn primary" data-act="pinsave" style="padding:10px 16px">Save</button>${u.hasPin ? '<button class="btn" data-act="pinclear" style="padding:10px 16px">Remove PIN</button>' : ''}
        <span class="dim" style="flex-basis:100%;font-size:13px">Asked when someone switches to ${esc(u.name)} on a shared device, so kids can’t open an adult’s profile. A password or sign-in link still works.</span></div>
        <div class="pwrow invrow" hidden><input class="field" readonly aria-label="Sign-in link"><button class="btn primary" data-act="copy" style="padding:10px 16px">Copy</button><button class="btn" data-act="share" style="padding:10px 16px" hidden>Share</button>
        <span class="dim" style="flex-basis:100%;font-size:13px">Send this to ${esc(u.name)}. Opening it on their phone, tablet or TV signs that device in with no password. It works once and expires in 7 days.</span></div></div>`).join('')}</div>
      <h2 class="sec">Add a family member</h2>
      <form id="uf" class="person"><div class="row-form"><input class="field" name="name" placeholder="Username" autocomplete="off" required><input class="field" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password"></div>
        <p class="dim" style="font-size:13px;margin:0">Kids (not an admin, and not allowed TV-MA) don’t need a password: leave it empty and they sign in with just their name.</p>
        <div><div class="dim" style="font-size:13px;margin-bottom:8px">Can watch:</div>${ratingPills(all, all, 'id="newr"')}
        <div class="row-form" style="margin-top:10px">${Object.keys(PRESETS).map((k) => `<button type="button" class="btn" data-preset="${k}" style="padding:7px 14px">${k}</button>`).join('')}</div></div>
        <div class="row-form"><label class="dim"><input type="checkbox" name="isAdmin"> Admin</label><button class="btn primary">Add person</button><span id="um" class="dim" role="status"></span></div></form>`
    wire()
  }
  const patch = async (id, body) => { const r = await api('/api/admin/users/' + id, body, 'PATCH'); users = users.map((u) => (u.id === id ? r : u)); return r }
  const wire = () => {
    root.querySelectorAll('.person[data-id]').forEach((card) => {
      const id = +card.dataset.id, u = () => users.find((x) => x.id === id), msg = $('.msg', card)
      card.querySelectorAll('.rpill').forEach((b) => b.onclick = async () => {
        const cur = onList(u()), r = b.dataset.r, next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
        b.setAttribute('aria-pressed', String(next.includes(r)))
        try { await patch(id, { allowedRatings: all.filter((x) => next.includes(x)) }); const l = $('.who .dim', card); if (l) l.textContent = u().allowed ? 'Limited' : 'Everything' }
        catch (e) { b.setAttribute('aria-pressed', String(cur.includes(r))); alert(e.message) }
      })
      card.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
        const act = b.dataset.act
        if (act === 'pw') { const row = $('.pwrow', card); row.hidden = !row.hidden; if (!row.hidden) $('input', row).focus() }
        else if (act === 'pwsave') { try { await patch(id, { password: $('.pwrow input', card).value }); msg.textContent = 'Password changed. They were signed out.'; $('.pwrow input', card).value = ''; $('[data-act=pw]', card).textContent = 'Reset password' } catch (e) { msg.textContent = e.message } }
        else if (act === 'pin') { const row = $('.pinrow', card); row.hidden = !row.hidden; if (!row.hidden) $('input', row).focus() }
        else if (act === 'pinsave' || act === 'pinclear') {
          try { await patch(id, { pin: act === 'pinclear' ? null : $('.pinrow input', card).value }); paint() } catch (e) { alert(e.message) }
        }
        else if (act === 'invite') {
          try {
            const r = await api(`/api/admin/users/${id}/invite`, {}); const url = `${location.origin}/#/join/${r.token}`
            const row = $('.invrow', card); row.hidden = false; const f = $('input', row); f.value = url; f.focus(); f.select()
            if (navigator.share) $('[data-act=share]', row).hidden = false
          } catch (e) { alert(e.message) }
        }
        else if (act === 'copy') { const f = $('.invrow input', card); f.select(); try { await navigator.clipboard.writeText(f.value); b.textContent = 'Copied' } catch { document.execCommand?.('copy'); b.textContent = 'Copied' } setTimeout(() => { b.textContent = 'Copy' }, 2000) }
        else if (act === 'share') navigator.share({ title: 'Flix', text: `Sign in to Flix as ${u().name}`, url: $('.invrow input', card).value }).catch(() => {})
        else if (act === 'role') { try { await patch(id, { isAdmin: !u().is_admin }); paint() } catch (e) { alert(e.message) } }
        else if (act === 'rm') {
          if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to remove'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Remove' }, 4000); return }
          try { await api('/api/admin/users/' + id, null, 'DELETE'); users = users.filter((x) => x.id !== id); paint() } catch (e) { alert(e.message) }
        }
      })
    })
    const nr = $('#newr')
    nr.querySelectorAll('.rpill').forEach((b) => b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')))
    root.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => { const set = PRESETS[b.dataset.preset] ?? all; nr.querySelectorAll('.rpill').forEach((p) => p.setAttribute('aria-pressed', String(set.includes(p.dataset.r)))) })
    $('#uf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target)
      const picked = [...nr.querySelectorAll('.rpill')].filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => p.dataset.r)
      try {
        const u = await api('/api/admin/users', { name: f.get('name'), password: f.get('password'), isAdmin: !!f.get('isAdmin'), allowedRatings: picked })
        users = [...users, { id: u.id, name: u.name, is_admin: !!u.is_admin, allowed: u.allowed, hasPassword: !!f.get('password') }]; paint(); $('#um').textContent = `Added ${u.name}`
      } catch (err) { $('#um').textContent = err.message }
    }
  }
  paint()
}

/** The encoder section: what the box is actually using, and the one choice that matters — how hard it works. */
function playbackSection(tc) {
  if (!tc) return ''
  const enc = tc.encoder === 'libx264' ? 'this CPU (libx264)' : `${tc.encoder} on the GPU`
  // Conversion is on the CPU and simply happens when a file needs it; the switch below decides what is downloaded.
  const rows = [
    ['economy', 'Economy', 'holds two streams at once on this box (4.8x real time at 1080p)'],
    ['balanced', 'Balanced', 'the best picture that still holds one stream (3.6x)'],
    ['best', 'Best', 'needs a faster machine: falls behind real time here (2.2x)'],
  ]
  return `<div id="s-playback" class="ssec"><h2 class="stitle2">Playback</h2>
      <p class="dim" style="max-width:66ch">How hard the box works to convert a file the player cannot take as it is. A file it can play directly is not converted at all, and when only the sound needs it the picture is copied, so this only applies to the rare file whose picture has to be converted. That happens on its own, with nothing to allow.</p>
      <div class="dim" role="status">Converting with <b>${esc(enc)}</b>${tc.steppedDown ? ' · stepped down by itself after falling behind' : ''}</div>
      <form id="tf" class="person"><label class="dim" for="tprofile">Quality</label>
        <select class="field" id="tprofile" name="profile">${rows.map(([v, l, d]) => `<option value="${v}"${tc.profile === v ? ' selected' : ''}>${l} — ${d}</option>`).join('')}</select>
        <label class="dim"><input type="checkbox" id="tnever"${tc.mode === 'off' ? ' checked' : ''}> Only download copies that play as they are (H.264), so nothing has to be converted</label>
        <div class="dim" id="tm2" role="status"></div></form></div>`
}

function settingsPanel(data, root) {
  let btn = data.btn, qbs = data.qb, tm = data.tmdb, om = data.omdb, tc = data.transcode
  const paint = () => {
    const state = btn.configured ? `Key set (ends in <code>${esc(btn.hint)}</code>)${btn.source === 'environment' ? ', from the server environment' : ''}` : 'No key set yet'
    root.innerHTML = `<div id="s-btn" class="ssec"><h2 class="stitle2">BroadcasTheNet</h2>
      <p class="dim" style="max-width:66ch">Flix talks to BTN with an API key, not your BTN username and password. Find the key in your BTN profile settings. BTN also only accepts a key from IP addresses you have approved on their site, so approve this server's address there if the test fails.</p>
      <form id="bf" class="person"><div class="dim" id="bs" role="status">${state}</div>
        <div class="row-form"><input class="field" name="key" type="password" placeholder="Paste API key" autocomplete="off" spellcheck="false">
          <button class="btn primary">Save</button><button type="button" class="btn" id="bt" ${btn.configured ? '' : 'disabled'}>Test connection</button>${btn.source === 'settings' ? '<button type="button" class="btn" id="bc">Remove saved key</button>' : ''}</div>
        <div class="dim" id="bm" role="status"></div></form>
      </div><div id="s-ratings" class="ssec"><h2 class="stitle2">Ratings from IMDb</h2>
      <p class="dim" style="max-width:66ch">Every show's content rating (TV-Y to TV-MA) and IMDb score are looked up automatically, through OMDb, which serves IMDb's data. Get a free key at omdbapi.com (it must be activated from the email they send). Without it Flix falls back to TMDB for the rating, and shows are Unrated when neither knows.</p>
      <form id="of" class="person"><div class="dim">${om.configured ? `Key set (ends in <code>${esc(om.hint)}</code>)${om.source === 'environment' ? ', from the server environment' : ''}` : 'No key set yet'}</div>
        <div class="row-form"><input class="field" name="key" type="password" placeholder="Paste OMDb API key" autocomplete="off" spellcheck="false">
          <button class="btn primary">Save</button><button type="button" class="btn" id="ot" ${om.configured ? '' : 'disabled'}>Test connection</button>${om.source === 'settings' ? '<button type="button" class="btn" id="oc">Remove saved key</button>' : ''}</div>
        <div class="dim" id="om" role="status"></div></form>
      </div><div id="s-tmdb" class="ssec"><h2 class="stitle2">TMDB (recommended)</h2>
      <p class="dim" style="max-width:66ch">A free TMDB v3 API key tells Flix which service each show is on, its language and season lengths, what is trending, and supplies summaries and artwork. It is also the fallback for content ratings.</p>
      <form id="tf" class="person"><div class="dim">${tm.configured ? `Key set (ends in <code>${esc(tm.hint)}</code>)${tm.source === 'environment' ? ', from the server environment' : ''}` : 'No key set yet'}</div>
        <div class="row-form"><input class="field" name="key" type="password" placeholder="Paste TMDB API key" autocomplete="off" spellcheck="false">
          <button class="btn primary">Save</button><button type="button" class="btn" id="tt" ${tm.configured ? '' : 'disabled'}>Test connection</button>${tm.source === 'settings' ? '<button type="button" class="btn" id="tc">Remove saved key</button>' : ''}</div>
        <div class="dim" id="tm" role="status"></div></form>
      </div>${playbackSection(tc)}<div id="s-qb" class="ssec"><h2 class="stitle2">qBittorrent</h2>
      <p class="dim" style="max-width:66ch">qBittorrent is the download engine. Use the address and web-UI login you set up in qBittorrent. Leave the password blank to keep the current one.</p>
      <form id="qf" class="person"><div class="dim">${qbs.passwordSet ? 'Password set' : 'No password set'}${qbs.source === 'environment' ? ', using the server environment' : ''}</div>
        <div class="row-form"><input class="field" name="url" value="${esc(qbs.url)}" placeholder="http://127.0.0.1:8080" autocomplete="off" required>
          <input class="field" name="user" value="${esc(qbs.user)}" placeholder="Username" autocomplete="off" required>
          <input class="field" name="pass" type="password" placeholder="${qbs.passwordSet ? 'Password (unchanged)' : 'Password'}" autocomplete="new-password"></div>
        <div class="row-form"><button class="btn primary">Save</button><button type="button" class="btn" id="qt">Test connection</button>${qbs.source === 'settings' ? '<button type="button" class="btn" id="qc">Use server environment</button>' : ''}</div>
        <div class="dim" id="qm" role="status"></div></form></div>`
    wire()
  }
  const wire = () => {
    const pmsg = (t) => { const el = $('#tm2'); if (el) el.textContent = t }
    const ps = $('#tprofile')
    if (ps) ps.onchange = async () => {
      pmsg('Saving…')
      try { tc = (await api('/api/admin/settings/transcode', { profile: ps.value }, 'PUT')).transcode; paint(); $('#tm2').textContent = 'Saved. Takes effect from the next thing you play.' } catch (err) { pmsg(err.message) }
    }
    const nv = $('#tnever')
    if (nv) nv.onchange = async () => {
      const off = nv.checked
      pmsg('Saving…')
      try {
        tc = (await api('/api/admin/settings/transcode', { mode: off ? 'off' : 'auto' }, 'PUT')).transcode; paint()
        $('#tm2').textContent = off ? 'Saved. Only copies that play as they are are downloaded from now on.' : 'Saved. Any copy may be downloaded; one that needs it is converted on the CPU.'
      } catch (err) { pmsg(err.message) }
    }
    const msg = (t) => { $('#bm').textContent = t }
    $('#bf').onsubmit = async (e) => {
      e.preventDefault(); const key = new FormData(e.target).get('key').trim()
      if (!key) return msg('Paste a key first.')
      try { btn = (await api('/api/admin/settings/btn', { apiKey: key }, 'PUT')).btn; paint(); msg('Saved. Use Test connection to check it.') } catch (err) { msg(err.message) }
    }
    $('#bt').onclick = async () => {
      msg('Testing…')
      try { const r = await api('/api/admin/settings/btn/test', {}); msg(r.username ? `Connected as ${r.username}.` : 'Connected.') } catch (err) { msg(err.message) }
    }
    const omsg = (t) => { $('#om').textContent = t }
    $('#of').onsubmit = async (e) => {
      e.preventDefault(); const key = new FormData(e.target).get('key').trim()
      if (!key) return omsg('Paste a key first.')
      try { om = (await api('/api/admin/settings/omdb', { apiKey: key }, 'PUT')).omdb; paint(); $('#om').textContent = 'Saved. Use Test connection to check it.' } catch (err) { omsg(err.message) }
    }
    $('#ot').onclick = async () => {
      omsg('Testing…')
      try { await api('/api/admin/settings/omdb/test', {}); omsg('OMDb accepted the key.') } catch (err) { omsg(err.message) }
    }
    const oc = $('#oc')
    if (oc) oc.onclick = async () => {
      if (oc.dataset.sure !== '1') { oc.dataset.sure = '1'; oc.textContent = 'Tap again to remove'; setTimeout(() => { oc.dataset.sure = ''; oc.textContent = 'Remove saved key' }, 4000); return }
      try { om = (await api('/api/admin/settings/omdb', { apiKey: '' }, 'PUT')).omdb; paint() } catch (err) { omsg(err.message) }
    }
    const tmsg = (t) => { $('#tm').textContent = t }
    $('#tf').onsubmit = async (e) => {
      e.preventDefault(); const key = new FormData(e.target).get('key').trim()
      if (!key) return tmsg('Paste a key first.')
      try { tm = (await api('/api/admin/settings/tmdb', { apiKey: key }, 'PUT')).tmdb; paint(); $('#tm').textContent = 'Saved. Use Test connection to check it.' } catch (err) { tmsg(err.message) }
    }
    $('#tt').onclick = async () => {
      tmsg('Testing…')
      try { await api('/api/admin/settings/tmdb/test', {}); tmsg('TMDB accepted the key.') } catch (err) { tmsg(err.message) }
    }
    const tc = $('#tc')
    if (tc) tc.onclick = async () => {
      if (tc.dataset.sure !== '1') { tc.dataset.sure = '1'; tc.textContent = 'Tap again to remove'; setTimeout(() => { tc.dataset.sure = ''; tc.textContent = 'Remove saved key' }, 4000); return }
      try { tm = (await api('/api/admin/settings/tmdb', { apiKey: '' }, 'PUT')).tmdb; paint() } catch (err) { tmsg(err.message) }
    }
    const qmsg = (t) => { $('#qm').textContent = t }
    $('#qf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target)
      try { qbs = (await api('/api/admin/settings/qb', { url: f.get('url'), user: f.get('user'), password: f.get('pass') }, 'PUT')).qb; paint(); $('#qm').textContent = 'Saved. Use Test connection to check it.' } catch (err) { qmsg(err.message) }
    }
    $('#qt').onclick = async () => {
      qmsg('Testing…')
      try { const r = await api('/api/admin/settings/qb/test', {}); qmsg(`Connected to qBittorrent ${r.version}.`) } catch (err) { qmsg(err.message) }
    }
    const qc = $('#qc')
    if (qc) qc.onclick = async () => {
      try { qbs = (await api('/api/admin/settings/qb', { reset: true }, 'PUT')).qb; paint() } catch (err) { qmsg(err.message) }
    }
    const bc = $('#bc')
    if (bc) bc.onclick = async () => {
      if (bc.dataset.sure !== '1') { bc.dataset.sure = '1'; bc.textContent = 'Tap again to remove'; setTimeout(() => { bc.dataset.sure = ''; bc.textContent = 'Remove saved key' }, 4000); return }
      try { btn = (await api('/api/admin/settings/btn', { apiKey: '' }, 'PUT')).btn; paint() } catch (err) { msg(err.message) }
    }
  }
  paint()
}

/* ---------- downloads (watch without a connection) ---------- */
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB')

/** Your own account: the little creature, the name, the password. Each part saves on its own. */
function profileView() {
  return () => {
    app.innerHTML = `<div class="pad page-top prof"><h1 class="stitle">Profile</h1>
      <p class="dim" style="margin:4px 0 20px">Everything here is yours alone on this Flix.</p>
      <h2 class="sec" style="margin-top:0">Your creature</h2>
      <div class="avgrid">${AVATARS.map((id) => `<button class="avpick" data-av="${id}" aria-pressed="${me.avatar === id}" aria-label="${id}">${avSvg(id)}</button>`).join('')}</div>
      <p class="dim" id="avmsg" style="margin:8px 0 0;font-size:14px">Tap one to use it beside your name.</p>
      <h2 class="sec">Name</h2>
      <form id="nform" class="pform"><input class="field" name="name" value="${esc(me.name)}" autocomplete="username" maxlength="32" required><button class="btn primary">Save name</button><div class="err" id="nerr" role="alert"></div></form>
      <h2 class="sec">Password</h2>
      <form id="pform" class="pform">${me.hasPassword === false ? '' : '<input class="field" name="current" type="password" placeholder="Current password" autocomplete="current-password" required>'}<input class="field" name="next" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" required><button class="btn primary">Change password</button><div class="err" id="perr" role="alert"></div><p class="dim" style="font-size:14px;margin:2px 0 0">Changing it signs out every other device.</p></form></div>`

    const setMsg = (el, text, bad) => { el.textContent = text; el.classList.toggle('ok', !bad) }
    app.querySelectorAll('.avpick').forEach((b) => b.onclick = async () => {
      const before = me.avatar
      const msg = $('avmsg')
      b.disabled = true
      try {
        me = (await api('/api/me', { avatar: b.dataset.av }, 'PATCH')).user
        app.querySelectorAll('.avpick').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.av === me.avatar)))
        renderTop()
        setMsg(msg, 'Saved.')
      } catch (e) { me.avatar = before; setMsg(msg, e.message, true) } finally { b.disabled = false }
    })
    $('nform').onsubmit = async (e) => {
      e.preventDefault()
      const err = $('nerr'); err.textContent = ''
      const name = new FormData(e.target).get('name')
      try {
        const r = await api('/api/me', { name }, 'PATCH')
        const old = me.name; me = r.user
        rememberProfile(old)
        renderTop()
        err.textContent = 'Name saved.'; err.classList.add('ok')
      } catch (ex) { err.textContent = ex.message; err.classList.remove('ok') }
    }
    $('pform').onsubmit = async (e) => {
      e.preventDefault()
      const err = $('perr'); err.textContent = ''
      const f = new FormData(e.target)
      try {
        await api('/api/me', { currentPassword: f.get('current'), newPassword: f.get('next') }, 'PATCH')
        e.target.reset(); me.hasPassword = true
        err.textContent = 'Password changed. Stay signed in here.'; err.classList.add('ok')
      } catch (ex) { err.textContent = ex.message; err.classList.remove('ok') }
    }
  }
}

/** Episodes saved on this device. With no connection this is the whole app: `offline` swaps the top bar for a notice. */
async function downloadsView(offline = false) {
  const items = await dl.list()
  const space = await dl.usage()
  return () => {
    let alive = true
    const paint = async (list) => {
      const act = [...dl.active.entries()]
      const bySeries = new Map()
      for (const m of list) { if (!bySeries.has(m.seriesId)) bySeries.set(m.seriesId, { name: m.seriesName, eps: [] }); bySeries.get(m.seriesId).eps.push(m) }
      app.innerHTML = `<div class="pad page-top"><h1 class="stitle">Downloads</h1>
        <p class="dim" style="margin:4px 0 18px">${offline ? 'Flix can’t be reached, so this is what is saved on this device.' : 'Saved on this device in 1080p or lower, to watch without a connection.'}${space && list.length ? ` Using ${mb(space.used)}.` : ''}</p>
        ${offline ? '<div class="notice" role="status">You’re offline. <button class="btn" id="rt" style="margin-left:8px;padding:6px 14px">Try to reconnect</button></div>' : ''}
        ${act.length ? `<div class="dl-active">${act.map(([id, a]) => `<div class="dl-row${a.error ? ' err' : ''}"><div class="dl-t"><b>${esc(a.name || 'Download')}</b><span>${esc(a.text)}</span></div>${a.error ? '' : `<div class="prog-line"><i style="width:${Math.round(a.pct * 100)}%"></i></div>`}</div>`).join('')}</div>` : ''}
        ${list.length ? [...bySeries.values()].map((g) => `<h2 class="sec">${esc(g.name || 'Show')}</h2><div class="eps">${g.eps.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map((m) => `
          <div class="ep dl-item" data-id="${esc(m.id)}" role="button" tabindex="0"><span class="thumb"><img class="fade" src="${dl.imgUrl(m.id)}" alt="" onload="this.classList.add('in')" onerror="this.remove()"><span class="play">${I.play}</span>${m.position > 30 && !m.watched ? `<span class="bar"><b style="width:${pct(m.position, m.duration)}%"></b></span>` : ''}</span>
            <span class="etxt"><span class="en">${esc(m.label)}${m.episodeTitle ? ' · ' + esc(m.episodeTitle) : ''}</span><span class="es">${mb(m.size)} · 1080p or lower${m.watched ? ' · Watched' : ''}</span></span>
            <span class="eside"><button class="btn dl-rm" data-id="${esc(m.id)}" aria-label="Delete from this device">Delete</button></span></div>`).join('')}</div>`).join('')
          : act.length ? '' : `<div class="empty">Nothing is saved on this device yet.<br><span class="dim" style="font-size:14px">Open a show and tap the download arrow next to an episode.</span></div>`}</div>`
      app.querySelectorAll('.dl-item').forEach((el) => {
        const open = () => go('#/offplay/' + el.dataset.id)
        el.onclick = open; el.onkeydown = (e) => { if (e.key === 'Enter') open() }
      })
      app.querySelectorAll('.dl-rm').forEach((b) => b.onclick = async (e) => {
        e.stopPropagation()
        if (!confirm('Delete this download from this device?')) return
        await dl.remove(b.dataset.id); if (alive) paint(await dl.list())
      })
      const rt = $('#rt'); if (rt) rt.onclick = () => route()
    }
    top.hidden = offline || !me
    paint(items)
    const on = async () => { if (alive) paint(await dl.list()) }
    addEventListener('flix-dl', on)
    cleanup = () => { alive = false; removeEventListener('flix-dl', on); top.hidden = !me }
  }
}

/** Plays a saved episode straight from this device's storage, so it works with no connection at all. */
async function offlinePlayView(id) {
  const m = await dl.get(id)
  return () => {
    if (!m) { go('#/downloads'); return }
    top.hidden = true
    app.innerHTML = `<div class="player" id="pl"><div class="p-top"><a class="icon-btn" href="#/downloads" aria-label="Back">${I.back}</a><div class="p-title"><b>${esc(m.seriesName || '')}</b><span>${esc(m.label)}${m.episodeTitle ? ' · ' + esc(m.episodeTitle) : ''}</span></div></div>
      <div id="vw"><video controls autoplay playsinline>${m.subs.map((t, i) => `<track kind="${t.forced ? 'forced' : 'subtitles'}" src="${esc(t.url)}" srclang="${esc(t.lang === 'und' ? 'en' : t.lang.slice(0, 2))}" label="${esc(t.label)}"${i === 0 && /^eng?$/.test(t.lang) ? ' default' : ''}>`).join('')}</video></div></div>`
    const pl = $('#pl'), v = $('video')
    let idleT = null, last = 0
    const wake = () => { pl.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (!v.paused) pl.classList.add('idle') }, 3000) }
    pl.addEventListener('mousemove', wake); pl.addEventListener('touchstart', wake, { passive: true }); wake()
    v.src = dl.videoUrl(id)
    if (m.position > 5) v.addEventListener('loadedmetadata', () => { v.currentTime = m.position }, { once: true })
    const save = (ended) => dl.saveProgress(id, v.currentTime, v.duration || m.duration, ended).then(() => syncDownloads()).catch(() => {})
    v.ontimeupdate = () => { if (Date.now() - last > 10000) { last = Date.now(); save(false) } }
    v.onpause = () => save(false)
    v.onended = () => { save(true); go('#/downloads') }
    v.onerror = () => { app.innerHTML = `<div class="pad page-top"><div class="empty err">This download can’t be played any more. Delete it and download it again.<br><br><a class="btn" href="#/downloads">Back</a></div></div>` }
    const key = (e) => { if (e.key === 'Escape') go('#/downloads') }
    addEventListener('keydown', key)
    cleanup = () => { clearTimeout(idleT); removeEventListener('keydown', key); if (v.currentTime) dl.saveProgress(id, v.currentTime, v.duration || m.duration, false).catch(() => {}); top.hidden = !me; if (document.fullscreenElement) document.exitFullscreen?.() }
  }
}

/** What was watched offline goes to the server once it can be reached, so "Continue watching" and "watched" stay right on every device. */
function syncDownloads() {
  return dl.syncPending((m) => api('/api/progress', { torrentId: m.torrentId, fileIndex: m.fileIndex, position: m.pending.position, duration: m.pending.duration, ended: m.pending.ended }))
}
addEventListener('online', () => syncDownloads().catch(() => {}))

/** Shown when Flix can't be reached, instead of a blank page. Retries by itself. */
function offlineView(why, isGate) {
  const admin = `https://${location.hostname}/`
  top.hidden = true
  app.innerHTML = `<div class="auth-wrap"><div class="auth" role="alert"><div class="brand">${I.logo}<span>Flix</span></div>
    <h1 style="text-align:center">${isGate ? 'Umbrel signed you out' : 'Can’t reach Flix'}</h1>
    <p class="dim" style="text-align:center;margin:0">${isGate
      ? 'Flix is installed behind Umbrel’s own login. Sign in to Umbrel, then open Flix again.'
      : 'The Flix server isn’t answering. Check that the Flix app is running in Umbrel, and that this device is online.'}</p>
    <p class="dim" style="text-align:center;margin:0;font-size:13px">${esc(why)}</p>
    ${isGate ? `<a class="btn primary" style="width:100%;display:block;text-align:center;box-sizing:border-box" href="${esc(admin)}">Sign in to Umbrel</a><div style="height:8px"></div>` : ''}
    <button class="btn${isGate ? '' : ' primary'}" id="rt" style="width:100%">Try again</button><div class="dim" style="text-align:center;font-size:13px">Retrying automatically…</div></div></div>`
  $('#rt').onclick = () => route()
  clearTimeout(retryT); retryT = setTimeout(route, isGate ? 15000 : 5000)
}

/** Admins see a red/amber strip on any page when something needs attention (BTN refused us, disk full, engine down). */
const HB_KEY = 'flix.hb.dismissed'
const hbKey = (i) => `${i.level}|${i.title}`
function hbDismissed() { try { return new Set(JSON.parse(sessionStorage.getItem(HB_KEY) || '[]')) } catch { return new Set() } }

async function healthBanner() {
  document.getElementById('hb')?.remove()
  const h = await api('/api/admin/health').catch(() => null)
  const seen = hbDismissed()
  // banner === false: Settings-only issues (reported problems) never get a strip over the page.
  const bad = (h?.issues ?? []).filter((i) => i.level !== 'info' && i.banner !== false && !seen.has(hbKey(i)))
  if (!bad.length || $('.player')) return
  const first = bad[0]
  const el = document.createElement('div')
  el.id = 'hb'; el.className = 'hbanner ' + first.level
  el.innerHTML = `<a class="hbmain" href="${esc(first.link || '#/settings')}"><b>${esc(first.title)}</b> ${esc(first.detail)}${bad.length > 1 ? ` <span>(+${bad.length - 1} more)</span>` : ''}</a><button type="button" class="hbx" aria-label="Dismiss" title="Dismiss">&times;</button>`
  el.querySelector('.hbx').addEventListener('click', () => {
    const s = hbDismissed()
    for (const i of bad) s.add(hbKey(i))
    try { sessionStorage.setItem(HB_KEY, JSON.stringify([...s])) } catch {}
    el.remove()
  })
  app.prepend(el)
}

/* ---------- TVs and keyboards: arrow keys move between things, Back goes back ---------- */
// A text field is a stop like any other: without it here a remote can never reach the search bar, which is what made
// the search field impossible to select on a Google TV.
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex="0"], .tile, input:not([disabled]), textarea:not([disabled]), select:not([disabled])'

/** One metrics pass for a whole press: every stop with its rect read once, and no computed style per element (a remote's
    press used to rebuild this list, read getComputedStyle on every candidate and measure each of them twice -- on a rail
    of 200 posters that is a style recalc and 400 layout reads before the highlight has moved). checkVisibility answers
    "is this drawn" on its own, and the offsetParent test is the fallback for a WebView that has never had it. */
function focusStops() {
  const out = []
  for (const n of document.querySelectorAll(FOCUSABLE)) {
    if (n.closest('[hidden]') || n.classList.contains('arrow')) continue
    if (!(n.checkVisibility?.({ visibilityProperty: true }) ?? (n.offsetParent !== null || getComputedStyle(n).position === 'fixed'))) continue
    const r = n.getBoundingClientRect()
    if (r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight + 400) out.push({ el: n, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 })
  }
  return out
}

/** Stops grouped into rows by where they are, never by what they are: anything whose vertical band overlaps the row, or
    starts within a third of a tile of its first item, is on that row. A rail of posters, a grid, a line of buttons and a
    lone search field all sort the same way, which is what lets Left/Right stay on one line and Up/Down find the next one. */
function focusRows(stops) {
  const rows = []
  for (const s of stops.slice().sort((a, b) => a.r.top - b.r.top)) {
    const row = rows[rows.length - 1]
    const same = row && (s.r.top < row.bottom - 1 || Math.abs(s.r.top - row.top) <= Math.min(s.r.height, row.h) / 3)
    if (!same) { rows.push({ top: s.r.top, bottom: s.r.bottom, h: s.r.height, items: [s] }); continue }
    row.items.push(s); row.bottom = Math.max(row.bottom, s.r.bottom); row.h = Math.max(row.h, s.r.height)
  }
  for (const row of rows) row.cy = (row.top + row.bottom) / 2
  return rows
}

/** Bring a newly highlighted thing into view, and only when it is really cut off. A rail of posters is its own sideways
    scroller, so the tile can be off the rail while the rail is on screen; the page then moves by the least that shows
    it. The old block/inline 'center' glide re-centred the page on every press, so the picture drifted under a highlight
    that had already jumped. On a television both are instant: a glide is a 300ms smear on a remote. */
function revealStop(el) {
  const r = el.getBoundingClientRect()
  // Sideways first, on the rail itself: the tile is brought in with a tile's width to spare on the side it came from,
  // so the next one is always visible beyond it and the rail never stops with the highlight hard against the edge.
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    if (p.scrollWidth <= p.clientWidth + 1 || !/auto|scroll|overlay|hidden/.test(getComputedStyle(p).overflowX)) continue
    const pr = p.getBoundingClientRect(), pad = Math.min(r.width * 0.6, 90)
    const dxs = r.left < pr.left + pad ? r.left - pr.left - pad : r.right > pr.right - pad ? r.right - pr.right + pad : 0
    if (dxs) p.scrollBy({ left: dxs, behavior: isTv ? 'auto' : smooth() })
    break
  }
  // Then the page: only when the row is near an edge, and then by enough to put it a little above the middle, with room
  // for its title below -- rather than the least that shows the poster, which left the row jammed against the bottom
  // with its name cut off. A short eased glide; the highlight itself has already moved, so it never lags the remote.
  const edge = Math.min(140, innerHeight * 0.16)
  if (r.top < edge || r.bottom > innerHeight - edge - 40) {
    const want = r.top + r.height / 2 - innerHeight * 0.42
    scrollBy({ top: want, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
}
// The column the highlight was last moved along, kept across Up and Down so a trip over a short row and back lands where
// it started instead of drifting toward the middle. Cleared by any sideways move or by focus arriving from elsewhere.
let stickyX = null, stickyEl = null

addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || $('.player')) return
  const el = document.activeElement
  const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
  // Back on a remote, while the search field has the keyboard: put the keyboard away first, leave the page alone.
  if ((e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack') && typing) { el.blur(); e.preventDefault(); return }
  if ((e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack') && !typing && location.hash.length > 2) { history.back(); return }
  const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]
  if (!dir || typing) return
  const onThing = el && el !== document.body
  if (!onThing && !isTv) return // on a computer with nothing focused, arrows keep scrolling the page
  const rows = focusRows(focusStops())
  if (!rows.length) return
  const [dx, dy] = dir
  const from = onThing ? el.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
  const oy = from.top + from.height / 2
  const ox = dy && stickyX != null && stickyEl === el ? stickyX : from.left + from.width / 2
  // The row the highlight is on; with nothing focused yet (a television that has just drawn the page) the row nearest the
  // middle of the screen stands in for it, so a first press still lands somewhere.
  const cur = (onThing && rows.find((row) => row.items.some((s) => s.el === el))) || rows.reduce((a, b) => (Math.abs(b.cy - oy) < Math.abs(a.cy - oy) ? b : a))
  let best = null, bestScore = Infinity
  if (dx) {
    // Left/Right stays on this row: the nearest thing beside us, and never a diagonal jump into another rail.
    for (const s of cur.items) {
      if (s.el === el) continue
      const along = (s.cx - ox) * dx
      if (along <= 4) continue
      const score = along + Math.abs(s.cy - oy) * 0.25
      if (score < bestScore) { bestScore = score; best = s.el }
    }
  } else {
    // Up/Down goes to the next row in that direction -- the nearest one, not any row in the half of the page -- and takes
    // the thing nearest our own column in it.
    let row = null, rowGap = Infinity
    for (const r of rows) {
      if (r === cur) continue
      const gap = (r.cy - cur.cy) * dy
      if (gap <= 4 || gap >= rowGap) continue
      rowGap = gap; row = r
    }
    for (const s of row?.items ?? []) {
      const score = Math.abs(s.cx - ox)
      if (score < bestScore) { bestScore = score; best = s.el }
    }
  }
  if (!best) return
  e.preventDefault()
  best.focus({ preventScroll: true })
  stickyX = dy ? ox : null; stickyEl = dy ? best : null
  revealStop(best)
  // A remote's OK on a text field has to raise the on-screen keyboard: the focus above happens inside a key event, which
  // is what lets a WebView show it, but a field that already had focus never raises it again.
  if (/^(INPUT|TEXTAREA)$/.test(best.tagName)) { try { best.setSelectionRange?.(best.value.length, best.value.length) } catch {} }
})

/* ---------- router ---------- */
// The page the player was opened from, kept across one episode handing over to the next, so leaving the player can step
// back to it instead of stacking another copy of the show page on the history.
let lastHash = null, playerOrigin = null
async function route() {
  cleanup?.(); cleanup = null
  clearTimeout(retryT)
  const fromHash = lastHash
  lastHash = location.hash
  if (location.hash.startsWith('#/play/') && !fromHash?.startsWith('#/play/')) playerOrigin = fromHash
  const token = ++navToken
  let st
  try { st = await api('/api/me', null, 'GET', 15000) } catch (e) {
    if (token !== navToken) return
    // Can't reach Flix but there are episodes saved on this device: that is what the app shows, and they play without the server.
    if (!e.gate && (await dl.list()).length) {
      const [p0, p1] = location.hash.slice(1).split('?')[0].split('/').filter(Boolean)
      const render = p0 === 'offplay' && p1 ? await offlinePlayView(p1) : await downloadsView(true)
      if (token !== navToken) return
      clearTimeout(retryT); retryT = setTimeout(() => { if (!$('video')) route() }, 15000)
      return swap(render)
    }
    offlineView(e.message, !!e.gate)
    return
  }
  me = st.user
  myState = st
  if (me && !profiles().some((p) => p.name === me.name)) rememberProfile()
  renderTop()
  syncDownloads().catch(() => {})
  top.classList.toggle('solid', scrollY > 30)
  const [path, query] = location.hash.slice(1).split('?')
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'join' && parts[1]) return swap(joinView(parts[1]))
  if (parts[0] === 'profiles' && profiles().length) return swap(profilesView())
  if (!me || parts[0] === 'signin') { if (token === navToken) return swap(authView(!me && st.needsSetup)); return }
  // A shared device asks who is watching each time the app is opened.
  if (profiles().length > 1 && !picked() && parts[0] !== 'play' && parts[0] !== 'offplay') { markPicked(); return swap(profilesView()) }
  // Opening a show can take a moment on the server. Show the placeholder at once rather than leave the old page up, which looks like the tap did nothing.
  const slow = setTimeout(() => { if (token === navToken) { window.scrollTo({ top: 0, behavior: 'instant' }); app.innerHTML = skeleton() } }, app.innerHTML.trim() ? 120 : 200)
  try {
    let render
    if (parts[0] === 'series') render = await seriesView(parts[1])
    else if (parts[0] === 'play') render = playView(parts[1], parts[2], parts[3])
    else if (parts[0] === 'profile') render = profileView()
    else if (parts[0] === 'downloads') render = await downloadsView()
    else if (parts[0] === 'offplay' && parts[1]) render = await offlinePlayView(parts[1])
    else if ((parts[0] === 'settings' || parts[0] === 'admin') && me.is_admin) render = await settingsView(parts[0] === 'admin' ? LEGACY_SECTION[parts[1] ?? ''] ?? 'torrents' : SETTINGS_PILLS.some(([id]) => id === parts[1]) ? parts[1] : 'torrents')
    else render = await homeView(new URLSearchParams(query).get('q'))
    clearTimeout(slow)
    if (token !== navToken) return
    await swap(render)
    if (me.is_admin && parts[0] !== 'play') healthBanner()
  } catch (e) {
    clearTimeout(slow)
    if (token === navToken) app.innerHTML = `<div class="pad page-top"><div class="empty err">${esc(e.message)}</div></div>`
  }
}
addEventListener('hashchange', route)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
route()

/**
 * Report what the player felt, so a hitch has a time on both ends: the browser knows it ran dry and when, the server knows
 * who it was waiting on. Only a stall, a seek and a coarse resolution change are sent -- never every tick -- so this costs
 * a handful of small requests an evening and nothing while the picture is fine.
 */
function watchStalls(v, getPlay) {
  let last = 0
  let waitingSince = 0
  const send = (kind, extra) => {
    const now = Date.now()
    if (now - last < 1500) return // a stall fires waiting, stalled and suspend in a burst; one report is the story
    last = now
    const ahead = (() => { try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) return Math.round((v.buffered.end(i) - v.currentTime) * 10) / 10; return 0 } catch { return 0 } })()
    api('/api/diag/client', { kind, at: Math.round(v.currentTime * 10) / 10, bufferedAhead: ahead, height: v.videoHeight || null, width: v.videoWidth || null, paused: v.paused, readyState: v.readyState, torrentId: getPlay?.()?.torrentId ?? null, fileIndex: getPlay?.()?.fileIndex ?? null, ...extra }).catch(() => {})
  }
  v.addEventListener('waiting', () => { waitingSince = Date.now(); send('stall') })
  v.addEventListener('stalled', () => send('stalled'))
  v.addEventListener('seeking', () => send('seek'))
  v.addEventListener('error', () => send('error', { code: v.error?.code ?? null, message: String(v.error?.message ?? '').slice(0, 120) }))
  v.addEventListener('playing', () => { if (waitingSince && Date.now() - waitingSince > 400) send('recovered', { stalledForMs: Date.now() - waitingSince }); waitingSince = 0 })
  // A resolution the browser settled on well below the file's told us it fell back to a lower rendition.
  let lowest = null
  v.addEventListener('resize', () => { const h = v.videoHeight || 0; if (h && (lowest == null || h < lowest)) { lowest = h; if (h <= 480) send('low-res', {}) } })
}
