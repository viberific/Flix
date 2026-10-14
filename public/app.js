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

async function homeView(q) {
  app.innerHTML = '<p class="dim">Loading…</p>'
  const { series } = await api('/api/series' + (q ? '?q=' + encodeURIComponent(q) : ''))
  app.innerHTML = `<h2>${q ? `Results for “${esc(q)}”` : 'Latest on BroadcasTheNet'}</h2>` +
    (series.length ? `<div class="grid">${series.map((s) => `<a class="card" href="#/series/${s.id}">
      <img loading="lazy" src="${esc(s.poster || '')}" alt=""><div>${esc(s.name)}</div></a>`).join('')}</div>`
      : '<p class="dim">Nothing yet. Search for a show above.</p>')
}

async function seriesView(id) {
  app.innerHTML = '<p class="dim">Loading from BroadcasTheNet…</p>'
  const { series, releases, progress } = await api('/api/series/' + id)
  const prog = new Map(progress.map((p) => [p.torrent_id, p]))
  const seasons = new Map()
  for (const r of releases) {
    const k = r.season ?? 'Other'
    if (!seasons.has(k)) seasons.set(k, new Map())
    const key = r.label
    if (!seasons.get(k).has(key)) seasons.get(k).set(key, [])
    seasons.get(k).get(key).push(r)
  }
  app.innerHTML = `<h2>${esc(series.name)}</h2>` + [...seasons].map(([s, eps]) => `<div class="season panel"><h3>${s === 'Other' ? 'Other' : 'Season ' + s}</h3>
    <table>${[...eps].map(([label, rs]) => `<tr><td style="width:110px"><b>${esc(label)}</b></td><td>${rs.map((r) => {
      const p = prog.get(r.torrent_id)
      return `<div class="row" style="margin:3px 0"><button data-play="${r.torrent_id}" class="primary">▶ Play</button>
        <span>${esc([r.resolution, r.source, r.codec, r.container].filter(Boolean).join(' · '))}</span>
        <span class="tag">${gb(r.size)}</span><span class="tag">${r.seeders ?? 0} seeders</span>${r.is_pack ? '<span class="tag">season pack</span>' : ''}
        ${r.download_state === 'active' ? '<span class="tag ok">on server</span>' : ''}
        ${p?.watched_at ? '<span class="tag ok">watched</span>' : p ? `<span class="tag warn">${Math.round((p.position / (p.duration || 1)) * 100)}%</span>` : ''}</div>`
    }).join('')}</td></tr>`).join('')}</table></div>`).join('')
  app.querySelectorAll('[data-play]').forEach((b) => b.onclick = () => go('#/play/' + b.dataset.play))
}

async function playView(torrentId) {
  app.innerHTML = `<div class="panel"><div id="msg">Contacting tracker and starting download…</div><div class="bar"><i id="pb" style="width:0%"></i></div></div><div id="vw"></div>`
  let alive = true, hls = null, timer = null
  cleanup = () => { alive = false; clearInterval(timer); hls?.destroy() }
  try {
    const { fileIndex, name, position: start } = await api('/api/play', { torrentId: +torrentId })
    const base = `/api/stream/${torrentId}/${fileIndex}`
    timer = setInterval(async () => {
      const s = await api(base + '/status').catch(() => null)
      if (!alive || !s || s.error) return
      $('#pb').style.width = s.bufferedPct + '%'
      $('#msg').textContent = `${name.split('/').pop()} — buffered ${s.bufferedPct}% · ${mbps(s.dlspeed)} · ${s.seeds} seeds · downloaded ${(s.fileProgress * 100).toFixed(1)}%`
    }, 1000)
    const info = await api(base + '/info')
    if (!alive) return
    $('#vw').innerHTML = '<video controls autoplay playsinline></video>'
    const v = $('video')
    if (info.mode === 'hls' && window.Hls?.isSupported()) {
      hls = new Hls({ maxBufferLength: 60 })
      hls.loadSource(info.url); hls.attachMedia(v)
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { hls.destroy(); $('#msg').textContent = 'Playback error: ' + d.details } })
    } else v.src = info.url
    let last = 0
    const report = () => {
      if (!isFinite(v.duration) && !info.duration) return
      api('/api/progress', { torrentId: +torrentId, fileIndex, position: v.currentTime, duration: info.duration || v.duration }).catch(() => {})
    }
    v.ontimeupdate = () => { if (Date.now() - last > 10000) { last = Date.now(); report() } }
    v.onpause = report; v.onended = report
    if (start > 5) v.addEventListener('loadedmetadata', () => { v.currentTime = start }, { once: true })
  } catch (e) { $('#msg').innerHTML = `<span class="bad">${esc(e.message)}</span>` }
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
    else if (parts[0] === 'play') await playView(parts[1])
    else if (parts[0] === 'admin' && me.is_admin) await adminView()
    else await homeView(new URLSearchParams(query).get('q'))
  } catch (e) { app.innerHTML = `<p class="bad">${esc(e.message)}</p>` }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
addEventListener('hashchange', route)
route()
