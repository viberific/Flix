import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { db, now } from './db.ts'
import { config } from './config.ts'
import { qb, type QbTorrent } from './qb.ts'
import { catalogChanged } from './seasons.ts'

/**
 * Flix and the Downloads folder stay in step. Flix puts its torrents straight into that folder (each torrent in its own named
 * folder, as qBittorrent does), takes over torrents of BTN releases it knows that were downloaded there by hand, and removes
 * only what it put there, leaving the folder clean. It never deletes a file it did not download or adopt.
 */

const inside = (dir: string, root = config.downloadDir) => { const r = relative(root, dir); return !!r && !r.startsWith('..') && !r.startsWith(sep) && r !== '' }

/** True when a folder (and everything under it) holds no files at all. */
function hasNoFiles(dir: string): boolean {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) return false
      if (!hasNoFiles(join(dir, e.name))) return false
    }
    return true
  } catch { return true }
}

/** After the engine deleted a torrent's files: drop the (empty) folders it leaves behind, up to but never including the Downloads folder. */
export function tidyAfterRemoval(t: Pick<QbTorrent, 'content_path' | 'save_path' | 'name'>) {
  const content = t.content_path || join(t.save_path, t.name)
  for (let dir = content; inside(dir) && existsSync(dir); dir = dirname(dir)) {
    try {
      if (!statSync(dir).isDirectory()) break
      if (!hasNoFiles(dir)) break // something else lives here: not ours to remove
      rmSync(dir, { recursive: true, force: true })
    } catch { break }
  }
}

/** The 40-hex folders earlier versions of Flix used (one per torrent) and any now-empty ones are removed once a torrent has been moved out. */
const HASH_DIR = /^[0-9a-f]{40}$/i
function removeEmptyHashDirs() {
  let names: string[] = []
  try { names = readdirSync(config.downloadDir) } catch { return }
  for (const n of names.filter((x) => HASH_DIR.test(x))) {
    const dir = join(config.downloadDir, n)
    try { if (statSync(dir).isDirectory() && hasNoFiles(dir)) rmSync(dir, { recursive: true, force: true }) } catch { /* leave it */ }
  }
}

const moveTried = new Map<string, number>()

/** One pass: adopt, move old layouts into the Downloads folder, tidy. Cheap enough to run on every sweep. */
export async function syncFolder() {
  const all = await qb.listAll()
  const dl = config.downloadDir
  const underDl = (t: QbTorrent) => t.save_path.replace(/[\\/]+$/, '') === dl || inside(t.save_path)

  // 1. Torrents of releases we know that are in the engine and in the Downloads folder but not managed by Flix: take them over.
  const known = new Map((db.prepare('SELECT torrent_id, info_hash FROM releases').all() as { torrent_id: number; info_hash: string }[]).map((r) => [r.info_hash.toLowerCase(), r.torrent_id]))
  const active = new Set((db.prepare(`SELECT info_hash FROM downloads WHERE state = 'active'`).all() as { info_hash: string }[]).map((r) => r.info_hash.toLowerCase()))
  for (const t of all) {
    const hash = t.hash.toLowerCase()
    const torrentId = known.get(hash)
    if (torrentId === undefined || active.has(hash) || !underDl(t)) continue
    db.prepare(`INSERT INTO downloads (torrent_id, info_hash, state, added_at, origin) VALUES (?,?, 'active', ?, 'adopted')
      ON CONFLICT(torrent_id) DO UPDATE SET state='active', removed_at=NULL, remove_reason=NULL, origin='adopted'`).run(torrentId, hash, now())
    await qb.addTags(t.hash, 'flix').catch(() => {})
    catalogChanged()
    console.log(`[folder] took over ${t.name} from the Downloads folder`)
  }

  // 2. Old layout: <Downloads>/<hash>/... becomes <Downloads>/... (only for torrents nobody has touched in the last half hour, since moving interrupts reading).
  const quiet = (hash: string) => !db.prepare(`SELECT 1 FROM interests i JOIN releases r ON r.torrent_id = i.torrent_id WHERE lower(r.info_hash) = ? AND i.updated_at > ?`).get(hash, now() - 1800)
  for (const t of all) {
    const hash = t.hash.toLowerCase()
    if (!active.has(hash) || t.save_path.replace(/[\\/]+$/, '') !== join(dl, t.hash) && t.save_path.replace(/[\\/]+$/, '') !== join(dl, hash)) continue
    if ((moveTried.get(hash) ?? 0) > Date.now() - 6 * 3600_000 || !quiet(hash)) continue
    moveTried.set(hash, Date.now())
    await qb.setLocation(t.hash, dl).catch((e) => console.warn(`[folder] could not move ${t.name}: ${e.message}`))
  }

  // 3. Empty leftovers of the old layout.
  removeEmptyHashDirs()
}
