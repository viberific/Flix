// A show that has finished downloading should seek anywhere in the episode, and the seek bar should show the frame it
// is over. These cover the pieces that make it work without a live torrent: the guard that refuses a frame from bytes
// that have not arrived, and the cache that answers a scrub over ground already covered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-seek-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'

// Frames are cut by ffmpeg, which is not on every machine this suite runs on: a test that "nothing is offered when
// ffmpeg cannot cut the frame" must not be a test of whether ffmpeg happens to be installed. So a stub goes on PATH
// ahead of the real one and the test decides what a cut does -- a JPEG on stdout, or a failure when FLIX_STUB_FFMPEG
// is set to fail. Nothing here needs a real video file.
const STUB_SIZE = 400
const bin = join(tmp, 'bin')
mkdirSync(bin, { recursive: true })
const stub = join(bin, 'ffmpeg')
writeFileSync(stub, `#!/usr/bin/env node
if (process.env.FLIX_STUB_FFMPEG === 'fail') { process.stderr.write('stub: nothing to cut here\\n'); process.exit(1) }
process.stdout.write(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(${STUB_SIZE})]))
`)
chmodSync(stub, 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`

const { frame } = await import('../src/thumbs.ts')
const { isPlainMp4, offlineReadyPath } = await import('../src/offline.ts')
type Probe = import('../src/transcode.ts').Probe

test('a frame is refused past the point the download has reached, instead of hanging on it', async () => {
  // 25% of a 40 minute episode is about 600 s: a cut at 1800 s would wait for bytes that are not there.
  assert.equal(await frame(1, 1, 1800, '/nope.mkv', 2400, 0.25), null)
})

test('a frame already cut is answered from disk, so scrubbing back and forth costs nothing', async () => {
  const dir = join(tmp, 'data', 'thumbs', '2-3')
  mkdirSync(dir, { recursive: true })
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400)])
  writeFileSync(join(dir, '42.jpg'), jpg)
  const got = await frame(2, 3, 42, '/nope.mkv', 600, 1)
  assert.ok(got && got.equals(jpg))
})

test('answering from the cache counts as a look, so the week-old sweeper leaves that folder alone', async () => {
  // The sweeper goes by the folder's mtime, which only moves when a frame is written: a show watched every night must
  // not look untouched for a week and lose its frames.
  const dir = join(tmp, 'data', 'thumbs', '2-3')
  const old = new Date(Date.now() - 30 * 86400_000)
  utimesSync(dir, old, old)
  await frame(2, 3, 42, '/nope.mkv', 600, 1)
  assert.ok(Date.now() - statSync(dir).mtimeMs < 60_000)
})

// The cache hit path trusts whatever is on disk, so a frame must never appear under its finished name before it is whole:
// whoever looks at the folder mid-write must find that name absent, never a short file. The hook runs between the write
// and the rename, so a plain writeFileSync to the finished name fails here -- the name exists, and it is there early.
// (Checked because a test that only looked afterwards passed even when the write was no longer atomic.)
test('a cut is written beside its name and renamed into place, never half-written under it', async () => {
  const { setCacheWriteHook } = await import('../src/thumbs.ts')
  const dir = join(tmp, 'data', 'thumbs', '6-7'), done = join(dir, '60.jpg')
  const seen: { dest: string; destThere: boolean; tmpSize: number }[] = []
  setCacheWriteHook((tmpFile, dest) => {
    seen.push({ dest, destThere: existsSync(done), tmpSize: existsSync(tmpFile) ? statSync(tmpFile).size : -1 })
  })
  let got: Buffer | null = null
  try {
    got = await frame(6, 7, 60, '/nope.mkv', 600, 1)
    assert.ok(got && got.length > 200)
    assert.equal(got[0], 0xff) // the JPEG the stub wrote
  } finally { setCacheWriteHook(null) }
  // The finished name is reached in exactly one step, and it was not there while the write was still in flight.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].dest, done)
  assert.equal(seen[0].destThere, false, '60.jpg must not exist before it is complete')
  assert.equal(seen[0].tmpSize, STUB_SIZE + 3)
  assert.deepEqual(readdirSync(dir), ['60.jpg'])
  assert.ok(readFileSync(done).equals(got!))
})

// A write that dies before the rename (a full disk, a crash) must leave nothing a later view would be served: no truncated
// JPEG under the frame's own name, and no stray temp file beside it. The picture is still returned to the viewer, and the
// next ask cuts it again rather than trusting a name that is not there.
test('a cut that dies before the rename leaves nothing to be served, and is cut again next time', async () => {
  const { setCacheWriteHook } = await import('../src/thumbs.ts')
  const dir = join(tmp, 'data', 'thumbs', '10-11'), dest = join(dir, '80.jpg')
  setCacheWriteHook(() => { throw new Error('the disk filled up') })
  try {
    const got = await frame(10, 11, 80, '/nope.mkv', 600, 1)
    assert.ok(got && got.length > 200, 'the frame asked for is still answered')
  } finally { setCacheWriteHook(null) }
  assert.equal(existsSync(dest), false, 'a truncated JPEG must never be served from the cache')
  assert.deepEqual(readdirSync(dir), [], 'and no half-written file is left behind')
  const again = await frame(10, 11, 80, '/nope.mkv', 600, 1)
  assert.ok(again && again.length > 200)
  assert.deepEqual(readdirSync(dir), ['80.jpg'])
})

test('nothing is offered when ffmpeg cannot cut the frame: no picture, not a broken one', async () => {
  process.env.FLIX_STUB_FFMPEG = 'fail'
  try {
    assert.equal(await frame(4, 5, 60, '/nope.mkv', 600, 1), null)
  } finally {
    delete process.env.FLIX_STUB_FFMPEG
  }
})

test('a single-file copy is only offered once it is actually on disk', () => {
  assert.equal(offlineReadyPath(9, 9), null)
})

// The case the person hit: a Matroska file holding H.264 plays as a growing HLS playlist, which cannot be seeked ahead
// of. It is not `direct` (so no byte ranges), but its picture can be copied, so one MP4 is made from it and seeked in.
test('an MKV holding H.264 needs the remux; a plain MP4 does not', () => {
  const base: Probe = { duration: 2400, copyVideo: true, videoCodec: 'h264', audioCodec: 'aac', height: 1080, container: 'matroska,webm', direct: false, hdr: false, audio: [], subs: [], chapters: [] }
  assert.equal(isPlainMp4(base), false)
  assert.equal(isPlainMp4({ ...base, container: 'mov,mp4,m4a,3gp,3g2,mj2', direct: true }), true)
  // A file whose picture must be re-encoded is never direct, so it is never sent as it is without a remux either.
  assert.equal(isPlainMp4({ ...base, copyVideo: false, videoCodec: 'hevc', direct: false }), false)
})
