import { execFile } from 'node:child_process'
import { mkdir, writeFile, access, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.ts'
import { fileSubtitleVtt } from './transcode.ts'

/**
 * English subtitles from the web, for episodes whose files carry none, from OpenSubtitles. Needs an API key
 * (OPENSUBTITLES_API_KEY, or Settings → Subtitles); without one, or when the site is down, slow or has no match, there are none.
 */
export interface OnlineSub { id: string; source: string; name: string }
export interface Query { series: string; season: number; episode: number; imdb: string | null; release?: string }

const UA = 'Flix v0.3'
const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(8000) })
const json = async (url: string, headers: Record<string, string> = {}) => { const r = await get(url, { accept: 'application/json', ...headers }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<any> }

interface Source {
  key: string
  label: string
  enabled: () => boolean
  search: (q: Query) => Promise<{ id: string; name: string }[]>
  /** The subtitle file itself (or a zip holding it). */
  fetch: (id: string) => Promise<Buffer>
}

const osHeaders = () => ({ 'api-key': config.subs.openSubtitlesKey })
const imdbNum = (s: string | null) => (s ?? '').replace(/^tt0*/, '')

const SOURCES: Source[] = [
  {
    key: 'os', label: 'OpenSubtitles', enabled: () => !!config.subs.openSubtitlesKey,
    async search(q) {
      const p = new URLSearchParams({ languages: 'en', season_number: String(q.season), episode_number: String(q.episode), type: 'episode', order_by: 'download_count' })
      if (imdbNum(q.imdb)) p.set('parent_imdb_id', imdbNum(q.imdb)); else p.set('query', q.series)
      const j = await json(`${config.subs.openSubtitlesUrl}/subtitles?${p}`, osHeaders())
      return (j.data ?? []).map((d: any) => ({ id: String(d.attributes?.files?.[0]?.file_id ?? ''), name: String(d.attributes?.release ?? '') })).filter((x: any) => x.id)
    },
    async fetch(id) {
      const r = await fetch(`${config.subs.openSubtitlesUrl}/download`, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json', ...osHeaders() }, body: JSON.stringify({ file_id: Number(id) }), signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const link = (await r.json() as any).link
      if (!link) throw new Error('no link')
      const f = await get(link)
      if (!f.ok) throw new Error(`HTTP ${f.status}`)
      return Buffer.from(await f.arrayBuffer())
    },
  },
]

const cache = new Map<string, { at: number; subs: OnlineSub[] }>()
const PER_SOURCE = 5

/** Words of a release name that say which cut it is ("amzn", "web", "dl", "ntb", "720p"), without the show's own name. */
const releaseWords = (name: string, series: string) => {
  const own = new Set(series.toLowerCase().split(/[^a-z0-9]+/))
  return new Set(name.toLowerCase().replace(/\.(mkv|mp4|avi|srt)$/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !own.has(w) && !/^s\d+e\d+/.test(w)))
}

/**
 * English matches from every source that is switched on, best first: a subtitle made for the same release as the file (so
 * it is in time with it) before the rest, and otherwise each source's own order (most downloaded). Remembered for an hour,
 * empty answers included.
 */
export async function findOnlineSubs(q: Query): Promise<OnlineSub[]> {
  const key = `${q.series}|${q.season}|${q.episode}|${q.imdb}|${q.release ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 3_600_000) return hit.subs
  const got = await Promise.all(SOURCES.filter((s) => s.enabled()).map((s) =>
    s.search(q).then((r) => r.slice(0, PER_SOURCE).map((x) => ({ id: `${s.key}:${x.id}`, source: s.label, name: x.name }))).catch((e) => { console.warn(`[subs] ${s.label}: ${e.message}`); return [] as OnlineSub[] })))
  const mine = releaseWords(q.release ?? '', q.series)
  const score = (s: OnlineSub) => [...releaseWords(s.name, q.series)].filter((w) => mine.has(w)).length
  const subs = got.flat().map((s, i) => ({ s, i, k: score(s) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.s)
  cache.set(key, { at: Date.now(), subs })
  return subs
}

const won = new Map<string, string>()
/** Forget every remembered search, so a key added or changed in Settings is used from the next episode on. */
export function forgetOnlineSubs() { cache.clear(); won.clear() }

/** The first of the ranked matches that actually downloads and has lines in it, as WebVTT; null when none does. */
export async function bestOnlineSubVtt(q: Query): Promise<string | null> {
  const key = `${q.series}|${q.season}|${q.episode}`
  const subs = await findOnlineSubs(q)
  const known = won.get(key) // the one that worked last time is asked first, so the ones that failed are not asked again
  for (const s of [...subs].sort((a, b) => Number(b.id === known) - Number(a.id === known))) {
    const vtt = await onlineSubVtt(s.id).catch((e) => { console.warn(`[subs] ${s.id}: ${e.message}`); return '' })
    if (vtt.includes('-->')) { won.set(key, s.id); return vtt }
  }
  return null
}

/** The first subtitle file inside a zip. unzip cannot read an archive from a pipe, so it goes through a file. */
async function unzip(buf: Buffer, tmp: string): Promise<Buffer> {
  await writeFile(tmp, buf)
  try {
    return await new Promise((resolve, reject) =>
      execFile('unzip', ['-p', tmp, '*.srt', '*.ass', '*.ssa', '*.vtt'], { encoding: 'buffer', maxBuffer: 16 << 20, timeout: 20_000 }, (err, out) => (err && !out?.length ? reject(err) : resolve(out))))
  } finally { await rm(tmp, { force: true }) }
}

/** A downloaded subtitle as WebVTT. Kept on disk, so the source is asked once per subtitle. */
export async function onlineSubVtt(id: string): Promise<string> {
  const [k, ...rest] = id.split(':')
  const src = SOURCES.find((s) => s.key === k && s.enabled())
  const sid = rest.join(':')
  if (!src || !sid) throw new Error('no such source')
  const dir = join(config.dataDir, 'subs')
  const path = join(dir, createHash('sha1').update(id).digest('hex') + '.srt')
  try { await access(path) } catch {
    let buf = await src.fetch(sid)
    await mkdir(dir, { recursive: true })
    if (buf[0] === 0x50 && buf[1] === 0x4b) buf = await unzip(buf, path + '.zip') // "PK": a zip
    if (!buf.length) throw new Error('empty')
    await writeFile(path, buf)
  }
  return fileSubtitleVtt(path)
}
