import { db, now } from './db.ts'
import { config } from './config.ts'
import { qb, type QbTorrent } from './qb.ts'
import { stopJobsFor } from './transcode.ts'
import { syncFolder, tidyAfterRemoval } from './folder.ts'
import { recordStorage } from './storage.ts'

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
  return (db.prepare(`SELECT DISTINCT u.name FROM interests i JOIN users u ON u.id = i.user_id
    WHERE i.torrent_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL AND i.updated_at > CASE WHEN i.auto = 1 THEN ? ELSE ? END`).all(torrentId, autoCutoff, cutoff) as { name: string }[])
    .map((r) => r.name)
}

export interface Holder { name: string; state: 'partway' | 'queued' | 'ahead'; lapsesAt: number | null }

/**
 * Who is keeping a torrent on disk, and why: people partway through it, who have it lined up to watch, or for whom it was fetched
 * ahead of time. Each hold lapses (abandonDays, or a week for ahead-of-time ones) unless they come back to it.
 */
export function holdersOf(torrentId: number): Holder[] {
  const rows = db.prepare(`SELECT u.name, i.auto, i.position, i.updated_at FROM interests i JOIN users u ON u.id = i.user_id
    WHERE i.torrent_id = ? AND i.watched_at IS NULL AND i.released_at IS NULL`).all(torrentId) as { name: string; auto: number; position: number; updated_at: number }[]
  const by = new Map<string, Holder>()
  const rank = { partway: 0, queued: 1, ahead: 2 }
  for (const r of rows) {
    const days = r.auto ? config.auto.expireDays : config.abandonDays
    const lapsesAt = days > 0 ? r.updated_at + days * 86400 : null
    if (lapsesAt !== null && lapsesAt <= now()) continue // lapsed: no longer holds it
    const state: Holder['state'] = r.position > 30 ? 'partway' : r.auto ? 'ahead' : 'queued'
    const have = by.get(r.name)
    if (!have || rank[state] < rank[have.state]) by.set(r.name, { name: r.name, state, lapsesAt })
  }
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
  // not worth keeping; without this a dead torrent would sit in the engine forever, "still downloading".
  if (t.downloaded === 0 && !pending.length) return { deletable: true, reasons: [], pending, seed }
  const reasons: string[] = []
  if (t.amount_left > 0) reasons.push('still downloading')
  if (pending.length) reasons.push(`waiting for: ${pending.join(', ')}`)
  if (!seed.met) {
    const need: string[] = []
    if (!seed.ratioMet) need.push(`ratio ${seed.ratio.toFixed(2)}/${config.seed.minRatio}`)
    if (!seed.hoursMet) need.push(`seed time ${seed.hours.toFixed(1)}h/${config.seed.minHours}h`)
    reasons.push(`BTN seeding requirement not met: need ${config.seed.minHours}h or ${config.seed.minRatio}:1 (${need.join(', ')})`)
  }
  return { deletable: reasons.length === 0, reasons, pending, seed }
}

export async function removeDownload(torrentId: number, hash: string, reason: string) {
  stopJobsFor(torrentId)
  const t = await qb.info(hash).catch(() => undefined)
  await qb.remove(hash, true)
  if (t) tidyAfterRemoval(t) // the engine deletes the files; sweep up the empty folders it leaves in Downloads
  db.prepare(`UPDATE downloads SET state='removed', removed_at=?, remove_reason=? WHERE torrent_id=?`).run(now(), reason, torrentId)
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
