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
  // Optional: automatic content ratings (TV-Y … TV-MA) via TMDB. Without a key the admin sets ratings by hand.
  tmdb: { apiKey: env.TMDB_API_KEY ?? '', apiUrl: (env.TMDB_API_URL ?? 'https://api.themoviedb.org/3').replace(/\/$/, '') },
  qb: {
    url: (env.QB_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),
    user: env.QB_USER ?? 'admin',
    pass: env.QB_PASS ?? '',
  },
  // BroadcasTheNet's seeding requirement: 130 hours of seeding OR a 1:1 ratio. Fixed on purpose, not configurable.
  seed: { minRatio: 1.0, minHours: 130, mode: 'any' } as { minRatio: number; minHours: number; mode: 'any' | 'all' },
  // Only for tests that serve artwork from localhost. Leave unset in production (blocks fetching internal addresses).
  art: { allowPrivateHosts: env.ART_ALLOW_PRIVATE_HOSTS === 'true' },
  watchedThreshold: num('WATCHED_THRESHOLD', 0.9),
  abandonDays: num('ABANDON_DAYS', 0),
  sweepIntervalSec: num('SWEEP_INTERVAL_SEC', 60),
  /** Random per-process secret so our own ffmpeg can read the raw stream without a user cookie. */
  internalKey: crypto.randomUUID(),
}
