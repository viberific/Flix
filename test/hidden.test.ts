// Delete show deleted the files and left the show on every screen, and a show hidden that way has to come back on its own
// when a new episode turns up -- in its own place, not in the Queue. The watch history has to survive both the delete and a
// fresh download of the same episodes, or the person loses where they were.
//
// Confirmed on the box at 0.3.116: four packs of "All the Queens Men" marked removed, its 48 releases still listed, its cards
// still on the home screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// The database has to be in memory before anything opens it, so the modules that touch it are imported inside the tests.
process.env.DB_PATH = ':memory:'

const T = Math.floor(Date.now() / 1000)
let seq = 0

const open = async () => {
  const { db, now } = await import('../src/db.ts')
  const seasons = await import('../src/seasons.ts')
  return { db, now, seasons }
}

const user = (db: any, name: string) => {
  db.prepare('INSERT INTO users (name, pass_hash, is_admin, created_at) VALUES (?,?,0,?)').run(name, 'x', T)
  return (db.prepare('SELECT * FROM users WHERE name = ?').get(name) as any).id as number
}

/** A release for a show. `time` is when BTN published it, which is what "new since" is measured against. H.264 at 1080p, so
 *  the show is playable whatever transcode mode the box is in and is not hidden by unplayableSeries(). */
const rel = (db: any, seriesId: number, season: number | null, episode: number | null, time: number, o: { pack?: number; seeders?: number; dead?: number | null; end?: number } = {}) => {
  const tid = 700000 + ++seq
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, season, episode, episode_end, is_pack, info_hash, time, seeders, dead_at, fetched_at, resolution, codec, label)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'1080p','H.264',?)`)
    .run(tid, seriesId, `Show ${seriesId}`, `grp ${tid}`, season, episode, o.end ?? episode, o.pack ?? 0, 'h' + tid, time, o.seeders ?? 5, o.dead ?? null, T,
      o.pack ? `Season ${season}` : `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`)
  return tid
}

/** A show the catalog knows and the library may list: read from BTN, English, one whole season of single episodes. */
const listableShow = (db: any, seasons: any, seriesId: number, episodes: number) => {
  db.prepare('INSERT OR REPLACE INTO series_sync (series_id, synced_at) VALUES (?,?)').run(seriesId, T)
  db.prepare('INSERT OR REPLACE INTO series_net (series_id, fetched_at, lang) VALUES (?,?,?)').run(seriesId, T, 'en')
  const ids = []
  for (let e = 1; e <= episodes; e++) ids.push(rel(db, seriesId, 1, e, T - 10 * 86400))
  seasons.catalogChanged()
  return ids
}

const download = (db: any, tid: number, state = 'active') =>
  db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at, removed_at) VALUES (?,?,?,?,?)`).run(tid, 'h' + tid, state, T - 1e6, state === 'active' ? null : T)

const interest = (db: any, userId: number, tid: number, fileIndex: number, o: { watched?: number | null; position?: number; updated?: number } = {}) =>
  db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, watched_at, position) VALUES (?,?,?,?,?,?,?)`)
    .run(userId, tid, fileIndex, T, o.updated ?? T, o.watched ?? null, o.position ?? 0)

// ---- hidden shows ---------------------------------------------------------------------------------

test('a deleted show is hidden from every listing, and it stays hidden while nothing new arrives', async () => {
  const { db, seasons } = await open()
  const { hideSeries, hiddenSeries, hiddenShows, hiddenList } = await import('../src/hidden.ts')
  const sid = 810100
  listableShow(db, seasons, sid, 2)

  assert.ok(!hiddenShows().has(sid), 'listed to begin with')
  hideSeries(sid, null)
  assert.ok(hiddenSeries().has(sid), 'hidden once the admin deleted it')
  assert.ok(hiddenShows().has(sid), 'and left out by everything that asks what is hidden (this is what isListed uses)')
  assert.deepEqual(hiddenList().map((h) => h.seriesId), [sid], 'listed in Settings so it can be restored')

  // A sync that re-reads what was already there is not news: only the release times would move, and those are not used.
  seasons.catalogChanged()
  assert.ok(hiddenShows().has(sid), 'a catalog sync does not bring it back on its own')
})

test('a hidden show comes back by itself when a later episode is uploaded, and not for a re-encode of one it had', async () => {
  const { db, seasons } = await open()
  const { hideSeries, hiddenShows } = await import('../src/hidden.ts')
  const sid = 810200
  listableShow(db, seasons, sid, 2) // S01E01, S01E02 uploaded 10 days ago
  hideSeries(sid, null)
  assert.ok(hiddenShows().has(sid))

  // A better copy of E02, uploaded to BTN after the delete: further along than nothing, so not news.
  rel(db, sid, 1, 2, T + 60, { end: 2 })
  seasons.catalogChanged()
  assert.ok(hiddenShows().has(sid), 'a re-encode of an episode it already had does not bring the show back')

  // A brand new episode, uploaded after the delete.
  rel(db, sid, 1, 3, T + 120)
  seasons.catalogChanged()
  assert.ok(!hiddenShows().has(sid), 'a new episode brings it back')
})

test('a new season brings a hidden show back too, but a new season nobody seeds does not', async () => {
  const { db, seasons } = await open()
  const { hideSeries, hiddenShows } = await import('../src/hidden.ts')
  const a = 810300, b = 810400
  listableShow(db, seasons, a, 2)
  listableShow(db, seasons, b, 2)
  hideSeries(a, null); hideSeries(b, null)
  rel(db, a, 2, null, T + 60, { pack: 1, seeders: 9 }) // season 2, whole season
  rel(db, b, 2, null, T + 60, { pack: 1, seeders: 0, dead: T + 61 }) // a season of it that cannot be played
  seasons.catalogChanged()
  assert.ok(!hiddenShows().has(a), 'a new season is something new and it plays')
  assert.ok(hiddenShows().has(b), 'a season nothing seeds would open onto nothing, so it stays hidden')
})

test('Restore brings a hidden show back now, and a show that came back is no longer listed as hidden', async () => {
  const { db, seasons } = await open()
  const { hideSeries, unhideSeries, hiddenShows, hiddenList } = await import('../src/hidden.ts')
  const sid = 810500
  listableShow(db, seasons, sid, 1)
  hideSeries(sid, null)
  assert.equal(unhideSeries(sid), true)
  assert.ok(!hiddenShows().has(sid), 'back in the library')
  assert.equal(unhideSeries(sid), false, 'restoring one that is not hidden says so')

  hideSeries(sid, null)
  rel(db, sid, 1, 2, T + 60)
  seasons.catalogChanged()
  assert.ok(!hiddenList().some((h) => h.seriesId === sid), 'a show a new episode already brought back is not offered as hidden')
})

// ---- watch history across a delete and a re-download ----------------------------------------------

test('an episode watched before a delete still reads watched once the same episode is downloaded again', async () => {
  const { db, seasons, now } = await open()
  const { buildEpisodes } = await import('../src/episodes.ts')
  const u = user(db, 'hidden_watch')
  const sid = 810600
  const [old] = listableShow(db, seasons, sid, 2)
  download(db, old, 'removed') // the delete
  interest(db, u, old, 0, { watched: T - 100 })

  const eps = buildEpisodes(sid, u)
  assert.equal(eps.length, 2)
  assert.equal(eps[0].watched, true, 'watched then deleted: still ticked')

  // Downloaded again: a different release, a different torrent id, nothing watched on it yet.
  const fresh = rel(db, sid, 1, 1, T - 60, { seeders: 40 })
  download(db, fresh)
  interest(db, u, fresh, 0, { updated: T + 5 })
  seasons.catalogChanged()

  const after = buildEpisodes(sid, u)
  assert.equal(after[0].torrentId, fresh, 'the copy on the box is the one that plays')
  assert.equal(after[0].watched, true, 'the tick survives the new copy')
})

test('a pack member watched before a delete still reads watched in the new pack', async () => {
  const { db, seasons, now } = await open()
  const { buildEpisodes } = await import('../src/episodes.ts')
  const u = user(db, 'hidden_pack')
  const sid = 810700
  db.prepare('INSERT OR REPLACE INTO series_sync (series_id, synced_at) VALUES (?,?)').run(sid, T)
  db.prepare('INSERT OR REPLACE INTO series_net (series_id, fetched_at, lang) VALUES (?,?,?)').run(sid, T, 'en')
  const pack = (tid: number, seeders: number) => {
    db.prepare(`INSERT INTO releases (torrent_id, series_id, series, group_name, season, episode, is_pack, info_hash, time, seeders, fetched_at, resolution, codec, label)
      VALUES (?,?,?,?,1,NULL,1,?,?,?,?,'1080p','H.264',?)`).run(tid, sid, `Show ${sid}`, `pack ${tid}`, 'h' + tid, T - 100, seeders, T, `Season 1`)
    db.prepare(`INSERT INTO pack_files (torrent_id, idx, path, size, season, episode, episode_end) VALUES (?,?,?,?,1,?,?)`)
      .run(tid, 0, `Show.${tid}.S01E01.mkv`, 1, 1, 1)
    db.prepare(`INSERT INTO pack_files (torrent_id, idx, path, size, season, episode, episode_end) VALUES (?,?,?,?,1,?,?)`)
      .run(tid, 1, `Show.${tid}.S01E02.mkv`, 1, 2, 2)
  }
  pack(810701, 5); download(db, 810701, 'removed'); interest(db, u, 810701, 0, { watched: T - 100 })
  seasons.catalogChanged()
  assert.equal(buildEpisodes(sid, u).find((e) => e.label === 'S01E01')?.watched, true, 'watched in the pack that was deleted')

  // A new pack, redownloaded and on the box: the episode list comes from the new one.
  pack(810702, 30); download(db, 810702); interest(db, u, 810702, 0, { updated: T + 5 })
  seasons.catalogChanged()
  const eps = buildEpisodes(sid, u)
  const e1 = eps.find((e) => e.label === 'S01E01')!, e2 = eps.find((e) => e.label === 'S01E02')!
  assert.equal(e1.torrentId, 810702, 'the new pack plays')
  assert.equal(e1.watched, true, 'the watched episode is still ticked')
  assert.equal(e2.watched, false, 'one it never watched is not')
})

test('where the person left off survives a re-download, and an episode they start again is not thrown backwards', async () => {
  const { db, seasons, now } = await open()
  const { buildEpisodes } = await import('../src/episodes.ts')
  const u = user(db, 'hidden_pos')
  const sid = 810800
  const [old] = listableShow(db, seasons, sid, 2)
  download(db, old, 'removed')
  interest(db, u, old, 0, { position: 600 }) // partway through E01 when it was deleted

  const fresh = rel(db, sid, 1, 1, T - 60, { seeders: 40 })
  download(db, fresh)
  interest(db, u, fresh, 0, { updated: T + 5, position: 0 }) // the new copy has never been played
  seasons.catalogChanged()
  assert.equal(buildEpisodes(sid, u)[0].position, 600, 'resumes where the deleted copy was, not at the start')

  // Played again and restarted from the beginning: that is the newest position, so it wins.
  db.prepare('UPDATE interests SET position = 12, updated_at = ? WHERE user_id = ? AND torrent_id = ?').run(now() + 60, u, fresh)
  assert.equal(buildEpisodes(sid, u)[0].position, 12, 'a deliberate restart is not undone by an older copy')
})

test('a hidden show is off Continue watching; one that was never deleted is still on it', async () => {
  const { db, seasons, now } = await open()
  const { continueWatching } = await import('../src/episodes.ts')
  const { hideSeries, hiddenSeries } = await import('../src/hidden.ts')
  const u = user(db, 'hidden_cont')
  const kept = 810900, gone = 811000
  const [k] = listableShow(db, seasons, kept, 2)
  const [g] = listableShow(db, seasons, gone, 2)
  download(db, k); interest(db, u, k, 0, { position: 600, updated: now() })
  download(db, g); interest(db, u, g, 0, { position: 600, updated: now() })
  const me = { id: u, name: 'hidden_cont', is_admin: 0, allowed: null } as any

  const before = continueWatching(me).map((x) => x.seriesId)
  assert.ok(before.includes(kept) && before.includes(gone), 'both are being watched')

  hideSeries(gone, null)
  const after = continueWatching(me, hiddenSeries()).map((x) => x.seriesId)
  assert.ok(after.includes(kept), 'a show that was never deleted keeps its place')
  assert.ok(!after.includes(gone), 'a hidden show has no business in the Queue')
})
