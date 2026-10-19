import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, now } from './db.ts'
import { config } from './config.ts'
import { parseAllowed, type Allowed } from './ratings.ts'

export interface User { id: number; name: string; is_admin: number; allowed: Allowed; avatar?: string | null }

/** The little creatures a person can pick for their picture. The app draws each one from this id. */
export const AVATAR_IDS = ['fox', 'owl', 'cat', 'bunny', 'frog', 'whale', 'octopus', 'bee', 'panda', 'axolotl', 'raccoon', 'hedgehog'] as const

export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`
}
function verifyPassword(pw: string, stored: string): boolean {
  if (!stored) return false // no password set (a child account)
  const [salt, hash] = stored.split(':')
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64)
  return a.length === b.length && timingSafeEqual(a, b)
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** A child account: not an admin and not allowed TV-MA. It signs in by name alone, no password. */
export const isChild = (isAdmin: boolean | number, allowed: Allowed) => !isAdmin && allowed !== null && !allowed.includes('TV-MA')

export function createUser(name: string, pw: string, isAdmin: boolean, allowed: Allowed = null): User {
  if (!/^[\w.-]{2,32}$/.test(name)) throw Object.assign(new Error('Username must be 2-32 chars (letters, digits, _ . -)'), { statusCode: 400 })
  const noPw = !pw && isChild(isAdmin, allowed)
  if (!noPw && pw.length < 8) throw Object.assign(new Error('Password must be at least 8 characters (only kids can go without one)'), { statusCode: 400 })
  if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw Object.assign(new Error('That username is taken'), { statusCode: 409 })
  const r = db.prepare('INSERT INTO users (name, pass_hash, is_admin, created_at, allowed_ratings) VALUES (?,?,?,?,?)')
    .run(name, noPw ? '' : hashPassword(pw), isAdmin ? 1 : 0, now(), allowed ? JSON.stringify(allowed) : null)
  return { id: Number(r.lastInsertRowid), name, is_admin: isAdmin ? 1 : 0, allowed }
}

/** A family device stays signed in for months; each use pushes the expiry out again (see userFor). */
export const SESSION_DAYS = 180

export function newSession(userId: number): string {
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, now() + SESSION_DAYS * 86400)
  return token
}

export function login(name: string, pw: string): string | null {
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name) as any
  if (!row) return null
  if (!isChild(row.is_admin, parseAllowed(row.allowed_ratings)) && !verifyPassword(pw, row.pass_hash)) return null
  return newSession(row.id)
}

/** A session token that is still good, for "switch profile" on a shared device. Returns the user's id. */
export function sessionUser(token: string): number | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const r = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(token), now()) as any
  return r ? r.user_id : null
}

// ---- profile PINs: guard "switch profile" on a shared device (a password or sign-in link still works anywhere) ----
export const hasPin = (userId: number) => !!(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId) as any)?.pin_hash
export function setPin(userId: number, pin: string | null) {
  if (pin !== null && !/^\d{4,8}$/.test(pin)) throw Object.assign(new Error('A PIN is 4 to 8 digits'), { statusCode: 400 })
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pin === null ? null : hashPassword(pin), userId)
}
const PIN_WINDOW_MS = 600_000
const PIN_TRIES = 5
/** True when there is no PIN, or this one is right. Five wrong tries in ten minutes locks the profile for the rest of that
 *  window, and the record of them is on disk: a restart must not hand somebody a fresh five tries. */
export function pinOk(userId: number, pin: string | undefined): boolean | 'locked' {
  const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId) as any
  if (!row?.pin_hash) return true
  const since = Date.now() - PIN_WINDOW_MS
  db.prepare('DELETE FROM pin_fails WHERE at <= ?').run(since) // old tries go as they are read, so the table stays small
  const recent = (db.prepare('SELECT COUNT(*) AS n FROM pin_fails WHERE user_id = ? AND at > ?').get(userId, since) as any).n as number
  if (recent >= PIN_TRIES) return 'locked'
  if (typeof pin === 'string' && /^\d{4,8}$/.test(pin) && verifyPassword(pin, row.pin_hash)) {
    db.prepare('DELETE FROM pin_fails WHERE user_id = ?').run(userId)
    return true
  }
  db.prepare('INSERT INTO pin_fails VALUES (?,?)').run(userId, Date.now())
  return false
}

// ---- one-time sign-in links ---------------------------------------------------------------------------

/** The admin gives this to a family member (a link or QR code); opening it signs that device in as them. Valid 7 days, once. */
export function createInvite(userId: number): string {
  const token = randomBytes(24).toString('hex')
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(now())
  db.prepare('INSERT INTO invites VALUES (?,?,?)').run(sha(token), userId, now() + 7 * 86400)
  return token
}
/** Consume an invite and sign the device in. Null when the link is unknown, used or expired. */
export function redeemInvite(token: string): { session: string; userId: number } | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null
  const r = db.prepare('SELECT user_id FROM invites WHERE token_hash = ? AND expires_at > ?').get(sha(token), now()) as any
  if (!r) return null
  db.prepare('DELETE FROM invites WHERE token_hash = ?').run(sha(token))
  return { session: newSession(r.user_id), userId: r.user_id }
}

// ---- cookie-free stream links (casting, TVs) ----------------------------------------------------------
// A TV or cast device fetches the video itself and has no cookie, so it gets a signed link whose token sits in the path
// (the HLS playlist's relative segment URLs keep it). Valid 12 hours; a restart of Flix invalidates them.
const tvSecret = randomBytes(32)
export function tvToken(userId: number): string {
  const exp = now() + 12 * 3600
  return `${userId}.${exp}.${createHmac('sha256', tvSecret).update(`${userId}.${exp}`).digest('hex').slice(0, 32)}`
}
export function userForTvToken(token: string): User | null {
  const m = /^(\d+)\.(\d+)\.([a-f0-9]{32})$/.exec(token)
  if (!m || Number(m[2]) < now()) return null
  const want = createHmac('sha256', tvSecret).update(`${m[1]}.${m[2]}`).digest('hex').slice(0, 32)
  if (!timingSafeEqual(Buffer.from(want), Buffer.from(m[3]))) return null
  const r = db.prepare('SELECT id, name, is_admin, allowed_ratings, avatar FROM users WHERE id = ?').get(Number(m[1])) as any
  return r ? { id: r.id, name: r.name, is_admin: r.is_admin, allowed: parseAllowed(r.allowed_ratings), avatar: r.avatar ?? null } : null
}

export const userCount = () => (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c as number

function cookieToken(req: FastifyRequest): string | null {
  const m = /(?:^|;\s*)flix_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')
  return m ? m[1] : null
}

export function userFor(req: FastifyRequest): User | null {
  const t = cookieToken(req)
  if (!t) return null
  const r = db.prepare(`SELECT u.id, u.name, u.is_admin, u.allowed_ratings, u.avatar, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), now()) as any
  // Sliding expiry: a device in regular use never gets signed out. Written at most about once a day.
  if (r && r.expires_at < now() + (SESSION_DAYS - 1) * 86400) db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now() + SESSION_DAYS * 86400, sha(t))
  return r ? { id: r.id, name: r.name, is_admin: r.is_admin, allowed: parseAllowed(r.allowed_ratings), avatar: r.avatar ?? null } : null
}

export function logout(req: FastifyRequest) {
  const t = cookieToken(req)
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t))
}

export function setSessionCookie(reply: FastifyReply, token: string | null) {
  const base = 'flix_session=' + (token ?? '') + '; Path=/; HttpOnly; SameSite=Strict'
  reply.header('set-cookie', token ? `${base}; Max-Age=${SESSION_DAYS * 86400}` : `${base}; Max-Age=0`)
}

declare module 'fastify' { interface FastifyRequest { user?: User } }

/** Fastify preHandler: require login (or the internal key, for our own ffmpeg). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const u = userFor(req)
  if (u) { req.user = u; return }
  if ((req.query as any)?.k === config.internalKey) return
  reply.code(401).send({ error: 'Not logged in' })
}
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply)
  if (!reply.sent && !req.user?.is_admin) reply.code(403).send({ error: 'Admin only' })
}

/** False for an account made without one (a child). */
export const hasPassword = (id: number) => !!(db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(id) as any)?.pass_hash

/** Is this the right password for this account? */
export function checkPassword(id: number, password: string): boolean {
  const r = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(id) as any
  return !!r && verifyPassword(String(password), r.pass_hash)
}

/** Change the name shown for this account. Names identify profiles, so they must be free. */
export function renameUser(id: number, name: string): User {
  const n = String(name).trim()
  if (!/^[\w .-]{2,32}$/.test(n)) throw Object.assign(new Error('A name is 2 to 32 letters, numbers, dots, dashes or spaces'), { statusCode: 400 })
  if (db.prepare('SELECT 1 FROM users WHERE lower(name) = lower(?) AND id <> ?').get(n, id)) throw Object.assign(new Error('That name is already taken'), { statusCode: 400 })
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(n, id)
  return renameBack(id)
}
function renameBack(id: number): User {
  const r = db.prepare('SELECT id, name, is_admin, allowed_ratings, avatar FROM users WHERE id = ?').get(id) as any
  return { id: r.id, name: r.name, is_admin: r.is_admin, allowed: parseAllowed(r.allowed_ratings), avatar: r.avatar ?? null }
}

/** Put one of the little creatures on this account, or none (null) for their initial. */
export function setAvatar(id: number, avatar: string | null): User {
  const a = avatar === null || avatar === '' ? null : String(avatar)
  if (a !== null && !(AVATAR_IDS as readonly string[]).includes(a)) throw Object.assign(new Error('No such picture'), { statusCode: 400 })
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(a, id)
  return renameBack(id)
}

/** Change this account's own password, having proved the current one. Other devices are signed out. */
export function setOwnPassword(id: number, current: string, next: string): void {
  if (hasPassword(id) && !checkPassword(id, current)) throw Object.assign(new Error('That is not your current password'), { statusCode: 400 })
  if (String(next).length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 })
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(next)), id)
  db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(id)
}
