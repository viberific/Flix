/**
 * What the encoder is allowed to do, and which encoder it is.
 *
 * The box Flix runs on is an Intel N95 (Alder Lake-N): four slow cores, Quick Sync on the integrated graphics, and the
 * container is given /dev/dri. Measured there with libx264 at 1080p24, one job on its own, speed relative to real time:
 *
 *   libx264 veryfast 3.56x   superfast 4.84x   ultrafast 8.51x      (720p is roughly double each)
 *
 * A single stream was never the problem. Two at once halve those numbers, and a third leaves them all behind real time,
 * which is what a hitch is: pieces arrive after the player needs them. So the profile defaults to a cheap one, the number
 * of jobs at once is capped, and the GPU's encoder is used when it is reachable.
 *
 * Two things had to be got right on this chip (measured 2026-10-31 on one 60 s 1080p->720p piece):
 *
 * 1. Low-power Quick Sync has no ICQ. Asking for -global_quality is what "parameters not supported by the QSV runtime"
 *    was, and it is why every probe failed and every conversion ran on the CPU. Low-power mode is bitrate-driven:
 *    -low_power 1 with -b:v works -- 14.7 s wall and ~30 s CPU against x264's 17.2 s and ~49 s.
 * 2. The 1080->720 resize was still on the CPU and dominated the cost of the piece. On the GPU (hwupload then vpp_qsv,
 *    which needs -init_hw_device qsv=qsv:hw -filter_hw_device qsv to be accepted at all) the scale stops costing cores.
 *
 * Everything here is measured, not guessed: `encoderInfo()` reports what was chosen and the mode it uses, and the
 * Settings page shows it so a wrong assumption is visible rather than silent. A probe that fails is never fatal: every
 * rung below it is tried, x264 is the floor, and a hardware encode that fails on a real file demotes itself to the CPU
 * rather than failing the transcode.
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

/** What the encoder that was actually chosen can do, which decides the flags below. */
export interface HwCaps {
  encoder: Exclude<Encoder, 'libx264'>
  /** Quick Sync's low-power (VDEnc) mode: bitrate rate control only. It cannot do ICQ. */
  lowPower: boolean
  /** The resize runs on the GPU (vpp_qsv / scale_vaapi) rather than on the CPU. */
  gpuScale: boolean
  /** VAAPI: the firmware takes a bitrate target (VBR) instead of a fixed quantiser. */
  rated: boolean
}

/** One rung worth trying at startup, and what it proves when it works. */
export interface ProbeStep extends HwCaps { args: string[] }

/** A resize target in pixels, for the GPU to do. */
export interface EncodeTarget { w: number; h: number }

/**
 * The rungs to try, best first. Each is a real tiny encode (8 frames of 640x360, well under a second) of the exact flag
 * shape a conversion would use, so a probe that passes means the conversion passes:
 *
 *   1. Quick Sync low-power, bitrate, resize in VPP   -- what this box takes, and the fastest of them
 *   2. Quick Sync low-power, resize left to the CPU  -- an older chip whose VPP cannot scale an uploaded frame
 *   3. Quick Sync with ICQ (global_quality)          -- older Quick Sync: no low-power mode, but it does have ICQ
 *   4. VAAPI, VBR, resize in scale_vaapi             -- Quick Sync without the iHD/oneVPL runtime
 *   5. VAAPI, VBR, resize on the CPU
 *   6. VAAPI with a fixed quantiser                  -- when the HuC firmware will not take a bitrate target
 *
 * Exported so a test can hold the order and the flags still without an ffmpeg to run them on.
 */
export function probePlan(): ProbeStep[] {
  const src = (pre: string[] = []) => ['-hide_banner', '-loglevel', 'error', '-nostdin', ...pre, '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-frames:v', '8']
  const qsvRate = ['-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k']
  const vaapiRate = ['-rc_mode', 'VBR', ...qsvRate]
  const qsvScale = 'format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=w=320:h=180'
  const vaapiScale = 'format=nv12,hwupload,scale_vaapi=w=320:h=180'
  const qsvDevice = ['-init_hw_device', 'qsv=qsv:hw', '-filter_hw_device', 'qsv']
  const vaapiDevice = ['-vaapi_device', GPU_DEVICE]
  const out = ['-f', 'null', '-']
  return [
    { encoder: 'h264_qsv', lowPower: true, gpuScale: true, rated: false, args: [...src(qsvDevice), '-vf', qsvScale, '-c:v', 'h264_qsv', '-low_power', '1', ...qsvRate, ...out] },
    { encoder: 'h264_qsv', lowPower: true, gpuScale: false, rated: false, args: [...src(), '-vf', 'format=nv12', '-c:v', 'h264_qsv', '-low_power', '1', ...qsvRate, ...out] },
    { encoder: 'h264_qsv', lowPower: false, gpuScale: false, rated: false, args: [...src(), '-c:v', 'h264_qsv', '-global_quality', '26', ...out] },
    { encoder: 'h264_vaapi', lowPower: false, gpuScale: true, rated: true, args: [...src(vaapiDevice), '-vf', vaapiScale, '-c:v', 'h264_vaapi', ...vaapiRate, ...out] },
    { encoder: 'h264_vaapi', lowPower: false, gpuScale: false, rated: true, args: [...src(vaapiDevice), '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', ...vaapiRate, ...out] },
    { encoder: 'h264_vaapi', lowPower: false, gpuScale: false, rated: false, args: [...src(vaapiDevice), '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '26', ...out] },
  ]
}

/**
 * Run one probe with ffmpeg. An encoder that is advertised but cannot open a session is worse than none, and so is one
 * that opens a session and then rejects the rate control -- which is exactly what happened here.
 */
function runProbe(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, why?: string) => {
      if (done) return
      done = true
      if (!ok && why) diag('encode', 'encoder probe failed', { why, encoder: args.includes('h264_qsv') ? 'h264_qsv' : 'h264_vaapi' })
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

let caps: HwCaps | null = null
let chosen: Encoder | null | undefined

/**
 * The encoder to use: Quick Sync (low-power first), else VAAPI, else libx264. Tested once per process -- or again after
 * the admin changes the switch or presses Test, because the answer depends on the container's devices and is the same
 * for every job afterwards. Nothing here can fail a conversion: no /dev/dri, no working encoder, or hardware switched
 * off all end at libx264, which is the floor.
 */
export async function pickEncoder(force = false): Promise<Encoder> {
  if (chosen !== undefined && !force) return chosen ?? 'libx264'
  chosen = null
  caps = null
  if (config.transcode.hardware && gpuPresent()) {
    for (const step of probePlan()) {
      if (!(await runProbe(step.args))) continue
      caps = { encoder: step.encoder, lowPower: step.lowPower, gpuScale: step.gpuScale, rated: step.rated }
      chosen = step.encoder
      diag('encode', `using hardware encoder ${step.encoder}`, { device: GPU_DEVICE, lowPower: step.lowPower, gpuScale: step.gpuScale, rated: step.rated })
      break
    }
    if (!chosen) hitch('encode', 'GPU is present but no hardware encoder opened a session; using the CPU', { device: GPU_DEVICE })
  } else if (config.transcode.hardware) {
    hitch('encode', 'no /dev/dri in this container, so transcoding is on the CPU', { hint: 'the app needs the GPU permission for /dev/dri' })
  }
  return chosen ?? 'libx264'
}

/** Forget the answer: the switch changed, so the next conversion decides again. */
export function resetEncoder() {
  chosen = undefined
  caps = null
}

/**
 * A hardware encode passed its probe and then failed on a real file. Flix never fails a conversion over hardware: the
 * caller rebuilds its flags from here (they come back as libx264), retries the piece it was making, and every
 * conversion afterwards uses the CPU.
 */
export function demoteHardware(why: string) {
  if (chosen && chosen !== 'libx264') hitch('encode', 'a hardware encode failed on a real file, finishing on the CPU', { encoder: chosen, why: why.slice(0, 200) })
  chosen = 'libx264'
  caps = null
}

/**
 * The filter chain for a hardware encoder. `scale` is the numeric target the GPU can be given; `scaleExpr` is the same
 * resize as ffmpeg's software expression, used when the GPU cannot scale -- or when a software-only filter has to be in
 * the chain, since a filter that wants system memory cannot run after hwupload.
 */
export function hwFilters(kind: 'h264_qsv' | 'h264_vaapi', gpuScale: boolean, scale: EncodeTarget | null, scaleExpr: string | undefined, filters: string[] = []): string[] {
  const software = [...(scaleExpr ? [scaleExpr] : []), ...filters]
  const onGpu = gpuScale && !!scale && filters.length === 0
  if (kind === 'h264_qsv') {
    return onGpu
      ? ['format=nv12', 'hwupload=extra_hw_frames=64', `vpp_qsv=w=${scale!.w}:h=${scale!.h}`]
      : [...software, 'format=nv12']
  }
  return onGpu
    ? ['format=nv12', 'hwupload', `scale_vaapi=w=${scale!.w}:h=${scale!.h}`]
    : [...software, 'format=nv12', 'hwupload']
}

/** Whether a chain uploads frames, which needs the device named before the input for Quick Sync. */
export const uploadsFrames = (chain: string[]) => chain.some((f) => f.startsWith('hwupload'))

/**
 * Quick Sync's video flags. Low-power mode has no ICQ at all, so the bitrate is named instead of a quality level; that is
 * the difference between "parameters not supported by the QSV runtime" and a working encode.
 */
export function qsvCodecArgs(o: { lowPower: boolean; capped: boolean; rate: string; buf: string; quality: number }): string[] {
  const rate = ['-b:v', o.rate, '-maxrate', o.rate, '-bufsize', o.buf]
  return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0',
    ...(o.lowPower || o.capped ? rate : ['-global_quality', String(o.quality)]),
    '-profile:v', 'high', '-pix_fmt', 'nv12']
}

/** VAAPI's video flags: a fixed quantiser, or a bitrate target when the firmware takes one and the cut is capped. */
export function vaapiCodecArgs(o: { rated: boolean; capped: boolean; rate: string; buf: string; quality: number }): string[] {
  const rate = ['-rc_mode', 'VBR', '-b:v', o.rate, '-maxrate', o.rate, '-bufsize', o.buf]
  return ['-c:v', 'h264_vaapi', ...(o.capped ? (o.rated ? rate : ['-qp', String(o.quality + 3)]) : ['-qp', String(o.quality)]), '-profile:v', 'high']
}

export interface VideoEncode {
  encoder: Encoder
  profile: ProfileName
  /** Flags that must come before `-i` (the device, when frames are uploaded). */
  inputArgs: string[]
  /** `-vf` when there is a filter chain. */
  filterArgs: string[]
  /** The video codec flags. */
  codecArgs: string[]
}

/**
 * The video side of an encode: the GPU when there is one, otherwise x264 at the current profile, threaded so two jobs at
 * once do not each try to use all four cores and fight. `scale` is the resize as pixels, so the GPU can do it, and
 * `scaleExpr` the same resize as an ffmpeg expression, so software can. `capped` is a smaller cut for a slow connection:
 * its point is the bitrate, so the GPU is held to the profile's rate for that size instead of a quality level (x264 is
 * capped either way).
 */
export async function videoEncode(height: number | undefined, _fps: number | undefined, opts: { capped?: boolean; scale?: EncodeTarget | null; scaleExpr?: string; filters?: string[] } = {}, seg = 4): Promise<VideoEncode> {
  const h = bucket(height)
  const encoder = await pickEncoder()
  const profile = profileName()
  const keyframes = ['-force_key_frames', `expr:gte(t,n_forced*${seg})`]
  const rate = PROFILES[profile].rate[h], buf = PROFILES[profile].buf[h]
  const q = PROFILES[profile].crf[h] + 1
  if (encoder === 'h264_qsv' || encoder === 'h264_vaapi') {
    const chain = hwFilters(encoder, caps?.gpuScale ?? false, opts.scale ?? null, opts.scaleExpr, opts.filters ?? [])
    return {
      encoder, profile,
      inputArgs: encoder === 'h264_qsv'
        ? (uploadsFrames(chain) ? ['-init_hw_device', 'qsv=qsv:hw', '-filter_hw_device', 'qsv'] : [])
        : ['-vaapi_device', GPU_DEVICE],
      filterArgs: ['-vf', chain.join(',')],
      codecArgs: [...(encoder === 'h264_qsv'
        ? qsvCodecArgs({ lowPower: caps?.lowPower ?? false, capped: !!opts.capped, rate, buf, quality: q })
        : vaapiCodecArgs({ rated: caps?.rated ?? false, capped: !!opts.capped, rate, buf, quality: q })), ...keyframes],
    }
  }
  const P = PROFILES[profile]
  // One core left for the server, qBittorrent and the stream itself.
  const threads = Math.max(1, Math.min(4, cpus().length - Math.max(1, config.transcode.maxJobs - 1)))
  const filters = [...(opts.scaleExpr ? [opts.scaleExpr] : []), ...(opts.filters ?? [])]
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

/** What the Settings page and the diag endpoint show: what is actually being used, how, and why. */
export async function encoderInfo() {
  const encoder = await pickEncoder()
  const rateControl = encoder === 'libx264' ? 'crf' : caps?.lowPower ? 'bitrate (low-power Quick Sync has no ICQ)' : encoder === 'h264_vaapi' ? (caps?.rated ? 'vbr' : 'fixed quantiser') : 'icq'
  return {
    encoder,
    hardware: encoder !== 'libx264',
    hardwareAllowed: config.transcode.hardware,
    gpuDevice: gpuPresent() ? GPU_DEVICE : null,
    /** Whether the resize is being done by the GPU, which is where most of the saving is on this box. */
    gpuScale: !!caps?.gpuScale,
    lowPower: !!caps?.lowPower,
    rateControl,
    profile: profileName(),
    savedProfile: config.transcode.profile,
    steppedDown: runtimeProfile !== null,
    maxJobs: config.transcode.maxJobs,
    cores: cpus().length,
    /** Measure again (the admin pressed Test): the answer can change when compose gains /dev/dri. */
    retest: async () => { runtimeProfile = null; resetEncoder(); return { encoder: await pickEncoder(true) } },
  }
}

/** The same, without the functions, for a JSON response. */
export async function encoderStatus() {
  const e = await encoderInfo()
  const { retest: _retest, ...rest } = e
  void _retest
  return rest
}
