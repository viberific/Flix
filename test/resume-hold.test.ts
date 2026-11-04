// Two things the player and the copy cache got wrong on 2026-11-04, pinned here.
//
// 1. A recovery must not restart the episode. The element's own clock reads 0 for a moment whenever a source is built
//    again, and the code that rebuilt it asked the clock, got 0, and opened the episode at the beginning. The decision is
//    lifted out of public/app.js between its two markers and run for real: it must never answer with a position behind
//    where the play already was.
// 2. A copy made ahead of time costs well over 700 MB an episode, so the cache has a cap and the oldest copies go first.
//    The folders here are real directories; the eviction is the app's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- 1. the position a rebuilt source opens at -------------------------------------------------------

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const block = /\/\* resume-hold \*\/([\s\S]*?)\/\* end-resume-hold \*\//.exec(app)
assert.ok(block, 'the resume-hold block is still marked in public/app.js')
const resumePoint = new Function(`${block![1]}; return resumePoint`)()

test('a swap that takes the clock to zero comes back where the viewer was, not at the start', () => {
  // Exactly the measured case: 28 seconds played, the element re-initialised, its clock at 0, nothing saved on the server
  // yet (it writes every ten seconds, and this was inside the first thirty).
  assert.equal(resumePoint({ clock: 0, held: 28, saved: 0, asked: 0 }), 28)
})

test('never behind where this play has been, whatever the clock says', () => {
  for (const clock of [0, 0.4, 2, 30, 31]) {
    for (const held of [0, 6, 300]) {
      for (const saved of [0, 12, 600]) {
        const at = resumePoint({ clock, held, saved, asked: 0 })
        if (held > 1) assert.ok(at >= held, `clock ${clock} held ${held} saved ${saved} answered ${at}`)
      }
    }
  }
})

test('the live clock wins when it is ahead, so a rebuild does not throw playback backwards', () => {
  assert.equal(resumePoint({ clock: 300, held: 299, saved: 120, asked: 0 }), 300)
})

test('the place the server holds outranks a caller that says 0:00', () => {
  // A retry with nothing played yet: the resume point must survive, or reopening the player starts the episode over.
  assert.equal(resumePoint({ clock: 0, held: 0, saved: 840, asked: 0 }), 840)
  assert.equal(resumePoint({ clock: 0, held: 0, saved: 0, asked: 840 }), 840)
})

test('nothing worth resuming is 0, so a fresh episode opens at the start', () => {
  assert.equal(resumePoint({ clock: 0, held: 0, saved: 0, asked: 0 }), 0)
  assert.equal(resumePoint({ clock: 0.2, held: 1, saved: 3, asked: 2 }), 0) // the first second of a stream is not a place
})

// ---- 2. the copy cache keeps itself under its cap ----------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'flix-cache-'))
process.env.DATA_DIR = tmp
process.env.DB_PATH = ':memory:'
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'
const { evictHls, hlsCacheBytes } = await import('../src/transcode.ts')

// Three finished copies, oldest first, 3 MB / 2 MB / 1 MB.
const MB = 1_000_000
const root = join(tmp, 'hls')
for (const [i, name] of ['100-0', '200-0', '300-0'].entries()) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'seg00000.ts'), Buffer.alloc((3 - i) * MB))
  const when = new Date(Date.now() - (3 - i) * 60_000)
  utimesSync(join(root, name), when, when)
}

test('the cache reports what each copy is holding', () => {
  const sizes = Object.fromEntries(hlsCacheBytes().map((x) => [x.dir, x.bytes]))
  assert.deepEqual(sizes, { '100-0': 3 * MB, '200-0': 2 * MB, '300-0': 1 * MB })
})

test('eviction takes the oldest copies until the cache is under the cap', () => {
  const r = evictHls(2 * MB)
  assert.deepEqual(r.removed, ['100-0', '200-0']) // 6 MB → 3 → 1, and it stops as soon as it is under
  assert.deepEqual(readdirSync(root), ['300-0'])
  assert.equal(r.left, 1 * MB)
})

test('a copy named keep is never evicted, and a cap above the total takes nothing', () => {
  mkdirSync(join(root, '400-0'), { recursive: true })
  writeFileSync(join(root, '400-0', 'seg00000.ts'), Buffer.alloc(5 * MB))
  assert.deepEqual(evictHls(10 * MB).removed, [])
  // The one named keep stays even when the cap says everything must go: it is the copy about to be played.
  const r = evictHls(0, ['300-0'])
  assert.deepEqual(r.removed, ['400-0'])
  assert.deepEqual(readdirSync(root), ['300-0'])
})
