// The prebuild's memory check: the container's own answer where Node has one, never more than the host has.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freemem } from 'node:os'
import { availableMb } from '../src/prebuild.ts'

test('available memory is a positive number of MB, and never more than the host has free', () => {
  const mb = availableMb()
  assert.ok(Number.isInteger(mb) && mb > 0, `got ${mb}`)
  assert.ok(mb <= Math.round(freemem() / 1048576) + 1)
})
