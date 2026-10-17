import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import { canToneMap, TONEMAP, type Probe } from './transcode.ts'

/**
 * A single MP4 of an episode, no bigger than 1080p, for saving on a device to watch without a connection.
 * A file that is already H.264/AAC in an MP4 is sent as it is; anything else (MKV, HEVC, AC3, 4K) is converted once and kept
 * for a while in Flix's own data folder (never in Downloads), so a second device or a retry doesn't convert it again.
 */
export type OfflineState = { state: 'working'; progress: number } | { state: 'ready'; path: string; size: number; type: string } | { state: 'error'; message: string }

interface Job { proc: ChildProcess; progress: number; error?: string; out: string; last: number }
const jobs = new Map<string, Job>()
const root = () => join(config.dataDir, 'offline')
const KEEP_MS = 2 * 3600_000
const outFor = (t: number, f: number) => join(root(), `${t}-${f}.mp4`)

export function isPlainMp4(p: Probe) {
  return p.direct && /mp4/.test(p.container ?? '') && p.videoCodec === 'h264' && (!p.audioCodec || p.audioCodec === 'aac')
}

/** Where the finished copy is, or the state of making it. `source` is the downloaded video file on disk. */
export async function offlineCopy(t: number, f: number, p: Probe, source: string): Promise<OfflineState> {
  if (isPlainMp4(p)) return { state: 'ready', path: source, size: statSync(source).size, type: 'video/mp4' }
  const out = outFor(t, f), key = `${t}:${f}`
  const j = jobs.get(key)
  if (j) {
    j.last = Date.now()
    return j.error ? { state: 'error', message: j.error } : { state: 'working', progress: j.progress }
  }
  if (existsSync(out)) { touch(out); return { state: 'ready', path: out, size: statSync(out).size, type: 'video/mp4' } }
  mkdirSync(root(), { recursive: true })
  const tone = p.hdr && (await canToneMap())
  const filters = [...((p.height ?? 0) > 1080 ? ['scale=-2:1080'] : []), ...(tone ? [TONEMAP] : [])]
  const part = out + '.part.mp4'
  rmSync(part, { force: true })
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-sn',
    ...(p.copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...(filters.length ? ['-vf', filters.join(',')] : [])]),
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', part]
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const job: Job = { proc, progress: 0, out, last: Date.now() }
  jobs.set(key, job)
  let buf = ''
  proc.stdout!.on('data', (d) => {
    buf += d
    const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop()
    buf = buf.slice(-200)
    if (m && p.duration) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / p.duration)
  })
  let err = ''
  proc.stderr!.on('data', (d) => { err = (err + d).slice(-500) })
  proc.on('exit', (code) => {
    if (code === 0 && existsSync(part)) { renameSync(part, out); jobs.delete(key) } else { rmSync(part, { force: true }); job.error = `ffmpeg failed: ${err.trim() || code}`; setTimeout(() => jobs.delete(key), 60_000) }
  })
  return { state: 'working', progress: 0 }
}

function touch(path: string) { const t = new Date(); try { utimesSync(path, t, t) } catch { /* gone */ } }

/** Converted copies nobody has asked for lately are removed; they are cheap to make again. */
export function sweepOffline() {
  if (!existsSync(root())) return
  for (const n of readdirSync(root())) {
    const p = join(root(), n)
    try { if (Date.now() - statSync(p).mtimeMs > KEEP_MS && ![...jobs.values()].some((j) => j.out === p || j.out + '.part.mp4' === p)) rmSync(p, { force: true }) } catch { /* gone */ }
  }
}
export function startOfflineSweeper() { rmSync(root(), { recursive: true, force: true }); setInterval(sweepOffline, 15 * 60_000).unref() }
export function stopOfflineFor(t: number) { for (const [k, j] of jobs) if (k.startsWith(`${t}:`)) { j.proc.kill('SIGKILL'); jobs.delete(k) } }
