import { statfsSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.ts'
import { db, now } from './db.ts'
import { btnState } from './btn/client.ts'
import { qb } from './qb.ts'
import { unsyncedCount } from './seasons.ts'

export interface Issue { level: 'bad' | 'warn' | 'info'; title: string; detail: string; link?: string }

const gb = (n: number) => (n / 1e9).toFixed(1) + ' GB'

/** Free and total bytes on the disk the downloads live on (walks up to a folder that exists). Null when it can't be read. */
export function diskInfo(): { free: number; total: number } | null {
  let dir = config.downloadDir
  for (let i = 0; i < 6 && !existsSync(dir); i++) dir = dirname(dir)
  try { const s = statfsSync(dir); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) } } catch { return null }
}

/** Refuse a download that would leave the disk nearly full; the message is written for the family, not for an admin. */
export function assertSpace(needBytes: number) {
  const d = diskInfo()
  if (d && d.free - needBytes < config.minFreeGb * 1e9)
    throw Object.assign(new Error('The server is out of storage right now, so this can’t start. Ask the person who runs Flix to free up some space.'), { statusCode: 507, space: true })
}

// ---- daily backup of the database (accounts, watch history, settings) -----------------------------------
const backupDir = () => join(config.dataDir, 'backups')
const dayStamp = () => new Date().toISOString().slice(0, 10)

export function lastBackup(): string | null {
  try { return readdirSync(backupDir()).filter((f) => /^flix-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().pop() ?? null } catch { return null }
}

/** One consistent copy per day (VACUUM INTO works while the app is running), keeping the newest 7. */
export function backupNow(): string | null {
  if ((process.env.DB_PATH ?? '') === ':memory:') return null
  const file = join(backupDir(), `flix-${dayStamp()}.db`)
  if (existsSync(file)) return file
  mkdirSync(backupDir(), { recursive: true })
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  for (const old of readdirSync(backupDir()).filter((f) => /^flix-.*\.db$/.test(f)).sort().slice(0, -7)) rmSync(join(backupDir(), old), { force: true })
  return file
}
export function startBackups() {
  const run = () => { try { backupNow() } catch (e: any) { console.warn(`[backup] ${e.message}`) } }
  run()
  setInterval(run, 6 * 3600_000).unref()
}

// ---- what the admin should know about -------------------------------------------------------------------
export async function health(): Promise<Issue[]> {
  const out: Issue[] = []
  if (!config.btn.apiKey) out.push({ level: 'bad', title: 'No BroadcasTheNet key', detail: 'Flix has nothing to show until you paste your BTN API key.', link: '#/admin/settings' })
  else if (btnState.ok === false) {
    const t: Record<string, string> = {
      ip: 'BTN is refusing this server’s address. Approve it from your notices on the BTN site.',
      key: 'BTN says the API key is wrong. Paste it again from your BTN profile.',
      account: 'BTN says the account is disabled.',
      offline: 'Flix can’t reach BTN right now (their site or this server’s internet may be down).',
      error: `BTN returned an error: ${btnState.message}`,
    }
    out.push({ level: btnState.kind === 'offline' ? 'warn' : 'bad', title: 'Trouble talking to BTN', detail: t[btnState.kind ?? 'error'], link: '#/admin/settings' })
  }
  const v = await Promise.race([qb.version().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
  if (!v) out.push({ level: 'bad', title: 'The download engine is not answering', detail: 'qBittorrent can’t be reached, so nothing can play. Check that Flix is running, or fix the address under Settings.', link: '#/admin/settings' })
  const d = diskInfo()
  if (d) {
    const min = config.minFreeGb * 1e9
    if (d.free < min) out.push({ level: 'bad', title: 'Out of storage', detail: `Only ${gb(d.free)} left, so new shows are refused until space is freed. Finished, seeded torrents are removed automatically; ask people to finish or release what they started.`, link: '#/admin' })
    else if (d.free < min * 2.5) out.push({ level: 'warn', title: 'Storage is getting low', detail: `${gb(d.free)} left of ${gb(d.total)}.`, link: '#/admin' })
  }
  if (!config.tmdb.apiKey) out.push({ level: 'info', title: 'Content ratings are manual', detail: 'Add a free TMDB key under Settings so kids’ accounts hide unsuitable shows automatically.', link: '#/admin/settings' })
  const left = unsyncedCount()
  if (config.btn.apiKey && left > 0) out.push({ level: 'info', title: 'Still building the library', detail: `${left} show${left === 1 ? '' : 's'} left to check with BTN. The home page fills in as they finish.` })
  if (!lastBackup() && (process.env.DB_PATH ?? '') !== ':memory:') out.push({ level: 'warn', title: 'No backup yet', detail: 'Accounts and watch history are backed up once a day; the first one is made shortly after start.' })
  return out
}
