import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.ts'

const execFileP = promisify(execFile)
const rawUrl = (t: number, f: number) => `http://127.0.0.1:${config.port}/api/stream/${t}/${f}/raw?k=${config.internalKey}`

export interface Probe { direct: boolean; videoCodec?: string; audioCodec?: string; container?: string; duration?: number; copyVideo: boolean }
const probes = new Map<string, Probe>()

const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis'])

/** ffprobe the file through our own range endpoint, then decide: serve raw bytes or remux/transcode to HLS. */
export async function probe(torrentId: number, fileIndex: number): Promise<Probe> {
  const key = `${torrentId}:${fileIndex}`
  const hit = probes.get(key)
  if (hit) return hit
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', rawUrl(torrentId, fileIndex)], { timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 120_000), maxBuffer: 8 << 20 })
    .catch((e) => { throw new Error(`ffprobe failed (code=${e.code} signal=${e.signal} killed=${e.killed}): ${String(e.stderr || e.message).replace(config.internalKey, '***').trim().slice(0, 500)}`) })
  const j = JSON.parse(stdout)
  const v = j.streams?.find((s: any) => s.codec_type === 'video')
  const a = j.streams?.find((s: any) => s.codec_type === 'audio')
  const fmt: string = j.format?.format_name ?? ''
  const containerOk = /mp4|webm/.test(fmt)
  const pixOk = !v?.pix_fmt || v.pix_fmt === 'yuv420p'
  const vOk = !!v && DIRECT_VIDEO.has(v.codec_name) && pixOk
  const aOk = !a || DIRECT_AUDIO.has(a.codec_name)
  const p: Probe = {
    direct: containerOk && vOk && aOk, videoCodec: v?.codec_name, audioCodec: a?.codec_name, container: fmt,
    duration: j.format?.duration ? Number(j.format.duration) : undefined, copyVideo: vOk,
  }
  probes.set(key, p)
  return p
}

interface Job { proc: ChildProcess; dir: string; idle: NodeJS.Timeout; torrentId: number; ready: Promise<void> }
const jobs = new Map<string, Job>()
const hlsRoot = () => join(config.dataDir, 'hls')

export function jobDir(torrentId: number, fileIndex: number) { return join(hlsRoot(), `${torrentId}-${fileIndex}`) }

function stopJob(key: string) {
  const j = jobs.get(key)
  if (!j) return
  clearTimeout(j.idle)
  j.proc.kill('SIGKILL')
  rmSync(j.dir, { recursive: true, force: true })
  jobs.delete(key)
}
export function stopJobsFor(torrentId: number) {
  for (const k of [...jobs.keys()]) if (k.startsWith(`${torrentId}:`)) stopJob(k)
  if (existsSync(hlsRoot())) for (const d of readdirSync(hlsRoot())) if (d.startsWith(`${torrentId}-`)) rmSync(join(hlsRoot(), d), { recursive: true, force: true })
}
export function cleanHlsCache() { rmSync(hlsRoot(), { recursive: true, force: true }) }

/** Start (or touch) the HLS job; resolves when the playlist exists with its first segment. */
export async function ensureHls(torrentId: number, fileIndex: number, p: Probe): Promise<string> {
  const key = `${torrentId}:${fileIndex}`
  let j = jobs.get(key)
  if (!j) {
    const dir = jobDir(torrentId, fileIndex)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const args = ['-hide_banner', '-loglevel', 'error', '-i', rawUrl(torrentId, fileIndex),
      '-map', '0:v:0', '-map', '0:a:0?', '-sn',
      ...(p.copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*6)']),
      '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments', '-hls_segment_filename', join(dir, 'seg%05d.ts'), join(dir, 'index.m3u8')]
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
    const ready = (async () => {
      for (let i = 0; i < 600; i++) {
        if (existsSync(join(dir, 'seg00000.ts')) && existsSync(join(dir, 'index.m3u8'))) return
        if (proc.exitCode !== null && proc.exitCode !== 0) throw new Error('ffmpeg failed')
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error('Timed out starting transcode')
    })()
    ready.catch(() => stopJob(key))
    j = { proc, dir, idle: setTimeout(() => {}, 0), torrentId, ready }
    jobs.set(key, j)
    proc.on('exit', () => { /* finished playlists stay on disk until idle timeout */ })
  }
  clearTimeout(j.idle)
  j.idle = setTimeout(() => stopJob(key), 15 * 60_000)
  await j.ready
  return j.dir
}

export function touchHls(torrentId: number, fileIndex: number) {
  const j = jobs.get(`${torrentId}:${fileIndex}`)
  if (!j) return false
  clearTimeout(j.idle)
  j.idle = setTimeout(() => stopJob(`${torrentId}:${fileIndex}`), 15 * 60_000)
  return true
}
