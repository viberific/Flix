// The whole-file read (2026-11-04). After a restart, the first play of an episode that had already finished downloading
// had ffprobe walk the file from byte 0 to EOF through /raw -- 613.9 MB read from the disk, served over HTTP by this
// server and read back again, 43 s of it, on a file that was whole and could have been read off the disk directly. It
// happened after every restart because what a probe remembers lives in memory. A finished file is now read from the disk.
// Two things have to hold first, and both fail towards /raw: the download is whole, and the path really sits inside the
// folder the torrent was saved in.
//
// Everything here is pure: a temp file and no ffprobe, so it runs where the unit tests do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeSource } from '../src/transcode.ts'

const STREAM = /\/raw\?k=/
const savePath = mkdtempSync(join(tmpdir(), 'flix-save-'))
const show = join(savePath, 'Some Show S01')
mkdirSync(show, { recursive: true })
const file = join(show, 'Some.Show.S01E01.1080p.mkv')
writeFileSync(file, 'not really a video, and it does not need to be')

test('a finished file is handed to ffprobe as a path on the disk', () => {
  assert.equal(probeSource(7, 0, { complete: true, source: file, savePath: show }), file)
  // The torrent's own folder counts as inside too: packs save straight into the layout's save path.
  assert.equal(probeSource(7, 0, { complete: true, source: file, savePath }), file)
})

test('a file still arriving goes through /raw, where a read waits for the next piece', () => {
  assert.match(probeSource(7, 0, { complete: false, source: file, savePath: show }), STREAM)
})

test('a caller that knows nothing about completeness does not read the disk', () => {
  assert.match(probeSource(7, 0, {}), STREAM)
  assert.match(probeSource(7, 0, { source: file, savePath: show }), STREAM)
})

test('a path that escapes the save folder is refused, however complete the file is', () => {
  const escape = join(show, '..', '..', 'etc', 'passwd')
  assert.match(probeSource(7, 0, { complete: true, source: escape, savePath: show }), STREAM)
  // The save folder itself is a directory, not this episode.
  assert.match(probeSource(7, 0, { complete: true, source: show, savePath: show }), STREAM)
})

test('with no save folder declared there is nothing to prove the path is inside, so it is streamed', () => {
  assert.match(probeSource(7, 0, { complete: true, source: file }), STREAM)
})

test('a file that is not on the disk is streamed rather than opened', () => {
  assert.match(probeSource(7, 0, { complete: true, source: join(show, 'gone.mkv'), savePath: show }), STREAM)
})
