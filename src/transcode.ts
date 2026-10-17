import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.ts'

const execFileP = promisify(execFile)
const rawUrl = (t: number, f: number) => `http://127.0.0.1:${config.port}/api/stream/${t}/${f}/raw?k=${config.internalKey}`

export interface AudioTrack { n: number; lang: string; label: string; channels?: number; default: boolean }
export interface SubTrack { n: number; lang: string; label: string; forced: boolean; default: boolean }
export interface Chapter { start: number; end: number; title: string }
export interface Probe {
  direct: boolean; videoCodec?: string; audioCodec?: string; container?: string; duration?: number; copyVideo: boolean; height?: number
  hdr: boolean; audio: AudioTrack[]; subs: SubTrack[]; chapters: Chapter[]
}
const probes = new Map<string, Probe>()

const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis'])
/** Subtitle formats that are text and can become WebVTT. Picture subtitles (PGS, VobSub) can't be shown in a browser. */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

const LANG: Record<string, string> = { eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish',
  tur: 'Turkish', ara: 'Arabic', heb: 'Hebrew', hin: 'Hindi', cze: 'Czech', ces: 'Czech', hun: 'Hungarian', gre: 'Greek', ell: 'Greek', tha: 'Thai', und: 'Unknown' }
const langName = (code?: string) => (code ? LANG[code.toLowerCase()] ?? code : 'Unknown')
const HDR_TRC = new Set(['smpte2084', 'arib-std-b67'])

/** ffprobe the file through our own range endpoint, then decide: serve raw bytes or remux/transcode to HLS. */
export async function probe(torrentId: number, fileIndex: number): Promise<Probe> {
  const key = `${torrentId}:${fileIndex}`
  const hit = probes.get(key)
  if (hit) return hit
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', rawUrl(torrentId, fileIndex)], { timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 120_000), maxBuffer: 8 << 20 })
    .catch((e) => { throw new Error(`ffprobe failed (code=${e.code} signal=${e.signal} killed=${e.killed}): ${String(e.stderr || e.message).replace(config.internalKey, '***').trim().slice(0, 500)}`) })
  const j = JSON.parse(stdout)
  const v = j.streams?.find((s: any) => s.codec_type === 'video')
  const a = j.streams?.find((s: any) => s.codec_type === 'audio')
  const fmt: string = j.format?.format_name ?? ''
  const containerOk = /mp4|webm/.test(fmt)
  const pixOk = !v?.pix_fmt || v.pix_fmt === 'yuv420p'
  const height: number | undefined = v?.height
  const vOk = !!v && DIRECT_VIDEO.has(v.codec_name) && pixOk && (height ?? 0) <= 1080 // 4K is always re-encoded down to 1080p
  const aOk = !a || DIRECT_AUDIO.has(a.codec_name)
  const audio: AudioTrack[] = (j.streams ?? []).filter((s: any) => s.codec_type === 'audio').map((s: any, n: number) => ({
    n, lang: s.tags?.language ?? 'und', channels: s.channels, default: !!s.disposition?.default,
    label: [langName(s.tags?.language), s.tags?.title && !/^(stereo|surround|\d\.\d)/i.test(s.tags.title) ? s.tags.title : '', s.channels > 2 ? `${s.channels - 1}.1` : ''].filter(Boolean).join(' · '),
  }))
  const subs: SubTrack[] = (j.streams ?? []).filter((s: any) => s.codec_type === 'subtitle').map((s: any, n: number) => ({ s, n }))
    .filter(({ s }: any) => TEXT_SUBS.has(s.codec_name))
    .map(({ s, n }: any) => ({ n, lang: s.tags?.language ?? 'und', forced: !!s.disposition?.forced, default: !!s.disposition?.default,
      label: [langName(s.tags?.language), s.tags?.title && !/^(full|default)$/i.test(s.tags.title) ? s.tags.title : '', s.disposition?.forced ? 'Forced' : '', s.disposition?.hearing_impaired ? 'CC' : ''].filter(Boolean).join(' · ') }))
  const chapters: Chapter[] = (j.chapters ?? []).map((c: any) => ({ start: Number(c.start_time), end: Number(c.end_time), title: String(c.tags?.title ?? '') })).filter((c: Chapter) => c.end > c.start)
  const p: Probe = {
    direct: containerOk && vOk && aOk, videoCodec: v?.codec_name, audioCodec: a?.codec_name, container: fmt,
    duration: j.format?.duration ? Number(j.format.duration) : undefined, copyVideo: vOk, height,
    hdr: HDR_TRC.has(v?.color_transfer ?? ''), audio, subs, chapters,
  }
  probes.set(key, p)
  return p
}

interface Job { proc: ChildProcess; dir: string; idle: NodeJS.Timeout; torrentId: number; ready: Promise<void> }
const jobs = new Map<string, Job>()
const hlsRoot = () => join(config.dataDir, 'hls')

/** One job (and folder) per file and chosen audio track, so switching language doesn't disturb anyone else watching. */
export function jobDir(torrentId: number, fileIndex: number, audio = 0) { return join(hlsRoot(), `${torrentId}-${fileIndex}${audio ? `-a${audio}` : ''}`) }
const jobKey = (t: number, f: number, a = 0) => `${t}:${f}:${a}`

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
  for (const k of [...vttCache.keys()]) if (k.startsWith(`${torrentId}:`)) vttCache.delete(k)
  if (existsSync(hlsRoot())) for (const d of readdirSync(hlsRoot())) if (d.startsWith(`${torrentId}-`)) rmSync(join(hlsRoot(), d), { recursive: true, force: true })
}
export function cleanHlsCache() { rmSync(hlsRoot(), { recursive: true, force: true }) }

let zscale: boolean | null = null
/** HDR to SDR needs ffmpeg's zscale filter; checked once. Without it HDR is passed through (and looks washed out). */
async function canToneMap(): Promise<boolean> {
  if (zscale === null) zscale = await execFileP('ffmpeg', ['-hide_banner', '-filters']).then((r) => /\bzscale\b/.test(r.stdout) && /\btonemap\b/.test(r.stdout)).catch(() => false)
  return zscale
}
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

/** Start (or touch) the HLS job; resolves when the playlist exists with its first segment. */
export async function ensureHls(torrentId: number, fileIndex: number, p: Probe, audio = 0): Promise<string> {
  const key = jobKey(torrentId, fileIndex, audio)
  let j = jobs.get(key)
  if (!j) {
    const dir = jobDir(torrentId, fileIndex, audio)
    const tonemap = p.hdr && (await canToneMap())
    const filters = [...((p.height ?? 0) > 1080 ? ['scale=-2:1080'] : []), ...(tonemap ? [TONEMAP] : [])]
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const args = ['-hide_banner', '-loglevel', 'error', '-i', rawUrl(torrentId, fileIndex),
      '-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn',
      ...(p.copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...(filters.length ? ['-vf', filters.join(',')] : []), '-force_key_frames', 'expr:gte(t,n_forced*6)']),
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

export function touchHls(torrentId: number, fileIndex: number, audio = 0) {
  const key = jobKey(torrentId, fileIndex, audio)
  const j = jobs.get(key)
  if (!j) return false
  clearTimeout(j.idle)
  j.idle = setTimeout(() => stopJob(key), 15 * 60_000)
  return true
}

// ---- subtitles ------------------------------------------------------------------------------------------
const VTT_HEAD = 'WEBVTT\n\n'
const vttCache = new Map<string, string>()
const vttBusy = new Map<string, Promise<string>>()

/**
 * A subtitle track as WebVTT. The file is still downloading in order while it plays, so only the part that has arrived can be
 * read: we extract the first N seconds (N follows the download, minus a safety margin, in 30 s steps) and the player asks again
 * as the file grows. A finished file is extracted whole, once.
 */
export async function subtitleVtt(torrentId: number, fileIndex: number, n: number, progress: number, duration: number): Promise<{ vtt: string; complete: boolean }> {
  const complete = progress >= 1
  const seconds = complete ? 0 : Math.floor((duration * progress * 0.85) / 30) * 30
  if (!complete && seconds < 120) return { vtt: VTT_HEAD, complete }
  const key = `${torrentId}:${fileIndex}:${n}:${seconds}`
  const hit = vttCache.get(key)
  if (hit !== undefined) return { vtt: hit, complete }
  let p = vttBusy.get(key)
  if (!p) {
    const args = ['-v', 'error', '-i', rawUrl(torrentId, fileIndex), '-map', `0:s:${n}`, ...(complete ? [] : ['-t', String(seconds)]), '-f', 'webvtt', '-']
    p = execFileP('ffmpeg', args, { timeout: 180_000, maxBuffer: 16 << 20 })
      .then((r) => { for (const k of [...vttCache.keys()]) if (k.startsWith(`${torrentId}:${fileIndex}:${n}:`)) vttCache.delete(k); vttCache.set(key, r.stdout || VTT_HEAD); return r.stdout || VTT_HEAD })
      .catch((e) => { console.warn(`[subs] ${key}: ${String(e.stderr || e.message).replace(config.internalKey, '***').slice(0, 200)}`); return VTT_HEAD })
      .finally(() => vttBusy.delete(key))
    vttBusy.set(key, p)
  }
  return { vtt: await p, complete }
}
