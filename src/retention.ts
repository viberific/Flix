import { db, now } from './db.ts'
import { config } from './config.ts'
import { qb, type QbTorrent } from './qb.ts'
import { stopJobsFor } from './transcode.ts'
import { syncFolder, tidyAfterRemoval } from './folder.ts'
import { recordStorage } from './storage.ts'
import { diskInfo } from './health.ts'
import { wantedBytes } from './wanted.ts'
import { canView, getRating, parseAllowed } from './ratings.ts'

export interface SeedStatus { ratio: number; hours: number; ratioMet: boolean; hoursMet: boolean; met: boolean }

/** Ratio is measured against the FULL torrent size (conservative when we only fetched part of a pack). */
export function seedStatus(t: Pick<QbTorrent, 'uploaded' | 'total_size' | 'seeding_time'>, c = config.seed): SeedStatus {
  const ratio = t.total_size > 0 ? t.uploaded / t.total_size : 0
  const hours = t.seeding_time / 3600
  const ratioMet = ratio >= c.minRatio
  const hoursMet = hours >= c.minHours
  return { ratio, hours, ratioMet, hoursMet, met: c.mode === 'all' ? ratioMet && hoursMet : ratioMet || hoursMet }
}

export function pendingViewers(torrentId: number): string[] {
  const cutoff = config.abandonDays > 0 ? now() - config.abandonDays * 86400 : -1
  // Something fetched ahead of time for a person lapses sooner than something they actually started.
  const autoCutoff = now() - config.auto.expireDays * 86400
  const started = (db.prepare(`SELECT DISTINCT u.name FROM interests i JOIN users u ON u.id = i.user_id
    WHERE i.torrent_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL AND i.updated_at > CASE WHEN i.auto = 1 THEN ? ELSE ? END`).all(torrentId, autoCutoff, cutoff) as { name: string }[])
    .map((r) => r.name)
  return started
}

/**
 * People who are allowed to watch this torrent's show (admins, unrestricted accounts, or a rating they may see) and have
 * not yet watched it. Someone who released it ("I don't need this") is counted as done. Nobody being left means everyone who
 * could have watched it has.
 */
export function unwatchedEligible(torrentId: number): string[] {
  // Once a pack's "Leaving soon" window has run out, the people who never opened it count as done.
  const leavingAt = (db.prepare('SELECT leaving_at FROM downloads WHERE torrent_id = ?').get(torrentId) as { leaving_at: number | null } | undefined)?.leaving_at
  if (leavingAt != null && leavingAt <= now()) return []
  return untouchedEligible(torrentId)
}

/**
 * unwatchedEligible without the "Leaving soon" expiry: allowed viewers who are not done with it. In a season pack that means every
 * episode in it (one watched episode is not the whole season); elsewhere, the file. Released ("I don't need this") counts as done.
 */
function untouchedEligible(torrentId: number): string[] {
  const rel = db.prepare('SELECT series_id, is_pack FROM releases WHERE torrent_id = ?').get(torrentId) as { series_id: number | null; is_pack: number } | undefined
  const rating = rel?.series_id != null ? getRating(rel.series_id).rating : 'Unrated'
  const users = db.prepare('SELECT id, name, is_admin, allowed_ratings FROM users').all() as { id: number; name: string; is_admin: number; allowed_ratings: string | null }[]
  // How many files someone has to be done with: every episode of a pack (when its file list is known), else just one.
  const need = rel?.is_pack ? Math.max(1, (db.prepare('SELECT COUNT(*) AS n FROM pack_files WHERE torrent_id = ?').get(torrentId) as { n: number }).n) : 1
  const done = db.prepare('SELECT COUNT(DISTINCT file_index) AS n FROM interests WHERE user_id = ? AND torrent_id = ? AND (watched_at IS NOT NULL OR released_at IS NOT NULL)')
  return users
    .filter((u) => canView({ is_admin: u.is_admin, allowed: parseAllowed(u.allowed_ratings) }, rating))
    .filter((u) => (done.get(u.id, torrentId) as { n: number }).n < need)
    .map((u) => u.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Start (or stop) the "Leaving soon" clock for a download (an episode, or a season pack). It runs only while it is fully downloaded and seeded, someone
 * has watched it, nobody is partway through or holding it (pressing play on it counts, and restarts the window once they finish or drop it), and some allowed viewers never opened it. Returns when it leaves, or null.
 */
export function updateLeaving(torrentId: number, t: Pick<QbTorrent, 'amount_left' | 'uploaded' | 'total_size' | 'seeding_time'>): number | null {
  const d = db.prepare('SELECT leaving_at FROM downloads WHERE torrent_id = ?').get(torrentId) as { leaving_at: number | null } | undefined
  if (!d) return null
  const applies = config.leavingDays > 0 && t.amount_left === 0 && seedStatus(t).met
    && pendingViewers(torrentId).length === 0
    && !!db.prepare('SELECT 1 FROM interests WHERE torrent_id = ? AND watched_at IS NOT NULL').get(torrentId)
    && untouchedEligible(torrentId).length > 0
  if (!applies) {
    if (d.leaving_at !== null) db.prepare('UPDATE downloads SET leaving_at = NULL WHERE torrent_id = ?').run(torrentId)
    return null
  }
  if (d.leaving_at !== null) return d.leaving_at
  const at = now() + config.leavingDays * 86400
  db.prepare('UPDATE downloads SET leaving_at = ? WHERE torrent_id = ?').run(at, torrentId)
  return at
}

/** Downloads on their way out that this person is allowed to watch and never opened, for the "Leaving soon" row. */
export function leavingSoonFor(user: { id: number; name: string }) {
  const rows = db.prepare(`SELECT d.torrent_id AS torrentId, d.leaving_at AS leavesAt, r.series_id AS seriesId, r.series, r.season, r.label,
      '/api/art/' || r.series_id || '/poster' AS poster
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id WHERE d.state = 'active' AND d.leaving_at IS NOT NULL AND d.leaving_at > ?
    ORDER BY d.leaving_at`).all(now()) as any[]
  return rows.filter((r) => untouchedEligible(r.torrentId).includes(user.name) && !pendingViewers(r.torrentId).includes(user.name))
}

/** The files inside a torrent: every episode of a pack, else whatever index this person already has for it. */
function fileIndexes(torrentId: number, userId: number): number[] {
  const pack = (db.prepare('SELECT idx FROM pack_files WHERE torrent_id = ? ORDER BY idx').all(torrentId) as { idx: number }[]).map((r) => r.idx)
  if (pack.length) return pack
  const mine = (db.prepare('SELECT file_index FROM interests WHERE user_id = ? AND torrent_id = ?').all(userId, torrentId) as { file_index: number }[]).map((r) => r.file_index)
  if (mine.length) return [...new Set(mine)]
  const any = db.prepare('SELECT file_index FROM interests WHERE torrent_id = ? LIMIT 1').get(torrentId) as { file_index: number } | undefined
  return [any?.file_index ?? 0]
}

/**
 * "Keep it": this person now holds the download, so its "Leaving soon" clock stops. Writes (or refreshes) an interest for
 * every file in it, which makes them a pending viewer and clears their release. It lapses like any other hold (abandonDays)
 * if they never come back to it, so one tap cannot pin a season on disk for ever.
 */
export function keepFor(userId: number, torrentId: number): { kept: boolean; leavesAt: null } {
  const d = db.prepare('SELECT state FROM downloads WHERE torrent_id = ?').get(torrentId) as { state: string } | undefined
  if (!d || d.state !== 'active') throw new Error('that download is not here any more')
  const t = now()
  const ins = db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, auto) VALUES (?,?,?,?,?,0)
    ON CONFLICT(user_id, torrent_id, file_index) DO UPDATE SET updated_at = excluded.updated_at, released_at = NULL, auto = 0`)
  for (const i of fileIndexes(torrentId, userId)) ins.run(userId, torrentId, i, t, t)
  db.prepare('UPDATE downloads SET leaving_at = NULL WHERE torrent_id = ?').run(torrentId)
  console.log(`[retention] user ${userId} kept torrent ${torrentId}; leaving clock stopped`)
  return { kept: true, leavesAt: null }
}

/**
 * "Let it go": this person is done with it without watching, so they stop holding it. Counts as done for every file in the
 * torrent. Nobody else's hold is touched: it goes when the last allowed viewer is done AND BTN's seeding rule is met.
 */
export function letGoFor(userId: number, torrentId: number): { ok: true } {
  const t = now()
  const ins = db.prepare(`INSERT INTO interests (user_id, torrent_id, file_index, created_at, updated_at, auto, released_at) VALUES (?,?,?,?,?,0,?)
    ON CONFLICT(user_id, torrent_id, file_index) DO UPDATE SET released_at = excluded.released_at, updated_at = excluded.updated_at, auto = 0`)
  for (const i of fileIndexes(torrentId, userId)) ins.run(userId, torrentId, i, t, t, t)
  console.log(`[retention] user ${userId} let go of torrent ${torrentId}`)
  return { ok: true }
}

export interface Holder { name: string; state: 'partway' | 'queued' | 'ahead' | 'unwatched'; lapsesAt: number | null }

/**
 * Who is keeping a torrent on disk, and why: people partway through it, who have it lined up to watch, or for whom it was fetched
 * ahead of time, plus anyone allowed to watch it who hasn't yet. Each hold from an interest lapses (abandonDays, or a week for ahead-of-time ones) unless they come back to it.
 */
export function holdersOf(torrentId: number): Holder[] {
  const rows = db.prepare(`SELECT u.name, i.auto, i.position, i.updated_at FROM interests i JOIN users u ON u.id = i.user_id
    WHERE i.torrent_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL`).all(torrentId) as { name: string; auto: number; position: number; updated_at: number }[]
  const by = new Map<string, Holder>()
  const rank = { partway: 0, queued: 1, ahead: 2, unwatched: 3 }
  for (const r of rows) {
    const days = r.auto ? config.auto.expireDays : config.abandonDays
    const lapsesAt = days > 0 ? r.updated_at + days * 86400 : null
    if (lapsesAt !== null && lapsesAt <= now()) continue // lapsed: no longer holds it
    const state: Holder['state'] = r.position > 30 ? 'partway' : r.auto ? 'ahead' : 'queued'
    const have = by.get(r.name)
    if (!have || rank[state] < rank[have.state]) by.set(r.name, { name: r.name, state, lapsesAt })
  }
  // Everyone else who is allowed to watch it and has not yet also holds it, whether or not they ever pressed play.
  for (const name of unwatchedEligible(torrentId)) if (!by.has(name)) by.set(name, { name, state: 'unwatched', lapsesAt: null })
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function whyKept(t: QbTorrent, torrentId: number): { deletable: boolean; reasons: string[]; pending: string[]; seed: SeedStatus } {
  const pending = pendingViewers(torrentId)
  const seed = seedStatus(t)
  // A torrent put in the Downloads folder by hand is not Flix's to delete until somebody has actually watched it
  // (this holds even if the engine reports nothing downloaded: it may simply have been checked, not fetched, here).
  const origin = (db.prepare('SELECT origin FROM downloads WHERE torrent_id = ?').get(torrentId) as any)?.origin
  if (origin === 'adopted' && !db.prepare('SELECT 1 FROM interests WHERE torrent_id = ?').get(torrentId))
    return { deletable: false, reasons: ['added to the Downloads folder outside Flix; kept until someone has watched it'], pending, seed }
  // A torrent that never got a single byte (no seeders, or the viewer was moved to another source) owes BTN nothing and is
  // not worth keeping; without this a dead torrent would sit in the engine forever, "still downloading". Every one of these
  // has to hold for that to be true: a torrent that fetched even a byte, or holds a partial file, is kept and seeded.
  if (t.downloaded === 0 && t.progress === 0 && t.amount_left >= t.size && !pending.length) return { deletable: true, reasons: [], pending, seed }
  const reasons: string[] = []
  if (t.amount_left > 0) reasons.push('still downloading')
  if (pending.length) reasons.push(`waiting for: ${pending.join(', ')}`)
  const asked = (db.prepare('SELECT remove_when_seeded FROM downloads WHERE torrent_id = ?').get(torrentId) as { remove_when_seeded: number } | undefined)?.remove_when_seeded === 1
  // The admin asked for it to go once seeded: only someone partway through (or with it lined up) still keeps it.
  const unwatched = asked ? [] : unwatchedEligible(torrentId).filter((n) => !pending.includes(n))
  if (unwatched.length) {
    const leavingAt = (db.prepare('SELECT leaving_at FROM downloads WHERE torrent_id = ?').get(torrentId) as { leaving_at: number | null } | undefined)?.leaving_at
    const leaving = leavingAt != null ? `; leaving in ${Math.max(0, Math.ceil((leavingAt - now()) / 86400))} day(s) unless they keep it` : ''
    reasons.push(`not yet watched by everyone who can: ${unwatched.join(', ')}${leaving}`)
  }
  if (!seed.met) {
    const need: string[] = []
    if (!seed.ratioMet) need.push(`ratio ${seed.ratio.toFixed(2)}/${config.seed.minRatio}`)
    if (!seed.hoursMet) need.push(`seed time ${seed.hours.toFixed(1)}h/${config.seed.minHours}h`)
    reasons.push(`BTN seeding requirement not met: need ${config.seed.minHours}h or ${config.seed.minRatio}:1 (${need.join(', ')})`)
  }
  return { deletable: reasons.length === 0, reasons, pending, seed }
}

export async function removeDownload(torrentId: number, hash: string, reason: string) {
  // FAIL CLOSED. Anything that has fetched a byte stays until BTN's 130 h or 1:1 is met -- and when the engine cannot say
  // what this torrent has done there, there is no way to prove the requirement is met. Then nothing happens at all: no
  // delete call, no file removal. A refusal costs a little disk; a wrong delete can cost the account.
  let t: QbTorrent
  try {
    t = await qb.info(hash) as QbTorrent
  } catch (e: any) {
    console.error(`[retention] could not read engine state for ${hash} (${e?.message ?? e}); not removing`)
    throw new Error('could not confirm BTN seeding requirement (engine state unreadable); not removing')
  }
  if (!t) {
    console.warn(`[retention] ${hash} is not in the engine, so its seeding cannot be confirmed; not removing`)
    throw new Error('could not confirm BTN seeding requirement (torrent not in engine); not removing')
  }
  if (t.downloaded > 0 && !seedStatus(t).met)
    throw new Error(`BTN seeding requirement (${config.seed.minHours}h or ${config.seed.minRatio}:1) not met yet; refusing to remove`)
  stopJobsFor(torrentId)
  await qb.remove(hash, true)
  tidyAfterRemoval(t) // the engine deletes the files; sweep up the empty folders it leaves in Downloads
  db.prepare(`UPDATE downloads SET state='removed', removed_at=?, remove_reason=? WHERE torrent_id=?`).run(now(), reason, torrentId)
}

/** Torrents Flix put in the engine are tagged 'flix'; anything else is only Flix's if it has a downloads row. */
function hasFlixTag(t: Pick<QbTorrent, 'tags'>): boolean {
  return (t.tags ?? '').split(',').some((x) => x.trim().toLowerCase() === 'flix')
}

/** Every hash Flix has a downloads row for, whatever state it is in, mapped to its torrent id. */
function flixHashes(): Map<string, number> {
  return new Map((db.prepare('SELECT torrent_id, info_hash FROM downloads').all() as { torrent_id: number; info_hash: string }[])
    .map((r) => [String(r.info_hash).toLowerCase(), r.torrent_id] as [string, number]))
}

/** True when the torrent is Flix's to touch: it carries the flix tag, or it has a downloads row. */
export function flixOwns(t: Pick<QbTorrent, 'hash' | 'tags'>, owned: Map<string, number>): boolean {
  return hasFlixTag(t) || owned.has(t.hash.toLowerCase())
}

/**
 * Point every torrent in the engine that Flix owns at the Downloads folder Flix is configured to use, so a changed
 * DOWNLOAD_DIR (or a folder that moved under it) does not leave files scattered and unseedable. Moving a torrent this way
 * keeps it in the engine: it stays in the swarm, keeps its seed time, and nothing is removed or deleted. Torrents already
 * there are left alone, ones still downloading are picked up next start, and ones somebody is watching right now wait until
 * they stop. A torrent Flix does not own (no flix tag, no downloads row) is not touched at all. Never throws: a start-up
 * that cannot reach the engine must still come up.
 */
export async function relocateDownloads(): Promise<{ moved: number; skipped: number; failed: number }> {
  const out = { moved: 0, skipped: 0, failed: 0 }
  const target = config.downloadDir.replace(/[\\/]+$/, '')
  const all = await qb.listAll().catch((e: any) => { console.warn(`[qb] could not list torrents to relocate: ${e.message}`); return [] as QbTorrent[] })
  const busy = new Set((db.prepare('SELECT DISTINCT torrent_id FROM interests WHERE watched_at IS NULL AND released_at IS NULL AND updated_at > ?').all(now() - 1800) as { torrent_id: number }[]).map((r) => r.torrent_id))
  const flixId = flixHashes()
  for (const t of all) {
    if (!flixOwns(t, flixId)) { out.skipped++; console.debug(`[qb] left ${t.name} alone: not Flix's (no flix tag, no downloads row)`); continue }
    if (t.save_path.replace(/[\\/]+$/, '') === target) { out.skipped++; continue }
    if (t.dlspeed > 0 || /DL$/.test(t.state) || t.progress < 1) { out.skipped++; console.log(`[qb] left ${t.name} where it is: still downloading`); continue }
    const id = flixId.get(t.hash.toLowerCase())
    if (id !== undefined && busy.has(id)) { out.skipped++; console.log(`[qb] left ${t.name} where it is: being watched right now`); continue }
    try {
      await qb.setLocation(t.hash, target)
      out.moved++
      console.log(`[qb] moved ${t.name} to ${target} (was ${t.save_path})`)
    } catch (e: any) { out.failed++; console.warn(`[qb] could not move ${t.name}: ${e.message}`) }
  }
  if (out.moved || out.failed) console.log(`[qb] relocate: ${out.moved} moved, ${out.skipped} left alone, ${out.failed} failed`)
  return out
}

/** Engine states that mean "the files are not where I left them": the torrent is stalled until it re-verifies. */
const MISSING_STATE = /^(missingFiles|error)$/i

/**
 * The download folder's host path can change while the container path stays /downloads, and then qBittorrent looks for files
 * at a path it believes has not moved and reports missingFiles. Ask it to re-verify the torrents that hold data and are in
 * that state, and let it sort itself out. Never re-adds, never deletes, never removes a torrent, never throws.
 */
export async function recheckMissingFiles(): Promise<{ rechecked: number; failed: number }> {
  const out = { rechecked: 0, failed: 0 }
  try {
    const all = await qb.listAll()
    const flixId = flixHashes()
    for (const t of all) {
      if (!flixOwns(t, flixId)) continue
      if (!(t.progress > 0 || (t.completed ?? 0) > 0)) continue
      if (!MISSING_STATE.test(t.state ?? '')) continue
      try {
        await qb.recheck(t.hash)
        out.rechecked++
        console.log(`[qb] rechecking ${t.name}: engine reports ${t.state} (its files are not where it left them)`)
      } catch (e: any) { out.failed++; console.warn(`[qb] could not recheck ${t.name}: ${e.message}`) }
    }
    if (out.rechecked || out.failed) console.log(`[qb] recheck: ${out.rechecked} rechecked, ${out.failed} failed`)
  } catch (e: any) { console.warn(`[qb] recheck pass skipped: ${e.message}`) }
  return out
}

/** When each active download was first found missing from the engine (see sweep). */
const absentSince = new Map<number, number>()
const ABSENT_FOR_SEC = 600

/** Someone touched a download this recently: it may be playing right now, so it is never deleted for space. */
export const PRUNE_BUSY_SEC = 1800

/** A download that has passed every gate in whyKept() and is only waiting for disk pressure. */
export interface PruneCandidate {
  torrentId: number
  hash: string
  /** downloads.added_at: the oldest goes first. */
  addedAt: number
  /** Bytes it holds, so the storage graph can be corrected once it goes. */
  bytes: number
  /** whyKept().deletable -- every hard gate (seeding met, no pending viewers, not outside Flix) already passed. */
  deletable: boolean
}

/** Where pruneUnderPressure reads the world from. Tests hand in their own. */
export interface PruneHooks {
  /** Free and total bytes on the download volume, or null when it cannot be read. */
  free: () => { free: number; total: number } | null
  /** True when an interest in this torrent was touched in the last PRUNE_BUSY_SEC: somebody may be watching it. */
  busy: (torrentId: number) => boolean
  /** Removes one download, files and all. May throw (removeDownload refuses when it cannot prove the seed state). */
  remove: (c: PruneCandidate) => Promise<void>
}

/** Free space as a share of the volume, or null when it cannot be read. */
function freeShare(d: { free: number; total: number } | null): number | null {
  return d && d.total > 0 ? (d.free / d.total) * 100 : null
}

const pruneHooks: PruneHooks = {
  free: () => { try { return diskInfo() } catch { return null } },
  busy: (id) => !!db.prepare('SELECT 1 FROM interests WHERE torrent_id = ? AND updated_at > ?').get(id, now() - PRUNE_BUSY_SEC),
  remove: async (c) => { await removeDownload(c.torrentId, c.hash, 'disk pressure: free space below PRUNE_FREE_PCT and nothing is waiting on it') },
}

/**
 * Delete the least-wanted downloads, oldest first, until the download volume is back above PRUNE_TARGET_PCT.
 *
 * Only ever called when config.pruneFreePct > 0, and only with candidates that have already passed whyKept(). Nothing is
 * deleted while free space is at or above PRUNE_FREE_PCT, and nothing at all when free space cannot be read (fail
 * closed: a refusal costs disk, a wrong delete can cost the BTN account). A download somebody touched in the last
 * PRUNE_BUSY_SEC is left alone -- deleting mid-playback is not acceptable -- and one whose BTN seeding goal is unmet is
 * never a candidate, whatever the pressure.
 *
 * Free space is re-measured after every deletion. If the volume has not reflected the space just freed, the pass stops
 * rather than deleting the next one on a reading that has not caught up (qBittorrent can return before the bytes are
 * unlinked, and that would otherwise delete every candidate in one sweep); the next sweep picks it up.
 */
export async function pruneUnderPressure(cands: PruneCandidate[], hooks: PruneHooks = pruneHooks): Promise<string[]> {
  const removed: string[] = []
  const start = freeShare(hooks.free())
  if (start === null) { console.warn('[retention] prune: free space cannot be read; deleting nothing'); return removed }
  if (start >= config.pruneFreePct) return removed // above the trigger: this pass deletes nothing
  const queue = cands.filter((c) => c.deletable && !hooks.busy(c.torrentId)).sort((a, b) => a.addedAt - b.addedAt)
  if (!queue.length) return removed
  console.log(`[retention] prune: ${start.toFixed(1)}% free is below ${config.pruneFreePct}%; ${queue.length} download(s) can go, oldest first`)
  for (const c of queue) {
    const before = freeShare(hooks.free())
    if (before === null) { console.warn('[retention] prune: free space cannot be read; deleting nothing more'); break }
    if (before >= config.pruneTargetPct) break
    try {
      await hooks.remove(c)
    } catch (e: any) {
      console.warn(`[retention] prune: kept ${c.hash}: ${e.message}`)
      continue // it stays; try the next one rather than giving up on the pass
    }
    removed.push(c.hash)
    console.log(`[retention] prune: deleted ${c.hash} (${(c.bytes / 1e9).toFixed(1)} GB), ${before.toFixed(1)}% free`)
    const after = freeShare(hooks.free())
    if (after !== null && after <= before) {
      console.log('[retention] prune: the volume has not reflected the space freed yet; stopping this pass')
      break
    }
  }
  return removed
}

/** One sweep: delete torrents nobody still needs AND whose seeding obligation is fulfilled -- or, when pruning is on, only under disk pressure. */
export async function sweep(): Promise<string[]> {
  const removed: string[] = []
  await syncFolder().catch((e) => console.warn(`[folder] ${e.message}`)) // adopt what was downloaded by hand, move old hash-named folders, tidy leftovers
  const rows = db.prepare(`SELECT torrent_id, info_hash, added_at FROM downloads WHERE state = 'active'`).all() as { torrent_id: number; info_hash: string; added_at: number }[]
  let onDisk = 0 // what the engine holds for Flix's downloads, for the storage graph
  const pruneable: PruneCandidate[] = [] // deletable, held only until disk pressure (pruneFreePct > 0)
  // An engine that has just started answers with an empty list for a while, as it reads its torrents back in. Taking that
  // at its word marked every download "missing from engine": they stopped counting as on the server and, no longer
  // active, were never swept again once seeded. So a torrent only counts as gone when the engine is plainly holding
  // others and this one has been absent for ten minutes of sweeps.
  const engineHasAny = rows.length ? (await qb.listAll().catch(() => [])).length > 0 : false
  for (const d of rows) {
    const t = await qb.info(d.info_hash)
    if (!t) { // vanished from the engine (manually deleted) -> reflect it
      const first = absentSince.get(d.torrent_id) ?? now()
      absentSince.set(d.torrent_id, first)
      if (engineHasAny && now() - first >= ABSENT_FOR_SEC) {
        absentSince.delete(d.torrent_id)
        db.prepare(`UPDATE downloads SET state='removed', removed_at=?, remove_reason='missing from engine' WHERE torrent_id=?`).run(now(), d.torrent_id)
      }
      continue
    }
    absentSince.delete(d.torrent_id)
    const held = (await wantedBytes(d.torrent_id).catch(() => null))?.held ?? t.size * t.progress
    onDisk += held
    if (d.added_at > now() - config.sweepGraceSec) continue // just added: its first viewer's interest may not be written yet
    updateLeaving(d.torrent_id, t)
    const why = whyKept(t, d.torrent_id)
    if (config.pruneFreePct > 0) {
      // Deleting on release is off: a download that can go is held, still seeding, until disk pressure decides.
      if (why.deletable) pruneable.push({ torrentId: d.torrent_id, hash: d.info_hash, addedAt: d.added_at, bytes: held, deletable: true })
      continue
    }
    if (why.deletable) {
      // One that cannot be removed right now (the engine did not answer) stays for the next sweep; the rest still go.
      try { await removeDownload(d.torrent_id, d.info_hash, 'all viewers done and seeding requirement met') } catch (e: any) { console.warn(`[retention] kept ${d.info_hash}: ${e.message}`); continue }
      removed.push(d.info_hash)
      onDisk -= held
    }
  }
  if (config.pruneFreePct > 0) {
    for (const h of await pruneUnderPressure(pruneable)) {
      removed.push(h)
      const c = pruneable.find((p) => p.hash === h)
      if (c) onDisk -= c.bytes
    }
  }
  try { recordStorage(onDisk) } catch (e: any) { console.warn(`[storage] ${e.message}`) }
  return removed
}

export function startSweeper() {
  const run = () => sweep().catch((e) => console.error('[retention] sweep failed:', e.message))
  const timer = setInterval(run, config.sweepIntervalSec * 1000)
  timer.unref()
  return run
}
