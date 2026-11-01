import { db } from './db.ts'
import { config } from './config.ts'
import { qb } from './qb.ts'

/**
 * Downloads slow down while something is playing, and speed back up afterwards.
 *
 * A show that freezes mid-episode is not short of bandwidth, it is short of disk: the torrents write to the same USB drives
 * the player reads from, and the drive spends its time seeking between the two. File priorities, which ahead.ts already
 * sets (the episode being watched at 7, the next one at 1), only decide who wins when the link is saturated; they do nothing
 * about the total, and the total is what the drive cannot keep up with. So the blunt instrument is the right one here: one
 * engine-wide download limit while somebody is watching. The other torrents are left exactly as they are, and so need no
 * putting back.
 *
 * The person's own limit (0 = unlimited) is kept in the settings table before the cap goes on, along with a flag saying the
 * cap is on. Both live on disk and not in memory so that a restart in the middle of an episode can undo it (recoverPace).
 */

const SAVED = 'pace_saved_limit'
const CAPPED = 'pace_capped'
/** Nothing has said something is playing for this long: the viewer left, or paused for good. */
const IDLE_MS = 60_000

const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
const put = (k: string, v: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
const drop = () => db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(SAVED, CAPPED)

let watching = false
let lastSeen = 0
/** The qBittorrent calls of one change finish before the next begins, so a quick on-off-on cannot interleave them. */
let chain: Promise<void> = Promise.resolve()
const inOrder = (fn: () => Promise<void>) => (chain = chain.then(fn, fn))

/** The cap in bytes a second; capKbps is kilobytes a second (see config). */
const capBytes = () => Math.round(config.pace.capKbps * 1024)

async function cap() {
  const current = await qb.downloadLimit()
  // The stored value is the person's, and is only ever written while the cap is NOT on. If the flag is already set (an earlier
  // run capped and never restored), what the engine reports now is our own cap, not theirs, so the stored value stays.
  if (get(CAPPED) !== '1') put(SAVED, String(current))
  put(CAPPED, '1') // before the limit changes, so a crash between the two still ends in a restore
  if (current !== capBytes()) await qb.setDownloadLimit(capBytes())
}

/** Put the person's own limit back, once. The flag goes only after the engine accepted it, so a failure is tried again. */
async function restore() {
  if (get(CAPPED) !== '1') return
  const saved = Number(get(SAVED))
  await qb.setDownloadLimit(Number.isFinite(saved) && saved >= 0 ? saved : 0)
  drop()
}

/**
 * Say that something is (or is no longer) playing. Safe to call as often as you like: the first `true` caps the downloads, and
 * every one after it only renews the clock the idle timer reads; `false` while idle does nothing. `label` is for the log.
 */
export function setWatching(on: boolean, label?: string): Promise<void> {
  if (on) lastSeen = Date.now()
  if (on === watching || (on && !config.pace.enabled)) return chain
  watching = on
  return inOrder(async () => {
    try {
      if (on) await cap()
      else await restore()
      console.log(`[pace] ${on ? 'slowing downloads' : 'downloads back to normal'}${label ? ` (${label})` : ''}`)
    } catch (e: any) {
      // The engine could not be reached. Forget the state change so the next call tries again; a cap that did land is
      // still flagged, and the next restore undoes it.
      watching = !on
      console.warn(`[pace] ${e.message}`)
    }
  })
}

/** Called on a timer: playback that has not been heard from for a minute has stopped. */
export function tick(nowMs = Date.now()): Promise<void> {
  if (watching && nowMs - lastSeen >= IDLE_MS) return setWatching(false)
  return chain
}

/** Run once at start, whatever the setting says: if the cap was on when the server went down, take it off. Never throws. */
export async function recoverPace(): Promise<void> {
  watching = false
  try { await restore() } catch (e: any) { console.warn(`[pace] could not restore the download limit: ${e.message}`) }
}
