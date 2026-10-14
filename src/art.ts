import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync, existsSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.ts'
import { db, now } from './db.ts'

const MAX_BYTES = 8 << 20
const dir = join(config.dataDir, 'art')
mkdirSync(dir, { recursive: true })

db.exec(`CREATE TABLE IF NOT EXISTS art_cache (url_hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL)`)

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase()
    if (l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    return m ? isPrivateIp(m[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Only real raster images; SVG (scriptable) is deliberately not accepted. */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Fetch an image server-side: http(s) only, no internal addresses, bounded redirects/size/time. */
async function download(url: string, hops = 3): Promise<Buffer> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme')
  if (!config.art.allowPrivateHosts) {
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true })
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('refusing to fetch an internal address')
  }
  const res = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'Flix/0.1', accept: 'image/*' }, signal: AbortSignal.timeout(15_000) })
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (hops <= 0) throw new Error('too many redirects')
    return download(new URL(res.headers.get('location')!, u).toString(), hops - 1)
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of res.body as any) {
    total += c.length
    if (total > MAX_BYTES) throw new Error('image too large')
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks)
}

let running = 0
const waiters: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => waiters.push(r))
  running++
  try { return await fn() } finally { running--; waiters.shift()?.() }
}

const inflight = new Map<string, Promise<{ path: string; type: string } | null>>()
const failed = new Map<string, number>()

function urlFor(seriesId: number, kind: 'poster' | 'banner'): string | null {
  const col = kind === 'poster' ? 'series_poster' : 'series_banner'
  const r = db.prepare(`SELECT ${col} AS u FROM releases WHERE series_id = ? AND ${col} IS NOT NULL AND ${col} != '' ORDER BY fetched_at DESC LIMIT 1`).get(seriesId) as { u: string } | undefined
  return r?.u ?? null
}

/** Cached artwork for a series, downloading it on first use. Returns null when there is none (or it can't be fetched). */
export async function getArt(seriesId: number, kind: 'poster' | 'banner') {
  const url = urlFor(seriesId, kind)
  if (!url) return null
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const hit = db.prepare('SELECT content_type FROM art_cache WHERE url_hash = ?').get(hash) as { content_type: string } | undefined
  if (hit) {
    const path = join(dir, `${hash}.${EXT[hit.content_type]}`)
    if (existsSync(path)) return { path, type: hit.content_type }
  }
  if ((failed.get(hash) ?? 0) > Date.now() - 30 * 60_000) return null
  let p = inflight.get(hash)
  if (!p) {
    p = limited(async () => {
      try {
        const buf = await download(url)
        const type = sniffImage(buf)
        if (!type) throw new Error('not a supported image')
        const path = join(dir, `${hash}.${EXT[type]}`)
        await writeFile(path + '.tmp', buf)
        await rename(path + '.tmp', path)
        db.prepare('INSERT OR REPLACE INTO art_cache VALUES (?,?,?)').run(hash, type, now())
        return { path, type }
      } catch (e: any) {
        console.warn(`[art] ${kind} for series ${seriesId} failed: ${e.message}`)
        failed.set(hash, Date.now())
        return null
      }
    }).finally(() => inflight.delete(hash))
    inflight.set(hash, p)
  }
  return p
}

/** SQL fragment: local artwork path instead of BTN's URL (which never reaches the browser). */
export const artPathSql = (col: 'series_poster' | 'series_banner', alias: string, kind: 'poster' | 'banner') =>
  `CASE WHEN MAX(${col}) IS NOT NULL AND MAX(${col}) != '' THEN '/api/art/' || series_id || '/${kind}' END AS ${alias}`
