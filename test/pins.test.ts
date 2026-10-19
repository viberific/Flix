// Profile PINs guard "switch to this profile" on a shared device. These pin the rules that matter: the PIN is never
// stored as somebody typed it, a kids profile is not exempt, and the lockout after repeated guesses is on disk so
// restarting the app does not hand anyone a fresh five tries.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_LEVEL = 'silent'

const { createUser, hasPin, isChild, pinOk, setPin } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')

const idOf = (name: string) => (db.prepare('SELECT id FROM users WHERE name = ?').get(name) as any).id as number
const row = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any

createUser('Parent', 'a password', true)
createUser('Sam', '', false, ['TV-Y', 'TV-G', 'TV-PG']) // a kids profile: not an admin, and TV-MA is off

test('a kids profile can have a PIN, and it is not exempt from it', () => {
  const kid = idOf('Sam')
  const r = row(kid)
  assert.equal(isChild(r.is_admin, ['TV-Y', 'TV-G', 'TV-PG']), true, 'this account is a kids profile')
  assert.equal(hasPin(kid), false, 'and it starts with none')
  setPin(kid, '4321')
  assert.equal(hasPin(kid), true)
  assert.equal(pinOk(kid, undefined), false, 'switching to it asks for the PIN like any other profile')
  assert.equal(pinOk(kid, '4321'), true)
})

test('the PIN is stored hashed, and never the digits', () => {
  const kid = idOf('Sam')
  setPin(kid, '987654')
  const stored = row(kid).pin_hash as string
  assert.ok(stored && stored.length > 32)
  assert.equal(stored.includes('987654'), false, 'the digits must not appear in what is stored')
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/, 'salt:hash, the same shape the passwords use')
  // The same PIN set twice does not produce the same stored value, which is the salt doing its job.
  const before = row(kid).pin_hash
  setPin(kid, '987654')
  assert.notEqual(row(kid).pin_hash, before)
})

test('a PIN that is not 4 to 8 digits is refused', () => {
  const kid = idOf('Sam')
  for (const bad of ['123', '', '123456789', 'abcd']) assert.throws(() => setPin(kid, bad), /4 to 8 digits/)
})

test('five wrong guesses lock the profile, and the right PIN does not get through while it is locked', () => {
  const kid = idOf('Sam')
  setPin(kid, '2468')
  db.prepare('DELETE FROM pin_fails').run()
  for (let i = 0; i < 5; i++) assert.equal(pinOk(kid, '1111'), false)
  assert.equal(pinOk(kid, '2468'), 'locked', 'a locked profile stays locked for the rest of the window')
  // The record is a row, not a variable in the process: that is what makes a restart harmless.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pin_fails WHERE user_id = ?').get(kid) as any).n, 5)
})

test('guesses older than the window do not count, and the right PIN clears the ones that do', () => {
  const kid = idOf('Sam')
  setPin(kid, '1357')
  db.prepare('DELETE FROM pin_fails').run()
  const long = Date.now() - 700_000
  for (let i = 0; i < 4; i++) db.prepare('INSERT INTO pin_fails VALUES (?,?)').run(kid, long)
  assert.equal(pinOk(kid, '1357'), true, 'four tries from yesterday evening are not four tries just now')
  for (let i = 0; i < 3; i++) assert.equal(pinOk(kid, '0000'), false)
  assert.equal(pinOk(kid, '1357'), true)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pin_fails WHERE user_id = ?').get(kid) as any).n, 0, 'a good PIN clears the record')
})

test('clearing a PIN opens the profile again', () => {
  const kid = idOf('Sam')
  setPin(kid, '5555')
  assert.equal(hasPin(kid), true)
  setPin(kid, null)
  assert.equal(hasPin(kid), false)
  assert.equal(pinOk(kid, undefined), true, 'no PIN means no asking')
  assert.equal(row(kid).pin_hash, null)
})
