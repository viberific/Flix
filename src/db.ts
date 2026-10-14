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
  genres TEXT, fetched_at INTEGER NOT NULL
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
`)

export const now = () => Math.floor(Date.now() / 1000)
