import { db } from './db.ts'
import { config } from './config.ts'

/** Values from the environment, kept so clearing a saved setting falls back to them. */
const envBtnKey = config.btn.apiKey
const envQb = { ...config.qb }
const envTmdbKey = config.tmdb.apiKey
const envOmdbKey = config.omdb.apiKey
const envTranscodeProfile = config.transcode.profile
const envTranscodeHardware = config.transcode.hardware
const envTranscodeMode = config.transcode.mode

const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
const put = (k: string, v: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)

/** Settings saved in the admin page override the matching environment variables. */
export function loadSettings() {
  config.btn.apiKey = get('btn_api_key') || envBtnKey
  config.tmdb.apiKey = get('tmdb_api_key') || envTmdbKey
  config.omdb.apiKey = get('omdb_api_key') || envOmdbKey
  config.qb.url = get('qb_url') ?? envQb.url
  config.qb.user = get('qb_user') ?? envQb.user
  config.qb.pass = get('qb_pass') ?? envQb.pass
  config.transcode.profile = (get('transcode_profile') as Profile) || envTranscodeProfile
  config.transcode.hardware = (get('transcode_hardware') ?? (envTranscodeHardware ? 'on' : 'off')) !== 'off'
  // Saved from the Settings page; without reading it back here a restart quietly went back to TRANSCODE_MODE.
  const mode = get('transcode_mode')
  config.transcode.mode = mode === 'off' || mode === 'auto' ? mode : envTranscodeMode
}

export function setBtnApiKey(key: string) {
  if (key) put('btn_api_key', key)
  else db.prepare('DELETE FROM settings WHERE key = ?').run('btn_api_key')
  loadSettings()
}

/** What the admin page may know about the key: whether it is set, where from, and the last 4 characters. Never the key itself. */
export function btnKeyStatus() {
  const saved = get('btn_api_key')
  const key = config.btn.apiKey
  return { configured: !!key, source: saved ? 'settings' : key ? 'environment' : null, hint: key ? key.slice(-4) : null }
}

export function setTmdbApiKey(key: string) {
  if (key) put('tmdb_api_key', key)
  else db.prepare('DELETE FROM settings WHERE key = ?').run('tmdb_api_key')
  loadSettings()
}

/** Same shape as btnKeyStatus: set or not, where from, last 4 characters, never the key. */
export function tmdbKeyStatus() {
  const saved = get('tmdb_api_key')
  const key = config.tmdb.apiKey
  return { configured: !!key, source: saved ? 'settings' : key ? 'environment' : null, hint: key ? key.slice(-4) : null }
}

export function setOmdbApiKey(key: string) {
  if (key) put('omdb_api_key', key)
  else db.prepare('DELETE FROM settings WHERE key = ?').run('omdb_api_key')
  loadSettings()
}

export function omdbKeyStatus() {
  const saved = get('omdb_api_key')
  const key = config.omdb.apiKey
  return { configured: !!key, source: saved ? 'settings' : key ? 'environment' : null, hint: key ? key.slice(-4) : null }
}

/** Save the qBittorrent connection. A blank password keeps the current one. */
export function setQb(v: { url: string; user: string; password?: string }) {
  put('qb_url', v.url.replace(/\/$/, ''))
  put('qb_user', v.user)
  put('qb_pass', v.password || config.qb.pass)
  loadSettings()
}

/** Forget the saved qBittorrent connection and go back to QB_URL / QB_USER / QB_PASS. */
export function clearQb() {
  db.prepare(`DELETE FROM settings WHERE key IN ('qb_url','qb_user','qb_pass')`).run()
  loadSettings()
}

/** Like btnKeyStatus: the password is never reported, only whether one is set. */
export function qbStatus() {
  return { url: config.qb.url, user: config.qb.user, passwordSet: !!config.qb.pass, source: get('qb_url') !== undefined ? 'settings' : 'environment' }
}
loadSettings()

const PROFILES = ['economy', 'balanced', 'best'] as const
export type Profile = (typeof PROFILES)[number]

/** Save the encoder quality. Anything unrecognised keeps the default (balanced) rather than being stored. */
export function setTranscodeProfile(profile: string) {
  const p = String(profile).toLowerCase()
  put('transcode_profile', (PROFILES as readonly string[]).includes(p) ? p : 'balanced')
  loadSettings()
}

/** Never re-encode the picture ('off'), or convert when a file needs it ('auto'). */
export function setTranscodeMode(mode: string) {
  const want = String(mode).toLowerCase() === 'off' ? 'off' : 'auto'
  put('transcode_mode', want)
  loadSettings()
}

/** Whether the picture may never be re-encoded: then a release that needs it is never downloaded either. */
export const copyOnly = () => config.transcode.mode === 'off'

/** Whether the GPU's encoder may be used when the container can see one. */
export function setTranscodeHardware(on: boolean) {
  put('transcode_hardware', on ? 'on' : 'off')
  loadSettings()
}

/** What the Settings page shows: the saved profile, whether hardware is allowed, and both origins. */
export function transcodeStatus() {
  return {
    profile: config.transcode.profile,
    source: get('transcode_profile') ? 'settings' : 'environment',
    hardwareAllowed: config.transcode.hardware,
    hardwareSource: get('transcode_hardware') ? 'settings' : 'environment',
    maxJobs: config.transcode.maxJobs,
    mode: config.transcode.mode,
    modeSource: get('transcode_mode') ? 'settings' : 'environment',
  }
}
