const $ = (s, el = document) => el.querySelector(s)
const app = $('#app'), top = $('#top')
let me = null

async function api(path, body, method) {
  const res = await fetch(path, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const gb = (n) => (n / 1073741824).toFixed(2) + ' GB'
const mbps = (n) => (n / 1048576).toFixed(1) + ' MB/s'
let cleanup = null
const go = (h) => { location.hash = h }

function renderTop() {
  top.innerHTML = `<a class="brand" href="#/">Flix</a>${me ? `<form id="sf" class="row"><input id="q" placeholder="Search BroadcasTheNet…" size="28"></form>
    <span class="sp"></span>${me.is_admin ? '<a href="#/admin">Admin</a>' : ''}<span class="dim">${esc(me.name)}</span><button id="lo">Log out</button>` : ''}`
  if (!me) return
  $('#sf').onsubmit = (e) => { e.preventDefault(); go('#/?q=' + encodeURIComponent($('#q').value)) }
  $('#lo').onclick = async () => { await api('/api/logout', {}); me = null; route() }
}

function authView(needsSetup) {
  app.innerHTML = `<form class="auth panel"><h2>${needsSetup ? 'Create the admin account' : 'Sign in'}</h2>
    <input name="name" placeholder="Username" autocomplete="username" required>
    <input name="password" type="password" placeholder="Password (8+ chars)" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required>
    <button class="primary">${needsSetup ? 'Create account' : 'Sign in'}</button><div class="bad" id="err"></div></form>`
  $('form').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try { await api(needsSetup ? '/api/signup' : '/api/login', { name: f.get('name'), password: f.get('password') }); route() }
    catch (err) { $('#err').textContent = err.message }
  }
}

const poster = (s) => `<a class="card" href="#/series/${s.id ?? s.seriesId}"><img loading="lazy" src="${esc(s.poster || '')}" alt="" onerror="this.style.visibility='hidden'"><div>${esc(s.name ?? s.series)}</div></a>`

async function homeView(q) {
  app.innerHTML = '<p class="dim">Loading…</p>'
  const [{ series }, cont] = await Promise.all([api('/api/series' + (q ? '?q=' + encodeURIComponent(q) : '')), q ? { items: [] } : api('/api/continue')])
  const items = cont.items
  app.innerHTML =
    (items.length ? `<h2>Continue watching</h2><div class="grid">${items.map((i) => `<button class="card cw" data-s="${i.seriesId}" data-season="${i.season ?? ''}" data-label="${esc(i.label)}">
      <img loading="lazy" src="${esc(i.poster || '')}" alt="" onerror="this.style.visibility='hidden'"><div>${esc(i.series)}<br><span class="dim">${esc(i.label)}</span></div>
      <i class="bar"><b style="width:${Math.min(100, Math.round((i.position / (i.duration || 1)) * 100))}%"></b></i></button>`).join('')}</div>` : '') +
    `<h2>${q ? `Results for “${esc(q)}”` : 'Latest shows'}</h2>` +
    (series.length ? `<div class="grid">${series.map(poster).join('')}</div>` : '<p class="dim">Nothing here yet. Try searching for a show.</p>')
  app.querySelectorAll('.cw').forEach((b) => b.onclick = () => go(`#/play/${b.dataset.s}/${b.dataset.season || 'x'}/${encodeURIComponent(b.dataset.label)}`))
}

async function seriesView(id) {
  app.innerHTML = '<p class="dim">Loading…</p>'
  const { series, episodes } = await api('/api/series/' + id)
  const seasons = new Map()
  for (const e of episodes) { const k = e.season ?? 'x'; if (!seasons.has(k)) seasons.set(k, []); seasons.get(k).push(e) }
  const nextUp = episodes.find((e) => !e.watched && e.available)
  const resume = episodes.find((e) => e.position > 30 && !e.watched)
  const hero = resume ?? nextUp
  app.innerHTML = `<div class="hero">${series.poster ? `<img src="${esc(series.poster)}" alt="" onerror="this.style.display='none'">` : ''}<div>
      <h2>${esc(series.name)}</h2>
      ${hero ? `<button class="big" data-ep="${esc(hero.label)}" data-season="${hero.season ?? ''}">▶ ${resume ? 'Resume' : 'Play'} ${esc(hero.label)}</button>` : '<p class="dim">Nothing is available to play right now.</p>'}
      ${series.trailer ? `<p><a class="trailer" href="${esc(series.trailer)}" target="_blank" rel="noopener">▶ Watch trailer</a></p>` : ''}
    </div></div>` +
    [...seasons].map(([s, eps]) => `<h3 class="sh">${s === 'x' ? 'Episodes' : 'Season ' + s}</h3><div class="eps">${eps.map((e) => `
      <button class="ep" data-ep="${esc(e.label)}" data-season="${e.season ?? ''}" ${e.available ? '' : 'disabled'}>
        <span class="en">${esc(e.label)}</span>
        <span class="et">${e.available ? '' : '<span class="dim">Not available right now</span>'}${e.position > 30 && !e.watched ? `<i class="bar"><b style="width:${Math.min(100, Math.round((e.position / (e.duration || 1)) * 100))}%"></b></i>` : ''}</span>
        <span class="eq">${e.watched ? '✓ Watched' : e.onServer ? 'Ready' : ''}</span>
      </button>`).join('')}</div>`).join('')
  app.querySelectorAll('[data-ep]').forEach((b) => b.onclick = () => go(`#/play/${id}/${b.dataset.season || 'x'}/${encodeURIComponent(b.dataset.ep)}`))
}

async function playView(seriesId, season, label) {
  label = decodeURIComponent(label)
  app.innerHTML = `<div class="stage"><div id="vw"></div><div class="wait" id="wait"><div class="spin"></div><div id="msg">Getting your show ready…</div><div class="bar big"><b id="pb" style="width:4%"></b></div></div></div>
    <div class="row" style="justify-content:space-between;margin-top:10px"><a href="#/series/${seriesId}">← Back</a><span id="q" class="dim"></span><span id="nx"></span></div>`
  let alive = true, hls = null, timer = null
  cleanup = () => { alive = false; clearInterval(timer); hls?.destroy() }
  const t0 = Date.now()
  try {
    const play = await api('/api/watch', { seriesId: +seriesId, season: season === 'x' ? null : +season, label })
    const { torrentId, fileIndex, position: start } = play
    $('#q').textContent = play.quality
    const base = `/api/stream/${torrentId}/${fileIndex}`
    timer = setInterval(async () => {
      const s = await api(base + '/status').catch(() => null)
      if (!alive || !s || s.error) return
      $('#pb').style.width = Math.max(4, s.bufferedPct) + '%'
      const slow = Date.now() - t0 > 25000 && s.bufferedPct < 10
      $('#msg').textContent = slow ? 'Still looking for a fast source… this can take a minute.' : 'Getting your show ready…'
    }, 1000)
    const info = await api(base + '/info')
    if (!alive) return
    $('#vw').innerHTML = '<video controls autoplay playsinline></video>'
    const v = $('video')
    v.addEventListener('playing', () => { $('#wait').hidden = true }, { once: true })
    if (info.mode === 'hls' && window.Hls?.isSupported()) {
      hls = new Hls({ maxBufferLength: 60 })
      hls.loadSource(info.url); hls.attachMedia(v)
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); $('#wait').hidden = false; $('#msg').textContent = 'Something went wrong playing this. Go back and try again.' } })
    } else v.src = info.url
    if (start > 5) v.addEventListener('loadedmetadata', () => { v.currentTime = start }, { once: true })
    let last = 0
    const report = () => {
      if (!isFinite(v.duration) && !info.duration) return
      api('/api/progress', { torrentId, fileIndex, position: v.currentTime, duration: info.duration || v.duration }).catch(() => {})
    }
    v.ontimeupdate = () => { if (Date.now() - last > 10000) { last = Date.now(); report() } }
    v.onpause = report
    v.onended = () => {
      report()
      if (play.next) $('#nx').innerHTML = `<button class="big" id="nb">Next: ${esc(play.next.label)} ▶</button>`, $('#nb').onclick = () => go(`#/play/${seriesId}/${play.next.season ?? 'x'}/${encodeURIComponent(play.next.label)}`)
    }
  } catch (e) { $('#msg').innerHTML = `<span class="bad">${esc(e.message)}</span>`; $('.spin')?.remove() }
}

async function adminView() {
  const render = async () => {
    const { requirements: r, downloads } = await api('/api/admin/downloads')
    app.innerHTML = `<h2>Downloads</h2><p class="dim">Kept until every viewer has watched it <b>and</b> seeding is met:
      ratio ≥ ${r.minRatio} ${r.mode === 'all' ? 'AND' : 'OR'} ${r.minHours} h.</p>
      <table><tr><th>Release</th><th>State</th><th>Progress</th><th>Ratio</th><th>Seeded</th><th>Why kept</th><th></th></tr>
      ${downloads.map((d) => `<tr><td>${esc(d.series)}<br><span class="dim">${esc(d.group_name)} ${esc(d.resolution || '')}</span></td>
        <td>${d.state === 'active' ? (d.deletable ? '<span class="ok">eligible for removal</span>' : 'active') : `<span class="dim">removed</span>`}</td>
        <td>${d.progress !== undefined ? (d.progress * 100).toFixed(0) + '% · ' + mbps(d.dlspeed) : ''}</td>
        <td>${d.ratio !== undefined ? d.ratio.toFixed(2) : ''}</td><td>${d.seedHours !== undefined ? d.seedHours.toFixed(1) + ' h' : ''}</td>
        <td class="dim">${d.state === 'active' ? esc((d.reasons || []).join('; ')) : esc(d.remove_reason || '')}</td>
        <td>${d.state === 'active' ? `<button data-rm="${d.torrent_id}">Force remove</button>` : ''}</td></tr>`).join('')}</table>
      <h2>Create user</h2><form id="uf" class="row"><input name="name" placeholder="Username"><input name="password" type="password" placeholder="Password">
      <label><input type="checkbox" name="isAdmin"> admin</label><button>Create</button><span id="um"></span></form>`
    app.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
      if (confirm('Delete this torrent and its files now? (Refused by the server unless the BTN seeding requirement is met.)')) { await api('/api/admin/downloads/' + b.dataset.rm, null, 'DELETE'); render() }
    })
    $('#uf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target)
      try { await api('/api/admin/users', { name: f.get('name'), password: f.get('password'), isAdmin: !!f.get('isAdmin') }); $('#um').textContent = 'Created'; e.target.reset() }
      catch (err) { $('#um').textContent = err.message }
    }
  }
  await render()
  const t = setInterval(render, 15000)
  cleanup = () => clearInterval(t)
}

async function route() {
  cleanup?.(); cleanup = null
  const st = await api('/api/me')
  me = st.user
  renderTop()
  if (!me) return authView(st.needsSetup)
  const [path, query] = location.hash.slice(1).split('?')
  const parts = path.split('/').filter(Boolean)
  try {
    if (parts[0] === 'series') await seriesView(parts[1])
    else if (parts[0] === 'play') await playView(parts[1], parts[2], parts[3])
    else if (parts[0] === 'admin' && me.is_admin) await adminView()
    else await homeView(new URLSearchParams(query).get('q'))
  } catch (e) { app.innerHTML = `<p class="bad">${esc(e.message)}</p>` }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
addEventListener('hashchange', route)
route()
