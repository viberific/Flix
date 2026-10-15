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
  assert.deepEqual(parseGroupName('Some Show - S02E05'), { season: 2, episode: 5, label: 'S02E05', isPack: false })
  assert.deepEqual(parseGroupName('Some Show - Season 3', 'Season'), { season: 3, episode: null, label: 'Season 3', isPack: true })
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

test('source pick: 1080p first, 4K only when there is no (living) 1080p', () => {
  assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p'), c(3, '720p')])!.torrent_id, 2)
  assert.equal(pickRelease([c(1, '2160p'), c(3, '720p')])!.torrent_id, 1) // no 1080p -> 4K
  assert.equal(pickRelease([c(1, '2160p'), c(2, '1080p', { seeders: 0 })])!.torrent_id, 1) // dead 1080p is not "found"
  assert.equal(pickRelease([c(2, '1080p', { seeders: 0, on_server: true }), c(1, '2160p')])!.torrent_id, 2) // already on disk counts as alive
  assert.equal(pickRelease([c(3, '720p'), c(4, 'SD')])!.torrent_id, 3) // last resort
  assert.equal(pickRelease([]), undefined)
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
    assert.deepEqual(await btnCall('userInfo', []), { ok: 1 })
    assert.ok(!('jsonrpc' in sent) && sent.id && sent.params[0] === 'k')
    reply = { result: null, error: { code: -32002, message: 'Call limit exceeded' } }
    await assert.rejects(btnCall('userInfo', []), RateLimitError)
    reply = { result: null, error: { code: -32004, message: 'IP not authorised' } }
    await assert.rejects(btnCall('userInfo', []), IpNotAuthorizedError)
    reply = { result: null, error: { code: 0, message: 'boom' } }
    await assert.rejects(btnCall('userInfo', []), /boom/)
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
