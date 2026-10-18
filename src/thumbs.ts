import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    try { return Promise.resolve(readFileSync(cached)) } catch { /* cut it again */ }
  }
  const key = `${t}:${f}:${Math.round(sec)}`
  const already = pending.get(key)
  if (already) return already
  const job = cut(source, sec)
    .then((buf) => {
      if (buf) {
        try { mkdirSync(dirFor(t, f), { recursive: true }); writeFileSync(cached, buf) } catch { /* the cache is best effort */ }
      }
      return buf
    })
    .finally(() => { pending.delete(key); running-- })
  pending.set(key, job)
  return job
}

/** ffmpeg, no more than CONCURRENCY at once: one scrub across the bar asks for a dozen frames in a second. */
async function cut(source: string, sec: number): Promise<Buffer | null> {
  while (running >= CONCURRENCY) await new Promise((r) => setTimeout(r, 40))
  running++
  return new Promise<Buffer | null>((resolve) => {
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
