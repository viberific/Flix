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

/** The least free space to leave: the larger of MIN_FREE_GB and MIN_FREE_PCT of the disk. */
export function freeFloor(d: { total: number }): number { return Math.max(config.minFreeGb * 1e9, (config.minFreePct / 100) * d.total) }

/** Refuse a download that would leave the disk nearly full; the message is written for the family, not for an admin. */
export function assertSpace(needBytes: number) {
  const d = diskInfo()
  if (d && d.free - needBytes < freeFloor(d))
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
  if (v) {
    // BTN's 1:1 ratio needs other people to be able to connect to us. Behind a closed router/container port, only the 130 hours can be met.
    const r = await Promise.race([qb.reachability().catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 3000))])
    if (r?.status === 'disconnected') out.push({ level: 'bad', title: 'No internet for downloads', detail: 'qBittorrent reports no network connection, so nothing can download or seed.', link: '#/admin' })
    else if (r?.status === 'firewalled') out.push({ level: 'warn', title: 'Seeding may be limited: the download port looks closed',
      detail: `qBittorrent hasn't seen anyone connect in${r.port ? ` (port ${r.port})` : ''}; this also shows for the first few minutes after a restart. If it stays, uploads are slow and the 1:1 ratio will take far longer. The 130-hour rule still counts, so torrents stay until that is met. To fix it, forward that port to this server on your router (and publish it in the Umbrel app's docker-compose).`, link: '#/admin' })
  }
  const d = diskInfo()
  if (d) {
    const pct = Math.round((d.free / d.total) * 100)
    if (d.free < freeFloor(d)) out.push({ level: 'bad', title: 'Please remove some videos: storage is nearly full', detail: `Only ${gb(d.free)} (${pct}%) of ${gb(d.total)} is left, so new shows are refused and nothing is fetched ahead of time. “Free up space” on the Torrents page lists what can go, biggest first. Finished, fully seeded torrents are removed automatically.`, link: '#/admin' })
    else if (pct < config.warnFreePct) out.push({ level: 'warn', title: 'Storage is getting low', detail: `${gb(d.free)} (${pct}%) left of ${gb(d.total)}. Shows are no longer fetched ahead of time below ${config.auto.pausePct}%; below ${config.minFreePct}% new ones are refused. “Free up space” on the Torrents page lists what can go.`, link: '#/admin' })
    else if (config.auto.enabled && pct < config.auto.pausePct) out.push({ level: 'info', title: 'Pre-downloading is paused', detail: `${pct}% of storage is free; next episodes and watchlist shows are not fetched ahead of time below ${config.auto.pausePct}%.` })
  }
  const reported = (db.prepare('SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL AND created_at > ?').get(now() - 7 * 86400) as any).n as number
  if (reported) out.push({ level: 'warn', title: `${reported} playback problem${reported === 1 ? '' : 's'} reported`, detail: 'Someone tapped “Something’s wrong”, or an episode failed to start. The Torrents page lists which.', link: '#/admin' })
  if (!config.tmdb.apiKey) out.push({ level: 'info', title: 'Ratings and Trending need a TMDB key', detail: 'Add a free TMDB key under Settings so kids’ accounts hide unsuitable shows automatically and the home screen can show a Trending row.', link: '#/admin/settings' })
  const left = unsyncedCount()
  if (config.btn.apiKey && left > 0) out.push({ level: 'info', title: 'Still building the library', detail: `${left} show${left === 1 ? '' : 's'} left to check with BTN. The home page fills in as they finish.` })
  if (!lastBackup() && (process.env.DB_PATH ?? '') !== ':memory:') out.push({ level: 'warn', title: 'No backup yet', detail: 'Accounts and watch history are backed up once a day; the first one is made shortly after start.' })
  return out
}
