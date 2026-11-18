/**
 * Flix's own diagnostic log: a short, always-on record of what the player and the server were doing when a
 * picture hitched. Not a replacement for the request log -- that says a request finished, this says the
 * player gave up on a buffering gap at 12:04 of episode 3, and that the pieces under that second had not
 * arrived.
 *
 * Two places at once, both cheap:
 *  - a ring in memory (the last RING events), served to an admin at /api/admin/diag so nobody has to keep
 *    their own copy;
 *  - one rotating file under DATA_DIR/logs, so it survives the restart that follows a crash and can be read
 *    from the host without an account.
 *
 * Nothing here may ever take playback down: every write is best-effort and a failure turns the file off
 * rather than throwing.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'

export type DiagLevel = 'info' | 'warn' | 'error'

export interface DiagEvent {
  /** Milliseconds since the epoch, so an event can be lined up against a request log entry. */
  t: number
  lvl: DiagLevel
  /** What part of the app: 'client', 'stream', 'hls', 'remux', 'pieces', 'engine'. */
  area: string
  msg: string
  /** Whatever makes the event useful later: seconds into the episode, bytes waited for, what the client saw. */
  d?: Record<string, unknown>
}

/** Events kept in memory. The log is verbose now (every play's whole story), so the ring and the files are larger. */
const RING = 8000
/** Size at which the file is rotated, and how many old ones are kept (so the folder stays under ~36 MB). */
const FILE_MAX = 6 << 20
const FILE_KEEP = 5

const ring: DiagEvent[] = []
let dropped = 0
let file: string | null = null
let size = 0
let fileBroken = false

/** The file events are also written to, or null when it could not be opened or was switched off. */
export function diagFile(): string | null {
  return file
}

function dir(): string {
  return join(config.dataDir, 'logs')
}

function open(): void {
  if (file || fileBroken) return
  try {
    mkdirSync(dir(), { recursive: true })
    file = join(dir(), 'flix.log')
    try { size = statSync(file).size } catch { size = 0 }
  } catch {
    fileBroken = true
    file = null
  }
}

/** Keep FILE_KEEP old files: flix.log -> flix.log.1 -> flix.log.2, the oldest thrown away. */
function rotate(): void {
  if (!file) return
  try {
    const oldest = `${file}.${FILE_KEEP}`
    try { unlinkSync(oldest) } catch { /* not there yet */ }
    for (let i = FILE_KEEP - 1; i >= 1; i--) {
      try { renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* not there yet */ }
    }
    renameSync(file, `${file}.1`)
  } catch { /* a failed rotation must not stop the next write */ }
  size = 0
}

export function diag(area: string, msg: string, d?: Record<string, unknown>, lvl: DiagLevel = 'info'): void {
  const e: DiagEvent = { t: Date.now(), lvl, area, msg }
  if (d && Object.keys(d).length) e.d = d
  ring.push(e)
  if (ring.length > RING) { ring.shift(); dropped++ }
  open()
  if (!file) return
  try {
    const line = JSON.stringify(e) + '\n'
    if (size + line.length > FILE_MAX) { rotate(); }
    appendFileSync(file, line)
    size += line.length
  } catch {
    fileBroken = true
    file = null
  }
}

/** A hitch is a fault, not a fact: it gets the louder level and its own helper so it can be counted. */
export function hitch(area: string, msg: string, d?: Record<string, unknown>): void {
  diag(area, msg, d, 'warn')
}

/** The last `n` events, oldest first. */
export function diagTail(n = 200): DiagEvent[] {
  const want = Math.max(1, Math.min(RING, n))
  return ring.slice(-want)
}

/** Per-area and per-level counts plus the size of the ring: what the whole evening looked like at a glance. */
export function diagCounts(): Record<string, unknown> {
  const byLevel: Record<string, number> = { info: 0, warn: 0, error: 0 }
  const byArea: Record<string, number> = {}
  for (const e of ring) {
    byLevel[e.lvl] = (byLevel[e.lvl] ?? 0) + 1
    byArea[e.area] = (byArea[e.area] ?? 0) + 1
  }
  return { held: ring.length, dropped, byLevel, byArea, file, fileSize: size, since: ring.length ? ring[0].t : null }
}

/** Old files on disk, so the folder can be checked rather than guessed at. */
export function diagFiles(): { name: string; bytes: number }[] {
  try {
    return readdirSync(dir()).filter((f) => f.startsWith('flix.log')).map((f) => ({ name: f, bytes: statSync(join(dir(), f)).size })).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** A stopwatch for one thing that can stall: playback waiting for pieces, an encoder making its first segment. */
export function timer(): () => number {
  const at = Date.now()
  return () => Date.now() - at
}

/**
 * What may never reach the log: a television's signed token in a path (/api/tv/<token>/...), the internal key, a BTN key or
 * passkey in a URL, a cookie. Applied to every string that comes from outside this file's own sentences.
 */
export function redact(s: unknown): string {
  let out = String(s ?? '')
  if (config.internalKey) out = out.split(config.internalKey).join('***')
  if (config.btn?.apiKey) out = out.split(config.btn.apiKey).join('***')
  return out
    .replace(/\/api\/tv\/[^/\s?]+/g, '/api/tv/***')
    .replace(/([?&](?:passkey|authkey|key|token|apikey|api_key)=)[^&\s]+/gi, '$1***')
    .replace(/(cookie|authorization)(["':=\s]+)[^\s"',;]+/gi, '$1$2***')
}

/** An error as the log needs it: its message, its kind, and the top of its stack (where it was thrown). */
export function errInfo(e: any, lines = 5): Record<string, unknown> {
  if (e == null) return { error: String(e) }
  const stack = typeof e.stack === 'string' ? e.stack.split('\n').slice(1, 1 + lines).map((x: string) => redact(x.trim())).join(' | ') : undefined
  return { error: redact(e.message ?? e).slice(0, 400), name: e.name ?? e.constructor?.name, code: e.code ?? e.statusCode ?? undefined, ...(stack ? { stack: stack.slice(0, 700) } : {}) }
}

/** Every file of the log, oldest first, as one text: what an admin downloads to send on. */
export function diagAll(): string {
  const age = (x: string) => (x === 'flix.log' ? 0 : Number(x.split('.').pop()) || 0) // flix.log.5 is the oldest, flix.log the newest
  const names = diagFiles().map((f) => f.name).sort((a, b) => age(b) - age(a))
  const parts: string[] = []
  for (const n of names) { try { parts.push(readFileSync(join(dir(), n), 'utf8')) } catch { /* rotated away just now */ } }
  return parts.join('')
}
