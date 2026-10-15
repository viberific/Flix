import { db } from './db.ts'
import { config } from './config.ts'

/** The BTN key from the environment, kept so clearing the saved key falls back to it. */
const envBtnKey = config.btn.apiKey

const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value

/** A key saved in the admin page overrides BTN_API_KEY from the environment. */
export function loadSettings() {
  config.btn.apiKey = get('btn_api_key') || envBtnKey
}

export function setBtnApiKey(key: string) {
  if (key) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('btn_api_key', key)
  else db.prepare('DELETE FROM settings WHERE key = ?').run('btn_api_key')
  loadSettings()
}

/** What the admin page may know about the key: whether it is set, where from, and the last 4 characters. Never the key itself. */
export function btnKeyStatus() {
  const saved = get('btn_api_key')
  const key = config.btn.apiKey
  return { configured: !!key, source: saved ? 'settings' : key ? 'environment' : null, hint: key ? key.slice(-4) : null }
}

loadSettings()
