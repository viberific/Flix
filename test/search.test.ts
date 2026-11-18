// Search as you type: punctuation does not get in the way, and the best match comes first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchNorm, searchRank, searchScore } from '../src/search.ts'

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

test('typos, word order, spacing, accents, "&" and initials still find the show', () => {
  const hit = (name: string, q: string) => assert.notEqual(searchScore(name, q), null, `${q} -> ${name}`)
  hit('Breaking Bad', 'braking bad')
  hit('Stranger Things', 'stranger thigns')
  hit('Stranger Things', 'strnger')
  hit("Grey's Anatomy", 'anatomy greys')
  hit('Spider-Man', 'spiderman')
  hit('Spiderman', 'spider man')
  hit('The White Lotus', 'white lotus')
  hit('Pokémon', 'pokemon')
  hit('Law & Order', 'law and order')
  hit('Game of Thrones', 'got')
  hit('House of the Dragon', 'hotd')
  hit('Succession', 'sucession')
  hit('The Office', 'the ofice')
})

test('forgiving, not loose: short words need to be right, and unrelated titles stay out', () => {
  assert.equal(searchScore('The Bear', 'bat'), null)
  assert.equal(searchScore('Breaking Bad', 'dexter'), null)
  assert.equal(searchScore('Succession', 'the a'), null)
})

test('plain matches always come before forgiving ones', () => {
  const order = (q: string, names: string[]) => names.map((n) => [n, searchScore(n, q)] as const).filter((x) => x[1] !== null).sort((a, b) => a[1]! - b[1]!).map(([n]) => n)
  assert.deepEqual(order('lost', ['Lust', 'Lost', 'Lost in Space', 'The Lost Room']), ['Lost', 'Lost in Space', 'The Lost Room', 'Lust'])
  assert.deepEqual(order('bad', ['Breaking Bad', 'Bad Sisters', 'Bed Rest']), ['Bad Sisters', 'Breaking Bad'])
})
