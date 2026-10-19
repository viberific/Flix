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

// Stands in for Flix's own /raw endpoint, which ffprobe and ffmpeg read the torrent file through.
const raw = createServer((req, res) => {
  const size = statSync(src).size
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  const start = m ? Number(m[1] || 0) : 0, end = m && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
  res.writeHead(m ? 206 : 200, { 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'video/x-matroska', ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
  createReadStream(src, { start, end }).pipe(res)
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

after(() => { raw.close(); tc.stopJobsFor(7) })

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
