// Three defects that starved playback on the box on 2026-11-12, each tested on what it did wrong rather than on ffmpeg:
// the subtitle read that went through Flix's own stream on every play, the background copy that was never stopped when a
// play began, and the folder of the file being watched that was emptied. None of these needs ffmpeg.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'flix-playback-'))
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = dir

const tc = await import('../src/transcode.ts')
const { config } = await import('../src/config.ts')

const hlsDir = (name: string) => { const d = join(config.dataDir, 'hls', name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'seg00000.ts'), 'x'.repeat(16)); return d }

test('a play takes the box: background work does not start while it holds, and the clock runs out on its own', () => {
  const now = Date.now()
  assert.equal(tc.playingNow(now), false)
  assert.equal(tc.backgroundRunAllowed({ low: true }, now), true)
  assert.equal(tc.beginPlayback(8001, 1), 0) // nothing was running: it only takes the lock
  assert.equal(tc.playingNow(), true)
  assert.equal(tc.backgroundRunAllowed({ low: true }), false, 'a background copy may not start while somebody is watching')
  assert.equal(tc.backgroundRunAllowed({ low: true, played: true }), true) // the file on screen is never refused
  assert.equal(tc.backgroundRunAllowed({ low: true, head: true }), true) // the next episode's opening is bounded, and always allowed
  assert.equal(tc.backgroundRunAllowed({ low: true }, now + 130_000), true) // two minutes with no player request and it lapses
  assert.equal(tc.playingNow(now + 130_000), false)
})

test('a subtitle is read from the file on disk once the download is whole, never back through the stream endpoint', () => {
  const source = join(dir, 'episode.mkv')
  writeFileSync(source, 'not really a matroska file')
  assert.equal(tc.subtitleInput(1903475, 2, true, source), source)
  // A file still arriving has no whole file to read, and nothing else has changed about it.
  assert.match(tc.subtitleInput(1903475, 2, false, source), /\/api\/stream\/1903475\/2\/raw/)
  // A whole file whose path is not there (a torrent that moved) still falls back to the endpoint instead of failing.
  assert.match(tc.subtitleInput(1903475, 2, true, join(dir, 'gone.mkv')), /\/api\/stream\/1903475\/2\/raw/)
})

test('a track read out already is served from the cache and starts no ffmpeg at all', async () => {
  const cached = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nthis line proves the cache answered\n'
  mkdirSync(join(config.dataDir, 'subs-cache'), { recursive: true })
  writeFileSync(tc.subtitleCachePath(7001, 3, 1), cached)
  const r = await tc.subtitleVtt(7001, 3, 1, 1, 1400)
  assert.equal(r.complete, true)
  assert.equal(r.vtt, cached)
})

test('the cache guard never takes the folder of a file somebody watched', () => {
  const watched = hlsDir('9001-2')
  const stranger = hlsDir('9002-1')
  tc.notePlaying(9001, 2)
  // A cap of nothing at all: everything removable would go, and the watched folder must still be there.
  const r = tc.evictHls(0)
  assert.ok(r.removed.includes('9002-1'), 'an unwatched folder is still evicted when the cap needs the room')
  assert.ok(!r.removed.includes('9001-2'), 'the folder of the file that was on screen was evicted')
  assert.ok(existsSync(watched) && !existsSync(stranger))
  assert.ok(tc.protectedDirs().includes('9001-2'))
})

test('pieces already cut are adopted instead of thrown away, and a different plan still wipes the folder', () => {
  const folder = join(config.dataDir, 'hls', '9100-1')
  mkdirSync(folder, { recursive: true })
  const plan = [0, 4, 8, 12, 16]
  writeFileSync(tc.planPath(folder), JSON.stringify(plan))
  writeFileSync(join(folder, 'list0.csv'), 'seg00000.ts,0.000000,4.000000\nseg00001.ts,4.000000,8.000000\n')
  for (const n of ['00000', '00001', '00002']) writeFileSync(join(folder, `seg${n}.ts`), 'x')
  const kept = tc.adoptCopy(folder, plan)
  assert.deepEqual([...kept!].sort((a, b) => a - b), [0, 1]) // only what a segment list says is whole
  assert.equal(tc.adoptCopy(folder, [0, 4, 8, 12, 20]), null)
  assert.equal(tc.adoptCopy(join(config.dataDir, 'hls', 'nobody'), plan), null)
})
