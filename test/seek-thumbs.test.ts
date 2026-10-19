// The pictures above the seek bar come out of one tiled sheet per finished episode, cropped by arithmetic. That
// arithmetic is pure and is what these pin: which tile holds a second, where it sits in the sheet, and what happens
// past the end. The rest covers the rules around the sheet itself -- served only when both the picture and its metadata
// are on disk, never half-written, and never offered when ffmpeg cannot cut it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-seek-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'

// Sheets are cut by ffmpeg, which is not on every machine this suite runs on, so a stub goes on PATH ahead of the real
// one and the test decides what a cut does: a JPEG on stdout, or a failure when FLIX_STUB_FFMPEG is set to fail.
const STUB_SIZE = 4000
const bin = join(tmp, 'bin')
mkdirSync(bin, { recursive: true })
const stub = join(bin, 'ffmpeg')
writeFileSync(stub, `#!/usr/bin/env node
if (process.env.FLIX_STUB_FFMPEG === 'fail') { process.stderr.write('stub: nothing to cut here\\n'); process.exit(1) }
process.stdout.write(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(${STUB_SIZE})]))
`)
chmodSync(stub, 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`

const { buildSprite, spriteMeta, spritePath, spritePlan, spriteTile, setSpriteWriteHook, TILE_H, TILE_W } = await import('../src/sprites.ts')
const { isPlainMp4, offlineReadyPath } = await import('../src/offline.ts')
type Probe = import('../src/transcode.ts').Probe

const source = join(tmp, 'episode.mkv')
writeFileSync(source, 'not really a video, but ffmpeg is stubbed')

// ---- the arithmetic the player repeats with the metadata it is sent ------------------------------------------------

test('a hundred tiles across the episode, and never closer together than two seconds', () => {
  assert.deepEqual(spritePlan(3600), { interval: 36, count: 100 }) // a 60 minute episode: one every 36 s
  assert.deepEqual(spritePlan(2700), { interval: 27, count: 100 })
  assert.deepEqual(spritePlan(60), { interval: 2, count: 30 }) // a short one is capped at the floor, not spread thinner
  assert.deepEqual(spritePlan(0), { interval: 2, count: 1 })
})

test('a time lands on the tile that holds it, and a time past the end lands on the last tile', () => {
  const m = { cols: 10, rows: 10, interval: 36, count: 100, tileW: TILE_W, tileH: TILE_H }
  assert.deepEqual(spriteTile(0, m), { index: 0, col: 0, row: 0, x: 0, y: 0 })
  assert.deepEqual(spriteTile(35.9, m), { index: 0, col: 0, row: 0, x: 0, y: 0 })
  assert.deepEqual(spriteTile(36, m), { index: 1, col: 1, row: 0, x: TILE_W, y: 0 })
  // The eleventh tile starts the second row: columns wrap, rows do not.
  assert.deepEqual(spriteTile(360, m), { index: 10, col: 0, row: 1, x: 0, y: TILE_H })
  assert.deepEqual(spriteTile(3600, m), { index: 99, col: 9, row: 9, x: 9 * TILE_W, y: 9 * TILE_H })
  // Scrubbing past the end, or a player that reports a negative time, must never index a tile that is not there.
  assert.equal(spriteTile(99999, m).index, 99)
  assert.equal(spriteTile(-4, m).index, 0)
})

test('a short episode has fewer tiles than the grid, and the count is what stops it, not the grid', () => {
  const m = { cols: 10, rows: 10, interval: 2, count: 30 }
  assert.equal(spriteTile(58, m).index, 29)
  assert.equal(spriteTile(200, m).index, 29) // index 30..99 would be blank tiles in the sheet
  assert.deepEqual(spriteTile(20, m), { index: 10, col: 0, row: 1, x: 0, y: TILE_H })
})

// ---- the sheet on disk ------------------------------------------------------------------------------------------

test('a sheet is made in one pass and its metadata describes it', async () => {
  const m = await buildSprite(10, 11, source, 600)
  assert.ok(m, 'a sheet was written')
  assert.deepEqual({ ...m, at: 0 }, { tileW: TILE_W, tileH: TILE_H, cols: 10, rows: 10, interval: 6, duration: 600, count: 100, at: 0 })
  assert.ok(existsSync(spritePath(10, 11)))
  assert.deepEqual(spriteMeta(10, 11), m)
})

test('nothing is served when ffmpeg cannot cut the sheet, and nothing is left behind', async () => {
  process.env.FLIX_STUB_FFMPEG = 'fail'
  try {
    assert.equal(await buildSprite(4, 5, source, 600), null)
    assert.equal(spriteMeta(4, 5), null)
  } finally { delete process.env.FLIX_STUB_FFMPEG }
})

test('a sheet is not offered before it is complete: the rename is the moment it becomes real', async () => {
  let seen: { tmpExists: boolean; destExists: boolean } | null = null
  setSpriteWriteHook((tmpFile, dest) => { seen = { tmpExists: existsSync(tmpFile), destExists: existsSync(dest) } })
  try {
    assert.ok(await buildSprite(20, 21, source, 600))
  } finally { setSpriteWriteHook(null) }
  assert.deepEqual(seen, { tmpExists: true, destExists: false }, 'the file beside it is the one being written')
  assert.deepEqual(readdirSync(join(process.env.DATA_DIR!, 'sprites', '20-21')).sort(), ['sprite.jpg', 'sprite.json'])
})

test('a write that dies before the rename leaves nothing to be served, and is cut again next time', async () => {
  setSpriteWriteHook(() => { throw new Error('the disk filled up') })
  try {
    assert.equal(await buildSprite(30, 31, source, 600), null, 'a sheet that did not land is not reported as made')
  } finally { setSpriteWriteHook(null) }
  assert.equal(existsSync(spritePath(30, 31)), false, 'a truncated sheet must never be served')
  assert.equal(spriteMeta(30, 31), null)
  assert.deepEqual(readdirSync(join(process.env.DATA_DIR!, 'sprites', '30-31')), [], 'and no half-written file is left')
  assert.ok(await buildSprite(30, 31, source, 600))
  assert.ok(spriteMeta(30, 31))
})

// ---- seeking a finished download ---------------------------------------------------------------------------------

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
