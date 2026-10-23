import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A television's poster tiles are cut down to 342px once and kept (src/art.ts getPosterThumb). The poster is seeded
// straight into the art cache, so nothing is fetched.
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'flix-thumb-'))
const { getPosterThumb, getArt } = await import('../src/art.ts')
const { db, now } = await import('../src/db.ts')

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

function seed(seriesId: number, w: number, h: number) {
  const url = `https://img.example/${seriesId}.jpg`
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32)
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}`, '-frames:v', '1', '-y', join(process.env.DATA_DIR!, 'art', `${hash}.jpg`)])
  db.prepare(`INSERT INTO releases (torrent_id, series_id, series, series_poster, group_name, info_hash, fetched_at) VALUES (?, ?, 'Show', ?, 'g', 'h', ?)`).run(seriesId, seriesId, url, now())
  db.prepare('INSERT INTO art_cache VALUES (?,?,?)').run(hash, 'image/jpeg', now())
}
const width = (path: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', path]).toString().trim())

test('a big poster is cut to 342px once, and the cut is reused', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  seed(1, 780, 1170)
  const a = await getPosterThumb(1, 342)
  assert.ok(a); assert.equal(a.type, 'image/jpeg'); assert.match(a.path, /\.w342\.jpg$/)
  assert.equal(width(a.path), 342)
  const b = await getPosterThumb(1, 342)
  assert.equal(b?.path, a.path)
  assert.ok(readFileSync(a.path).length < readFileSync((await getArt(1, 'poster'))!.path).length)
})

test('a poster already small enough is sent as it is', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  seed(2, 300, 450)
  const a = await getPosterThumb(2, 342)
  assert.equal(a?.path, (await getArt(2, 'poster'))!.path)
})
