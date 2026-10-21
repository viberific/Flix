// The re-encoded picture is served as a complete playlist, and ffmpeg starts wherever the viewer is. Needs ffmpeg; skipped without it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

const dir = mkdtempSync(join(tmpdir(), 'flix-vod-'))
const src = join(dir, 'src.mkv')
if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=duration=40', '-c:v', 'mpeg4', '-c:a', 'ac3', '-y', src])
// The commonest file there is: H.264 that plays as it is, with E-AC-3/AC-3 sound no browser decodes. Keyframes at odd
// spacings (every 2.5 s, plus a forced one at 13 s), because a copied picture can only be cut where its keyframes are.
const copySrc = join(dir, 'copy.mkv')
if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=duration=40',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-force_key_frames', '13', '-c:a', 'ac3', '-y', copySrc])

// Stands in for Flix's own /raw endpoint, which ffprobe and ffmpeg read the torrent file through.
const raw = createServer((req, res) => {
  const file = /\/stream\/9\//.test(req.url ?? '') ? copySrc : src
  const size = statSync(file).size
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  const start = m ? Number(m[1] || 0) : 0, end = m && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
  res.writeHead(m ? 206 : 200, { 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'video/x-matroska', ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
  createReadStream(file, { start, end }).pipe(res)
})
await new Promise<void>((ok) => raw.listen(0, '127.0.0.1', ok))
process.env.PORT = String((raw.address() as any).port)
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = dir
const tc = await import('../src/transcode.ts')
// Everything here is about the encode path, which copy-only mode (Flix's default) refuses on purpose: a picture that
// has to be converted is not played until someone allows it. These tests drive the encoder itself, so allow it.
// Imported after PORT is set above, because config.ts reads it once on load.
const { config } = await import('../src/config.ts')
config.transcode.mode = 'auto'

after(() => { raw.close(); tc.stopJobsFor(7); tc.stopJobsFor(9) })

const start = (f: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', f]).toString().trim().split(/\s+/)[0]

test('a re-encoded picture gets a whole playlist at once and any piece on request', { skip: !hasFfmpeg }, async () => {
  const p = await tc.probe(7, 0)
  assert.equal(p.copyVideo, false)
  await tc.ensureHls(7, 0, p)
  const list = tc.vodPlaylist(7, 0)!
  assert.match(list, /PLAYLIST-TYPE:VOD/)
  assert.match(list, /ENDLIST/)
  assert.equal((list.match(/#EXTINF/g) ?? []).length, Math.ceil(p.duration! / tc.SEG))
  const ac = new AbortController()
  // Jump straight into the middle: nothing before it is encoded.
  const mid = await tc.vodSegment(7, 0, 'seg00005.ts', ac.signal)
  assert.ok(mid)
  assert.ok(Math.abs(Number(start(mid!)) - 5 * tc.SEG) < 0.3, `piece 5 starts at ${start(mid!)}`)
  // The next one comes from the same run, and one far back starts a second run.
  const next = await tc.vodSegment(7, 0, 'seg00006.ts', ac.signal)
  assert.ok(Math.abs(Number(start(next!)) - 6 * tc.SEG) < 0.3)
  const back = await tc.vodSegment(7, 0, 'seg00001.ts', ac.signal)
  assert.ok(Math.abs(Number(start(back!)) - tc.SEG) < 0.3)
  assert.equal(await tc.vodSegment(7, 0, 'seg00099.ts', ac.signal), null)
})

test('a picture that can be passed through keeps the plain on-disk playlist', { skip: !hasFfmpeg }, async () => {
  assert.equal(tc.vodPlaylist(8, 0), null)
  assert.equal(await tc.vodSegment(8, 0, 'seg00000.ts', new AbortController().signal), undefined)
})

const streams = (f: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,start_time', '-of', 'csv=p=0', f]).toString().trim().split('\n').map((l) => { const [codec, type, start] = l.split(','); return [type, codec, start] })

test('a copied picture of a whole file is cut on its own keyframes, so any piece can be made first', { skip: !hasFfmpeg }, async () => {
  const p = await tc.probe(9, 0, { complete: true })
  assert.equal(p.videoCodec, 'h264')
  assert.equal(tc.copyIntoTs(p), true)
  await tc.ensureHls(9, 0, p, 0, false, { complete: true, source: copySrc })
  const list = tc.vodPlaylist(9, 0)!
  assert.ok(list, 'a whole playlist straight away, not one that grows as a remux runs')
  assert.match(list, /PLAYLIST-TYPE:VOD/)
  assert.match(list, /ENDLIST/)
  const lens = [...list.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]))
  const starts = lens.map((_, i) => lens.slice(0, i).reduce((a, b) => a + b, 0))
  assert.ok(Math.abs(lens.reduce((a, b) => a + b, 0) - p.duration!) < 0.5, 'the pieces add up to the episode')
  assert.ok(lens.every((l) => l >= tc.SEG - 0.01 || l === lens[lens.length - 1]), 'no piece is shorter than SEG but the last')
  const kf = (await tc.keyframes(9, 0, copySrc))!
  assert.ok(starts.every((t) => kf.some((k) => Math.abs(k - kf[0] - t) < 0.05)), 'every piece begins on one of the file\'s keyframes')
  const ac = new AbortController()
  // A seek into the middle first: nothing before it has been made.
  const n = starts.findIndex((t) => t > 20)
  const mid = await tc.vodSegment(9, 0, `seg${String(n).padStart(5, '0')}.ts`, ac.signal)
  assert.ok(mid)
  const st = streams(mid!)
  assert.ok(st.some(([type, codec]) => type === 'video' && codec === 'h264'), 'the picture is copied')
  assert.ok(st.some(([type, codec]) => type === 'audio' && codec === 'aac'), 'the sound is AAC')
  const v = st.find(([type]) => type === 'video')!
  assert.ok(Math.abs(Number(v[2]) - starts[n]) < 0.06, `piece ${n} starts at ${v[2]}, the playlist says ${starts[n]}`)
  // Backwards, then the very first piece: each lands exactly where the playlist says it does.
  for (const k of [1, 0]) {
    const seg = await tc.vodSegment(9, 0, `seg${String(k).padStart(5, '0')}.ts`, ac.signal)
    const vs = streams(seg!).find(([type]) => type === 'video')!
    assert.ok(Math.abs(Number(vs[2]) - starts[k]) < 0.06, `piece ${k} starts at ${vs[2]}, the playlist says ${starts[k]}`)
  }
})

test('keyframes are read once and kept on disk', { skip: !hasFfmpeg }, async () => {
  const k = await tc.keyframes(9, 0, copySrc)
  assert.ok(k && k.length >= 16)
  assert.ok(k!.some((t) => Math.abs(t - 13) < 0.05))
  const b = tc.copyBounds(k!, 40)!
  assert.equal(b[0], k![0])
  assert.equal(b[b.length - 1], 40)
  for (let i = 1; i < b.length - 1; i++) assert.ok(b[i] - b[i - 1] >= tc.SEG, 'every piece is at least SEG long')
})
