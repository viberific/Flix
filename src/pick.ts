/** Automatic source selection: the family never sees a list of releases. */
export interface Cand {
  torrent_id: number; resolution: string | null; codec: string | null
  seeders: number | null; size: number | null; on_server: boolean
}

/** 0 = 1080p (preferred), 1 = 720p, 2 = anything else, 3 = 4K: a last resort, because it takes far more disk than the rest. */
export function tierOf(res?: string | null): number {
  const r = (res ?? '').toLowerCase()
  if (/2160|4k|uhd/.test(r)) return 3
  if (/1080/.test(r)) return 0
  if (/720/.test(r)) return 1
  return 2
}
export const qualityLabel = (res?: string | null) => ['1080p', '720p', 'SD', '4K'][tierOf(res)]

/** A release is "alive" if somebody is seeding it, or we already hold the complete file. */
export const isAlive = (c: Cand) => c.on_server || (c.seeders ?? 0) > 0

/**
 * Best source for one episode:
 * a living source beats a dead one; then 1080p beats 720p beats the rest, and 4K is only chosen when nothing else is alive;
 * then what we already have on disk (instant start); then H.264 (plays without heavy transcoding); then most seeders.
 */
export function pickRelease<T extends Cand>(cands: T[]): T | undefined {
  const h264 = (c: Cand) => (/264|avc/i.test(c.codec ?? '') ? 0 : 1)
  return [...cands].sort((a, b) =>
    Number(!isAlive(a)) - Number(!isAlive(b)) ||
    tierOf(a.resolution) - tierOf(b.resolution) ||
    Number(!a.on_server) - Number(!b.on_server) ||
    h264(a) - h264(b) ||
    (b.seeders ?? 0) - (a.seeders ?? 0),
  )[0]
}
