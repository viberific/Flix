import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

const env = process.env
/** The user's own Downloads folder (XFCE and other desktops keep it in ~/.config/user-dirs.dirs; otherwise ~/Downloads). Null when there isn't one. */
function userDownloads(): string | null {
  const home = homedir()
  try {
    const m = /^XDG_DOWNLOAD_DIR=\s*"?([^"\n]+)"?/m.exec(readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8'))
    if (m) { const p = m[1].replace(/^\$HOME/, home); if (existsSync(p)) return p }
  } catch { /* no desktop folders configured */ }
  const d = join(home, 'Downloads')
  return existsSync(d) ? d : null
}

const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d)

export const config = {
  port: num('PORT', 8096),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  // Torrents live straight in the desktop's Downloads folder (so what you download by hand there is the same pile Flix manages); DOWNLOAD_DIR overrides it.
  downloadDir: resolve(env.DOWNLOAD_DIR || userDownloads() || './downloads'),
  // The port qBittorrent listens on for peers. Fixed rather than random so a
  // port forward on the router keeps working across restarts (a random port
  // moves every start and nothing can be forwarded to it). The container
  // publishes this same number in docker-compose's `ports`, and UPnP asks the
  // router to open it where the router supports that.
  p2pPort: num('QB_LISTEN_PORT', 6881),
  btn: {
    apiKey: env.BTN_API_KEY ?? '',
    apiUrl: env.BTN_API_URL ?? 'https://api.broadcasthe.net/',
    // BTN allows 150 calls/hour; stay well under.
    maxCallsPerHour: num('BTN_MAX_CALLS_PER_HOUR', 100),
  },
  // Content ratings (TV-Y … TV-MA) and the IMDb score come from IMDb through OMDb (needs a free key). TMDB is the fallback for the rating.
  omdb: { apiKey: env.OMDB_API_KEY ?? '', apiUrl: (env.OMDB_API_URL ?? 'https://www.omdbapi.com').replace(/\/$/, '') },
  // Optional: also the source of networks, languages, season sizes, trending shows, summaries and artwork.
  tmdb: { apiKey: env.TMDB_API_KEY ?? '', apiUrl: (env.TMDB_API_URL ?? 'https://api.themoviedb.org/3').replace(/\/$/, '') },
  // Backup artwork when BTN has none (or its image host refuses us): TMDB (needs the key above), then TVmaze (no key).
  // Set TVMAZE_URL to an empty string to turn TVmaze off.
  art: { tmdbImages: (env.TMDB_IMAGE_URL ?? 'https://image.tmdb.org/t/p').replace(/\/$/, ''), tvmazeUrl: (env.TVMAZE_URL ?? 'https://api.tvmaze.com').replace(/\/$/, ''), youtubeImages: (env.YOUTUBE_IMAGE_URL ?? 'https://i.ytimg.com/vi').replace(/\/$/, ''),
    // Where trailers are searched for and checked. Set YOUTUBE_SEARCH_URL to an empty string to switch the search off (tests do, so they never leave the machine).
    youtubeSearch: (env.YOUTUBE_SEARCH_URL ?? 'https://www.youtube.com/results').replace(/\/$/, ''), youtubeOembed: (env.YOUTUBE_OEMBED_URL ?? 'https://www.youtube.com/oembed').replace(/\/$/, ''),
    // Only for tests that serve artwork from localhost. Leave unset in production (blocks fetching internal addresses).
    allowPrivateHosts: env.ART_ALLOW_PRIVATE_HOSTS === 'true' },
  qb: {
    url: (env.QB_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),
    user: env.QB_USER ?? 'admin',
    pass: env.QB_PASS ?? '',
  },
  // BroadcasTheNet's seeding requirement: 130 hours of seeding OR a 1:1 ratio. Fixed on purpose, not configurable.
  seed: { minRatio: 1.0, minHours: 130, mode: 'any' } as { minRatio: number; minHours: number; mode: 'any' | 'all' },
  // The one address Flix should be reached at, e.g. https://umbrel-1.tail16900.ts.net:9443.
  // Empty (the default) means no redirect: every address serves Flix as before.
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  // The address a TV or cast device should fetch media from. Those devices are on the LAN and cannot resolve a
  // Tailscale name, so this is usually the box's plain-HTTP LAN address (http://10.0.0.247:8096). Empty means
  // "same address as the page", which only works when the page itself is reachable from the TV.
  lanUrl: (env.LAN_URL ?? '').replace(/\/$/, ''),
  // Host names or addresses served directly even though PUBLIC_URL is set, besides the home-network ones
  // already allowed (a private IPv4 literal, an mDNS .local name, and whatever LAN_URL names). Comma-separated,
  // e.g. "flix.home.arpa,media.lan" — for a router DNS name or a phone book name the LAN happens to resolve.
  lanHosts: (env.LAN_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // A show counts as watched only when it has played to the end (within a few seconds, for the credits' last frame); lower this to count e.g. 0.9 as watched.
  watchedThreshold: num('WATCHED_THRESHOLD', 1),
  // A viewer who has not touched a half-watched show for this many days stops holding it (0 = never), so one abandoned show can't pin storage forever.
  abandonDays: num('ABANDON_DAYS', 14),
  // A finished, fully seeded season pack that some allowed viewers never opened is shown to them as "Leaving soon" for this many days, then removed (0 = off).
  leavingDays: num('LEAVING_DAYS', 7),
  // Refuse new downloads when less than this much disk would be left (GB).
  minFreeGb: num('MIN_FREE_GB', 10),
  /** ...and when less than this share of the disk is free (the larger of the two limits applies). */
  minFreePct: num('MIN_FREE_PCT', 10),
  /** Warn the admin below this share free. */
  warnFreePct: num('WARN_FREE_PCT', 20),
  /**
   * When to delete for space, as a share of the download volume's disk. 0 (the default) means off: a finished, fully
   * seeded download nobody needs is removed the moment it is deletable, as Flix has always done. Above 0, nothing is
   * removed on that basis any more -- a download that can go is held (still seeding, still accounted for) until free
   * space falls below this share, and then the oldest of them are deleted until PRUNE_TARGET_PCT is free again.
   */
  pruneFreePct: num('PRUNE_FREE_PCT', 0),
  /** Where a prune pass stops: the share free to climb back to, so it lands clear of the refuse floor below. */
  pruneTargetPct: num('PRUNE_TARGET_PCT', 10),
  /** Downloads Flix starts on its own, ahead of anyone pressing play. They are conservative because a download must seed 130 h / 1:1 before it can be deleted. */
  auto: {
    enabled: env.AUTO_DOWNLOADS !== 'false',
    /** No automatic downloads below this share of free disk. */
    pausePct: num('AUTO_PAUSE_FREE_PCT', 25),
    perUser: num('AUTO_PER_USER', 3),
    /** An automatic download nobody opens is let go after this many days. */
    expireDays: num('AUTO_EXPIRE_DAYS', 7),
  },
  /**
   * How hard the encoder is allowed to work. Measured on the box (Intel N95, 4 cores, 1080p24):
   * economy 4.8x real time, balanced 3.6x, best 2.2x — per job, so two at once roughly halve it.
   * balanced is the default: one screen at a time, where 3.6x keeps the old picture quality and still
   * finishes ahead of the player. Two streams at once was what fell behind, and that is the job cap's
   * problem now, not the preset's. economy is for a box doing something else heavy at the same time.
   */
  transcode: {
    profile: (env.TRANSCODE_PROFILE ?? 'balanced') as 'economy' | 'balanced' | 'best',
    /**
     * auto: convert a file the player cannot take, which is a full libx264 encode when the picture is not one the
     * box can copy (HEVC mostly). off: never re-encode the picture -- copy it into MP4, or refuse and say so. That
     * is what makes playback cost no CPU at all, at the price of the few releases no copy can serve.
     */
    // Copy-only by default: a release whose picture would have to be re-encoded is never downloaded in the first
    // place (pick.ts), and what is downloaded plays as it is or is repacked. TRANSCODE_MODE=auto allows conversions.
    mode: (env.TRANSCODE_MODE === 'auto' ? 'auto' : 'off') as 'auto' | 'off',
    /** Use the GPU's encoder (Quick Sync / VAAPI) when the container can see /dev/dri. Falls back to libx264 on its own. */
    hardware: env.TRANSCODE_HARDWARE !== 'false',
    /**
     * Encodes allowed at once. One, because this box serves one screen: a second full-quality job
     * halves the speed of both on four cores. A second client is never turned away -- enforceJobCap
     * only closes an idle job, never the stream someone is watching.
     */
    maxJobs: num('TRANSCODE_MAX_JOBS', 1),
  },
  sweepIntervalSec: num('SWEEP_INTERVAL_SEC', 60),
  /** A torrent added less than this long ago is never swept (its first viewer is still being recorded). */
  sweepGraceSec: num('SWEEP_GRACE_SEC', 300),
  /** Random per-process secret so our own ffmpeg can read the raw stream without a user cookie. */
  internalKey: crypto.randomUUID(),
}
