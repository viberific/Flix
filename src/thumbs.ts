import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

/**
 * One frame of an episode as a small JPEG: the picture that appears above the seek bar while someone scrubs.
 * Cut at the requested second and kept in Flix's own data folder, because dragging a thumb across a bar asks for the
 * same frames again and again (and a TV seeks back over ground it has already covered).
 */
const root = () => join(config.dataDir, 'thumbs')
const KEEP_MS = 7 * 24 * 3600_000
const MAX_SIDE = 320
const TIMEOUT_MS = 10_000
const CONCURRENCY = 2

const dirFor = (t: number, f: number) => join(root(), `${t}-${f}`)
const fileFor = (t: number, f: number, at: number) => join(dirFor(t, f), `${Math.max(1, Math.round(at))}.jpg`)

let running = 0
const pending = new Map<string, Promise<Buffer | null>>()
/** The newest second asked for, per download: a scrub queues a frame a second and the ones behind the finger are waste. */
const wanted = new Map<string, number>()
/** How long a job may wait for a permit before it is dropped: a preview 1.5 s late is worse than no preview. */
const QUEUE_WAIT_MS = 1500

/**
 * The frame at `at` seconds, or null when there is none to be had: the download has not reached that far, or ffmpeg
 * could not cut it. `progress` is the file's own 0..1, so a partly downloaded episode shows pictures only where it has
 * picture instead of hanging on the rest.
 */
export function frame(t: number, f: number, at: number, source: string, duration: number, progress: number): Promise<Buffer | null> {
  const sec = Math.max(0, Math.min(duration > 0 ? duration - 0.5 : at, at))
  if (progress < 1 && duration > 0 && sec > duration * progress * 0.9) return Promise.resolve(null)
  const cached = fileFor(t, f, sec)
  if (existsSync(cached)) {
    try {
      // The sweeper goes by the folder's mtime, which only moves when a frame is written: without this a show watched
      // every night would look untouched for a week and its frames would be thrown away.
      touch(dirFor(t, f))
      return Promise.resolve(readFileSync(cached))
    } catch { /* cut it again */ }
  }
  const want = `${t}:${f}`
  wanted.set(want, Math.round(sec))
  const key = `${want}:${Math.round(sec)}`
  const already = pending.get(key)
  if (already) return already
  const job = cut(source, sec, want)
    .then((buf) => {
      if (buf) {
        try {
          mkdirSync(dirFor(t, f), { recursive: true })
          // Written to one side and renamed into place: a crash mid-write would otherwise leave a truncated JPEG that
          // is served for ever, because the cache hit path trusts whatever is on disk.
          const tmp = `${cached}.${process.pid}.tmp`
          writeFileSync(tmp, buf)
          renameSync(tmp, cached)
        } catch { /* the cache is best effort */ }
      }
      return buf
    })
    .finally(() => { pending.delete(key) })
  pending.set(key, job)
  return job
}

function touch(path: string) { const t = new Date(); try { utimesSync(path, t, t) } catch { /* gone */ } }

/** ffmpeg, no more than CONCURRENCY at once: one scrub across the bar asks for a dozen frames in a second. The permit is
 *  taken and given back inside this function, so no early return anywhere above can leave the count stuck up. */
async function cut(source: string, sec: number, want: string): Promise<Buffer | null> {
  const since = Date.now()
  while (running >= CONCURRENCY) {
    if (wanted.get(want) !== Math.round(sec)) return null // the finger has moved on: this frame is no longer the one wanted
    if (Date.now() - since > QUEUE_WAIT_MS) return null
    await new Promise((r) => setTimeout(r, 40))
  }
  running++
  try {
    return await new Promise<Buffer | null>((resolve) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(sec), '-i', source,
        '-frames:v', '1', '-vf', `scale=${MAX_SIDE}:-2`, '-q:v', '6', '-f', 'mjpeg', 'pipe:1']
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks: Buffer[] = []
      let done = false
      const finish = (buf: Buffer | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
        resolve(buf)
      }
      const timer = setTimeout(() => finish(null), TIMEOUT_MS)
      proc.stdout!.on('data', (d: Buffer) => chunks.push(d))
      proc.on('error', () => finish(null))
      proc.on('exit', (code) => {
        const buf = Buffer.concat(chunks)
        finish(code === 0 && buf.length > 200 ? buf : null)
      })
    })
  } finally { running-- }
}

/** Frames nobody has looked at in a week go; cutting them again is cheap. */
export function sweepThumbs() {
  if (!existsSync(root())) return
  for (const d of readdirSync(root())) {
    const dir = join(root(), d)
    try { if (Date.now() - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
  }
}

export function startThumbSweeper() { setInterval(sweepThumbs, 3600_000).unref() }
