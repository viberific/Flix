import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, now } from './db.ts'
import { config } from './config.ts'

export interface User { id: number; name: string; is_admin: number }

export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`
}
function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64)
  return a.length === b.length && timingSafeEqual(a, b)
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function createUser(name: string, pw: string, isAdmin: boolean): User {
  if (!/^[\w.-]{2,32}$/.test(name)) throw new Error('Username must be 2-32 chars (letters, digits, _ . -)')
  if (pw.length < 8) throw new Error('Password must be at least 8 characters')
  const r = db.prepare('INSERT INTO users (name, pass_hash, is_admin, created_at) VALUES (?,?,?,?)')
    .run(name, hashPassword(pw), isAdmin ? 1 : 0, now())
  return { id: Number(r.lastInsertRowid), name, is_admin: isAdmin ? 1 : 0 }
}

export function login(name: string, pw: string): string | null {
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name) as any
  if (!row || !verifyPassword(pw, row.pass_hash)) return null
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), row.id, now() + 30 * 86400)
  return token
}

export const userCount = () => (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c as number

function cookieToken(req: FastifyRequest): string | null {
  const m = /(?:^|;\s*)flix_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')
  return m ? m[1] : null
}

export function userFor(req: FastifyRequest): User | null {
  const t = cookieToken(req)
  if (!t) return null
  return (db.prepare(`SELECT u.id, u.name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), now()) as User | undefined) ?? null
}

export function logout(req: FastifyRequest) {
  const t = cookieToken(req)
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t))
}

export function setSessionCookie(reply: FastifyReply, token: string | null) {
  const base = 'flix_session=' + (token ?? '') + '; Path=/; HttpOnly; SameSite=Strict'
  reply.header('set-cookie', token ? `${base}; Max-Age=${30 * 86400}` : `${base}; Max-Age=0`)
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
