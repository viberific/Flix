// Search as you type: punctuation does not get in the way, and the best match comes first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchNorm, searchRank } from '../src/search.ts'

test('punctuation and case do not count', () => {
  assert.equal(searchNorm("Grey's Anatomy"), 'greys anatomy')
  assert.equal(searchNorm('CSI: Miami'), 'csi miami')
  assert.equal(searchNorm('Mr. Robot'), 'mr robot')
  assert.equal(searchNorm('Spider-Man'), 'spider man')
})

test('the title itself, then what starts with the words, then a word inside, then the rest', () => {
  const order = (q: string, names: string[]) => names.map((n, i) => [n, searchRank(n, q), i] as const).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([n]) => n)
  assert.deepEqual(order('office', ['Home Office Blues', 'The Office', 'Officer Down', 'Postoffice']), ['The Office', 'Officer Down', 'Home Office Blues', 'Postoffice'])
  assert.deepEqual(order('greys', ['Fifty Greys', "Grey's Anatomy"]), ["Grey's Anatomy", 'Fifty Greys'])
  assert.equal(searchRank('The Bear', 'the bear'), 0)
})
