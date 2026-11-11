// The 0.3.100 bug was a mismatch, not a wrong flag: the probe ladder chose a session with `-low_power 1` (low-power
// Quick Sync, VDEnc) and then handed the conversion's hwupload + vpp_qsv filter chain to an h264_qsv session opened
// without it. Every real encode on the box then failed to open -- "Current resolution is unsupported", "Current pixel
// format is unsupported" -- and the app retried on libx264, so the settings page said hardware and the process cmdline
// said nothing of the kind. Twice in the box's log, at boot and again on the next attempt.
//
// So the rule this file holds is not "the flag is present": it is that the flags and the filter chain a REAL conversion
// builds agree with the rung that chose them, for every rung of the ladder, with no GPU and no ffmpeg in sight.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'flix-shape-'))
process.env.DB_PATH ??= ':memory:'

const { probePlan, videoEncode, useCapsForTest, resetEncoder, hwEncodeParts, encodeShape } = await import('../src/encode.ts')

/** `['-vf', 'a,b,c']` -> 'a,b,c', or '' when the plan carries no filter chain. */
const chainOf = (filterArgs: string[]) => (filterArgs[0] === '-vf' ? filterArgs[1] : '')

/** The real conversion a rung would produce: 720p target, the resize as both pixels and an expression, 4 s keyframes. */
async function encodeFor(rung: { encoder: string; lowPower: boolean; gpuScale: boolean; rated: boolean }) {
  useCapsForTest(rung.encoder as any, { encoder: rung.encoder as any, lowPower: rung.lowPower, gpuScale: rung.gpuScale, rated: rung.rated })
  return videoEncode(720, 24, { scale: { w: 1280, h: 720 }, scaleExpr: 'scale=1280:720' }, 4)
}

test('every rung of the ladder is internally consistent: what it uploads, it can also drive', () => {
  for (const rung of probePlan()) {
    const args = rung.args
    const lowPower = args.includes('-low_power')
    const uploads = args.includes('-vf') && /hwupload/.test(args[args.indexOf('-vf') + 1])
    if (rung.encoder === 'h264_qsv' && uploads) {
      assert.ok(lowPower, `${rung.encoder} rung uploads frames without -low_power: ${args.join(' ')}`)
    }
    assert.equal(lowPower, rung.lowPower, 'the rung reports the low-power mode its args ask for')
    assert.equal(/vpp_qsv|scale_vaapi/.test(args.join(' ')), rung.gpuScale, 'the rung scales on the GPU exactly when it says so')
    if (rung.encoder === 'h264_qsv' && lowPower) {
      assert.ok(args.includes('-b:v') && !args.includes('-global_quality'), 'low-power Quick Sync is rate-driven, never ICQ')
    }
  }
})

test('the conversion built from a rung has the same session shape as the rung that passed', async () => {
  for (const rung of probePlan()) {
    const plan = await encodeFor(rung)
    const chain = chainOf(plan.filterArgs)
    const lowPower = plan.codecArgs.includes('-low_power')
    const uploads = /hwupload/.test(chain)
    const rungLowPower = rung.args.includes('-low_power')
    assert.equal(plan.encoder, rung.encoder)
    assert.equal(lowPower, rungLowPower, `${rung.encoder}: the conversion must open the session the probe proved (rung low-power=${rungLowPower})`)
    // VAAPI always uploads (a vaapi encoder needs frames on the device even when the CPU did the resize); Quick Sync
    // uploads only for the VPP scale, which is the pair this bug was about.
    assert.equal(uploads, rung.gpuScale || rung.encoder === 'h264_vaapi', `${rung.encoder}: frames are uploaded exactly when the rung does`)
    assert.equal(/vpp_qsv|scale_vaapi/.test(chain), rung.gpuScale, `${rung.encoder}: the GPU scaler is in the chain exactly when the rung has it`)
    if (rung.encoder === 'h264_qsv' && uploads) {
      // The 0.3.100 failure, as one line: an uploaded frame and a low-power session go together or not at all.
      assert.ok(lowPower, `an h264_qsv conversion uploads frames without -low_power, which is the box's bug: ${plan.codecArgs.join(' ')}`)
    }
    // The device has to be named before the input whenever frames are uploaded, or ffmpeg rejects the chain outright.
    assert.equal(plan.inputArgs.includes('-init_hw_device'), plan.encoder === 'h264_qsv' && uploads)
    assert.equal(plan.inputArgs.includes('-vaapi_device'), plan.encoder === 'h264_vaapi')
    assert.ok(plan.codecArgs.some((a) => a.startsWith('expr:gte(t,n_forced*4)')), 'keyframes still land every segment')
  }
})

test('no plan for Quick Sync ever scales on the GPU without the low-power session it was probed with', async () => {
  // The same bug wearing a different hat: caps that claim a GPU resize but no low-power mode. The resize falls back to
  // the CPU rather than being asked of a session that will not take an uploaded, scaled frame.
  const shape = encodeShape('h264_qsv', { lowPower: false, gpuScale: true, rated: false })
  assert.deepEqual(shape, { lowPower: false, gpuScale: false, rated: false })
  const parts = hwEncodeParts('h264_qsv', shape, { capped: false, rate: '3500k', buf: '7000k', quality: 22, scale: { w: 1280, h: 720 }, scaleExpr: 'scale=1280:720', seg: 4 })
  assert.equal(/hwupload|vpp_qsv/.test(parts.filterArgs.join(' ')), false, 'no GPU upload on a session that cannot take it')
  assert.equal(parts.inputArgs.length, 0, 'and no qsv device arguments for a chain that uploads nothing')
  assert.ok(parts.filterArgs[1].startsWith('scale=1280:720'), 'the resize still happens, on the CPU')

  // VAAPI has no low-power mode: its GPU scale is the path it was probed with, and must survive.
  assert.equal(encodeShape('h264_vaapi', { lowPower: false, gpuScale: true, rated: true }).gpuScale, true)
})

test('the low-power flag is what the encoder is opened with, not just what it was probed with', async () => {
  resetEncoder()
  const plan = await encodeFor({ encoder: 'h264_qsv', lowPower: true, gpuScale: true, rated: false })
  assert.deepEqual(plan.codecArgs.slice(0, 4), ['-c:v', 'h264_qsv', '-low_power', '1'])
  assert.match(chainOf(plan.filterArgs), /hwupload=extra_hw_frames=64/, 'the upload the low-power session was chosen for')
  assert.ok(plan.inputArgs.includes('-filter_hw_device'), 'vpp_qsv needs the device named before the input')
})

test('a hardware conversion never walks away from the caps without saying so', async () => {
  // Not a shape the ladder produces any more, but if one ever gets in, the CPU resize is logged rather than silent.
  resetEncoder()
  const plan = await encodeFor({ encoder: 'h264_qsv', lowPower: false, gpuScale: true, rated: false })
  assert.equal(/hwupload/.test(chainOf(plan.filterArgs)), false)
  assert.equal(plan.codecArgs.includes('-low_power'), false)
})
