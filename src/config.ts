import { resolve } from 'node:path'

const env = process.env
const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d)

export const config = {
  port: num('PORT', 8096),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  downloadDir: resolve(env.DOWNLOAD_DIR ?? './downloads'),
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
  watchedThreshold: num('WATCHED_THRESHOLD', 0.9),
  // A viewer who has not touched a half-watched show for this many days stops holding it (0 = never), so one abandoned show can't pin storage forever.
  abandonDays: num('ABANDON_DAYS', 30),
  // Refuse new downloads when less than this much disk would be left (GB).
  minFreeGb: num('MIN_FREE_GB', 10),
  sweepIntervalSec: num('SWEEP_INTERVAL_SEC', 60),
  /** A torrent added less than this long ago is never swept (its first viewer is still being recorded). */
  sweepGraceSec: num('SWEEP_GRACE_SEC', 300),
  /** Random per-process secret so our own ffmpeg can read the raw stream without a user cookie. */
  internalKey: crypto.randomUUID(),
}
