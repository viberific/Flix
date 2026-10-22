import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.ts'
import { hitch, diag } from './diag.ts'
import { videoEncode, notePace } from './encode.ts'

const execFileP = promisify(execFile)
export const rawUrl = (t: number, f: number) => `http://127.0.0.1:${config.port}/api/stream/${t}/${f}/raw?k=${config.internalKey}`

export interface AudioTrack { n: number; lang: string; label: string; channels?: number; default: boolean }
export interface SubTrack { n: number; lang: string; label: string; forced: boolean; default: boolean }
export interface Chapter { start: number; end: number; title: string }
export interface Probe {
  direct: boolean; videoCodec?: string; audioCodec?: string; container?: string; duration?: number; copyVideo: boolean; height?: number
  hdr: boolean; audio: AudioTrack[]; subs: SubTrack[]; chapters: Chapter[]
  /** More about the picture, so the encoder settings can be sized to it instead of one guess for every file. */
  hdrKind?: 'pq' | 'hlg'; fps?: number; srcBitrate?: number; tenBit?: boolean
  /** The colour layout ffprobe reported. yuv420p is what every player takes; anything else needs a conversion. */
  pixFmt?: string
  /** The container's first timestamp, in seconds. A segment plan cut on keyframes ends at startTime + duration. */
  startTime?: number
}
/** `complete` is whether the file had fully downloaded when it was probed: a probe taken while it was arriving can be
 *  missing a stream or a height, and the decision it led to must not be kept for the life of the server because of it. */
const probes = new Map<string, { p: Probe; complete: boolean }>()

/** Drop what was learned about a file, so the next ask runs ffprobe again. */
export function forgetProbe(torrentId: number, fileIndex: number) { probes.delete(`${torrentId}:${fileIndex}`) }

/**
 * Whether the player can be handed the PICTURE and container of these bytes exactly as they are: a container it takes, a
 * picture it decodes in the colour layout every player handles. The picture's size is the player's business, not this
 * box's — a 4K television plays a 4K file, and refusing it here is what told the viewer "this would need converting" about
 * a file nothing had to be done to. `can` is the codecs the player itself said it decodes (asked in the browser, because
 * only it knows whether the screen behind it has an HEVC decoder); the box's own list covers the rest.
 *
 * Sound is NOT decided here: a container and picture a player takes says nothing about the audio track inside it, and
 * an E-AC-3 track (every AMZN WEB-DL on this box) hands the viewer a picture with no sound at all. Every caller must
 * also ask audioDirect() — see the 0.3.54 note on that function.
 */
export function directPlay(p: Probe, can?: Set<string>) {
  const codec = String(p.videoCodec ?? '')
  const containerOk = /mp4|webm/.test(p.container ?? '')
  const codecOk = DIRECT_VIDEO.has(codec) || !!can?.has(codec)
  return containerOk && codecOk && (!p.pixFmt || p.pixFmt === 'yuv420p')
}

/**
 * Whether the player decodes this file's first audio track as it is. No audio track at all is fine.
 *
 * 0.3.54: this is a fix for a regression in 0.3.48, where the /info decision began reading directPlay() alone. That
 * dropped the audio test which used to live on p.direct, so a file whose picture and container were fine was served as
 * raw bytes whatever its sound was. An MKV reports its container as "matroska,webm", so it passed the container test;
 * its audio was E-AC-3, which no browser decodes — the episode played with a picture and no sound. A file that fails
 * this goes to the MP4 repack, which carries AAC.
 */
export function audioDirect(p: Probe, can?: Set<string>) {
  const codec = String(p.audioCodec ?? '')
  return !codec || DIRECT_AUDIO.has(codec) || !!can?.has(codec)
}

const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis'])
/** Every episode's sound goes through this on its way to stereo AAC. A 5.1 mix folded down to two channels, and most
    streaming-era mixes anyway, sit far below where a television expects dialogue, so the volume had to be wound up to
    hear anyone and then a loud scene took the roof off. dynaudnorm lifts quiet stretches toward a steady level (at most
    about 15 dB, so room tone is not blown up), leaves what is already loud alone, and its peak target keeps it from
    clipping. It looks at about two seconds at a time, so a piece started from the middle of the file settles at once. */
export const AUDIO_LEVEL = ['-af', 'dynaudnorm=f=250:g=9:p=0.9:m=6']
/** Codecs an MP4 can hold with the picture copied. server.ts remuxes to MP4, so it uses this same set. */
export const MP4_CARRY = new Set(['h264', 'hevc', 'av1'])
/**
 * Whether the picture can be passed through untouched at ANY height: an MP4 or TS holds the codec and the player decodes
 * the colour layout. The 1080p cap belongs to the MP4 repack (a whole second file on disk), not to a stream: 0.3.55 uses
 * this so a file whose only fault is its sound is remuxed with the picture copied, at whatever resolution it is.
 */
export const copyPictureOnly = (p: Probe) => MP4_CARRY.has(String(p.videoCodec ?? '')) && (!p.pixFmt || p.pixFmt === 'yuv420p')
/** Pictures an MPEG-TS segment carries with the picture copied. AV1 and VP9 are left to the encoder. */
const TS_CARRY = new Set(['h264', 'hevc'])
/** Whether an MPEG-TS piece can carry this picture copied, for a player that decodes it. */
export const copyIntoTs = (p: Probe) => TS_CARRY.has(String(p.videoCodec ?? '')) && (!p.pixFmt || p.pixFmt === 'yuv420p')
/**
 * Whether THIS player can be handed the picture copied, inside a playlist: it decodes the codec (H.264 always; HEVC only
 * when the device said so) in the colour layout every player takes. False means the picture has to be converted.
 */
export function copyPictureFor(p: Probe, can?: Set<string>) {
  const codec = String(p.videoCodec ?? '')
  return copyIntoTs(p) && (codec === 'h264' || !!can?.has(codec))
}
/** Playing this file needs a libx264 encode: not playable as it is, not HDR (which is copied), and its picture cannot be copied. */
export const needsEncode = (p: Probe) => !p.direct && !p.hdr && !p.copyVideo

/** Subtitle formats that are text and can become WebVTT. Picture subtitles (PGS, VobSub) can't be shown in a browser. */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

const LANG: Record<string, string> = { eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', pol: 'Polish',
  tur: 'Turkish', ara: 'Arabic', heb: 'Hebrew', hin: 'Hindi', cze: 'Czech', ces: 'Czech', hun: 'Hungarian', gre: 'Greek', ell: 'Greek', tha: 'Thai', und: 'Unknown' }
const langName = (code?: string) => (code ? LANG[code.toLowerCase()] ?? code : 'Unknown')
const HDR_TRC = new Set(['smpte2084', 'arib-std-b67'])

/** ffprobe the file through our own range endpoint, then decide: serve raw bytes or remux/transcode to HLS. */
export async function probe(torrentId: number, fileIndex: number, opts: { complete?: boolean } = {}): Promise<Probe> {
  const key = `${torrentId}:${fileIndex}`
  const hit = probes.get(key)
  // A probe of a file that has finished downloading is the whole truth about it and is kept. One taken while it was still
  // arriving is used for now, but is asked again the moment the caller knows the file is complete: a partial read can
  // report no height (or no audio stream) and that answer was kept for ever before, which is what made a playable 4K file
  // announce itself as needing converting.
  if (hit && (hit.complete || !opts.complete)) return hit.p
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', rawUrl(torrentId, fileIndex)], { timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 120_000), maxBuffer: 8 << 20 })
    .catch((e) => { throw new Error(`ffprobe failed (code=${e.code} signal=${e.signal} killed=${e.killed}): ${String(e.stderr || e.message).replace(config.internalKey, '***').trim().slice(0, 500)}`) })
  const j = JSON.parse(stdout)
  const v = j.streams?.find((s: any) => s.codec_type === 'video')
  const a = j.streams?.find((s: any) => s.codec_type === 'audio')
  const fmt: string = j.format?.format_name ?? ''
  const containerOk = /mp4|webm/.test(fmt)
  const pixOk = !v?.pix_fmt || v.pix_fmt === 'yuv420p'
  const height: number | undefined = v?.height
  // What a repack into MP4 can carry with the picture copied. The height cap belongs to that copy (a second full file on
  // the disk), not to direct play: handing the bytes over as they are costs this box nothing at any resolution.
  const vOk = !!v && DIRECT_VIDEO.has(v.codec_name) && pixOk && (height ?? 0) <= 1080
  const audio: AudioTrack[] = (j.streams ?? []).filter((s: any) => s.codec_type === 'audio').map((s: any, n: number) => ({
    n, lang: s.tags?.language ?? 'und', channels: s.channels, default: !!s.disposition?.default,
    label: [langName(s.tags?.language), s.tags?.title && !/^(stereo|surround|\d\.\d)/i.test(s.tags.title) ? s.tags.title : '', s.channels > 2 ? `${s.channels - 1}.1` : ''].filter(Boolean).join(' · '),
  }))
  const subs: SubTrack[] = (j.streams ?? []).filter((s: any) => s.codec_type === 'subtitle').map((s: any, n: number) => ({ s, n }))
    .filter(({ s }: any) => TEXT_SUBS.has(s.codec_name))
    .map(({ s, n }: any) => ({ n, lang: s.tags?.language ?? 'und', forced: !!s.disposition?.forced, default: !!s.disposition?.default,
      label: [langName(s.tags?.language), s.tags?.title && !/^(full|default)$/i.test(s.tags.title) ? s.tags.title : '', s.disposition?.forced ? 'Forced' : '', s.disposition?.hearing_impaired ? 'CC' : ''].filter(Boolean).join(' · ') }))
  const fpsRaw = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? '')
  const [fn, fd] = fpsRaw.split('/').map(Number)
  const fps = fn > 0 && fd > 0 ? Math.min(120, fn / fd) : undefined
  const chapters: Chapter[] = (j.chapters ?? []).map((c: any) => ({ start: Number(c.start_time), end: Number(c.end_time), title: String(c.tags?.title ?? '') })).filter((c: Chapter) => c.end > c.start)
  const p: Probe = {
    direct: false, videoCodec: v?.codec_name, audioCodec: a?.codec_name, container: fmt,
    duration: j.format?.duration ? Number(j.format.duration) : undefined, copyVideo: vOk, height,
    hdr: HDR_TRC.has(v?.color_transfer ?? ''), audio, subs, chapters,
    hdrKind: v?.color_transfer === 'arib-std-b67' ? 'hlg' : v?.color_transfer === 'smpte2084' ? 'pq' : undefined,
    fps, srcBitrate: v?.bit_rate ? Number(v.bit_rate) : undefined,
    tenBit: /10|12/.test(String(v?.pix_fmt ?? '')),
    pixFmt: v?.pix_fmt,
    startTime: Number.isFinite(Number(j.format?.start_time)) ? Number(j.format.start_time) : undefined,
  }
  // The answer for a player that has said nothing about itself: the box's own list of what every player takes.
  p.direct = directPlay(p) && audioDirect(p)
  // No picture at all means the read did not reach the streams: nothing worth remembering, so the next ask runs again.
  if (v) probes.set(key, { p, complete: !!opts.complete })
  return p
}

/** One ffmpeg started at segment `from`; `stopAt` is the first segment that was already on disk then (it ends there on its own). */
interface Run { proc: ChildProcess; from: number; stopAt: number; exited: boolean }
/**
 * A copy that is served as a complete playlist from the first request, with ffmpeg started wherever the viewer actually is.
 * `bounds` holds where each piece starts, plus the end: SEG apart for a converted picture (its keyframes are forced
 * there), and on the file's own keyframes for a copied one, because a copied picture can only be cut on a keyframe.
 */
interface Vod { count: number; bounds: number[]; copy?: boolean; start: (from: number, stopAt: number) => string[]; run: Run | null; done: Set<number> }
interface Job { proc: ChildProcess | null; dir: string; idle: NodeJS.Timeout; torrentId: number; ready: Promise<void>; vod?: Vod; touched: number }
const jobs = new Map<string, Job>()
const hlsRoot = () => join(config.dataDir, 'hls')

/**
 * One job (and folder) per file and chosen audio track, so switching language doesn't disturb anyone else watching.
 * `encode` is the converted cut of a picture that is otherwise copied: a player that cannot decode HEVC gets that one,
 * while a player that can keeps the copy, and the two never share pieces. `maxH` is a smaller cut asked for by a viewer
 * on a slow connection (720 or 480); each size is a job of its own, so a phone on 480p never disturbs the TV.
 */
export function jobDir(torrentId: number, fileIndex: number, audio = 0, hdr = false, encode = false, maxH = 0) {
  return join(hlsRoot(), `${torrentId}-${fileIndex}${audio ? `-a${audio}` : ''}${hdr ? '-hdr' : ''}${encode ? '-x' : ''}${maxH ? `-h${maxH}` : ''}`)
}
const jobKey = (t: number, f: number, a = 0, hdr = false, encode = false, maxH = 0) => `${t}:${f}:${a}${hdr ? ':hdr' : ''}${encode ? ':x' : ''}${maxH ? `:h${maxH}` : ''}`

/** The sizes a viewer can ask for, as the box each fits inside: "720p" is 1280x720 whatever the shape of the picture. */
export const QUALITIES: Record<number, [number, number]> = { 720: [1280, 720], 480: [854, 480] }
export const qualityOf = (v: unknown) => { const n = Number(v); return n in QUALITIES ? n : 0 }

/** A job touched this recently is being watched right now, and is never closed to make room for another. */
const ACTIVE_MS = 90_000

/**
 * Make room for one more encode. The cap exists because a second full-quality encode on four cores half the
 * speed of both, which the viewer sees as a hitch. Room is made only by closing a job nobody is watching —
 * untouched for ACTIVE_MS — so the cap can never take away the stream in front of someone. If every job is
 * live, the new one starts anyway: a second screen slows the first rather than stopping it.
 */
function enforceJobCap() {
  const cap = Math.max(1, config.transcode.maxJobs)
  const now = Date.now()
  while (jobs.size >= cap) {
    let oldestKey: string | null = null
    let oldest = Infinity
    for (const [k, job] of jobs) {
      if (now - job.touched < ACTIVE_MS) continue
      if (job.touched < oldest) { oldest = job.touched; oldestKey = k }
    }
    if (!oldestKey) {
      hitch('encode', 'starting a conversion over the job cap: every running job is in use', { cap, running: jobs.size })
      return
    }
    hitch('encode', 'closed an idle conversion to stay within the job cap', { cap, closed: oldestKey, idleSec: Math.round((now - oldest) / 1000) })
    stopJob(oldestKey)
  }
}

function stopJob(key: string) {
  const j = jobs.get(key)
  if (!j) return
  clearTimeout(j.idle)
  j.proc?.kill('SIGKILL')
  j.vod?.run?.proc.kill('SIGKILL')
  rmSync(j.dir, { recursive: true, force: true })
  jobs.delete(key)
}
export function stopJobsFor(torrentId: number) {
  for (const k of [...jobs.keys()]) if (k.startsWith(`${torrentId}:`)) stopJob(k)
  forgetKeyframes(torrentId)
  for (const k of [...vttCache.keys()]) if (k.startsWith(`${torrentId}:`)) vttCache.delete(k)
  if (existsSync(hlsRoot())) for (const d of readdirSync(hlsRoot())) if (d.startsWith(`${torrentId}-`)) rmSync(join(hlsRoot(), d), { recursive: true, force: true })
}
export function cleanHlsCache() { rmSync(hlsRoot(), { recursive: true, force: true }) }

let zscale: boolean | null = null
/** HDR to SDR needs ffmpeg's zscale filter; checked once. Without it HDR is passed through (and looks washed out). */
export async function canToneMap(): Promise<boolean> {
  if (zscale === null) zscale = await execFileP('ffmpeg', ['-hide_banner', '-filters']).then((r) => /\bzscale\b/.test(r.stdout) && /\btonemap\b/.test(r.stdout)).catch(() => false)
  return zscale
}
/**
 * HDR (PQ or HLG) to SDR. mobius keeps highlights from flattening the way hable does -- sky and lamps stay bright
 * instead of going grey -- with desat=2 so the very brightest parts lose saturation rather than turning neon.
 */
export const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=2,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

/**
 * The encoder flags live in encode.ts now, which uses the GPU's encoder when the container can see one and
 * otherwise x264 at the profile saved in settings (economy by default: measured to keep up with two jobs at once).
 */

/** Length of one piece of the converted video. Short, so a seek only has to fetch a small piece before it plays. */
export const SEG = 4

/**
 * Whether this file can go to the player as HDR rather than being tonemapped down to SDR. The client says it can
 * show HDR; HEVC 10-bit is copied untouched (PQ or HLG tags kept), because re-encoding 10-bit would cost CPU for a
 * worse picture. Anything else, or a file above 1080p, still gets the SDR path.
 */
export function hdrCopyOk(p: Probe, clientSaysHdr: boolean) {
  return !!clientSaysHdr && p.hdr && p.tenBit !== false && p.videoCodec === 'hevc' && (p.height ?? 0) <= 1080
}

const AHEAD = 2 // a request this many segments past where ffmpeg is working waits for it; further away, ffmpeg is started there instead
const segPath = (j: Job, n: number) => join(j.dir, `seg${String(n).padStart(5, '0')}.ts`)

/**
 * A converted segment is written under a temporary name and renamed when whole, so a name that exists can be served. A
 * copied one comes from ffmpeg's segment muxer, which has no temporary names: it is whole once its run's list names it.
 */
function scanDone(j: Job) {
  const v = j.vod!
  for (const f of readdirSync(j.dir)) {
    const m = /^seg(\d{5})\.ts$/.exec(f)
    if (m && !v.copy) v.done.add(Number(m[1]))
    if (v.copy && /^list\d+\.csv$/.test(f)) {
      for (const line of readFileSync(join(j.dir, f), 'utf8').split('\n')) { const s = /^seg(\d{5})\.ts,/.exec(line); if (s) v.done.add(Number(s[1])) }
    }
  }
}

function vodNext(v: Vod, r: Run) { let n = r.from; while (v.done.has(n)) n++; return n }

function startRun(j: Job, n: number) {
  const v = j.vod!
  v.run?.proc.kill('SIGKILL')
  scanDone(j)
  let stopAt = n + 1
  while (stopAt < v.count && !v.done.has(stopAt)) stopAt++ // stop where the next piece already exists instead of encoding it again
  const started = Date.now()
  const proc = spawn('ffmpeg', v.start(n, stopAt >= v.count ? Infinity : stopAt), { stdio: ['ignore', 'ignore', 'inherit'] })
  const run: Run = { proc, from: n, stopAt: stopAt >= v.count ? Infinity : stopAt, exited: false }
  proc.on('exit', () => {
    run.exited = true
    try { scanDone(j) } catch { /* folder already removed */ }
    // Real timings, so a profile that cannot keep up shows up in the log instead of being felt as a hitch.
    if (!v.copy) notePace('segment', Date.now() - started, (v.bounds[Math.min(stopAt, v.count)] - v.bounds[n]) * 1000)
  })
  v.run = run
}

/**
 * The path of segment `file`, encoding it first if it is not there yet. ffmpeg runs from the segment the viewer asked for
 * (a seek, a resume, a TV jumping ahead), not always from the start, so jumping anywhere costs about a second.
 * undefined: this job has no on-demand playlist (the caller serves the file from disk); null: no such segment.
 */
export async function vodSegment(torrentId: number, fileIndex: number, file: string, signal: AbortSignal, audio = 0, hdr = false, encode = false, maxH = 0): Promise<string | null | undefined> {
  const j = jobs.get(jobKey(torrentId, fileIndex, audio, hdr, encode, maxH))
  const v = j?.vod
  if (!j || !v) return undefined
  const m = /^seg(\d{5})\.ts$/.exec(file)
  const n = m ? Number(m[1]) : -1
  if (n < 0 || n >= v.count) return null
  const deadline = Date.now() + 120_000
  let startedFor = -1
  const asked = Date.now()
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    scanDone(j)
    if (v.done.has(n)) {
      // A segment the encoder was not ready with is a hitch on screen: the player had nothing to play for that wait. Recorded
      // with the job it came from, so a slow CPU (every segment late) looks nothing like one late seek.
      const waited = Date.now() - asked
      if (waited > 600) hitch('hls', 'player waited for a segment', { torrent: torrentId, file: fileIndex, seg: n, waitedMs: waited, made: v.done.size, of: v.count })
      return segPath(j, n)
    }
    const r = v.run
    if (!(r && !r.exited && n >= r.from && n < r.stopAt && n <= vodNext(v, r) + AHEAD)) {
      if (startedFor === n && r?.exited) throw new Error('ffmpeg failed')
      startRun(j, n); startedFor = n
    }
    if (Date.now() > deadline) throw new Error('Timed out starting transcode')
    await sleep(60)
  }
}

/** The complete playlist of a job made by ensureHls, or null when that job plays from disk as it is written. */
export function vodPlaylist(torrentId: number, fileIndex: number, audio = 0, hdr = false, encode = false, maxH = 0): string | null {
  const v = jobs.get(jobKey(torrentId, fileIndex, audio, hdr, encode, maxH))?.vod
  if (!v) return null
  const len = (n: number) => Math.max(0.001, v.bounds[n + 1] - v.bounds[n])
  let longest = SEG
  for (let n = 0; n < v.count; n++) longest = Math.max(longest, len(n))
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (let n = 0; n < v.count; n++) lines.push(`#EXTINF:${len(n).toFixed(3)},`, `seg${String(n).padStart(5, '0')}.ts`)
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}

/** Every HLS job running now, and how far each has got: enough to tell a job that is encoding faster than it plays from one that is not. */
export function hlsSummary() {
  return [...jobs.entries()].map(([key, j]) => ({ job: key, segs: j.vod ? j.vod.done.size : null, of: j.vod ? j.vod.count : null, running: !!j.proc && j.proc.exitCode === null, dir: j.dir }))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- keyframes: where a copied picture can be cut ---------------------------------------------------------------
const kfRoot = () => join(config.dataDir, 'keyframes')
const kfBusy = new Map<string, Promise<number[] | null>>()

/**
 * Where the picture's keyframes are, in seconds, for a file that has finished downloading. Read from the packets alone --
 * ffprobe demuxes the file and decodes nothing -- so it costs the box a read of the file and almost no CPU, and it is kept
 * on disk, so it is read once per file and survives a restart. `source` is the file on disk when the caller knows it
 * (a plain read is quicker than going through the stream endpoint); otherwise the stream endpoint is used.
 */
export function keyframes(torrentId: number, fileIndex: number, source?: string): Promise<number[] | null> {
  const key = `${torrentId}-${fileIndex}`
  const file = join(kfRoot(), `${key}.json`)
  try { const k = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(k) && k.length) return Promise.resolve(k) } catch { /* not read yet */ }
  let p = kfBusy.get(key)
  if (!p) {
    const input = source && existsSync(source) ? source : rawUrl(torrentId, fileIndex)
    p = execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input],
      { timeout: 10 * 60_000, maxBuffer: 64 << 20 })
      .then(({ stdout }) => {
        const k = [...new Set(stdout.split('\n').filter((l) => /,K/.test(l)).map((l) => Number(l.split(',')[0])).filter(Number.isFinite))].sort((a, b) => a - b)
        if (!k.length) return null
        mkdirSync(kfRoot(), { recursive: true })
        writeFileSync(file, JSON.stringify(k))
        return k
      })
      .catch((e) => { hitch('hls', 'could not read the keyframes', { torrentId, fileIndex, why: String(e.message).replace(config.internalKey, '***').slice(0, 200) }); return null })
      .finally(() => kfBusy.delete(key))
    kfBusy.set(key, p)
  }
  return p
}
export function forgetKeyframes(torrentId: number) {
  if (!existsSync(kfRoot())) return
  for (const f of readdirSync(kfRoot())) if (f.startsWith(`${torrentId}-`)) rmSync(join(kfRoot(), f), { force: true })
}

/**
 * Where each piece of a copied picture starts, plus the end: the first keyframe at least `seg` seconds after the start
 * of the piece before. A copied picture can only begin on a keyframe, so these are the only places a piece can be cut,
 * and cutting there means every piece can be made on its own, in any order -- which is what lets a seek go anywhere.
 */
export function copyBounds(kf: number[], end: number, seg = SEG): number[] | null {
  const k = kf.filter((t) => Number.isFinite(t) && t < end).sort((a, b) => a - b)
  if (!k.length || !(end > k[0])) return null
  const b = [k[0]]
  for (const t of k) if (t - b[b.length - 1] >= seg) b.push(t)
  if (b.length > 1 && end - b[b.length - 1] < 1) b.pop() // a sliver at the very end joins the piece before it
  b.push(end)
  return b
}

/**
 * Start (or touch) the HLS job. Every picture gets a complete playlist straight away and ffmpeg only works where the
 * viewer is (see vodSegment), so a seek, a resume or a jump backwards is a piece made in about a second wherever it is:
 * - a picture that has to be converted is re-encoded on the CPU, its keyframes forced every SEG seconds;
 * - a picture that is copied (the sound is all that is converted) is cut on its own keyframes, once the file is whole.
 * Only a copied picture still arriving is remuxed from the start as it grows, because its keyframes are not all there yet.
 *
 * `encode` asks for the converted cut even where the picture could be copied: the player cannot decode it (HEVC).
 * `maxHeight` asks for a smaller converted cut (720 or 480, see QUALITIES), with its bitrate capped, for a slow connection.
 */
export async function ensureHls(torrentId: number, fileIndex: number, p: Probe, audio = 0, hdr = false, opts: { complete?: boolean; source?: string; encode?: boolean; maxHeight?: number } = {}): Promise<string> {
  const maxH = hdr ? 0 : qualityOf(opts.maxHeight)
  const encodeAsked = (!!opts.encode || maxH > 0) && !hdr
  const key = jobKey(torrentId, fileIndex, audio, hdr, encodeAsked, maxH)
  let j = jobs.get(key)
  if (!j) {
    const dir = jobDir(torrentId, fileIndex, audio, hdr, encodeAsked, maxH)
    const tonemap = p.hdr && (await canToneMap())
    const copy = !hdr && !encodeAsked && copyIntoTs(p)
    const outH = Math.min(p.height ?? 720, 1080, maxH || 1080)
    const box = maxH ? QUALITIES[maxH] : null
    // A chosen size fits the picture inside its box (a 2.40:1 film at "720p" is 1280 wide, not 1728), never larger than the source.
    const scale = box ? [`scale=w='min(iw,${box[0]})':h='min(ih,${box[1]})':force_original_aspect_ratio=decrease:force_divisible_by=2`]
      : (p.height ?? 0) > outH ? [`scale=-2:${outH}`] : []
    const filters = [...scale, ...(tonemap ? [TONEMAP] : [])]
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const input = ['-i', rawUrl(torrentId, fileIndex)]
    const maps = ['-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn']
    const audioOut = [...AUDIO_LEVEL, '-c:a', 'aac', '-ac', '2', '-b:a', '160k']
    // Decided once per file: the profile does not change while it plays. The GPU when the container has one (see pickEncoder).
    const enc = !hdr && !copy ? await videoEncode(outH, p.fps, filters, SEG, { capped: maxH > 0 }) : null
    if (enc) diag('encode', `converting with ${enc.encoder} at ${enc.profile}`, { torrentId, fileIndex, height: outH, ...(maxH ? { quality: maxH } : {}) })
    // A copied picture of a whole file: its keyframes, read once, are where the pieces are cut. Waited for a while, since
    // a playlist that can be seeked is worth a few seconds; a read that takes longer carries on behind and the old
    // forwards-only remux is used this once.
    const kf = copy && opts.complete && p.duration ? await Promise.race([keyframes(torrentId, fileIndex, opts.source), sleep(20_000).then(() => null)]) : null
    const copyPlan = kf && p.duration ? copyBounds(kf, (p.startTime ?? 0) + p.duration) : null
    if (copy && copyPlan) {
      const b = copyPlan
      const count = b.length - 1
      // -copyts keeps the file's own clock, so pieces cut by different runs join exactly. The input seek lands on the
      // keyframe at or before the time asked, so it is asked for a hair after the piece's own keyframe.
      const start = (from: number, stopAt: number) => {
        const last = Number.isFinite(stopAt) ? stopAt : count
        return ['-hide_banner', '-loglevel', 'error', '-ss', (b[from] + 0.05).toFixed(3), '-copyts', ...input, ...maps,
          '-c:v', 'copy', ...audioOut, ...(last < count ? ['-to', b[last].toFixed(3)] : []),
          '-muxdelay', '0', '-muxpreload', '0',
          '-f', 'segment', '-segment_format', 'mpegts', '-segment_time_delta', '0.05', '-segment_start_number', String(from),
          ...(last - from > 1 ? ['-segment_times', b.slice(from + 1, last).map((t) => (t - b[from]).toFixed(3)).join(',')] : []),
          '-segment_list', join(dir, `list${from}.csv`), '-segment_list_type', 'csv', join(dir, 'seg%05d.ts')]
      }
      j = { proc: null, dir, idle: setTimeout(() => {}, 0), torrentId, ready: Promise.resolve(), touched: Date.now(), vod: { count, bounds: b, copy: true, start, run: null, done: new Set() } }
      jobs.set(key, j)
    } else if (!hdr && !copy && p.duration && p.duration > 0) {
      const count = Math.max(1, Math.ceil(p.duration / SEG))
      const bounds = Array.from({ length: count }, (_, n) => n * SEG).concat(p.duration)
      const start = (from: number, stopAt: number) => ['-hide_banner', '-loglevel', 'error', ...(from ? ['-ss', String(from * SEG)] : []), ...enc!.inputArgs, ...input, ...maps,
        ...enc!.codecArgs, ...enc!.filterArgs, ...audioOut,
        ...(Number.isFinite(stopAt) ? ['-t', String((stopAt - from) * SEG)] : []),
        // The same clock whichever piece ffmpeg began at, so pieces made by different runs join without a jump.
        '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(from * SEG),
        '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-start_number', String(from),
        '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', join(dir, 'seg%05d.ts'), join(dir, `enc${from}.m3u8`)]
      j = { proc: null, dir, idle: setTimeout(() => {}, 0), torrentId, ready: Promise.resolve(), touched: Date.now(), vod: { count, bounds, start, run: null, done: new Set() } }
      enforceJobCap()
      jobs.set(key, j)
    } else {
      const args = ['-hide_banner', '-loglevel', 'error', ...(enc?.inputArgs ?? []), ...input, ...maps,
        ...(hdr
          ? ['-c:v', 'copy', '-tag:v', 'hvc1',
            '-color_primaries', 'bt2020', '-color_trc', p.hdrKind === 'hlg' ? 'arib-std-b67' : 'smpte2084', '-colorspace', 'bt2020nc']
          : copy ? ['-c:v', 'copy'] : [...enc!.codecArgs, ...enc!.filterArgs]),
        ...audioOut,
        // HDR is copied into fragmented MP4 segments, which is what the player's HEVC support expects; SDR stays in TS.
        ...(hdr
          ? ['-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
            '-hls_segment_filename', join(dir, 'seg%05d.m4s'), join(dir, 'index.m3u8')]
          : ['-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-hls_flags', 'independent_segments', '-hls_segment_filename', join(dir, 'seg%05d.ts'), join(dir, 'index.m3u8')])]
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
      const ready = (async () => {
        for (let i = 0; i < 600; i++) {
          if (existsSync(join(dir, hdr ? 'seg00000.m4s' : 'seg00000.ts')) && existsSync(join(dir, 'index.m3u8'))) return
          if (proc.exitCode !== null && proc.exitCode !== 0) throw new Error('ffmpeg failed')
          await new Promise((r) => setTimeout(r, 250))
        }
        throw new Error('Timed out starting transcode')
      })()
      ready.catch(() => stopJob(key))
      j = { proc, dir, idle: setTimeout(() => {}, 0), torrentId, ready, touched: Date.now() }
      if (!copy) enforceJobCap()
      jobs.set(key, j)
      proc.on('exit', () => { /* finished playlists stay on disk until idle timeout */ })
    }
  }
  clearTimeout(j.idle)
  j.idle = setTimeout(() => stopJob(key), 10 * 60_000).unref() // a timer, not a reason to keep the process alive
  await j.ready
  return j.dir
}

/**
 * The viewer left the player: the converted copy (temporary, in Flix's own data folder, never in Downloads) is not needed any more, so
 * it goes after a short grace period rather than lingering. Opening the player again within that time cancels it (touchHls resets the timer).
 */
export function releaseHls(torrentId: number, fileIndex: number) {
  for (const [key, j] of jobs) {
    if (!key.startsWith(`${torrentId}:${fileIndex}:`)) continue
    clearTimeout(j.idle)
    j.idle = setTimeout(() => stopJob(key), 90_000).unref()
  }
}

export function touchHls(torrentId: number, fileIndex: number, audio = 0, hdr = false, encode = false, maxH = 0) {
  const key = jobKey(torrentId, fileIndex, audio, hdr, encode, maxH)
  const j = jobs.get(key)
  if (!j) return false
  clearTimeout(j.idle)
  j.idle = setTimeout(() => stopJob(key), 10 * 60_000).unref()
  return true
}

// ---- subtitle files that sit beside the video in the torrent ------------------------------------------
export const SUBFILE = /\.(srt|ass|ssa|vtt)$/i
const TWO: Record<string, string> = { en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'chi', nl: 'dut', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', tr: 'tur', ar: 'ara', he: 'heb', hi: 'hin', cs: 'cze', hu: 'hun', el: 'gre', th: 'tha' }
/** A language guessed from a subtitle file name like "Show.S01E01.English.srt" or "2_Spanish.srt". 'und' when there is no clue. */
export function guessSubLang(name: string): { lang: string; label: string; forced: boolean } {
  const base = name.split('/').pop()!.replace(SUBFILE, '')
  const toks = base.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const byName = Object.entries(LANG).find(([, n]) => toks.includes(n.toLowerCase()))?.[0]
  const code = byName ?? toks.find((t) => LANG[t] && t !== 'und') ?? toks.map((t) => TWO[t]).find(Boolean) ?? 'und'
  const forced = toks.includes('forced')
  return { lang: code, forced, label: [code === 'und' ? 'Subtitles' : langName(code), forced ? 'Forced' : '', toks.includes('sdh') || toks.includes('cc') ? 'CC' : ''].filter(Boolean).join(' · ') }
}
const xvtt = new Map<string, string>()
/** A subtitle file as WebVTT. Not valid UTF-8 means an old Windows code page, so say so to ffmpeg. */
export async function fileSubtitleVtt(path: string): Promise<string> {
  const hit = xvtt.get(path)
  if (hit !== undefined) return hit
  const buf = await readFile(path)
  let utf8 = true
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { utf8 = false }
  const r = await execFileP('ffmpeg', ['-v', 'error', ...(utf8 ? [] : ['-sub_charenc', 'CP1252']), '-i', path, '-f', 'webvtt', '-'], { timeout: 60_000, maxBuffer: 16 << 20 })
    .catch((e) => { console.warn(`[subs] ${path}: ${String(e.stderr || e.message).slice(0, 200)}`); return { stdout: VTT_HEAD } })
  xvtt.set(path, r.stdout || VTT_HEAD)
  return xvtt.get(path)!
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
