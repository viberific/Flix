import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { parseGroupName, isVideo } = await import('../src/btn/parse.ts')
const { seedStatus } = await import('../src/retention.ts')
const { config } = await import('../src/config.ts')

test('BTN seeding requirement is fixed at 130h OR 1:1', () => {
  assert.equal(config.seed.minHours, 130)
  assert.equal(config.seed.minRatio, 1)
  assert.equal(config.seed.mode, 'any')
})

test('seedStatus: either condition is enough', () => {
  const size = 1000
  assert.equal(seedStatus({ uploaded: 0, total_size: size, seeding_time: 0 }).met, false)
  assert.equal(seedStatus({ uploaded: 999, total_size: size, seeding_time: 129 * 3600 }).met, false)
  assert.equal(seedStatus({ uploaded: 1000, total_size: size, seeding_time: 0 }).met, true) // 1:1
  assert.equal(seedStatus({ uploaded: 0, total_size: size, seeding_time: 130 * 3600 }).met, true) // 130h
})

test('ratio is measured against full torrent size', () => {
  assert.equal(seedStatus({ uploaded: 500, total_size: 1000, seeding_time: 0 }).ratio, 0.5)
})

test('parseGroupName', () => {
  assert.deepEqual(parseGroupName('Some Show - S02E05'), { season: 2, episode: 5, episodeEnd: 5, label: 'S02E05', isPack: false })
  assert.deepEqual(parseGroupName('Some Show - Season 3', 'Season'), { season: 3, episode: null, episodeEnd: null, label: 'Season 3', isPack: true })
  const d = parseGroupName('Late Show - 2024.03.01')
  assert.equal(d.label, '2024-03-01'); assert.equal(d.season, 2024)
})

test('isVideo ignores samples and non-video', () => {
  assert.equal(isVideo('a/b.mkv'), true)
  assert.equal(isVideo('a/Sample.mkv'), false)
  assert.equal(isVideo('a/b.nfo'), false)
})

const { pickRelease, qualityLabel } = await import('../src/pick.ts')
const { youtubeUrl } = await import('../src/catalog.ts')
const c = (id: number, resolution: string, o: any = {}) => ({ torrent_id: id, resolution, codec: 'H.264', seeders: 10, size: 1, on_server: false, ...o })

test('source pick: 1080p first, then 720p, then the rest; 4K only as a last resort', async () => {
  const { config } = await import('../src/config.ts')
  const was = config.transcode.mode
  config.transcode.mode = 'auto' // 4K is only ever a fallback when conversions are allowed at all
  try {
    assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p'), c(3, '720p')])!.torrent_id, 2)
    assert.equal(pickRelease([c(1, '2160p'), c(3, '720p')])!.torrent_id, 3) // no 1080p -> 720p, not 4K
    assert.equal(pickRelease([c(1, '2160p'), c(4, 'SD')])!.torrent_id, 4) // even SD beats 4K
    assert.equal(pickRelease([c(1, '2160p'), c(3, '720p', { seeders: 0 })])!.torrent_id, 1) // nothing else alive -> 4K
    assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p', { seeders: 0 })])!.torrent_id, 1) // dead 1080p is not "found"
    assert.equal(pickRelease([c(2, '1080p', { seeders: 0, on_server: true }), c(1, '2160p')])!.torrent_id, 2) // already on disk counts as alive
    assert.equal(pickRelease([c(3, '720p'), c(4, 'SD')])!.torrent_id, 3) // last resort
    assert.equal(pickRelease([]), undefined)
  } finally { config.transcode.mode = was }
  // Copy-only (the default) never takes 4K, not even when it is the only living release: that download is a
  // picture the box caps at 1080p anyway, and downloading it is exactly what this mode exists to prevent.
  assert.equal(pickRelease([c(1, '2160p'), c(3, '720p', { seeders: 0 })])!.torrent_id, 3)
  assert.equal(pickRelease([c(1, '2160p')]), undefined)
})

test('source pick tie-breaks: on-server, then H.264, then seeders', () => {
  assert.equal(pickRelease([c(1, '1080p', { seeders: 50 }), c(2, '1080p', { on_server: true, seeders: 1 })])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '1080p', { codec: 'H.265', seeders: 99 }), c(2, '1080p', { seeders: 5 })])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '1080p', { seeders: 5 }), c(2, '1080p', { seeders: 9 })])!.torrent_id, 2)
  assert.deepEqual(['1080p', '2160p', '1080i', 'SD'].map(qualityLabel), ['1080p', '4K', '1080p', 'SD'])
})

test('youtubeUrl only ever yields a youtube.com watch link', () => {
  assert.equal(youtubeUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(youtubeUrl('https://youtu.be/dQw4w9WgXcQ?t=3'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(youtubeUrl('javascript:alert(1)'), null)
  assert.equal(youtubeUrl(''), null)
})

const { isPrivateIp, sniffImage } = await import('../src/art.ts')
test('artwork safety: internal addresses blocked, only raster images accepted', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip)
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null)
  assert.equal(sniffImage(Buffer.from('<html>not an image at all</html>')), null)
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
})

const { normalizeRating, cleanAllowed, canView, ratingClause, RATINGS } = await import('../src/ratings.ts')
test('ratings: normalisation maps movie-style and TV ratings onto the TV scale', () => {
  const m: Record<string, string> = { 'TV-Y': 'TV-Y', 'tv-y7': 'TV-Y7', 'TV-Y7-FV': 'TV-Y7', G: 'TV-G', 'TV-G': 'TV-G', PG: 'TV-PG', 'TV-PG': 'TV-PG', 'PG-13': 'TV-14', 'TV-14': 'TV-14', R: 'TV-MA', 'NC-17': 'TV-MA', 'TV-MA': 'TV-MA', '': 'Unrated', nonsense: 'Unrated' }
  for (const [raw, want] of Object.entries(m)) assert.equal(normalizeRating(raw), want, raw)
  assert.equal(normalizeRating(null), 'Unrated')
})
test('ratings: allowed lists and viewing rules', () => {
  assert.equal(cleanAllowed(undefined), null)
  assert.equal(cleanAllowed([...RATINGS]), null) // everything ticked == unrestricted
  assert.deepEqual(cleanAllowed(['TV-G', 'TV-Y', 'TV-G']), ['TV-G', 'TV-Y'])
  assert.throws(() => cleanAllowed(['PG-13']))
  const kid = { is_admin: 0, allowed: ['TV-Y', 'TV-G'] as any }
  assert.equal(canView(kid, 'TV-G'), true)
  assert.equal(canView(kid, 'TV-14'), false)
  assert.equal(canView(kid, 'Unrated'), false) // unknown rating is never shown to a restricted user
  assert.equal(canView({ is_admin: 0, allowed: [] }, 'TV-Y'), false)
  assert.equal(canView({ is_admin: 1, allowed: ['TV-Y'] as any }, 'TV-MA'), true) // admins see everything
  assert.equal(canView({ is_admin: 0, allowed: null }, 'TV-MA'), true)
  assert.deepEqual(ratingClause(kid).params, ['TV-Y', 'TV-G'])
  assert.equal(ratingClause({ is_admin: 0, allowed: [] }).sql, '0')
})

const { btnKeyStatus, setBtnApiKey } = await import('../src/settings.ts')
const { btnCall, RateLimitError, IpNotAuthorizedError } = await import('../src/btn/client.ts')

test('settings: saved BTN key overrides the environment, status never exposes it, clearing reverts', () => {
  config.btn.apiKey = ''
  setBtnApiKey('abcdef123456')
  assert.equal(config.btn.apiKey, 'abcdef123456')
  const st = btnKeyStatus()
  assert.deepEqual(st, { configured: true, source: 'settings', hint: '3456' })
  assert.ok(!JSON.stringify(st).includes('abcdef'))
  setBtnApiKey('')
  assert.deepEqual(btnKeyStatus(), { configured: false, source: null, hint: null })
})

test('BTN client: no jsonrpc field, -32002 is a rate limit, -32004 is an unapproved IP', async () => {
  config.btn.apiKey = 'k'
  const realFetch = globalThis.fetch
  let sent: any
  let reply: any = { result: { ok: 1 } }
  globalThis.fetch = (async (_u: any, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(reply)) }) as any
  try {
    assert.deepEqual(await btnCall('userInfo'), { ok: 1 })
    assert.ok(!('jsonrpc' in sent) && sent.id && sent.params.key === 'k')
    reply = { result: null, error: { code: -32002, message: 'Call limit exceeded' } }
    await assert.rejects(btnCall('userInfo'), RateLimitError)
    reply = { result: null, error: { code: -32004, message: 'IP not authorised' } }
    await assert.rejects(btnCall('userInfo'), IpNotAuthorizedError)
    reply = { result: null, error: { code: 0, message: 'boom' } }
    await assert.rejects(btnCall('userInfo'), /boom/)
  } finally { globalThis.fetch = realFetch; config.btn.apiKey = '' }
})

const { setQb, clearQb, qbStatus } = await import('../src/settings.ts')

test('settings: qBittorrent override keeps the old password when left blank, never reports it, and can revert', () => {
  const env = { ...config.qb }
  config.qb.pass = 'envpass'
  setQb({ url: 'http://qb.local:9090/', user: 'me', password: '' })
  assert.equal(config.qb.url, 'http://qb.local:9090')
  assert.equal(config.qb.user, 'me')
  assert.equal(config.qb.pass, 'envpass') // blank = keep
  setQb({ url: 'http://qb.local:9090', user: 'me', password: 'newpass' })
  assert.equal(config.qb.pass, 'newpass')
  const st = qbStatus()
  assert.deepEqual(st, { url: 'http://qb.local:9090', user: 'me', passwordSet: true, source: 'settings' })
  assert.ok(!JSON.stringify(st).includes('newpass'))
  clearQb()
  assert.equal(config.qb.url, env.url)
  assert.equal(qbStatus().source, 'environment')
})

const { setTmdbApiKey, tmdbKeyStatus } = await import('../src/settings.ts')

test('settings: TMDB key overrides the environment, status hides it, clearing reverts', () => {
  const env = config.tmdb.apiKey
  setTmdbApiKey('tmdbsecret7788')
  assert.equal(config.tmdb.apiKey, 'tmdbsecret7788')
  const st = tmdbKeyStatus()
  assert.deepEqual(st, { configured: true, source: 'settings', hint: '7788' })
  assert.ok(!JSON.stringify(st).includes('tmdbsecret'))
  setTmdbApiKey('')
  assert.equal(config.tmdb.apiKey, env)
})

const { parseEpisodeTag } = await import('../src/btn/parse.ts')
const { visibleSeasons } = await import('../src/seasons.ts')
const { torrentFiles } = await import('../src/btn/torrentfile.ts')

test('episode tags: normal, double episodes, 1x02, and no false hits on resolutions', () => {
  assert.deepEqual(parseEpisodeTag('Show.S01E02.1080p.WEB'), { season: 1, episode: 2, episodeEnd: 2 })
  assert.deepEqual(parseEpisodeTag('Show.S01E02E03.720p'), { season: 1, episode: 2, episodeEnd: 3 })
  assert.deepEqual(parseEpisodeTag('Show - S01E05-E06'), { season: 1, episode: 5, episodeEnd: 6 })
  assert.deepEqual(parseEpisodeTag('Show - S01E05-1080p'), { season: 1, episode: 5, episodeEnd: 5 })
  assert.deepEqual(parseEpisodeTag('Show 2x07 HDTV'), { season: 2, episode: 7, episodeEnd: 7 })
  assert.equal(parseEpisodeTag('Show.1920x1080.mkv'), null)
  assert.equal(parseEpisodeTag('Season 3'), null)
})

const ep = (season: number, episode: number, end?: number) => ({ season, episode, episode_end: end ?? episode, is_pack: 0 })
const pack = (season: number) => ({ season, episode: null, episode_end: null, is_pack: 1 })
const seasons = (rows: any[]) => [...visibleSeasons(rows)]

test('seasons: a show needs a complete season 1, or it is not listed', () => {
  assert.deepEqual(seasons([]), [])
  assert.deepEqual(seasons([ep(2, 1), ep(2, 2)]), []) // no season 1
  assert.deepEqual(seasons([ep(1, 2), ep(1, 3)]), []) // season 1 starts at E02
  assert.deepEqual(seasons([ep(1, 1), ep(1, 2), ep(1, 4)]), []) // E03 missing
  assert.deepEqual(seasons([ep(1, 1), ep(1, 2), ep(1, 3)]), [[1, 'episodes']])
})

test('seasons: only the next sequential season may follow, and only when whole', () => {
  const s1 = [ep(1, 1), ep(1, 2)]
  assert.deepEqual(seasons([...s1, ep(3, 1), ep(3, 2)]), [[1, 'episodes']]) // 1 and 3 but no 2: only 1
  assert.deepEqual(seasons([...s1, ep(2, 1), ep(2, 3)]), [[1, 'episodes']]) // season 2 has a hole
  assert.deepEqual(seasons([...s1, ep(2, 1), ep(2, 2), ep(3, 2)]), [[1, 'episodes'], [2, 'episodes']])
  assert.deepEqual(seasons([...s1, ep(2, 1), ep(2, 2), ep(4, 1)]).map(([n]) => n), [1, 2]) // 3 missing hides 4
})

test('seasons: packs fill seasons with no complete set of single episodes', () => {
  assert.deepEqual(seasons([pack(1)]), [[1, 'pack']])
  assert.deepEqual(seasons([pack(1), ep(1, 1), ep(1, 3)]), [[1, 'pack']]) // singles have a hole, the pack is whole
  assert.deepEqual(seasons([pack(1), ep(1, 1), ep(1, 2)]), [[1, 'pack']]) // length unknown: the pack is the whole season, two singles may not be
  assert.deepEqual(seasons([ep(1, 1), ep(1, 2), pack(2)]), [[1, 'episodes'], [2, 'pack']]) // no pack for season 1: unbroken singles count
})

test('seasons: with the real season length known, one episode is not a season and singles only beat a pack when they reach it', () => {
  const sizes = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]))
  const withLen = (rows: any[], o: Record<number, number>) => [...visibleSeasons(rows, sizes(o))]
  assert.deepEqual(withLen([ep(1, 1)], { 1: 10 }), []) // only E01 of ten: not listed
  assert.deepEqual(withLen([pack(1), ep(1, 1)], { 1: 10 }), [[1, 'pack']]) // the pack carries the season, not the lone E01
  assert.deepEqual(withLen([pack(1), ep(1, 1), ep(1, 2)], { 1: 2 }), [[1, 'episodes']]) // singles reach the season's length
  assert.deepEqual(withLen([ep(1, 1), ep(1, 2), ep(2, 1)], { 1: 2, 2: 8 }), [[1, 'episodes']]) // season 2 is short
  assert.deepEqual(withLen([ep(1, 1, 2)], { 1: 2 }), [[1, 'episodes']]) // a double episode covers both
})

test('seasons: double episodes cover both numbers; specials and date shows never count', () => {
  assert.deepEqual(seasons([ep(1, 1, 2), ep(1, 3)]), [[1, 'episodes']])
  assert.deepEqual(seasons([ep(0, 1), ep(1, 1)]), [[1, 'episodes']])
  assert.deepEqual(seasons([{ season: 2024, episode: null, episode_end: null, is_pack: 0 }]), [])
})

test('torrentFiles reads single- and multi-file torrents', () => {
  const ben = (v: any): string => typeof v === 'number' ? `i${v}e` : typeof v === 'string' ? `${Buffer.byteLength(v)}:${v}` : Array.isArray(v) ? `l${v.map(ben).join('')}e`
    : `d${Object.keys(v).sort().map((k) => ben(k) + ben(v[k])).join('')}e`
  const multi = Buffer.from(ben({ info: { name: 'Show.S01', files: [{ length: 100, path: ['S01E01.mkv'] }, { length: 200, path: ['sub', 'S01E02.mkv'] }] } }))
  assert.deepEqual(torrentFiles(multi), [{ path: 'Show.S01/S01E01.mkv', size: 100 }, { path: 'Show.S01/sub/S01E02.mkv', size: 200 }])
  assert.deepEqual(torrentFiles(Buffer.from(ben({ info: { name: 'a.mkv', length: 5 } }))), [{ path: 'a.mkv', size: 5 }])
  assert.throws(() => torrentFiles(Buffer.from('d4:spam')))
})

const { createUser, createInvite, redeemInvite, newSession, sessionUser, tvToken, userForTvToken, login, hasPassword, setOwnPassword } = await import('../src/auth.ts')

test('a child account (not admin, no TV-MA) signs in by name alone; everyone else needs a password', () => {
  assert.throws(() => createUser('pwless', '', false), /8 characters/)
  assert.throws(() => createUser('pwless', '', false, ['TV-14', 'TV-MA']), /8 characters/)
  assert.throws(() => createUser('pwless', '', true, ['TV-Y']), /8 characters/)
  const kid = createUser('pwless', '', false, ['TV-Y', 'Unrated'])
  assert.equal(hasPassword(kid.id), false)
  assert.ok(login('pwless', ''))
  assert.ok(login('pwless', 'anything'), 'a child is never asked for one')
  setOwnPassword(kid.id, '', 'kidpassword1') // no current password to prove
  assert.equal(hasPassword(kid.id), true)
  const teen = createUser('teenpw', 'password123', false, ['TV-14'])
  assert.ok(login('teenpw', ''), 'a child with a password still signs in without it')
  assert.equal(login('nobody-here', ''), null)
  createUser('grownpw', 'password123', false, ['TV-MA'])
  assert.equal(login('grownpw', ''), null)
  assert.ok(login('grownpw', 'password123'))
  assert.ok(teen)
})

test('sign-in links work once; sessions and TV links are checked', () => {
  const u = createUser('ann', 'password123', false)
  const inv = createInvite(u.id)
  const r = redeemInvite(inv)
  assert.equal(r?.userId, u.id)
  assert.equal(redeemInvite(inv), null, 'second use is refused')
  assert.equal(redeemInvite('0'.repeat(48)), null)
  assert.equal(sessionUser(r!.session), u.id)
  assert.equal(sessionUser('f'.repeat(64)), null)
  assert.notEqual(newSession(u.id), newSession(u.id))
  const tok = tvToken(u.id)
  assert.equal(userForTvToken(tok)?.id, u.id)
  assert.equal(userForTvToken(tok.slice(0, -1) + (tok.endsWith('0') ? '1' : '0')), null, 'a tampered token is refused')
  assert.equal(userForTvToken(`${u.id}.1.${'0'.repeat(32)}`), null)
})

test('assertSpace refuses when the disk would fill up', async () => {
  const { assertSpace } = await import('../src/health.ts')
  assert.doesNotThrow(() => assertSpace(0))
  config.minFreeGb = 1e9 // more than any disk
  assert.throws(() => assertSpace(1), /out of storage/)
  config.minFreeGb = 10
})

const { normalizeStreamer, primaryGenre, isHiddenService, STREAMERS } = await import('../src/networks.ts')
const { curateHome, ROW_SIZE } = await import('../src/home.ts')

test('streaming services are recognised however a source spells them', () => {
  assert.equal(normalizeStreamer('Netflix'), 'Netflix')
  assert.equal(normalizeStreamer('Disney+'), 'Disney+')
  assert.equal(normalizeStreamer('Disney Plus'), 'Disney+')
  assert.equal(normalizeStreamer('Apple TV+'), 'Apple TV+')
  assert.equal(normalizeStreamer('Apple TV'), 'Apple TV+')
  assert.equal(normalizeStreamer('HBO'), 'HBO')
  assert.equal(normalizeStreamer('HBO Max'), 'HBO')
  assert.equal(normalizeStreamer('Max'), 'HBO')
  assert.equal(normalizeStreamer('Cinemax'), null)
  assert.equal(normalizeStreamer('Crave'), 'Crave')
  assert.equal(normalizeStreamer('Showcase'), 'Showcase')
  assert.equal(normalizeStreamer('AMC'), null)
  assert.equal(normalizeStreamer('Paramount+'), 'Paramount+')
  assert.equal(normalizeStreamer('Paramount Plus'), 'Paramount+')
  assert.equal(normalizeStreamer('Paramount Network'), null)
  // Disney brands its shows across several channels, and Disney+ carries Hulu and National Geographic: all of these belong
  // to the Disney+ row. Most Disney+ series are filed under "Disney Channel" by the metadata, not under "Disney+".
  assert.equal(normalizeStreamer('Disney Channel'), 'Disney+')
  assert.equal(normalizeStreamer('Disney Junior'), 'Disney+')
  assert.equal(normalizeStreamer('National Geographic'), 'Disney+')
  assert.equal(normalizeStreamer('Hulu'), 'Disney+')
  assert.equal(normalizeStreamer(null), null)
})

test('Netflix is recognised but is never put on the home screen', () => {
  assert.equal(normalizeStreamer('Netflix'), 'Netflix')
  assert.ok(isHiddenService('Netflix'))
  for (const s of STREAMERS) assert.ok(!isHiddenService(s), `${s} is on the home screen`)
  assert.ok(!isHiddenService(null) && !isHiddenService('HBO'))
})

test('a show has one primary genre: the most specific it has', () => {
  assert.equal(primaryGenre(['Drama', 'Documentary']), 'Documentary')
  assert.equal(primaryGenre(['Comedy', 'Animation', 'Family']), 'Animation')
  assert.equal(primaryGenre(['Drama', 'Crime']), 'Crime')
  assert.equal(primaryGenre(['Drama']), 'Drama')
  assert.equal(primaryGenre(['Zzz']), 'Zzz')
  assert.equal(primaryGenre([]), null)
})

const row = (id: number, genres: string[], latest = id) => ({ id, name: `S${id}`, poster: `/p${id}`, banner: null, genres, latest })
const info = (streamer: string | null, first_air: string, trending: number | null = null, popularity = 10) => ({ streamer, first_air, notable: true, popularity, trending })

test('home: the services, ten to a full row, a short row for a thin service, and Netflix and Disney+ nowhere', () => {
  const rows: any[] = [], net = new Map<number, any>()
  let id = 1
  const add = (n: number, streamer: string | null, genre: string, trending = false) => {
    for (let i = 0; i < n; i++, id++) { rows.push(row(id, [genre])); net.set(id, info(streamer, `20${String(10 + (id % 14))}-01-01`, trending ? id : null, id)) }
  }
  add(12, 'HBO', 'Crime', true)       // trending, on HBO
  add(10, 'Disney+', 'Animation')      // kept in the library (searches, lists, plays) but not on the home screen
  add(4, 'Crave', 'Comedy')            // too few for a row of ten: it gets a short row of its own instead
  add(22, 'Netflix', 'Drama')          // where they watch anyway: never on the home screen
  add(15, null, 'Drama')               // on none of the services: never on the home screen
  const { hero, sections } = curateHome(rows, net)
  assert.ok(hero && net.get(hero.id)!.trending != null, 'the billboard is a trending show')
  for (const s of sections.filter((x) => x.title !== 'New on Crave')) assert.equal(s.series.length, ROW_SIZE, `${s.title} has ${s.series.length}`)
  const titles = sections.map((s) => s.title)
  assert.equal(titles[0], 'Trending shows')
  assert.ok(titles.indexOf('New on HBO') < titles.indexOf('New on Crave'), 'rows follow the services\' order')
  assert.ok(!titles.includes('New on Netflix'), 'Netflix is not on the home screen')
  assert.ok(!titles.includes('New on Disney+'), 'Disney+ is not on the home screen either')
  assert.ok(!titles.includes('New on Showcase') && !titles.includes('New on Apple TV+'), 'a service with no shows has no row')
  const crave = sections.find((s) => s.title === 'New on Crave')
  assert.equal(crave?.series.length, 4, 'four Crave shows make a short row, not no row at all')
  assert.ok(!sections.some((s) => s.title === 'Comedy'), 'four shows cannot make a genre row')
  // A hidden service is off every row, the billboard included, but the rest of the library still fills the genre rows.
  const onHome = [hero!.id, ...sections.flatMap((s) => s.series.map((r) => r.id))]
  assert.ok(onHome.every((i) => net.get(i)!.streamer !== 'Netflix'), 'no Netflix show on any row')
  assert.ok(!sections.some((s) => s.title.startsWith('New on Disney+')), 'no Disney+ row')
  assert.ok(onHome.every((i) => net.get(i)!.streamer !== 'Disney+'), 'no Disney+ show on a service row or the billboard')
  const onService = [hero!.id, ...sections.filter((s) => s.title === 'Trending shows' || s.title.startsWith('New on ')).flatMap((s) => s.series.map((r) => r.id))]
  assert.ok(onService.every((i) => net.get(i)!.streamer), 'the billboard, trending and service rows are only shows on a service')
})

test('home: a library of nothing but Netflix leaves the home screen with no discovery rows', () => {
  const rows: any[] = [], net = new Map<number, any>()
  for (let i = 1; i <= 20; i++) { rows.push(row(i, [i % 2 ? 'Drama' : 'Comedy'])); net.set(i, info('Netflix', `2021-01-${String(i).padStart(2, '0')}`, i)) }
  const { hero, sections } = curateHome(rows, net)
  assert.equal(hero, null)
  assert.deepEqual(sections, [])
})

test('home: a service with a few shows is topped up from shows already shown rather than left short', () => {
  const rows: any[] = [], net = new Map<number, any>()
  for (let i = 1; i <= 14; i++) { rows.push(row(i, ['Drama'])); net.set(i, info('HBO', `2020-01-${String(i).padStart(2, '0')}`, i <= 12 ? i : null)) }
  const { sections } = curateHome(rows, net)
  // Two rows is under the four a page needs, so a "Newest additions" row (which may repeat shows) makes up the numbers.
  assert.deepEqual(sections.map((s) => s.title), ['Trending shows', 'New on HBO', 'Newest additions'])
  for (const s of sections) assert.equal(s.series.length, ROW_SIZE)
  const mine = new Set([1, 2, 3, 4, 5])
  const above = curateHome(rows, net, mine).sections[0].series
  assert.equal(above.length, ROW_SIZE)
  assert.ok(above.slice(0, 5).every((r) => !mine.has(r.id)), 'shows already above (My List) only come back last, to fill the row')
})

test('home: genre rows only appear with ten shows not yet shown, and no rows when too little is known', () => {
  const rows: any[] = [], net = new Map<number, any>()
  for (let i = 1; i <= 90; i++) { rows.push(row(i, [i % 2 ? 'Drama' : 'Comedy'])); net.set(i, info(['HBO', 'Showcase', 'Apple TV+'][i % 3], `2021-01-${String((i % 28) + 1).padStart(2, '0')}`)) }
  const { hero, sections } = curateHome(rows, net)
  for (const s of sections) assert.equal(s.series.length, ROW_SIZE, s.title)
  assert.ok(sections.some((s) => s.title === 'Drama' || s.title === 'Comedy'), 'genre rows follow the service rows')
  const ids = [hero!.id, ...sections.flatMap((s) => s.series.map((r) => r.id))]
  const dupes = ids.length - new Set(ids).size
  assert.ok(dupes <= 4, `repeats only come from topping up a thin row (${dupes})`)
  const none = curateHome([row(1, ['Drama']), row(2, ['Drama'])], new Map())
  assert.deepEqual(none.sections, []) // too little to make any row
  assert.ok(none.hero, 'but the billboard still shows the newest show, rather than an empty page')
})

test('library: only English-language shows, and a season is judged against its real length', async () => {
  const { db } = await import('../src/db.ts')
  const { listable, catalogChanged, isEnglish } = await import('../src/seasons.ts')
  assert.ok(isEnglish('en') && isEnglish('English') && isEnglish(null) && !isEnglish('ko') && !isEnglish('Korean'))
  const rel = db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, season, episode, episode_end, is_pack, info_hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,0)`)
  let t = 1
  const show = (id: number, eps: number[], opts: { pack?: boolean; lang?: string | null; counts?: Record<number, number>; read?: boolean } = {}) => {
    for (const e of eps) rel.run(t++, id, `S${id}`, `S${id} - S01E${e}`, 1, e, e, 0, `h${t}`)
    if (opts.pack) rel.run(t++, id, `S${id}`, `S${id} - Season 1`, 1, null, null, 1, `h${t}`)
    db.prepare('INSERT INTO series_sync VALUES (?,0)').run(id)
    if (opts.read !== false) db.prepare(`INSERT INTO series_net (series_id, fetched_at, lang, season_counts, ver) VALUES (?,0,?,?,3)`).run(id, opts.lang === undefined ? 'en' : opts.lang, JSON.stringify(opts.counts ?? {}))
  }
  show(1, [1], { counts: { 1: 10 } })                       // only E01 of ten, no pack: not a season 1
  show(2, [1], { counts: { 1: 10 }, pack: true })           // E01 plus the pack: the pack carries it
  show(3, [1, 2, 3], { counts: { 1: 3 } })                  // all three: fine
  show(4, [1, 2, 3], { counts: { 1: 3 }, lang: 'ko' })      // not English
  show(5, [1, 2, 3], { counts: { 1: 3 }, lang: 'English' })
  show(6, [1, 2, 3], { read: false })                       // language and lengths not read yet
  show(7, [1, 2, 3], { lang: null })                        // read, but nobody knows the language or the lengths: let through
  catalogChanged()
  const l = listable()
  assert.deepEqual([...l.keys()].sort(), [2, 3, 5, 7])
  assert.equal(l.get(2)!.get(1), 'pack')
  assert.equal(l.get(3)!.get(1), 'episodes')
})

test('ratings: IMDb (through OMDb) is the source, TMDB the fallback, and an admin can no longer set one', async () => {
  const { createServer } = await import('node:http')
  const { lookupImdb } = await import('../src/ratings.ts')
  const asked: string[] = []
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'); asked.push(`${u.searchParams.get('i')}|${u.searchParams.get('apikey')}`)
    const i = u.searchParams.get('i')
    res.setHeader('content-type', 'application/json')
    if (i === 'tt1') return void res.end(JSON.stringify({ Response: 'True', Rated: 'TV-MA', imdbRating: '9.5' }))
    if (i === 'tt2') return void res.end(JSON.stringify({ Response: 'True', Rated: 'N/A', imdbRating: 'N/A' }))
    if (i === 'tt3') return void res.end(JSON.stringify({ Response: 'False', Error: 'Invalid API key!' }))
    res.end(JSON.stringify({ Response: 'False', Error: 'Incorrect IMDb ID.' }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const old = { ...config.omdb }
  config.omdb.apiUrl = `http://127.0.0.1:${(srv.address() as any).port}`; config.omdb.apiKey = 'k&1'
  try {
    assert.deepEqual(await lookupImdb('tt1'), { rating: 'TV-MA', score: 9.5 })
    assert.deepEqual(await lookupImdb('tt2'), { rating: null, score: null }) // IMDb has no certificate for it
    assert.deepEqual(await lookupImdb('tt404'), { rating: null, score: null })
    await assert.rejects(lookupImdb('tt3'), /Invalid API key/)
    assert.equal(asked[0], 'tt1|k&1')
  } finally { Object.assign(config.omdb, old); srv.close() }
  const ratings = await import('../src/ratings.ts')
  assert.ok(!('setRating' in ratings), 'ratings are always automatic')
})

test('networks: a show\'s service, language and season lengths are read (the airing season counts what has aired)', async () => {
  const { createServer } = await import('node:http')
  const { db } = await import('../src/db.ts')
  const { ensureNet, netInfo } = await import('../src/networks.ts')
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url!.startsWith('/find/900')) return void res.end(JSON.stringify({ tv_results: [{ id: 5 }] }))
    if (req.url!.startsWith('/tv/5')) return void res.end(JSON.stringify({ original_language: 'en', networks: [{ name: 'Cinemax' }, { name: 'HBO' }], first_air_date: '2024-02-02', popularity: 80,
      seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 8 }, { season_number: 2, episode_count: 10 }],
      last_episode_to_air: { season_number: 2, episode_number: 4 } }))
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const old = { ...config.tmdb, tvmaze: config.art.tvmazeUrl }
  config.tmdb.apiUrl = `http://127.0.0.1:${(srv.address() as any).port}`; config.tmdb.apiKey = 'k'; config.art.tvmazeUrl = ''
  try {
    db.prepare(`INSERT INTO releases (torrent_id, series_id, series, tvdb_id, group_name, info_hash, fetched_at) VALUES (9001, 90, 'Net Show', 900, 'Net Show - S01E01', 'hh', 0)`).run()
    await ensureNet(90)
    const r = db.prepare('SELECT streamer, lang, season_counts, ver FROM series_net WHERE series_id = 90').get() as any
    assert.equal(r.streamer, 'HBO'); assert.equal(r.lang, 'en'); assert.equal(r.ver, 3)
    assert.deepEqual(JSON.parse(r.season_counts), { 1: 8, 2: 4 })
    assert.equal(netInfo().get(90)!.popularity, 80)
  } finally { config.tmdb.apiUrl = old.apiUrl; config.tmdb.apiKey = old.apiKey; config.art.tvmazeUrl = old.tvmaze; srv.close() }
})

test('episode pictures: gaps in TMDB are patched from TVmaze, then TMDB\'s other images', async () => {
  const { createServer } = await import('node:http')
  const { db } = await import('../src/db.ts')
  const { queueEpisodeInfo, episodeInfoFor } = await import('../src/episodeinfo.ts')
  const { catalogChanged } = await import('../src/seasons.ts')
  let base = ''
  const srv = createServer((req, res) => {
    const u = req.url!
    res.setHeader('content-type', 'application/json')
    if (u.startsWith('/tmdb/find/700')) return void res.end(JSON.stringify({ tv_results: [{ id: 7 }] }))
    if (u.startsWith('/tmdb/tv/7/season/1/episode/3/images')) return void res.end(JSON.stringify({ stills: [{ file_path: '/ep3.jpg' }] }))
    if (u.startsWith('/tmdb/tv/7/season/1/episode/4/images')) return void res.end(JSON.stringify({ stills: [] }))
    if (u.startsWith('/tmdb/tv/7/season/1')) return void res.end(JSON.stringify({ episodes: [
      { episode_number: 1, name: 'One', still_path: '/one.jpg' }, { episode_number: 2, name: 'Two' }, { episode_number: 3, name: 'Three' }, { episode_number: 4, name: 'Four' }] }))
    if (u.startsWith('/tvmaze/lookup/shows')) return void res.end(JSON.stringify({ id: 70 }))
    if (u.startsWith('/tvmaze/shows/70/episodes')) return void res.end(JSON.stringify([{ season: 1, number: 2, name: 'Two!', image: { original: 'https://static.tvmaze.com/two.jpg' } }]))
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as any).port}`
  const old = { api: config.tmdb.apiUrl, key: config.tmdb.apiKey, tv: config.art.tvmazeUrl, img: config.art.tmdbImages }
  Object.assign(config.tmdb, { apiUrl: `${base}/tmdb`, apiKey: 'k' }); config.art.tvmazeUrl = `${base}/tvmaze`; config.art.tmdbImages = `${base}/img`
  try {
    db.prepare(`INSERT INTO releases (torrent_id, series_id, series, tvdb_id, group_name, season, episode, episode_end, is_pack, info_hash, fetched_at) VALUES (7001, 70, 'Pic Show', 700, 'Pic Show - Season 1', 1, NULL, NULL, 1, 'pp', 0)`).run()
    db.prepare('INSERT INTO series_sync VALUES (70, 0)').run()
    db.prepare(`INSERT INTO series_net (series_id, fetched_at, lang, season_counts, ver) VALUES (70,0,'en','{}',3)`).run()
    catalogChanged()
    await queueEpisodeInfo(70)
    const info = episodeInfoFor(70)
    assert.equal(info.get('1|1')!.still, `${base}/img/w500/one.jpg`)          // TMDB's own
    assert.equal(info.get('1|2')!.still, 'https://static.tvmaze.com/two.jpg')  // from TVmaze
    assert.equal(info.get('1|2')!.name, 'Two')                                // TMDB's text is kept
    assert.equal(info.get('1|3')!.still, `${base}/img/w500/ep3.jpg`)           // TMDB's other images
    assert.equal(info.get('1|4')!.still, null)                                // nobody has one: the show's artwork stands in at display time
  } finally { Object.assign(config.tmdb, { apiUrl: old.api, apiKey: old.key }); config.art.tvmazeUrl = old.tv; config.art.tmdbImages = old.img; srv.close() }
})

test('downloads folder: removal leaves no empty folders behind, and never touches anything else', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { tidyAfterRemoval } = await import('../src/folder.ts')
  const root = mkdtempSync(join(tmpdir(), 'flix-dl-'))
  const old = config.downloadDir; config.downloadDir = root
  try {
    mkdirSync(join(root, 'Show.S01.1080p', 'Subs'), { recursive: true })           // emptied by the engine: only folders left
    mkdirSync(join(root, 'Mine'), { recursive: true }); writeFileSync(join(root, 'Mine', 'notes.txt'), 'x') // somebody else's file in the way
    mkdirSync(join(root, 'a'.repeat(40), 'Old.Show.S01'), { recursive: true })    // the old <hash>/<name> layout
    tidyAfterRemoval({ save_path: root, name: 'Show.S01.1080p', content_path: join(root, 'Show.S01.1080p') })
    assert.equal(existsSync(join(root, 'Show.S01.1080p')), false)
    tidyAfterRemoval({ save_path: root, name: 'Mine', content_path: join(root, 'Mine') })
    assert.equal(existsSync(join(root, 'Mine', 'notes.txt')), true, 'a folder with files in it is not ours to remove')
    tidyAfterRemoval({ save_path: join(root, 'a'.repeat(40)), name: 'Old.Show.S01', content_path: join(root, 'a'.repeat(40), 'Old.Show.S01') })
    assert.equal(existsSync(join(root, 'a'.repeat(40))), false, 'the empty hash folder goes with it')
    assert.equal(existsSync(root), true, 'the Downloads folder itself stays')
    tidyAfterRemoval({ save_path: root, name: '..', content_path: root })
    assert.equal(existsSync(root), true)
  } finally { config.downloadDir = old }
})

test('low storage: the larger of 10 GB and 10% is kept free; automatic downloads stop earlier and respect their limits', async () => {
  const { freeFloor, assertSpace } = await import('../src/health.ts')
  const { autoBlocked } = await import('../src/autodl.ts')
  const { db } = await import('../src/db.ts')
  assert.equal(freeFloor({ total: 1e12 }), 1e11)  // 10% of 1 TB beats 10 GB
  assert.equal(freeFloor({ total: 5e10 }), 1e10)  // on a small disk the 10 GB floor applies
  const keep = { ...config.auto }, pct = config.minFreePct, gbMin = config.minFreeGb
  config.minFreePct = 0; config.minFreeGb = 0; config.auto.pausePct = 0
  try {
    const u = createUser('autoann', 'password123', false).id
    assert.equal(autoBlocked(u, 1e6), null)
    config.auto.enabled = false; assert.match(autoBlocked(u, 1)!, /off/); config.auto.enabled = true
    config.auto.pausePct = 101; assert.match(autoBlocked(u, 1)!, /low/); config.auto.pausePct = 0
    const ins = db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, auto) VALUES (?,?,?,?,?,1)`)
    db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, info_hash, fetched_at, size) VALUES (8001, 80, 'A', 'A - S01E01', 'x1', 0, 30000000)`).run()
    db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at) VALUES (8001, 'x1', 'active', 0)`).run()
    const t = Math.floor(Date.now() / 1000)
    ins.run(u, 8001, 0, t, t)
    assert.equal(autoBlocked(u, 25e6), null, 'no size budget: only whole episodes per person are counted')
    for (let i = 1; i < config.auto.perUser; i++) ins.run(u, 8001, i, t, t)
    assert.match(autoBlocked(u, 1)!, /enough lined up/)
    db.prepare('UPDATE interests SET updated_at = ? WHERE user_id = ?').run(t - (config.auto.expireDays + 1) * 86400, u)
    assert.equal(autoBlocked(u, 1), null, 'a week untouched and it no longer counts')
    const { pendingViewers } = await import('../src/retention.ts')
    assert.deepEqual(pendingViewers(8001), [], 'and no longer holds the torrent')
  } finally { config.minFreePct = pct; config.minFreeGb = gbMin; Object.assign(config.auto, keep) }
})

test('a torrent downloaded by hand is kept until somebody has watched it', async () => {
  const { whyKept } = await import('../src/retention.ts')
  const { db } = await import('../src/db.ts')
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, info_hash, fetched_at, size) VALUES (8101, 81, 'B', 'B - S01E01', 'x2', 0, 1000)`).run()
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at, origin) VALUES (8101, 'x2', 'active', 0, 'adopted')`).run()
  const done = { uploaded: 5000, total_size: 1000, seeding_time: 200 * 3600, downloaded: 0, amount_left: 0 } as any // seeding goal met, and the engine counts nothing downloaded here
  const k = whyKept(done, 8101)
  assert.equal(k.deletable, false); assert.match(k.reasons[0], /outside Flix/)
  const u = createUser('watcher', 'password123', false).id
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?,8101,0,1,1,1)`).run(u)
  const others = (db.prepare('SELECT id FROM users WHERE id != ?').all(u) as { id: number }[]).map((r) => r.id)
  if (others.length) assert.match(whyKept(done, 8101).reasons.join(' '), /not yet watched by everyone who can/, 'one viewer is not enough while others could watch it')
  for (const o of others) db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?,8101,0,1,1,1)`).run(o)
  assert.equal(whyKept(done, 8101).deletable, true, 'everyone who can watch it has, and it is seeded: now it goes like any other')
})

test('a torrent waits only for the users whose ratings let them watch it', async () => {
  const { unwatchedEligible } = await import('../src/retention.ts')
  const { db } = await import('../src/db.ts')
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, info_hash, fetched_at, size) VALUES (8201, 82, 'M', 'M - S01E01', 'x3', 0, 1000)`).run()
  db.prepare(`INSERT OR REPLACE INTO series_meta (series_id, rating, source, fetched_at) VALUES (82, 'TV-MA', 'imdb', 0)`).run()
  const kid = createUser('kidtest', 'password123', false, ['TV-Y']).id
  const adult = createUser('adulttest', 'password123', false).id
  const waiting = unwatchedEligible(8201)
  assert.ok(!waiting.includes('kidtest'), 'a user who may not see TV-MA is not waited for')
  assert.ok(waiting.includes('adulttest'))
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, released_at) VALUES (?,8201,0,1,1,1)`).run(adult)
  assert.ok(!unwatchedEligible(8201).includes('adulttest'), 'releasing it counts as done')
  void kid
  const { holdersOf } = await import('../src/retention.ts')
  const held = holdersOf(8201).map((h) => h.name)
  assert.ok(held.includes('adulttest') === false && !held.includes('kidtest'), 'released, or not allowed: holds nothing')
  assert.ok(held.length > 0 || unwatchedEligible(8201).length === 0, 'everyone else allowed to watch it holds it, not only whoever pressed play')
  assert.ok(holdersOf(8201).every((h) => h.state === 'unwatched'))
})

test('storage graph: a year of daily points that rise and fall as downloads come and go, real samples taking over once recorded', async () => {
  const { db } = await import('../src/db.ts')
  const { storageHistory, recordStorage } = await import('../src/storage.ts')
  db.exec('DELETE FROM downloads; DELETE FROM storage_samples') // earlier tests left theirs
  const day = 86400, at = Math.floor(Date.UTC(2026, 5, 15, 12) / 1000)
  const rel = db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, info_hash, fetched_at, size) VALUES (?,?,?,?,?,0,?)`)
  const dl = db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at, removed_at) VALUES (?,?,?,?,?)`)
  rel.run(9501, 95, 'G', 'G - S01E01', 'g1', 10e9); dl.run(9501, 'g1', 'removed', at - 200 * day, at - 100 * day)   // 10 GB for 100 days, then cleared
  rel.run(9502, 96, 'H', 'H - S01E01', 'g2', 4e9); dl.run(9502, 'g2', 'active', at - 50 * day, null)               // 4 GB since, still there
  const h = storageHistory(at)
  assert.equal(h.points.length, 365); assert.equal(h.since, null)
  const near = (d: number) => h.points.reduce((b, p) => (Math.abs(p[0] - (at - d * day)) < Math.abs(b[0] - (at - d * day)) ? p : b))[1]
  assert.equal(near(300), 0); assert.equal(near(150), 10e9); assert.equal(near(75), 0); assert.equal(near(10), 4e9)
  assert.ok(h.points.every((p, i) => i === 0 || p[0] > h.points[i - 1][0]), 'in time order')
  db.prepare('INSERT INTO storage_samples (ts, bytes) VALUES (?,?)').run(at - 2 * day, 6e9)
  const real = storageHistory(at)
  assert.equal(real.since, at - 2 * day)
  assert.equal(real.points.at(-1)![1], 6e9, 'measured numbers win from the first sample on')
  assert.equal(real.points.find((p) => p[0] > at - 40 * day && p[0] < at - 30 * day)![1], 4e9, 'earlier days stay estimated')
  recordStorage(1)
})

test('held by: who keeps a torrent on disk, each hold lapsing if they never come back', async () => {
  const { holdersOf } = await import('../src/retention.ts')
  const { db, now } = await import('../src/db.ts')
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, info_hash, fetched_at, size) VALUES (9701, 97, 'K', 'K - S01E01', 'k1', 0, 1000)`).run()
  const a = createUser('holda', 'password123', false).id, b = createUser('holdb', 'password123', false).id, c = createUser('holdc', 'password123', false).id, d = createUser('holdd', 'password123', false).id
  const t = now(), ins = db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, position, auto, watched_at, released_at) VALUES (?,9701,?,?,?,?,?,?,?)`)
  ins.run(a, 0, t, t - 3 * 86400, 600, 0, null, null)            // partway through
  ins.run(b, 0, t, t, 0, 0, null, null)                           // lined up
  ins.run(c, 0, t, t, 0, 1, null, null)                           // fetched ahead of time
  ins.run(d, 0, t, t - 40 * 86400, 600, 0, null, null)            // gave up 40 days ago: lapsed
  ins.run(d, 1, t, t, 0, 0, t, null)                              // finished: not a hold
  const h = holdersOf(9701)
  const ours = h.filter((x) => x.name.startsWith('hold'))
  assert.deepEqual(ours.map((x) => [x.name, x.state]), [['holda', 'partway'], ['holdb', 'queued'], ['holdc', 'ahead']], 'holdd finished it, so holds nothing')
  assert.ok(h.filter((x) => !x.name.startsWith('hold')).every((x) => x.state === 'unwatched' && x.lapsesAt === null), 'everyone else who can watch it and has not holds it too')
  assert.ok(h.length > ours.length, 'including accounts that never pressed play')
  assert.ok(ours[0].lapsesAt! > t && ours[0].lapsesAt! <= t + 27 * 86400, 'a hold has an end date')
  assert.ok(ours[2].lapsesAt! <= t + config.auto.expireDays * 86400 + 5, 'ahead-of-time holds lapse sooner')
})

const { addRefusal } = await import('../src/qb.ts')

test('add response: qBittorrent 5 JSON with failure_count 0 is a success, not a refusal', () => {
  // This exact body is what 5.0.x answers; /fail/i used to match "failure_count":0.
  const ok = '{"added_torrent_ids":["85b7c049416b96b4611bc7e75cbb1a5c7908af1b"],"success_count":1,"failure_count":0,"pending_count":0}'
  assert.equal(addRefusal(true, ok), null)
  assert.equal(addRefusal(true, '{"success_count":0,"failure_count":0,"pending_count":1}'), null) // queued
})

test('add response: real refusals are still refusals', () => {
  assert.equal(addRefusal(true, 'Fails.'), 'Fails.')
  assert.equal(addRefusal(true, '{"success_count":0,"failure_count":1,"pending_count":0}'), '{"success_count":0,"failure_count":1,"pending_count":0}')
  assert.equal(addRefusal(false, 'Forbidden'), 'Forbidden')
  assert.equal(addRefusal(false, ''), 'HTTP error')
})

test('add response: the older plain-text and empty replies are accepted', () => {
  assert.equal(addRefusal(true, 'Ok.'), null)
  assert.equal(addRefusal(true, ''), null)
  assert.equal(addRefusal(true, 'not json at all'), null)
})

test('taste: thumbs steer genres and hide downvoted shows, but the newest still lead', async () => {
  const { tasteOf, tasteSort } = await import('../src/taste.ts')
  const { db, now } = await import('../src/db.ts')
  const genres: Record<number, string[]> = { 1: ['Comedy'], 2: ['Comedy'], 3: ['Horror'], 4: ['Horror'] }
  const u = createUser('taster', 'password123', false).id
  db.prepare('INSERT INTO votes (user_id, series_id, vote, voted_at) VALUES (?,?,?,?)').run(u, 1, 1, now())
  db.prepare('INSERT INTO votes (user_id, series_id, vote, voted_at) VALUES (?,?,?,?)').run(u, 3, -1, now() - 5)
  const t = tasteOf(u, (id) => genres[id] ?? [])
  assert.deepEqual([...t.hidden], [3])
  assert.equal(t.lastLiked, 1)
  assert.ok(t.fit(['Comedy']) > 0 && t.fit(['Horror']) < 0 && t.fit(['Drama']) === 0)
  const row = (id: number) => ({ id, genres: genres[id] })
  // Newest first: 4 (Horror, disliked genre), then 2 (Comedy). A liked genre lifts a show one place, not ten.
  assert.deepEqual(tasteSort([row(4), row(2)], t).map((r) => r.id), [2, 4])
  const many = [row(4), ...Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, genres: ['Comedy'] })), row(2)]
  assert.equal(tasteSort(many, t, 30).at(-1)!.id, 2, 'beyond the freshest window nothing is promoted')
  assert.equal(tasteSort([row(4), row(2)], undefined).map((r) => r.id).join(), '4,2', 'no taste, no change')
})

test('leaving soon: a seeded, finished pack nobody else opened leaves after the window; playing it stops the clock', async () => {
  const { updateLeaving, unwatchedEligible, leavingSoonFor, pendingViewers } = await import('../src/retention.ts')
  const { db, now } = await import('../src/db.ts')
  const watcher = createUser('lv_watcher', 'password123', false).id
  const sleeper = createUser('lv_sleeper', 'password123', false)
  const tid = 9100
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, is_pack, info_hash, fetched_at) VALUES (?,?,?,?,1,?,?)`).run(tid, 9100, 'Leaving Show', 'S01', 'abc', now())
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, added_at) VALUES (?,?,?)`).run(tid, 'abc', now() - 1e6)
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?,?,0,?,?,?)`).run(watcher, tid, now(), now(), now())
  const seeded = { amount_left: 0, uploaded: 2, total_size: 1, seeding_time: 0 }
  assert.equal(updateLeaving(tid, { ...seeded, uploaded: 0 }), null, 'seed rule not met: no clock')
  assert.equal(updateLeaving(tid, { ...seeded, amount_left: 5 }), null, 'still downloading: no clock')
  const at = updateLeaving(tid, seeded)
  assert.ok(at && at > now(), 'clock starts')
  assert.ok(unwatchedEligible(tid).includes('lv_sleeper'), 'still held during the window')
  assert.ok(leavingSoonFor(sleeper).some((r) => r.torrentId === tid), 'shown on the sleeper\'s Home')
  db.prepare('UPDATE downloads SET leaving_at = ? WHERE torrent_id = ?').run(now() - 1, tid)
  assert.ok(!unwatchedEligible(tid).includes('lv_sleeper'), 'window over: the sleeper no longer holds it')
  assert.ok(updateLeaving(tid, seeded)! <= now(), 'expired clock is left in place, not restarted')
  // The sleeper presses play: that holds the pack and stops the clock; finishing it restarts nothing because nobody is left untouched.
  db.prepare('INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at) VALUES (?,?,0,?,?)').run(sleeper.id, tid, now(), now())
  assert.deepEqual(pendingViewers(tid), ['lv_sleeper'])
  assert.equal(updateLeaving(tid, seeded), null, 'someone is playing it: the clock stops')
})

test('leaving soon also covers single episodes; a pack counts as done only once every episode is', async () => {
  const { updateLeaving, unwatchedEligible } = await import('../src/retention.ts')
  const { db, now } = await import('../src/db.ts')
  const a = createUser('lv2_a', 'password123', false).id
  createUser('lv2_b', 'password123', false)
  const seeded = { amount_left: 0, uploaded: 2, total_size: 1, seeding_time: 0 }
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, is_pack, info_hash, fetched_at) VALUES (9200, 9200, 'Ep Show', 'S01E01', 0, 'ep1', ?)`).run(now())
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, added_at) VALUES (9200, 'ep1', ?)`).run(now() - 1e6)
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?, 9200, 0, ?, ?, ?)`).run(a, now(), now(), now())
  assert.ok(updateLeaving(9200, seeded), 'a single episode gets the window too')

  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, is_pack, info_hash, fetched_at) VALUES (9201, 9201, 'Pack Show', 'Season 1', 1, 'pk1', ?)`).run(now())
  db.prepare(`INSERT INTO pack_files (torrent_id, idx, path, size, season, episode) VALUES (9201, 0, 'e1.mkv', 1, 1, 1), (9201, 1, 'e2.mkv', 1, 1, 2)`).run()
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?, 9201, 0, ?, ?, ?)`).run(a, now(), now(), now())
  assert.ok(unwatchedEligible(9201).includes('lv2_a'), 'one episode of two watched: not done with the pack')
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at) VALUES (?, 9201, 1, ?, ?, ?)`).run(a, now(), now(), now())
  assert.ok(!unwatchedEligible(9201).includes('lv2_a'), 'both watched: done')
})

test('storage forecast: days left at the recent pace, none when flat', async () => {
  const { fullInDays } = await import('../src/storage.ts')
  const D = 86400
  assert.equal(fullInDays([[0, 0], [14 * D, 14e9]], 10e9), 10, '1 GB a day, 10 GB of room')
  assert.equal(fullInDays([[0, 5e9], [14 * D, 5e9]], 10e9), null)
  assert.equal(fullInDays([[0, 0], [2 * D, 2e9]], 10e9), null, 'too little history')
})

test('one screen: the better preset is the default and only one encode runs at a time', async () => {
  // Brian runs one television, so the box can afford balanced (veryfast, crf 20, 6500k) rather than economy.
  assert.equal(config.transcode.profile, 'balanced', 'balanced is the default picture quality')
  assert.equal(config.transcode.maxJobs, 1, 'one encode at a time on four cores')
})

test('nothing above 1080p is ever served or saved', async () => {
  const { tierOf } = await import('../src/pick.ts')
  assert.equal(tierOf('2160p'), 3, '4K is the last resort, never preferred')
  assert.equal(tierOf('1080p'), 0)
  // The gates themselves: direct play and HDR passthrough both require <= 1080, and the encode clamps to 1080.
  const { readFileSync } = await import('node:fs')
  const t = readFileSync(new URL('../src/transcode.ts', import.meta.url), 'utf8')
  assert.match(t, /\(height \?\? 0\) <= 1080/, 'direct play refuses above 1080p')
  assert.match(t, /Math\.min\(p\.height \?\? 720, 1080\)/, 'the HLS output is clamped to 1080p')
  const o = readFileSync(new URL('../src/offline.ts', import.meta.url), 'utf8')
  assert.match(o, /scale=-2:1080/, 'the saved MP4 is scaled to 1080p')
})

test('a file is only converted when it has to be, and never in no-encode mode', async () => {
  const { needsEncode, mayEncode, MP4_CARRY } = await import('../src/transcode.ts')
  const base = { copyVideo: false, direct: false, hdr: false } as any
  assert.equal(needsEncode({ ...base, videoCodec: 'hevc' }), true, 'HEVC that cannot be copied needs an encode')
  assert.equal(needsEncode({ ...base, videoCodec: 'h264', copyVideo: true }), false, 'H.264 is copied, not encoded')
  assert.equal(needsEncode({ ...base, direct: true, videoCodec: 'h264' }), false, 'direct play needs nothing')
  assert.equal(needsEncode({ ...base, hdr: true, videoCodec: 'hevc' }), false, 'HDR is passed through, not encoded')
  assert.equal(MP4_CARRY.has('hevc'), true, 'HEVC can be carried in MP4 by a copy')
  // The setting is what decides, and 'off' means the picture is never re-encoded.
  assert.equal(mayEncode(), config.transcode.mode !== 'off')
  const off = await import('../src/offline.ts')
  const src = (await import('node:fs')).readFileSync(new URL('../src/offline.ts', import.meta.url), 'utf8')
  assert.match(src, /config\.transcode\.mode === 'off'/, 'the saved copy refuses to encode in this mode')
  assert.ok(off, 'offline module loads')
})

test('nothing above 1080p is chosen: 4K is never picked while anything else is alive', async () => {
  const { pickRelease, convertCost } = await import('../src/pick.ts')
  const uhd = { torrent_id: 1, resolution: '2160p', codec: 'H.265', seeders: 50, size: 20e9, on_server: false }
  const hd = { torrent_id: 2, resolution: '1080p', codec: 'H.264', seeders: 3, size: 3e9, on_server: false }
  assert.equal(pickRelease([uhd, hd])?.torrent_id, 2, 'the 1080p H.264 wins over a well-seeded 4K')
  assert.equal(convertCost(uhd), 2)
  assert.equal(convertCost(hd), 0)
  // A 4K H.264 release is still 4K: the box streams 1080p, so it is not worth the extra download.
  assert.equal(convertCost({ resolution: '2160p', codec: 'H.264' }), 2)
})

test('copy-only: nothing that needs an encode is picked, so nothing is downloaded', async () => {
  const { pickRelease } = await import('../src/pick.ts')
  const { config } = await import('../src/config.ts')
  const was = config.transcode.mode
  config.transcode.mode = 'off'
  try {
    const hevc = { torrent_id: 1, resolution: '1080p', codec: 'H.265', seeders: 90, size: 8e9, on_server: false }
    const h264 = { torrent_id: 2, resolution: '720p', codec: 'H.264', seeders: 2, size: 2e9, on_server: false }
    assert.equal(pickRelease([hevc])?.torrent_id, undefined, 'an episode with only HEVC has no source at all')
    assert.equal(pickRelease([hevc, h264])?.torrent_id, 2, 'the H.264 copy is chosen over the better-seeded HEVC')
    const xvid = { torrent_id: 3, resolution: 'SD', codec: 'XViD', seeders: 99, size: 1e9, on_server: false }
    assert.equal(pickRelease([xvid, hevc]), undefined, 'XViD and HEVC both need an encode, so neither is downloaded')
  } finally { config.transcode.mode = was }
  // With conversions allowed, the old preference returns: the sharpest release wins again.
  config.transcode.mode = 'auto'
  try {
    const hevc = { torrent_id: 1, resolution: '1080p', codec: 'H.265', seeders: 90, size: 8e9, on_server: false }
    const h264 = { torrent_id: 2, resolution: '720p', codec: 'H.264', seeders: 2, size: 2e9, on_server: false }
    assert.equal(pickRelease([hevc, h264])?.torrent_id, 1, 'auto mode still takes the 1080p')
  } finally { config.transcode.mode = was }
})

test('copy-only is the default, so a fresh install never downloads something it must convert', async () => {
  const { config } = await import('../src/config.ts')
  assert.equal(config.transcode.mode, 'off')
})

test('an episode with no copy-playable release is left out, not crashed on', async () => {
  const { config } = await import('../src/config.ts')
  const was = config.transcode.mode
  config.transcode.mode = 'off'
  try {
    const { pickRelease } = await import('../src/pick.ts')
    // episodes.ts relies on this being undefined rather than throwing, which it guards for.
    assert.equal(pickRelease([{ torrent_id: 9, resolution: '1080p', codec: 'H.265', seeders: 5, size: 1, on_server: false }]), undefined)
    assert.ok(pickRelease([{ torrent_id: 10, resolution: '1080p', codec: 'H.264', seeders: 1, size: 1, on_server: false }]))
  } finally { config.transcode.mode = was }
})

test('a tile that cannot play says why, instead of going dead', async () => {
  const { config } = await import('../src/config.ts')
  const { needsEncode } = await import('../src/transcode.ts')
  const { readFileSync } = await import('node:fs')
  const was = config.transcode.mode
  config.transcode.mode = 'off'
  try {
    // A picture that would have to be re-encoded, in a mode whose whole point is not to.
    assert.equal(needsEncode({ direct: false, hdr: false, copyVideo: false } as any), true)
    // And one that only needs its container changed still plays: that is a copy, not a conversion.
    assert.equal(needsEncode({ direct: false, hdr: false, copyVideo: true } as any), false)
  } finally { config.transcode.mode = was }
  // The server answers 'convert' rather than an error, and the player turns that into a line the viewer can tap.
  // Both halves are asserted because either one alone leaves a dead screen: a reason nobody renders.
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(server, /mode: 'convert', needsConvert: true/)
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.match(app, /info\.mode === 'convert'/)
  assert.match(app, /allow it for this episode/)
})
