/**
 * What the encoder is allowed to do, and which encoder it is.
 *
 * The box Flix runs on is an Intel N95: four slow cores and no hardware encode unless the container is given
 * /dev/dri. Measured there with 1080p24, one job on its own, speed relative to real time:
 *
 *   libx264 veryfast 3.56x   superfast 4.84x   ultrafast 8.51x      (720p is roughly double each)
 *
 * A single stream was never the problem. Two at once halve those numbers, and a third leaves them all behind
 * real time, which is what a hitch is: pieces arrive after the player needs them. So the profile defaults to a
 * cheap one, the number of jobs at once is capped, and the GPU's encoder is used when it is reachable.
 *
 * Everything here is measured, not guessed: `encoderInfo()` reports what was actually chosen, and the Settings
 * page shows it so a wrong assumption is visible rather than silent.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { config } from './config.ts'
import { diag, hitch } from './diag.ts'

export type Encoder = 'h264_qsv' | 'h264_vaapi' | 'libx264'
export type ProfileName = 'economy' | 'balanced' | 'best'

/** Per 1080p job. Rates are capped so a cheap preset does not spend the saving on bitrate instead. */
const PROFILES: Record<ProfileName, { x264: string; crf: Record<number, number>; rate: Record<number, string>; buf: Record<number, string> }> = {
  // 4.8x real time at 1080p on its own: still ahead of the player with two jobs going.
  economy: { x264: 'superfast', crf: { 1080: 22, 720: 23, 480: 24 }, rate: { 1080: '5000k', 720: '3000k', 480: '1600k' }, buf: { 1080: '10000k', 720: '6000k', 480: '3200k' } },
  // 3.6x on its own, the old default: the best picture that still keeps up with a single stream.
  balanced: { x264: 'veryfast', crf: { 1080: 20, 720: 21, 480: 22 }, rate: { 1080: '6500k', 720: '3500k', 480: '1800k' }, buf: { 1080: '13000k', 720: '7000k', 480: '3600k' } },
  // For a bigger machine or a file being converted to keep: not expected to hold real time here.
  best: { x264: 'faster', crf: { 1080: 19, 720: 20, 480: 21 }, rate: { 1080: '8000k', 720: '4000k', 480: '2000k' }, buf: { 1080: '16000k', 720: '8000k', 480: '4000k' } },
}

/** The rung below this one, for the step-down when an encode is measured falling behind. */
const CHEAPER: Record<ProfileName, ProfileName | null> = { best: 'balanced', balanced: 'economy', economy: null }

const bucket = (height?: number) => ((height ?? 720) >= 1080 ? 1080 : (height ?? 720) >= 720 ? 720 : 480)

/** The profile in force. A step-down changes this for the rest of the process, never the saved setting. */
let runtimeProfile: ProfileName | null = null
const profileName = (): ProfileName => runtimeProfile ?? config.transcode.profile

const GPU_DEVICE = '/dev/dri/renderD128'
export const gpuPresent = () => existsSync(GPU_DEVICE) || existsSync('/dev/dri/card0')

/** Probe with ffmpeg itself, once: an encoder that is advertised but cannot open a session is worse than none. */
function tryEncoder(name: Encoder, rated = false): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-frames:v', '12']
    if (name === 'h264_qsv') args.push('-c:v', 'h264_qsv', '-global_quality', '26')
    else if (name === 'h264_vaapi') args.push('-vaapi_device', GPU_DEVICE, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', ...(rated ? VAAPI_VBR('1000k', '2000k') : ['-qp', '26']))
    else args.push('-c:v', 'libx264', '-preset', 'ultrafast')
    args.push('-f', 'null', '-')
    let done = false
    const finish = (ok: boolean, why?: string) => {
      if (done) return
      done = true
      if (!ok && why) diag('encode', `encoder ${name} unavailable`, { why })
      resolve(ok)
    }
    try {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr?.on('data', (d) => { err = (err + String(d)).slice(-400) })
      p.on('error', () => finish(false, 'ffmpeg missing'))
      p.on('exit', (code) => finish(code === 0, err.trim().split('\n').pop()))
      setTimeout(() => { p.kill('SIGKILL'); finish(false, 'timed out') }, 12_000).unref()
    } catch (e) {
      finish(false, String(e))
    }
  })
}

/**
 * A bitrate the GPU holds to, for the smaller cuts a slow connection asks for. Gen12 VAAPI does rate control on the HuC
 * firmware, which a box may not load, so whether it works is probed rather than assumed (vaapiRated); without it those
 * cuts fall back to a fixed quantiser one notch coarser, which is smaller but not capped.
 */
const VAAPI_VBR = (rate: string, buf: string) => ['-rc_mode', 'VBR', '-b:v', rate, '-maxrate', rate, '-bufsize', buf]
let vaapiRated = false

let chosen: Encoder | null | undefined
/**
 * The encoder to use: Quick Sync, else VAAPI, else libx264. Tested once per process (or again when the admin
 * asks), because the answer depends on the container's devices and is the same for every job afterwards.
 * 0.3.57: on again by default (0.3.56 kept it behind an opt-in switch). The image now carries the iHD driver and the
 * Umbrel compose passes /dev/dri; an encoder that cannot open a session is never chosen, so x264 is still the floor.
 * Off by default now: everything runs on the CPU unless TRANSCODE_HARDWARE=true (or the admin switch in Settings) opts in.
 */
export async function pickEncoder(force = false): Promise<Encoder> {
  if (chosen !== undefined && !force) return chosen ?? 'libx264'
  chosen = null
  if (config.transcode.hardware && gpuPresent()) {
    for (const name of ['h264_qsv', 'h264_vaapi'] as const) {
      if (await tryEncoder(name)) {
        chosen = name
        vaapiRated = name === 'h264_vaapi' && (await tryEncoder(name, true))
        diag('encode', `using hardware encoder ${name}`, { device: GPU_DEVICE, ...(name === 'h264_vaapi' ? { rateControl: vaapiRated } : {}) })
        break
      }
    }
    if (!chosen) hitch('encode', 'GPU is present but its encoder did not open a session; using the CPU', { device: GPU_DEVICE })
  } else if (config.transcode.hardware) {
    hitch('encode', 'no /dev/dri in this container, so transcoding is on the CPU', { hint: 'pass /dev/dri in docker-compose.yml to use Quick Sync' })
  }
  return chosen ?? 'libx264'
}

export interface VideoEncode {
  encoder: Encoder
  profile: ProfileName
  /** Flags that must come before `-i` (the VAAPI device). */
  inputArgs: string[]
  /** `-vf` when there is a filter chain. */
  filterArgs: string[]
  /** The video codec flags. */
  codecArgs: string[]
}

/**
 * The video side of an encode: the GPU when there is one, otherwise x264 at the current profile, threaded so
 * two jobs at once do not each try to use all four cores and fight. `capped` is a smaller cut for a slow connection:
 * its point is the bitrate, so the GPU is held to the profile's rate for that size instead of a quality level
 * (x264 is capped either way).
 */
export async function videoEncode(height: number | undefined, fps: number | undefined, filters: string[], seg = 4, opts: { capped?: boolean } = {}): Promise<VideoEncode> {
  const h = bucket(height)
  const encoder = await pickEncoder()
  const profile = profileName()
  const keyframes = ['-force_key_frames', `expr:gte(t,n_forced*${seg})`]
  const rate = PROFILES[profile].rate[h], buf = PROFILES[profile].buf[h]
  if (encoder === 'h264_qsv') {
    // Hardware ignores the software preset; global_quality is its CRF. Frames are uploaded for it when needed.
    const q = PROFILES[profile].crf[h] + 1
    return {
      encoder, profile, inputArgs: [],
      filterArgs: filters.length ? ['-vf', [...filters, 'format=nv12'].join(',')] : ['-vf', 'format=nv12'],
      codecArgs: ['-c:v', 'h264_qsv', '-preset', 'veryfast',
        ...(opts.capped ? ['-b:v', rate, '-maxrate', rate, '-bufsize', buf] : ['-global_quality', String(q)]), '-look_ahead', '0',
        '-profile:v', 'high', '-pix_fmt', 'nv12', ...keyframes],
    }
  }
  if (encoder === 'h264_vaapi') {
    const q = PROFILES[profile].crf[h] + 1
    return {
      encoder, profile, inputArgs: ['-vaapi_device', GPU_DEVICE],
      filterArgs: ['-vf', [...filters, 'format=nv12', 'hwupload'].join(',')],
      codecArgs: ['-c:v', 'h264_vaapi', ...(opts.capped ? (vaapiRated ? VAAPI_VBR(rate, buf) : ['-qp', String(q + 3)]) : ['-qp', String(q)]),
        '-profile:v', 'high', ...keyframes],
    }
  }
  const P = PROFILES[profile]
  // One core left for the server, qBittorrent and the stream itself.
  const threads = Math.max(1, Math.min(4, cpus().length - Math.max(1, config.transcode.maxJobs - 1)))
  return {
    encoder, profile, inputArgs: [],
    filterArgs: filters.length ? ['-vf', filters.join(',')] : [],
    codecArgs: ['-c:v', 'libx264', '-preset', P.x264, '-crf', String(P.crf[h]), '-maxrate', P.rate[h], '-bufsize', P.buf[h],
      '-profile:v', 'high', '-level', h === 1080 ? '4.1' : '4.0', '-pix_fmt', 'yuv420p', '-sc_threshold', '0',
      '-threads', String(threads), ...keyframes],
  }
}

/**
 * One encode took this long for this much video. If it could not keep up and there is a cheaper rung, take it
 * for the rest of the process (the saved setting is untouched), so the next job is not queued behind the same
 * mistake. Called by the transcode path with real timings, never on a guess.
 */
export function notePace(label: string, tookMs: number, videoMs: number) {
  if (videoMs <= 0 || tookMs <= 0) return
  const speed = videoMs / tookMs
  if (speed >= 1.1) return
  const from = profileName()
  const to = CHEAPER[from]
  hitch('encode', `encode fell behind real time (${speed.toFixed(2)}x)`, { label, profile: from, tookMs, videoMs })
  if (!to) return
  runtimeProfile = to
  diag('encode', `stepped the encoder down from ${from} to ${to}`, { label, speed: Number(speed.toFixed(2)) })
}

/** What the Settings page and the diag endpoint show: what is actually being used, and why. */
export async function encoderInfo() {
  const encoder = await pickEncoder()
  return {
    encoder,
    hardware: encoder !== 'libx264',
    gpuDevice: gpuPresent() ? GPU_DEVICE : null,
    profile: profileName(),
    savedProfile: config.transcode.profile,
    steppedDown: runtimeProfile !== null,
    maxJobs: config.transcode.maxJobs,
    cores: cpus().length,
    /** Measure again (the admin pressed Test): the answer can change when compose gains /dev/dri. */
    retest: async () => { runtimeProfile = null; return { encoder: await pickEncoder(true) } },
  }
}

/** The same, without the function, for a JSON response. */
export async function encoderStatus() {
  const e = await encoderInfo()
  return { encoder: e.encoder, hardware: e.hardware, gpuDevice: e.gpuDevice, steppedDown: e.steppedDown, cores: e.cores }
}
