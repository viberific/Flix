import { db, now } from './db.ts'
import { config } from './config.ts'
import { qb, type QbTorrent } from './qb.ts'
import { stopJobsFor } from './transcode.ts'
import { syncFolder, tidyAfterRemoval } from './folder.ts'
import { recordStorage } from './storage.ts'
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
  // Someone who tapped Keep on "Leaving soon" holds the pack until they have watched it or the usual lapse.
  const kept = (db.prepare(`SELECT u.name FROM leaving_choice c JOIN users u ON u.id = c.user_id WHERE c.torrent_id = ? AND c.choice = 'keep' AND c.at > ?
    AND NOT EXISTS (SELECT 1 FROM interests i WHERE i.user_id = c.user_id AND i.torrent_id = c.torrent_id AND (i.watched_at IS NOT NULL OR i.released_at IS NOT NULL))`).all(torrentId, cutoff) as { name: string }[])
    .map((r) => r.name)
  return [...new Set([...started, ...kept])]
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

/** unwatchedEligible without the "Leaving soon" expiry: allowed viewers who have neither watched nor released it. */
function untouchedEligible(torrentId: number): string[] {
  const rel = db.prepare('SELECT series_id FROM releases WHERE torrent_id = ?').get(torrentId) as { series_id: number | null } | undefined
  const rating = rel?.series_id != null ? getRating(rel.series_id).rating : 'Unrated'
  const users = db.prepare('SELECT id, name, is_admin, allowed_ratings FROM users').all() as { id: number; name: string; is_admin: number; allowed_ratings: string | null }[]
  const done = db.prepare(`SELECT 1 FROM interests WHERE user_id = ? AND torrent_id = ? AND (watched_at IS NOT NULL OR released_at IS NOT NULL)
    UNION ALL SELECT 1 FROM leaving_choice WHERE user_id = ? AND torrent_id = ? AND choice = 'release'`)
  return users
    .filter((u) => canView({ is_admin: u.is_admin, allowed: parseAllowed(u.allowed_ratings) }, rating))
    .filter((u) => !done.get(u.id, torrentId, u.id, torrentId))
    .map((u) => u.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Start (or stop) the "Leaving soon" clock for a season pack. It runs only while the pack is fully downloaded and seeded, someone
 * has watched it, nobody is partway through or holding it, and some allowed viewers never opened it. Returns when it leaves, or null.
 */
export function updateLeaving(torrentId: number, t: Pick<QbTorrent, 'amount_left' | 'uploaded' | 'total_size' | 'seeding_time'>): number | null {
  const d = db.prepare('SELECT d.leaving_at, r.is_pack FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id WHERE d.torrent_id = ?').get(torrentId) as { leaving_at: number | null; is_pack: number } | undefined
  if (!d) return null
  const applies = config.leavingDays > 0 && d.is_pack === 1 && t.amount_left === 0 && seedStatus(t).met
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

/** Packs on their way out that this person is allowed to watch and never opened, for the "Leaving soon" row. */
export function leavingSoonFor(user: { id: number; name: string }) {
  const rows = db.prepare(`SELECT d.torrent_id AS torrentId, d.leaving_at AS leavesAt, r.series_id AS seriesId, r.series, r.season, r.label,
      '/api/art/' || r.series_id || '/poster' AS poster
    FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id WHERE d.state = 'active' AND d.leaving_at IS NOT NULL AND d.leaving_at > ?
    AND NOT EXISTS (SELECT 1 FROM leaving_choice c WHERE c.user_id = ? AND c.torrent_id = d.torrent_id)
    ORDER BY d.leaving_at`).all(now(), user.id) as any[]
  return rows.filter((r) => untouchedEligible(r.torrentId).includes(user.name))
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
  const unwatched = unwatchedEligible(torrentId).filter((n) => !pending.includes(n))
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

/** One sweep: delete torrents nobody still needs AND whose seeding obligation is fulfilled. */
export async function sweep(): Promise<string[]> {
  const removed: string[] = []
  await syncFolder().catch((e) => console.warn(`[folder] ${e.message}`)) // adopt what was downloaded by hand, move old hash-named folders, tidy leftovers
  const rows = db.prepare(`SELECT torrent_id, info_hash, added_at FROM downloads WHERE state = 'active'`).all() as { torrent_id: number; info_hash: string; added_at: number }[]
  let onDisk = 0 // what the engine holds for Flix's downloads, for the storage graph
  for (const d of rows) {
    const t = await qb.info(d.info_hash)
    if (!t) { // vanished from the engine (manually deleted) -> reflect it
      db.prepare(`UPDATE downloads SET state='removed', removed_at=?, remove_reason='missing from engine' WHERE torrent_id=?`).run(now(), d.torrent_id)
      continue
    }
    const held = t.size * t.progress
    onDisk += held
    if (d.added_at > now() - config.sweepGraceSec) continue // just added: its first viewer's interest may not be written yet
    updateLeaving(d.torrent_id, t)
    if (whyKept(t, d.torrent_id).deletable) {
      await removeDownload(d.torrent_id, d.info_hash, 'all viewers done and seeding requirement met')
      removed.push(d.info_hash)
      onDisk -= held
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
