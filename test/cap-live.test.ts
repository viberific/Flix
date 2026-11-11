// The cap against real jobs, not just the accounting: one play asks for a copied picture and then steps down to 720 the way
// the player does on the box, and the box must end up running ONE encoder. Skipped without ffmpeg, like vod.test.ts.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

const dir = mkdtempSync(join(tmpdir(), 'flix-cap-'))
// The episode on the box: H.264 at 960p, sound the browser cannot decode (AC-3), picture copyable.
const src = join(dir, 'ep.mkv')
if (hasFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=24:size=1706x960:rate=24',
  '-f', 'lavfi', '-i', 'sine=duration=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
  '-c:a', 'ac3', '-y', src])

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
process.env.TRANSCODE_MAX_JOBS = '1'
const tc = await import('../src/transcode.ts')

after(() => { raw.close(); tc.stopJobsFor(42) })

/** The jobs holding an encoder right now, out of what the box will say on /api/diag. */
const encoders = () => tc.hlsSummary().filter((j: any) => /:x(:\w+)?$/.test(j.job))
/** The job map is process-wide, so every test starts from an empty box. */
const fresh = () => tc.stopJobsFor(42)

test('one play, stepped down from the copy to 720: the box holds one encoder, not two', { skip: !hasFfmpeg }, async () => {
  fresh()
  const p = await tc.probe(42, 0)
  // What /info does first: the copy the picture plays as it is, sound converted.
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src })
  assert.equal(encoders().length, 0, 'a copied picture is not an encoder')

  // Then the player steps down to 720, exactly as watchQuality() does: the copied job is left on its grace, and /info asks
  // for the smaller cut. Before the fix this started a SECOND encoder beside the first (cap 1, running 3 on the box).
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 720 })
  assert.equal(encoders().length, 1, `one conversion for one play, got ${JSON.stringify(tc.hlsSummary())}`)
})

test('a step down to 720 and then 480 leaves one encoder behind, not a stair of them', { skip: !hasFfmpeg }, async () => {
  fresh()
  const p = await tc.probe(42, 0)
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 720 })
  // What the player does when it swaps: it names the playlist it just left, and that rendition goes at once (see the
  // /api/stream/:t/:f/stop route in server.ts).
  tc.dropHls(42, 0, 0, false, true, 720)
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 480 })
  assert.equal(encoders().length, 1, `cap 1 was exceeded: ${JSON.stringify(tc.hlsSummary())}`)
})

test('a single conversion on an idle box is no longer logged as "over the job cap"', { skip: !hasFfmpeg }, async () => {
  fresh()
  const { diagTail } = await import('../src/diag.ts')
  const p = await tc.probe(42, 0)
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 720 })
  // The old loop counted the job being started, so with cap 1 it was already over the cap before anything ran: fifteen of
  // these in a minute at 00:16:24Z, none of them about a real second job.
  const over = diagTail(500).filter((e: any) => /job cap/.test(e.msg))
  assert.deepEqual(over.map((e: any) => e.msg), [], 'cap 1 with nothing else running is not over the cap')
})

test('a swap whose /stop never arrived ends on one encoder a few seconds later', { skip: !hasFfmpeg }, async () => {
  fresh()
  const p = await tc.probe(42, 0)
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 720 })
  // The player swaps and the request that says so is lost. The new size starts while the old one is still inside the grace
  // that protects an in-flight read, so the box comes back for it once that grace is over rather than running both.
  await tc.ensureHls(42, 0, p, 0, false, { complete: true, source: src, encode: true, maxHeight: 480 })
  await new Promise((r) => setTimeout(r, 6_000))
  assert.equal(encoders().length, 1, `cap 1 was exceeded: ${JSON.stringify(tc.hlsSummary())}`)
})
