import { db, now } from './db.ts'

/**
 * How much disk Flix's downloads have taken over time, for the graph on the Torrents page. The sweeper records what the engine
 * holds once an hour (`storage_samples`). For the time before that was recorded, the line is estimated from when each download was
 * added and removed (full torrent sizes), so a 12-month graph exists from the first day and goes up and down as downloads come and go.
 */

const HOUR = 3600, DAY = 86400, DAYS = 365

/** Remember the bytes the downloads take right now (at most one row an hour; the last write in the hour wins). */
export function recordStorage(bytes: number) {
  db.prepare('INSERT OR REPLACE INTO storage_samples (ts, bytes) VALUES (?, ?)').run(Math.floor(now() / HOUR) * HOUR, Math.max(0, Math.round(bytes)))
}

export interface StorageHistory { points: [number, number][]; since: number | null }

/** One point per day for the last 12 months, plus now. `since` is when real measuring began: the line before it is an estimate. */
export function storageHistory(at = now()): StorageHistory {
  const samples = db.prepare('SELECT ts, bytes FROM storage_samples ORDER BY ts').all() as { ts: number; bytes: number }[]
  const events = db.prepare(`SELECT d.added_at AS a, d.removed_at AS r, COALESCE(r.size, 0) AS size FROM downloads d JOIN releases r ON r.torrent_id = d.torrent_id`).all() as { a: number; r: number | null; size: number }[]
  const since = samples[0]?.ts ?? null
  let si = -1 // the last sample at or before t
  const valueAt = (t: number) => {
    if (since !== null && t >= since) { while (si + 1 < samples.length && samples[si + 1].ts <= t) si++; return samples[si].bytes }
    return events.reduce((s, e) => s + (e.a <= t && (e.r === null || e.r > t) ? e.size : 0), 0)
  }
  const points: [number, number][] = []
  const today = Math.floor(at / DAY) * DAY
  for (let d = DAYS - 1; d >= 0; d--) { const t = Math.min(today - d * DAY + DAY - 1, at); if (t < at) points.push([t, valueAt(t)]) }
  points.push([at, valueAt(at)])
  return { points, since }
}
