// A never-played episode whose sound has to be converted (AC-3 5.1, the commonest WEB-DL there is) must have the drive to
// itself for its first pieces: the whole-file reads that are not the picture wait (warming), the player is told the box is
// still cutting (hlsBuild.running), and the subtitle can be read out ahead of the play at low priority. Needs ffmpeg.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

const dir = mkdtempSync(join(tmpdir(), 'flix-cold-'))
const src = join(dir, 'ep.mkv')
const srt = join(dir, 'ep.srt')
writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:20,000 --> 00:00:22,000\nStill here.\n')
if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=duration=40',
  '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
  '-c:a', 'ac3', '-ac', '6', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-y', src])

process.env.PORT = '1' // nothing is read through /raw here: every file is whole and on the disk
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = dir
const tc = await import('../src/transcode.ts')
after(() => { tc.stopJobsFor(21); tc.stopJobsFor(22) })

const whole = { complete: true, source: src, savePath: dir }

test('a cold play is warming until its first pieces are cut, and the box says it is working meanwhile', { skip: !hasFfmpeg }, async () => {
  const p = await tc.probe(21, 0, whole)
  assert.equal(p.audioCodec, 'ac3')
  assert.equal(p.direct, false, 'AC-3 sound is not played as it is')
  await tc.ensureHls(21, 0, p, 0, false, { complete: true, source: src })
  assert.equal(tc.warming(21, 0), false, 'a job nobody has opened is not a play')
  tc.notePlayOpen(21, 0)
  assert.equal(tc.warming(21, 0), true, 'opened, and nothing asked for yet')
  assert.equal(tc.warming(21, 1), false, 'only this file')

  const ac = new AbortController()
  const first = await tc.vodSegment(21, 0, 'seg00000.ts', ac.signal)
  assert.ok(first && existsSync(first))
  const b = tc.hlsBuild(21, 0)!
  assert.ok(b && b.of > 1)
  // The run carries on past the piece asked for, so the box reports it is cutting while the opening is not all there.
  if (tc.warming(21, 0)) assert.equal(b.running, true, 'still warming, so an ffmpeg is on it')
  for (let i = 0; i < 400 && tc.warming(21, 0); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(tc.warming(21, 0), false, 'the first minute (here the whole short episode) is cut: the play is under way')
  assert.equal(tc.hlsBuild(21, 0)!.running, false, 'and nothing is cutting any more')

  // A replay: the pieces are already there, so the moment the first one is asked for the gate is open.
  tc.notePlayOpen(21, 0)
  assert.equal(tc.warming(21, 0), true)
  await tc.vodSegment(21, 0, 'seg00000.ts', ac.signal)
  assert.equal(tc.warming(21, 0), false, 'a warm replay holds nothing back')
})

test('the gate lapses on its own, whatever the pieces say', { skip: !hasFfmpeg }, async () => {
  await tc.ensureHls(22, 0, await tc.probe(22, 0, whole), 0, false, { complete: true, source: src })
  tc.notePlayOpen(22, 0)
  assert.equal(tc.warming(22, 0), true)
  assert.equal(tc.warming(22, 0, Date.now() + tc.WARM_MAX_MS + 1000), false)
  // A TV's playlist fetch does not restart a gate a browser's /info has just started.
  tc.notePlayOpen(22, 0, 0, false, false, 0, true)
  assert.equal(tc.warming(22, 0), true)
})

test('keyframes read at low priority are the same list', { skip: !hasFfmpeg }, async () => {
  const a = await tc.keyframes(23, 0, src, undefined, true)
  assert.ok(a && a.length >= 2)
})

test('the subtitle read out ahead of the play is kept on disk for the play to find', { skip: !hasFfmpeg }, async () => {
  const p = await tc.probe(24, 0, whole)
  const sub = tc.bestEnglishSub(p.subs)!
  assert.ok(sub, 'the English track is found')
  assert.equal(existsSync(tc.subtitleCachePath(24, 0, sub.n)), false)
  const { vtt, complete } = await tc.subtitleVtt(24, 0, sub.n, 1, p.duration ?? 0, src, true)
  assert.equal(complete, true)
  assert.match(vtt, /Hello there/)
  assert.equal(existsSync(tc.subtitleCachePath(24, 0, sub.n)), true)
})
