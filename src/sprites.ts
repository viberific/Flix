import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

/**
 * The pictures above the seek bar, as one tiled JPEG per episode: a grid of small frames taken at regular intervals.
 *
 * This replaces cutting a frame per request. That version ran ffmpeg on every second of a drag, which put a process
 * spawn and a seek into the request the finger was dragging, and a television seeking back over ground it had already
 * covered paid for it again. Here the whole episode is cut once, in the background, after the download has finished:
 * scrubbing then costs one HTTP GET of a still image that is already on disk, and cropping it is arithmetic in the
 * browser. Nothing is ever generated on a seek.
 *
 * Only a file that has finished downloading gets one, because ffmpeg cannot seek through bytes that are not there yet.
 * Streaming content simply has no sprite, and the player falls back to the bar with no picture.
 */
export type SpriteMeta = {
  /** One tile's size in pixels, and the grid it sits in. */
  tileW: number; tileH: number; cols: number; rows: number
  /** Seconds between two tiles, the episode's length, and how many tiles hold a picture. */
  interval: number; duration: number; count: number
  /** When the sheet was made, for the sweeper. */
  at: number
}

export const TILE_W = 160
export const TILE_H = 90
export const COLS = 10
export const ROWS = 10
/** Sheets nobody has looked at in a fortnight go; making one again is a background job, not a stall. */
const KEEP_MS = 14 * 24 * 3600_000
/** A whole episode through ffmpeg: minutes, not seconds, and never on a request. */
const TIMEOUT_MS = 20 * 60_000
const spriteRoot = () => join(config.dataDir, 'sprites')
const dirFor = (t: number, f: number) => join(spriteRoot(), `${t}-${f}`)
export const spritePath = (t: number, f: number) => join(dirFor(t, f), 'sprite.jpg')
export const metaPath = (t: number, f: number) => join(dirFor(t, f), 'sprite.json')

/** How far apart two tiles are, given the episode's length: a hundred of them, and never closer than two seconds. */
export function spritePlan(duration: number): { interval: number; count: number } {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0
  const interval = Math.max(2, Math.round(d / (COLS * ROWS)) || 2)
  const count = Math.min(COLS * ROWS, Math.max(1, Math.ceil(d / interval) || 1))
  return { interval, count }
}

/**
 * Which tile holds this second, and where in the sheet it is. Pure, and the only arithmetic the client repeats: the
 * player is sent this metadata and crops with the same formula, so a change here changes both.
 */
export function spriteTile(at: number, m: Pick<SpriteMeta, 'cols' | 'rows' | 'interval' | 'count'> & Partial<Pick<SpriteMeta, 'tileW' | 'tileH'>>) {
  const last = Math.max(0, (m.count > 0 ? m.count : m.cols * m.rows) - 1)
  const index = Math.max(0, Math.min(last, Math.floor(Math.max(0, at) / Math.max(0.5, m.interval))))
  const tileW = m.tileW ?? TILE_W, tileH = m.tileH ?? TILE_H
  return { index, col: index % m.cols, row: Math.floor(index / m.cols), x: (index % m.cols) * tileW, y: Math.floor(index / m.cols) * tileH }
}

/** What has already been made for this download, or null when there is nothing to serve. */
export function spriteMeta(t: number, f: number): SpriteMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(t, f), 'utf8')) as SpriteMeta
    if (!(m.cols > 0 && m.rows > 0 && m.interval > 0 && m.count > 0) || !existsSync(spritePath(t, f))) return null
    touch(dirFor(t, f))
    return m
  } catch { return null }
}

/**
 * Run after the sheet has been written beside its own name and before it is renamed into place: the one moment the
 * folder holds both. A test uses it to see the write in flight, or to make it fail; nothing in the app sets it.
 */
let writeHook: ((tmp: string, dest: string) => void) | null = null
export function setSpriteWriteHook(fn: ((tmp: string, dest: string) => void) | null) { writeHook = fn }

/**
 * Cut the whole sheet in one pass: one frame every `interval` seconds, scaled to a tile, laid out in a grid, and written
 * as one JPEG. The temp file and the rename are the same discipline the old frame cache used -- a crash part-way must
 * not leave a half-written sheet that would be served for ever, because a hit trusts whatever is on disk.
 */
export async function buildSprite(t: number, f: number, source: string, duration: number): Promise<SpriteMeta | null> {
  const { interval, count } = spritePlan(duration)
  if (!Number.isFinite(duration) || duration <= 0 || !existsSync(source)) return null
  // A tile is scaled to fit and padded, so a 4:3 episode and a 2.39:1 film both give full 160x90 tiles with no stretch.
  const vf = `fps=1/${interval},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${COLS}x${ROWS}`
  // Keyframes only: the decoder skips every other frame, which is nearly all of the work. A tile is the keyframe nearest
  // its moment, a second or two off at most, and the whole sheet costs a fraction of a core for a short while instead of
  // the full decode that took 0.3.44 over three of the box's four cores. One thread, at the lowest priority there is.
  const args = ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-skip_frame', 'nokey', '-ss', '0', '-i', source,
    '-vf', vf, '-threads', '1', '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', 'pipe:1']
  const buf = await new Promise<Buffer | null>((resolve) => {
    const proc = spawn(...lowPriority(args), { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let done = false
    const finish = (b: Buffer | null) => { if (done) return; done = true; clearTimeout(timer); try { proc.kill('SIGKILL') } catch { /* gone */ } resolve(b) }
    const timer = setTimeout(() => finish(null), TIMEOUT_MS)
    proc.stdout!.on('data', (d: Buffer) => chunks.push(d))
    proc.on('error', () => finish(null))
    proc.on('exit', (code) => { const out = Buffer.concat(chunks); finish(code === 0 && out.length > 2000 ? out : null) })
  })
  if (!buf) return null
  const meta: SpriteMeta = { tileW: TILE_W, tileH: TILE_H, cols: COLS, rows: ROWS, interval, duration: Math.round(duration), count, at: Date.now() }
  try {
    mkdirSync(dirFor(t, f), { recursive: true })
    const dest = spritePath(t, f), tmp = `${dest}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, buf)
      writeHook?.(tmp, dest)
      renameSync(tmp, dest)
      // The metadata goes in last: a sheet without one is never served, so the two cannot disagree.
      writeFileSync(metaPath(t, f), JSON.stringify(meta))
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  } catch { return null }
  return meta
}

/** ffmpeg at the lowest CPU and disk priority the box has, so a background cut never takes time from a stream. */
export function lowPriority(args: string[]): [string, string[]] {
  const nice = ['/usr/bin/nice', '/bin/nice'].find((p) => existsSync(p))
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find((p) => existsSync(p))
  if (!nice) return ['ffmpeg', args]
  return ionice ? [ionice, ['-c3', nice, '-n', '19', 'ffmpeg', ...args]] : [nice, ['-n', '19', 'ffmpeg', ...args]]
}

function touch(path: string) { const t = new Date(); try { utimesSync(path, t, t) } catch { /* gone */ } }

/** Sheets nobody has looked at in a fortnight go. */
export function sweepSprites() {
  if (!existsSync(spriteRoot())) return
  for (const d of readdirSync(spriteRoot())) {
    const dir = join(spriteRoot(), d)
    try { if (Date.now() - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
  }
}

export function startSpriteSweeper() {
  sweepSprites()
  setInterval(sweepSprites, 6 * 3600_000).unref()
}
