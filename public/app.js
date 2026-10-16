const $ = (s, el = document) => el.querySelector(s)
const app = $('#app'), top = $('#top')
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
let me = null, cleanup = null, navToken = 0, retryT = null
window.__flixBooted = true

async function api(path, body, method, timeoutMs) {
  const res = await fetch(path, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const gb = (n) => (n / 1073741824).toFixed(2) + ' GB'
const mbps = (n) => (n / 1048576).toFixed(1) + ' MB/s'
const go = (h) => { location.hash = h }
const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
const pct = (p, d) => Math.min(100, Math.round((p / (d || 1)) * 100))

const I = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  // The F's middle arm is a play button. Same artwork as /icon.svg.
  logo: '<svg viewBox="0 0 512 512" aria-hidden="true"><defs><linearGradient id="fxl-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset=".5" stop-color="#ff3d6e"/><stop offset="1" stop-color="#b8155a"/></linearGradient><radialGradient id="fxl-hl" cx=".25" cy="0" r="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="512" height="512" rx="118" fill="url(#fxl-bg)"/><rect width="512" height="512" rx="118" fill="url(#fxl-hl)"/><g fill="#fff"><rect x="140" y="116" width="76" height="280" rx="38"/><rect x="140" y="116" width="232" height="76" rx="38"/><path transform="translate(242 287) scale(.906) translate(-242 -287)" d="M242 228c0-16 17-26 31-18l102 59c14 8 14 28 0 36l-102 59c-14 8-31-2-31-18z"/></g></svg>',
}

/** A poster-shaped block: generated colour + title underneath, real artwork fades in over it once loaded. */
const art = (url, name) => `<div class="poster ph" style="--h:${hue(name)}"><span class="ph-t">${esc(name)}</span>${url ? `<img class="fade" loading="lazy" src="${esc(url)}" alt="" onload="this.classList.add('in')" onerror="this.remove()">` : ''}</div>`

/** Set a hero backdrop: banner if it exists, otherwise a blurred poster. */
function backdrop(el, banner, poster) {
  const load = (u, cls) => new Promise((ok, no) => { if (!u) return no(); const i = new Image(); i.onload = () => ok(u); i.onerror = no; i.src = u }).then((u) => { el.style.backgroundImage = `url("${u}")`; el.className = 'bd ' + cls; requestAnimationFrame(() => el.classList.add('in')) })
  load(banner, '').catch(() => load(poster, 'blur')).catch(() => {})
}

/** Swap the page with a cross-fade when the browser supports View Transitions. */
async function swap(fn) {
  window.scrollTo(0, 0)
  if (!reduce && document.startViewTransition) { try { await document.startViewTransition(fn).updateCallbackDone; return } catch { /* fall through */ } }
  fn()
}

function skeleton() {
  return `<div class="pad page-top"><div class="skel" style="height:min(46vh,380px);margin-bottom:28px"></div><div style="display:flex;gap:18px;overflow:hidden">${'<div class="skel" style="flex:none;width:168px;aspect-ratio:2/3"></div>'.repeat(8)}</div></div>`
}

/* ---------- top bar ---------- */
function renderTop() {
  if (!me) { top.hidden = true; return }
  top.hidden = false
  top.innerHTML = `<a class="brand" href="#/" aria-label="Flix home">${I.logo}<span>Flix</span></a><span class="sp"></span>
    <form class="search" id="sf" role="search">${I.search}<input id="q" type="search" placeholder="Search shows" aria-label="Search shows" autocomplete="off"></form>
    <button class="avatar" id="av" aria-label="Account menu" aria-haspopup="true">${esc(me.name[0].toUpperCase())}</button>`
  const q = $('#q'), sf = $('#sf')
  const cur = new URLSearchParams((location.hash.split('?')[1]) || '').get('q')
  if (cur) { q.value = cur; sf.classList.add('has') }
  q.oninput = () => sf.classList.toggle('has', !!q.value)
  sf.onsubmit = (e) => { e.preventDefault(); go('#/?q=' + encodeURIComponent(q.value.trim())); q.blur() }
  $('#av').onclick = (e) => {
    e.stopPropagation()
    const old = $('.menu'); if (old) return old.remove()
    const m = document.createElement('div'); m.className = 'menu'
    m.innerHTML = `<div class="who">Signed in as <b>${esc(me.name)}</b></div>${me.is_admin ? '<a href="#/admin">Downloads</a><a href="#/admin/family">Family &amp; ratings</a><a href="#/admin/settings">Settings</a>' : ''}<button id="lo">Sign out</button>`
    top.appendChild(m)
    $('#lo').onclick = async () => { await api('/api/logout', {}); me = null; route() }
    m.querySelectorAll('a').forEach((a) => a.onclick = () => m.remove())
  }
}
addEventListener('click', () => $('.menu')?.remove())
addEventListener('scroll', () => top.classList.toggle('solid', scrollY > 30), { passive: true })

/* ---------- auth ---------- */
function authView(needsSetup) {
  return () => {
    app.innerHTML = `<div class="auth-wrap"><form class="auth"><div class="brand">${I.logo}<span>Flix</span></div>
      <h1 style="text-align:center">${needsSetup ? 'Create the admin account' : 'Welcome back'}</h1>
      <input class="field" name="name" placeholder="Username" autocomplete="username" required>
      <input class="field" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required>
      <button class="btn primary" style="width:100%">${needsSetup ? 'Create account' : 'Sign in'}</button><div class="err" id="err" role="alert"></div></form></div>`
    $('form').onsubmit = async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      try { await api(needsSetup ? '/api/signup' : '/api/login', { name: f.get('name'), password: f.get('password') }); route() } catch (err) { $('#err').textContent = err.message }
    }
  }
}

/* ---------- home ---------- */
const tile = (s, i) => `<a class="tile rise" style="--i:${Math.min(i, 12)}" href="#/series/${s.id}">${art(s.poster, s.name)}<div class="tt">${esc(s.name)}</div></a>`
const contTile = (c, i) => `<button class="tile rise" style="--i:${Math.min(i, 12)}" data-s="${c.seriesId}" data-season="${c.season ?? ''}" data-label="${esc(c.label)}">
  <div style="position:relative">${art(c.poster, c.series)}<div class="prog"><b style="width:${pct(c.position, c.duration)}%"></b></div></div><div class="tt">${esc(c.series)}</div><div class="ts">${esc(c.label)}</div></button>`

function rowOf(items, html) {
  return `<div class="rowwrap"><button class="arrow l" aria-label="Scroll left">${I.back}</button><div class="row-scroll">${items.map(html).join('')}</div><button class="arrow r" aria-label="Scroll right">${I.next}</button></div>`
}
function wireRows(root) {
  root.querySelectorAll('.rowwrap').forEach((w) => {
    const sc = $('.row-scroll', w)
    $('.arrow.l', w).onclick = () => sc.scrollBy({ left: -sc.clientWidth * 0.85, behavior: 'smooth' })
    $('.arrow.r', w).onclick = () => sc.scrollBy({ left: sc.clientWidth * 0.85, behavior: 'smooth' })
  })
  root.querySelectorAll('.tile[data-s]').forEach((b) => b.onclick = () => go(`#/play/${b.dataset.s}/${b.dataset.season || 'x'}/${encodeURIComponent(b.dataset.label)}`))
}

async function homeView(q) {
  const [{ series }, cont] = await Promise.all([api('/api/series' + (q ? '?q=' + encodeURIComponent(q) : '')), q ? { items: [] } : api('/api/continue')])
  const items = cont.items
  return () => {
    let html = ''
    if (!q && (items[0] || series[0])) {
      const c = items[0], s = c ? { id: c.seriesId, name: c.series } : series[0]
      html += `<section class="hero"><div class="bd" id="hbd"></div><div class="hero-in pad"><div class="eyebrow rise">${c ? 'Continue watching' : 'New on BroadcasTheNet'}</div>
        <h1 class="rise" style="--i:1">${esc(s.name)}</h1><p class="sub rise" style="--i:2">${c ? esc(c.label) + ' · ' + pct(c.position, c.duration) + '% watched' : 'Tap to see episodes'}</p>
        <div class="actions rise" style="--i:3">${c ? `<button class="btn primary" id="hp">${I.play} Resume</button>` : `<a class="btn primary" href="#/series/${s.id}">${I.play} Watch now</a>`}
        <a class="btn" href="#/series/${s.id}">${I.info} Details</a></div></div></section>`
    } else html += '<div class="page-top"></div>'
    html += '<div class="pad">'
    if (items.length) html += `<h2 class="sec">Continue watching</h2>${rowOf(items, contTile)}`
    if (q) html += `<h2 class="sec" style="margin-top:0">Results for “${esc(q)}”</h2>` + (series.length ? `<div class="grid">${series.map(tile).join('')}</div>` : '<div class="empty">No shows found. Try a different spelling.</div>')
    else html += `<h2 class="sec">New on BroadcasTheNet</h2>` + (series.length ? rowOf(series, tile) : '<div class="empty">Nothing here yet.</div>')
    html += '</div>'
    app.innerHTML = html
    wireRows(app)
    const hs = !q && (items[0] ? { id: items[0].seriesId } : series[0])
    if (hs) backdrop($('#hbd'), `/api/art/${hs.id}/banner`, `/api/art/${hs.id}/poster`)
    const hp = $('#hp'); if (hp) hp.onclick = () => go(`#/play/${items[0].seriesId}/${items[0].season ?? 'x'}/${encodeURIComponent(items[0].label)}`)
  }
}

/* ---------- series ---------- */
async function seriesView(id) {
  const { series, episodes } = await api('/api/series/' + id)
  const seasons = new Map()
  for (const e of episodes) { const k = e.season ?? 'x'; if (!seasons.has(k)) seasons.set(k, []); seasons.get(k).push(e) }
  const resume = episodes.find((e) => e.position > 30 && !e.watched)
  const hero = resume ?? episodes.find((e) => !e.watched && e.available)
  const keys = [...seasons.keys()]
  let cur = hero ? (hero.season ?? 'x') : keys[keys.length - 1]
  const go1 = (e) => go(`#/play/${id}/${e.season ?? 'x'}/${encodeURIComponent(e.label)}`)
  return () => {
    app.innerHTML = `<section class="s-hero"><div class="bd" id="sbd"></div><div class="s-in pad">${art(series.poster, series.name)}
      <div class="s-meta"><h1 class="rise">${esc(series.name)}</h1>
      <div class="line rise" style="--i:1"><span class="chip" id="rchip" title="${series.source === 'admin' ? 'Set by an admin' : series.source === 'tmdb' ? 'From TMDB' : 'No rating known'}">${esc(series.rating || 'Unrated')}</span><span>${episodes.length} episode${episodes.length === 1 ? '' : 's'}</span>${keys.length > 1 ? `<span>${keys.length} seasons</span>` : ''}
        ${me.is_admin ? `<label class="dim" style="font-size:13px">Rating <select id="rsel" class="field" style="width:auto;padding:6px 10px;display:inline-block"><option value="auto">Automatic</option>${['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Unrated'].map((r) => `<option ${series.source === 'admin' && series.rating === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>` : ''}</div>
      <div class="rise" style="--i:2;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        ${hero ? `<button class="btn primary" id="hp">${I.play} ${resume ? 'Resume' : 'Play'} ${esc(hero.label)}</button>` : '<span class="dim">Nothing is available to play right now.</span>'}
        ${series.trailer ? `<a class="trailer-link" href="${esc(series.trailer)}" target="_blank" rel="noopener noreferrer">${I.play} Trailer</a>` : ''}</div></div></div></section>
      <div class="pad"><div class="pills" role="tablist" aria-label="Seasons">${keys.map((k) => `<button class="pill" role="tab" data-k="${k}" aria-selected="${k === cur}">${k === 'x' ? 'Episodes' : 'Season ' + k}</button>`).join('')}</div><div class="eps" id="eps"></div></div>`
    backdrop($('#sbd'), `/api/art/${id}/banner`, `/api/art/${id}/poster`)
    const paint = () => {
      $('#eps').innerHTML = (seasons.get(cur) ?? []).map((e, i) => `<button class="ep rise" style="--i:${Math.min(i, 14)}" data-i="${i}" ${e.available ? '' : 'disabled'}>
        <span class="play">${I.play}</span><span><span class="en">${esc(e.label)}</span><br>
        <span class="es">${e.available ? (e.onServer ? 'Ready to watch' : '') : 'Not available right now'}</span></span>
        <span>${e.watched ? `<span class="tick">${I.check} Watched</span>` : ''}</span>${e.position > 30 && !e.watched ? `<span class="bar"><b style="width:${pct(e.position, e.duration)}%"></b></span>` : ''}</button>`).join('')
      $('#eps').querySelectorAll('.ep').forEach((b) => b.onclick = () => go1(seasons.get(cur)[+b.dataset.i]))
    }
    paint()
    app.querySelectorAll('.pill').forEach((p) => p.onclick = () => {
      cur = p.dataset.k === 'x' ? 'x' : +p.dataset.k
      app.querySelectorAll('.pill').forEach((x) => x.setAttribute('aria-selected', String(x === p)))
      paint()
    })
    const hp = $('#hp'); if (hp) hp.onclick = () => go1(hero)
    const rs = $('#rsel'); if (rs) rs.onchange = async () => {
      try { const r = await api(`/api/admin/series/${id}/rating`, { rating: rs.value === 'auto' ? null : rs.value }, 'PUT'); $('#rchip').textContent = r.rating } catch (e) { alert(e.message) }
    }
  }
}

/* ---------- player ---------- */
function playView(seriesId, season, label) {
  label = decodeURIComponent(label)
  return () => {
    app.innerHTML = `<div class="player" id="pl"><div class="p-bg" id="pbg"></div>
      <div class="p-top"><a class="icon-btn" href="#/series/${seriesId}" aria-label="Back">${I.back}</a><div class="p-title"><b id="pt">${esc(label)}</b><span id="pe"></span></div><span class="sp"></span><span class="chip" id="q" style="color:#fff;border-color:rgba(255,255,255,.3)" hidden></span></div>
      <div id="vw"></div>
      <div class="p-wait" id="wait"><img class="art" id="wart" alt="" hidden><div class="ring"></div><div id="msg">Getting your show ready…</div><div class="pline"><i id="pb"></i></div></div></div>`
    top.hidden = true
    const pl = $('#pl')
    $('#pbg').style.backgroundImage = `url("/api/art/${seriesId}/poster")`
    const wa = $('#wart'); wa.onload = () => { wa.hidden = false }; wa.src = `/api/art/${seriesId}/poster`
    let alive = true, hls = null, timer = null, idleT = null, cdT = null
    const wake = () => { pl.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { const v = $('video'); if (v && !v.paused) pl.classList.add('idle') }, 3000) }
    pl.addEventListener('mousemove', wake); pl.addEventListener('touchstart', wake, { passive: true }); wake()
    cleanup = () => { alive = false; clearInterval(timer); clearInterval(cdT); clearTimeout(idleT); hls?.destroy(); top.hidden = !me }
    const t0 = Date.now()
    ;(async () => {
      try {
        const play = await api('/api/watch', { seriesId: +seriesId, season: season === 'x' ? null : +season, label })
        if (!alive) return
        const { torrentId, fileIndex, position: start } = play
        $('#pt').textContent = play.seriesName || label; $('#pe').textContent = label
        const qc = $('#q'); qc.textContent = play.quality; qc.hidden = false
        const base = `/api/stream/${torrentId}/${fileIndex}`
        timer = setInterval(async () => {
          const s = await api(base + '/status').catch(() => null)
          if (!alive || !s || s.error) return
          $('#pb').style.width = Math.max(4, s.bufferedPct) + '%'
          $('#msg').textContent = Date.now() - t0 > 25000 && s.bufferedPct < 10 ? 'Still looking for a fast source… this can take a minute.' : 'Getting your show ready…'
        }, 1000)
        const info = await api(base + '/info')
        if (!alive) return
        $('#vw').innerHTML = '<video controls autoplay playsinline></video>'
        const v = $('video')
        v.addEventListener('playing', () => { $('#wait').classList.add('gone'); wake() }, { once: true })
        v.addEventListener('pause', () => pl.classList.remove('idle'))
        v.addEventListener('play', wake)
        if (info.mode === 'hls' && window.Hls?.isSupported()) {
          hls = new Hls({ maxBufferLength: 60 })
          hls.loadSource(info.url); hls.attachMedia(v)
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); fail('Something went wrong playing this. Go back and try again.') } })
        } else v.src = info.url
        if (start > 5) v.addEventListener('loadedmetadata', () => { v.currentTime = start }, { once: true })
        let last = 0
        const report = () => { if (!isFinite(v.duration) && !info.duration) return; api('/api/progress', { torrentId, fileIndex, position: v.currentTime, duration: info.duration || v.duration }).catch(() => {}) }
        v.ontimeupdate = () => { if (Date.now() - last > 10000) { last = Date.now(); report() } }
        v.onpause = report
        v.onended = () => {
          report()
          if (!play.next) return go(`#/series/${seriesId}`)
          const nx = play.next, target = `#/play/${seriesId}/${nx.season ?? 'x'}/${encodeURIComponent(nx.label)}`
          const box = document.createElement('div'); box.className = 'p-next'
          box.innerHTML = `<small>Up next</small><b>${esc(nx.label)}</b><div class="actions"><button class="btn primary" id="nn">${I.play} Play now</button><button class="btn" id="nc">Not now</button></div><div class="cd"><i id="cdb"></i></div>`
          pl.appendChild(box)
          const bar = $('#cdb'); let left = 8
          bar.style.transition = `transform ${left}s linear`; requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)' }))
          cdT = setInterval(() => { if (--left <= 0) { clearInterval(cdT); go(target) } }, 1000)
          $('#nn').onclick = () => go(target)
          $('#nc').onclick = () => { clearInterval(cdT); box.remove() }
        }
      } catch (e) { fail(e.message) }
    })()
    function fail(msg) { if (!alive) return; clearInterval(timer); $('.ring')?.remove(); $('#wait').classList.remove('gone'); $('#msg').innerHTML = `<span style="color:#ff8a98">${esc(msg)}</span>`; $('#pb').parentElement.remove() }
  }
}

/* ---------- admin ---------- */
const PRESETS = { Kids: ['TV-Y', 'TV-Y7', 'TV-G'], Teens: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'], Everything: null }
const RATING_HELP = { 'TV-Y': 'All children', 'TV-Y7': 'Ages 7+', 'TV-G': 'General audience', 'TV-PG': 'Parental guidance', 'TV-14': 'Ages 14+', 'TV-MA': 'Mature, 17+', Unrated: 'No rating known' }

function ratingPills(all, on, attrs = '') {
  return `<div class="rpills" ${attrs}>${all.map((r) => `<button type="button" class="rpill" data-r="${esc(r)}" aria-pressed="${on.includes(r)}" title="${esc(RATING_HELP[r] || '')}">${esc(r)}</button>`).join('')}</div>`
}

async function adminView(tab = 'downloads') {
  const data = await api(tab === 'family' ? '/api/admin/users' : tab === 'settings' ? '/api/admin/settings' : '/api/admin/downloads')
  return () => {
    app.innerHTML = `<div class="pad page-top"><div class="pills" role="tablist" aria-label="Admin sections" style="margin-bottom:8px">
      <a class="pill" role="tab" href="#/admin" aria-selected="${tab === 'downloads'}">Downloads</a><a class="pill" role="tab" href="#/admin/family" aria-selected="${tab === 'family'}">Family</a><a class="pill" role="tab" href="#/admin/settings" aria-selected="${tab === 'settings'}">Settings</a></div><div id="adm-body"></div></div>`
    ;(tab === 'family' ? familyPanel : tab === 'settings' ? settingsPanel : downloadsPanel)(data, $('#adm-body'))
  }
}

function downloadsPanel(data, root) {
  root.innerHTML = `<h1 style="font-size:32px">Downloads</h1>
    <p class="dim" style="max-width:62ch">A show stays on the server until everyone has watched it <b style="color:var(--fg)">and</b> BroadcasTheNet's rule is met: ${data.requirements.minHours} hours seeded <b style="color:var(--fg)">or</b> a ${data.requirements.minRatio}:1 ratio. This can't be changed.</p>
    <div class="card-box" id="adm"></div>`
  const draw = (d) => {
    const rows = d.downloads.map((x) => {
      const active = x.state === 'active'
      return `<tr><td><b>${esc(x.series)}</b><br><span class="dim">${esc(x.group_name)} ${esc(x.resolution || '')}</span></td>
      <td>${x.progress !== undefined ? Math.round(x.progress * 100) + '%' + (x.dlspeed ? '<br><span class="dim">' + mbps(x.dlspeed) + '</span>' : '') : '—'}</td>
      <td>${x.ratio !== undefined ? `<div class="meter">Ratio ${x.ratio.toFixed(2)} / ${d.requirements.minRatio}<div class="m"><i style="width:${Math.min(100, x.ratio * 100)}%"></i></div></div>
        <div class="meter">${x.seedHours.toFixed(1)} h / ${d.requirements.minHours} h<div class="m"><i style="width:${Math.min(100, (x.seedHours / d.requirements.minHours) * 100)}%"></i></div></div>` : ''}</td>
      <td>${active ? (x.deletable ? '<span class="badge ok">will be removed</span>' : '<span class="badge warn">kept</span>') : '<span class="badge dim">removed</span>'}</td>
      <td class="dim">${active ? esc((x.reasons || []).join('; ')) : esc(x.remove_reason || '')}</td>
      <td>${active ? `<button class="btn" data-rm="${x.torrent_id}" style="padding:7px 12px">Remove</button>` : ''}</td></tr>`
    }).join('')
    $('#adm').innerHTML = `<table><thead><tr><th>Show</th><th>Download</th><th>BTN requirement</th><th>Status</th><th>Why</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Nothing downloaded yet.</td></tr>'}</tbody></table>`
    $('#adm').querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
      try { await api('/api/admin/downloads/' + b.dataset.rm, null, 'DELETE'); draw(await api('/api/admin/downloads')) } catch (e) { b.textContent = e.message.includes('requirement') ? 'Not yet' : 'Failed'; b.disabled = true }
    })
  }
  draw(data)
  const t = setInterval(async () => draw(await api('/api/admin/downloads').catch(() => data)), 15000)
  cleanup = () => clearInterval(t)
}

function familyPanel(data, root) {
  const all = data.ratings
  let users = data.users
  const onList = (u) => u.allowed ?? all
  const paint = () => {
    root.innerHTML = `<h1 style="font-size:32px">Family</h1>
      <p class="dim" style="max-width:66ch">Only you can add people. Choose which ratings each person can watch; anything above their level is hidden completely. Shows with no known rating count as <b style="color:var(--fg)">Unrated</b>, so turn that off for kids.</p>
      ${data.ratingLookup ? '' : '<p class="notice">Ratings are not looked up automatically yet. Set <code>TMDB_API_KEY</code>, or set each show\'s rating yourself on its page.</p>'}
      <div class="people">${users.map((u) => `<div class="person rise" data-id="${u.id}">
        <div class="who"><span class="avatar" style="width:44px;height:44px;cursor:default">${esc(u.name[0].toUpperCase())}</span><div><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="chip">You</span>' : ''}${u.is_admin ? ' <span class="chip">Admin</span>' : ''}
        <div class="dim" style="font-size:13px">${u.is_admin ? 'Admins can watch everything' : u.allowed ? 'Limited' : 'Everything'}</div></div></div>
        <div class="rcell">${u.is_admin ? '<span class="dim">All ratings</span>' : ratingPills(all, onList(u))}</div>
        <div class="pact"><button class="btn" data-act="pw" style="padding:8px 14px">Reset password</button>
        ${u.id === me.id ? '' : `<button class="btn" data-act="role" style="padding:8px 14px">${u.is_admin ? 'Remove admin' : 'Make admin'}</button><button class="btn" data-act="rm" style="padding:8px 14px">Remove</button>`}</div>
        <div class="pwrow" hidden><input class="field" type="password" placeholder="New password (8+ characters)" autocomplete="new-password"><button class="btn primary" data-act="pwsave" style="padding:10px 16px">Save</button><span class="dim msg"></span></div></div>`).join('')}</div>
      <h2 class="sec">Add a family member</h2>
      <form id="uf" class="person"><div class="row-form"><input class="field" name="name" placeholder="Username" autocomplete="off" required><input class="field" name="password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password" required></div>
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
        else if (act === 'pwsave') { try { await patch(id, { password: $('.pwrow input', card).value }); msg.textContent = 'Password changed. They were signed out.'; $('.pwrow input', card).value = '' } catch (e) { msg.textContent = e.message } }
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
        users = [...users, { id: u.id, name: u.name, is_admin: !!u.is_admin, allowed: u.allowed }]; paint(); $('#um').textContent = `Added ${u.name}`
      } catch (err) { $('#um').textContent = err.message }
    }
  }
  paint()
}

function settingsPanel(data, root) {
  let btn = data.btn, qbs = data.qb, tm = data.tmdb
  const paint = () => {
    const state = btn.configured ? `Key set (ends in <code>${esc(btn.hint)}</code>)${btn.source === 'environment' ? ', from the server environment' : ''}` : 'No key set yet'
    root.innerHTML = `<h1 style="font-size:32px">Settings</h1>
      <h2 class="sec">BroadcasTheNet</h2>
      <p class="dim" style="max-width:66ch">Flix talks to BTN with an API key, not your BTN username and password. Find the key in your BTN profile settings. BTN also only accepts a key from IP addresses you have approved on their site, so approve this server's address there if the test fails.</p>
      <form id="bf" class="person"><div class="dim" id="bs" role="status">${state}</div>
        <div class="row-form"><input class="field" name="key" type="password" placeholder="Paste API key" autocomplete="off" spellcheck="false">
          <button class="btn primary">Save</button><button type="button" class="btn" id="bt" ${btn.configured ? '' : 'disabled'}>Test connection</button>${btn.source === 'settings' ? '<button type="button" class="btn" id="bc">Remove saved key</button>' : ''}</div>
        <div class="dim" id="bm" role="status"></div></form>
      <h2 class="sec">TMDB (optional)</h2>
      <p class="dim" style="max-width:66ch">A free TMDB v3 API key lets Flix look up each show's content rating (TV-Y to TV-MA) automatically. Without one, you set ratings by hand on each show's page.</p>
      <form id="tf" class="person"><div class="dim">${tm.configured ? `Key set (ends in <code>${esc(tm.hint)}</code>)${tm.source === 'environment' ? ', from the server environment' : ''}` : 'No key set yet'}</div>
        <div class="row-form"><input class="field" name="key" type="password" placeholder="Paste TMDB API key" autocomplete="off" spellcheck="false">
          <button class="btn primary">Save</button><button type="button" class="btn" id="tt" ${tm.configured ? '' : 'disabled'}>Test connection</button>${tm.source === 'settings' ? '<button type="button" class="btn" id="tc">Remove saved key</button>' : ''}</div>
        <div class="dim" id="tm" role="status"></div></form>
      <h2 class="sec">qBittorrent</h2>
      <p class="dim" style="max-width:66ch">qBittorrent is the download engine. Use the address and web-UI login you set up in qBittorrent. Leave the password blank to keep the current one.</p>
      <form id="qf" class="person"><div class="dim">${qbs.passwordSet ? 'Password set' : 'No password set'}${qbs.source === 'environment' ? ', using the server environment' : ''}</div>
        <div class="row-form"><input class="field" name="url" value="${esc(qbs.url)}" placeholder="http://127.0.0.1:8080" autocomplete="off" required>
          <input class="field" name="user" value="${esc(qbs.user)}" placeholder="Username" autocomplete="off" required>
          <input class="field" name="pass" type="password" placeholder="${qbs.passwordSet ? 'Password (unchanged)' : 'Password'}" autocomplete="new-password"></div>
        <div class="row-form"><button class="btn primary">Save</button><button type="button" class="btn" id="qt">Test connection</button>${qbs.source === 'settings' ? '<button type="button" class="btn" id="qc">Use server environment</button>' : ''}</div>
        <div class="dim" id="qm" role="status"></div></form>`
    wire()
  }
  const wire = () => {
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

/** Shown when the server can't be reached, instead of a blank page. Retries by itself. */
function offlineView(why) {
  top.hidden = true
  app.innerHTML = `<div class="auth-wrap"><div class="auth" role="alert"><div class="brand">${I.logo}<span>Flix</span></div>
    <h1 style="text-align:center">Can’t reach Flix</h1>
    <p class="dim" style="text-align:center;margin:0">The Flix server isn’t answering. Make sure it’s running (<code>npm start</code>) and that this device is on the same network.</p>
    <p class="dim" style="text-align:center;margin:0;font-size:13px">${esc(why)}</p>
    <button class="btn primary" id="rt" style="width:100%">Try again</button><div class="dim" style="text-align:center;font-size:13px">Retrying automatically…</div></div></div>`
  $('#rt').onclick = () => route()
  clearTimeout(retryT); retryT = setTimeout(route, 5000)
}

/* ---------- router ---------- */
async function route() {
  cleanup?.(); cleanup = null
  clearTimeout(retryT)
  const token = ++navToken
  let st
  try { st = await api('/api/me', null, 'GET', 15000) } catch (e) {
    if (token === navToken) offlineView(e.name === 'TimeoutError' ? 'The server took too long to answer.' : e.message)
    return
  }
  me = st.user
  renderTop()
  top.classList.toggle('solid', scrollY > 30)
  if (!me) return swap(authView(st.needsSetup))
  const [path, query] = location.hash.slice(1).split('?')
  const parts = path.split('/').filter(Boolean)
  const slow = app.innerHTML.trim() ? null : setTimeout(() => { if (token === navToken) app.innerHTML = skeleton() }, 200)
  try {
    let render
    if (parts[0] === 'series') render = await seriesView(parts[1])
    else if (parts[0] === 'play') render = playView(parts[1], parts[2], parts[3])
    else if (parts[0] === 'admin' && me.is_admin) render = await adminView(parts[1] === 'family' || parts[1] === 'settings' ? parts[1] : 'downloads')
    else render = await homeView(new URLSearchParams(query).get('q'))
    clearTimeout(slow)
    if (token !== navToken) return
    await swap(render)
  } catch (e) {
    clearTimeout(slow)
    if (token === navToken) app.innerHTML = `<div class="pad page-top"><div class="empty err">${esc(e.message)}</div></div>`
  }
}
addEventListener('hashchange', route)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
route()
