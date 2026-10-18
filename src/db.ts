import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

mkdirSync(config.dataDir, { recursive: true })
export const db = new DatabaseSync(process.env.DB_PATH ?? join(config.dataDir, 'flix.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Admin-editable settings (e.g. the BTN API key). Values are secrets: NEVER send them to clients.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
-- Catalog of BTN torrents we have seen. torrent_link contains the user's passkey: NEVER send to clients.
CREATE TABLE IF NOT EXISTS releases (
  torrent_id INTEGER PRIMARY KEY,
  group_id INTEGER, series_id INTEGER, series TEXT NOT NULL,
  series_poster TEXT, series_banner TEXT, tvdb_id INTEGER, imdb_id TEXT,
  group_name TEXT NOT NULL, release_name TEXT,
  season INTEGER, episode INTEGER, label TEXT, is_pack INTEGER NOT NULL DEFAULT 0,
  resolution TEXT, codec TEXT, container TEXT, source TEXT, origin TEXT,
  size INTEGER, seeders INTEGER, time INTEGER, info_hash TEXT NOT NULL, torrent_link TEXT,
  genres TEXT, youtube_trailer TEXT, fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_series ON releases(series_id, season, episode);
CREATE TABLE IF NOT EXISTS series_sync (series_id INTEGER PRIMARY KEY, synced_at INTEGER NOT NULL);
-- One row per torrent we have (had) in the engine.
CREATE TABLE IF NOT EXISTS downloads (
  torrent_id INTEGER PRIMARY KEY REFERENCES releases(torrent_id),
  info_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',      -- active | removed
  added_at INTEGER NOT NULL,
  removed_at INTEGER,
  remove_reason TEXT
);
-- Who still needs this file. A torrent is only deleted when nobody has an unwatched interest.
CREATE TABLE IF NOT EXISTS interests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  torrent_id INTEGER NOT NULL REFERENCES releases(torrent_id),
  file_index INTEGER NOT NULL,
  file_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched_at INTEGER,
  released_at INTEGER,                       -- user said "I don't need this"
  PRIMARY KEY (user_id, torrent_id, file_index)
);
-- One-time sign-in links the admin hands out, so a family member never has to type a password on a new device.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS my_list (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id INTEGER NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, series_id)
);
`)
db.exec(`
-- Titles, summaries and stills per episode (TMDB, or TVmaze when there is no TMDB key).
CREATE TABLE IF NOT EXISTS episode_info (
  series_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, overview TEXT, still TEXT, runtime INTEGER, PRIMARY KEY (series_id, season, episode)
);
CREATE TABLE IF NOT EXISTS episode_info_sync (series_id INTEGER PRIMARY KEY, fetched_at INTEGER NOT NULL);
-- "Something's wrong" taps and automatic playback failures, for the admin.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, torrent_id INTEGER, series_id INTEGER, label TEXT,
  kind TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
);
`)
try { db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT') } catch { /* already present */ }
// The little creature a person picks for themselves. Null means "no picture": the app shows their initial.
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT') } catch { /* already present */ }
try { db.exec('ALTER TABLE my_list ADD COLUMN seen_at INTEGER') } catch { /* already present */ }
try { db.exec('ALTER TABLE releases ADD COLUMN youtube_trailer TEXT') } catch { /* already present */ }
// Last episode a multi-episode file covers (S01E01E02 -> 2); null for everything else.
try { db.exec('ALTER TABLE releases ADD COLUMN episode_end INTEGER') } catch { /* already present */ }
// The videos inside a season pack, read from its .torrent, so a pack lists as individual episodes before anything is downloaded.
db.exec(`CREATE TABLE IF NOT EXISTS pack_files (
  torrent_id INTEGER NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
  season INTEGER, episode INTEGER, episode_end INTEGER, PRIMARY KEY (torrent_id, idx)
);
CREATE TABLE IF NOT EXISTS pack_listed (torrent_id INTEGER PRIMARY KEY, listed_at INTEGER NOT NULL);`)

// What the home screen and the library rules know about each show (TMDB/TVmaze): service, premiere, popularity, spoken language, episodes per season.
db.exec(`CREATE TABLE IF NOT EXISTS series_net (
  series_id INTEGER PRIMARY KEY, tmdb_id INTEGER, streamer TEXT, network TEXT, first_air TEXT, popularity REAL, notable INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER NOT NULL
)`)
try { db.exec('ALTER TABLE series_net ADD COLUMN lang TEXT') } catch { /* already present */ }
try { db.exec('ALTER TABLE series_net ADD COLUMN season_counts TEXT') } catch { /* already present */ }
try { db.exec('ALTER TABLE series_net ADD COLUMN ver INTEGER NOT NULL DEFAULT 0') } catch { /* already present */ }

// Where a download came from: 'flix' (someone pressed play), 'auto' (started ahead of time) or 'adopted' (already in the Downloads folder, outside Flix).
try { db.exec(`ALTER TABLE downloads ADD COLUMN origin TEXT NOT NULL DEFAULT 'flix'`) } catch { /* already present */ }
// 1 = started ahead of time for this person, not yet opened by them; lapses after a week (AUTO_EXPIRE_DAYS) instead of the usual 14 days.
try { db.exec('ALTER TABLE interests ADD COLUMN auto INTEGER NOT NULL DEFAULT 0') } catch { /* already present */ }

// When a finished, fully seeded season pack nobody else has touched is removed (see retention.ts); null = not leaving.
try { db.exec('ALTER TABLE downloads ADD COLUMN leaving_at INTEGER') } catch { /* already present */ }
// 1 = the admin asked for this one to go as soon as BTN's seeding rule is met, whoever has not watched it yet.
try { db.exec('ALTER TABLE downloads ADD COLUMN remove_when_seeded INTEGER NOT NULL DEFAULT 0') } catch { /* already present */ }

// Thumbs up (1) / thumbs down (-1) a person gave a show; it steers what the home screen offers them.
db.exec('CREATE TABLE IF NOT EXISTS votes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id INTEGER NOT NULL, vote INTEGER NOT NULL, voted_at INTEGER NOT NULL, PRIMARY KEY (user_id, series_id))')

// How much disk Flix's downloads take, sampled hourly, for the 12-month graph on the Torrents page.
db.exec('CREATE TABLE IF NOT EXISTS storage_samples (ts INTEGER PRIMARY KEY, bytes INTEGER NOT NULL)')

export const now = () => Math.floor(Date.now() / 1000)
