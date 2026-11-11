// The check 0.3.100 was shipped without. The unit test beside this one proves the flags and the filter chain agree with
// the rung that chose them; this one proves the agreement is true of the REAL encoder, by running the args a conversion
// would run against a real file and reading out of ffmpeg which encoder did the work.
//
// It exists because "using hardware encoder h264_qsv" in Flix's own log only means the probe passed. On 2026-11-04 the
// box printed that line and then, one line later, "a hardware encode failed on a real file, finishing on the CPU" --
// twice, at boot and on the next attempt -- so every real encode ran on libx264 while the settings page said otherwise.
//
// Skipped unless there is an ffmpeg, a /dev/dri and a file to encode: FLIX_LIVE_SRC. On the box:
//   FLIX_LIVE_SRC=/downloads/<episode>.mkv node --import tsx --test test/encode-live.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const src = process.env.FLIX_LIVE_SRC ?? ''
let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const hasGpu = existsSync('/dev/dri/renderD128')
const skip = !hasFfmpeg ? 'no ffmpeg in this container' : !hasGpu ? 'no /dev/dri: nothing to prove about a hardware encoder' : !src || !existsSync(src) ? 'no FLIX_LIVE_SRC file to encode' : false

const dir = mkdtempSync(join(tmpdir(), 'flix-live-'))
process.env.DATA_DIR ??= dir
process.env.DB_PATH ??= ':memory:'
process.env.TRANSCODE_HARDWARE ??= 'on'

const enc = await import('../src/encode.ts')

/** Run the plan a conversion would use, and keep everything ffmpeg said about it. */
function runFfmpeg(args: string[]): Promise<{ code: number | null; err: string; secs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('close', (code) => resolve({ code, err, secs: (Date.now() - t0) / 1000 }))
    setTimeout(() => p.kill('SIGKILL'), 180_000).unref()
  })
}

test('the encoder that is chosen is the encoder that runs a real file, and it is Quick Sync', { skip }, async () => {
  enc.resetEncoder()
  const encoder = await enc.pickEncoder()
  assert.notEqual(encoder, 'libx264', 'the box has /dev/dri and hardware turned on, so a rung must have passed')

  const plan = await enc.videoEncode(720, 24, { scale: { w: 1280, h: 720 }, scaleExpr: 'scale=1280:720' }, 4)
  assert.equal(plan.encoder, encoder, 'the conversion encodes with the encoder the ladder chose')

  // What a real play does: 20 s of the episode from a minute in, cut into segments, picture only. The device flags go
  // before -i and the filter chain after it, exactly as the conversion places them.
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-ss', '60', ...plan.inputArgs, '-i', src, '-t', '20', '-an',
    ...plan.filterArgs, ...plan.codecArgs, '-f', 'segment', '-segment_time', '4', '-segment_format', 'mpegts', join(dir, 'seg%03d.ts')]
  const r = await runFfmpeg(args)

  assert.equal(r.code, 0, `ffmpeg exited ${r.code}; its own words: ${r.err.trim().split('\n').slice(-6).join(' | ')}`)
  // ffmpeg names the encoder it opened on one line, "encoder : Lavc61.19.101 h264_qsv". That line is the proof.
  // The FIRST `encoder :` in the log is often the input file's own muxer (libebml/libmatroska), so match the Lavc one.
  const line = r.err.split('\n').find((l) => /^\s*encoder\s*:\s*Lavc/.test(l)) ?? ''
  assert.match(line, /h264_qsv/, `a real file must be encoded by Quick Sync, not demoted to the CPU: ${r.err.trim().split('\n').slice(-6).join(' | ')}`)
  assert.doesNotMatch(r.err, /libx264/, 'nothing on this path may fall back to x264')
  assert.doesNotMatch(r.err, /Current (resolution|pixel format) is unsupported/, 'the 0.3.100 failure must not be back')

  const segs = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  // 20 s at SEG = 4 s: five pieces. Getting two long ones means the keyframes were not IDR and the muxer could not split,
  // which is a slower start and coarser seeking on the TV, not a cosmetic detail.
  assert.ok(segs.length >= 5, `20 s at 4 s segments should make 5 pieces, made ${segs.length}: ${readdirSync(dir).join(', ')}`)
  for (const s of segs) {
    const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, s)], { encoding: 'utf8' }).trim())
    assert.ok(d > 0.5 && d < 5, `${s} is ${d.toFixed(2)} s: segments must stay at SEG, not stretch to the encoder's own GOP`)
  }

  // Nothing demoted behind our back: the process still believes what it proved.
  const info = await enc.encoderInfo()
  assert.equal(info.encoder, 'h264_qsv')
  assert.equal(info.lowPower, true, 'this box takes low-power Quick Sync, and the conversion is what asks for it')
  console.log(`live: ${plan.encoder} lowPower=${plan.codecArgs.includes('-low_power')} gpuScale=${/vpp_qsv/.test(plan.filterArgs.join(' '))} -- 20 s in ${r.secs.toFixed(1)} s, ${segs.length} segments`)
})
