import { config } from './config.ts'

/** Automatic source selection: the family never sees a list of releases. */
export interface Cand {
  torrent_id: number; resolution: string | null; codec: string | null
  seeders: number | null; size: number | null; on_server: boolean
  /** Set when BTN no longer serves this release's .torrent: it is never picked again, whatever its cached seeders say. */
  dead?: number | boolean | null
  /** When BTN published it: between two copies of the same episode, the newer one is the one still being talked about. */
  time?: number | null
}

/** 0 = 1080p (preferred), 1 = 720p, 2 = anything else, 3 = 4K: a last resort, because it takes far more disk than the rest. */
/**
 * What playing this release costs the box. 0 needs no conversion at all: H.264 at 1080p or below is either played
 * as it is or has its picture copied into MP4. 1 has to be re-encoded (HEVC, older codecs). 2 is 4K, which is
 * never chosen: the box streams 1080p, so a 4K release is a much bigger download for a picture that is downscaled.
 */
export function convertCost(c: { codec?: string | null; resolution?: string | null }): number {
  const res = (c.resolution ?? '').toLowerCase()
  if (/2160|4k|uhd/.test(res)) return 2
  return /264|avc/i.test(c.codec ?? '') ? 0 : 1
}

export function tierOf(res?: string | null): number {
  const r = (res ?? '').toLowerCase()
  if (/2160|4k|uhd/.test(r)) return 3
  if (/1080/.test(r)) return 0
  if (/720/.test(r)) return 1
  return 2
}
export const qualityLabel = (res?: string | null) => ['1080p', '720p', 'SD', '4K'][tierOf(res)]

/** A release is "alive" if somebody is seeding it, or we already hold the complete file. */
export const isAlive = (c: Cand) => c.on_server || (!c.dead && (c.seeders ?? 0) > 0)

/**
 * Two files whose sizes land in the same 25 MB bin count as the same size. Sizes are what the tracker reported for a
 * listing that may be months old and for a file cut by a different group; a few KB apart is noise, not a difference.
 * A bin rather than a pairwise "within 5%" test, because a comparator that is not transitive makes the sort's result
 * depend on the order the rows came back in.
 */
const SIZE_BIN = 25 * 1024 * 1024
const sizeBin = (n: number | null | undefined) => (n == null ? Infinity : Math.floor(n / SIZE_BIN))

/**
 * Best source for one episode:
 * a living source beats a dead one; then 1080p beats 720p beats the rest, and 4K is only chosen when nothing else is alive;
 * then what we already have on disk (instant start); then H.264 (plays without heavy transcoding); then the smaller file
 * of the same resolution, because there is nothing to wait for in the larger one; then most seeders; then the newest.
 */
export function pickRelease<T extends Cand>(cands: T[]): T | undefined {
  // In copy-only mode a release that would need the picture re-encoded is not a candidate at all: it is never
  // downloaded, so the box never spends the CPU this mode exists to save. An episode with no such release simply
  // has no source, which is honest -- the alternative was downloading gigabytes to convert them.
  const off = config.transcode.mode === 'off'
  const usable = off ? cands.filter((c) => convertCost(c) === 0) : cands
  // 4K is only ever a fallback for an episode with nothing else alive: it is a much larger download for a picture
  // the box caps at 1080p anyway, so it is never worth choosing over a 1080p release.
  const not4k = usable.filter((c) => convertCost(c) < 2)
  const pool = off ? usable : not4k.some(isAlive) ? not4k : usable
  return [...pool].sort((a, b) =>
    Number(!isAlive(a)) - Number(!isAlive(b)) ||
    // With the picture never re-encoded, the cheapest thing to play wins before the sharpest: a 720p H.264 is
    // copied in seconds, where a 1080p HEVC would need a full encode. Otherwise resolution leads, as it always has.
    (off ? convertCost(a) - convertCost(b) : 0) ||
    tierOf(a.resolution) - tierOf(b.resolution) ||
    Number(!a.on_server) - Number(!b.on_server) ||
    (off ? 0 : convertCost(a) - convertCost(b)) ||
    // Same resolution: the smaller file wins, because it is here sooner and this box's line is what stalls a play --
    // but only when it really is smaller. Two copies a few KB apart are the same download, so the swarm decides:
    // most seeders first, then the newest release (a stale listing is the one whose torrent has quietly been deleted).
    sizeBin(a.size) - sizeBin(b.size) ||
    (b.seeders ?? 0) - (a.seeders ?? 0) ||
    (b.time ?? 0) - (a.time ?? 0) ||
    (a.size ?? Infinity) - (b.size ?? Infinity) ||
    a.torrent_id - b.torrent_id,
  )[0]
}
