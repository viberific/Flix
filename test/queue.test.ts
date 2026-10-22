// The home screen's Queue (resume, My List and suggestions in one rail) is drawn in the browser, so its one piece of logic,
// what goes in it, is pulled out of public/app.js here and run on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const cap = app.match(/const QUEUE_SUGGESTIONS = (\d+)/)
const body = app.match(/function queueOf\(cont, home\) \{[\s\S]*?\n\}\n/)
assert.ok(cap && body, 'queueOf is still in public/app.js')
const queueOf = new Function(`const QUEUE_SUGGESTIONS = ${cap![1]}; ${body![0]}; return queueOf`)() as (cont: any[], home: any) => any

const shows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `Show ${from + i}` }))
const resume = (id: number) => ({ seriesId: id, series: `Resume ${id}` })

test('with nothing to resume and nothing on the list there is no Queue', () => {
  assert.equal(queueOf([], { myList: [], picked: shows(100, 10), sections: [{ title: 'HBO', series: shows(200, 10) }] }), null)
  assert.equal(queueOf([], { picked: null, sections: [] }), null)
})

test('suggestions are the picks first, then Because you watched, then the first popular row', () => {
  const home = { myList: [shows(1, 1)[0]], picked: shows(100, 10), because: { name: 'X', liked: false, series: shows(300, 10) }, sections: [{ title: 'HBO', series: shows(200, 10) }] }
  const a = queueOf([], home)
  assert.equal(a.used, 'picked'); assert.equal(a.title, 'Suggested for you')
  const b = queueOf([], { ...home, picked: null })
  assert.equal(b.used, 'because'); assert.equal(b.title, 'Because you watched X'); assert.equal(b.sugg[0].id, 300)
  assert.equal(queueOf([], { ...home, picked: null, because: { ...home.because, liked: true } }).title, 'Because you liked X')
  const c = queueOf([], { ...home, picked: null, because: null })
  assert.equal(c.used, 'section'); assert.equal(c.title, 'HBO'); assert.equal(c.sugg[0].id, 200)
})

test('some suggestions show, the rest wait to fill in as one is added, and none repeats a show already in the Queue', () => {
  const home = { myList: [shows(1, 1)[0], shows(100, 1)[0]], picked: shows(100, 10), sections: [] }
  const q = queueOf([resume(101)], home)
  const ids = [...q.sugg, ...q.pool].map((s: any) => s.id)
  assert.ok(!ids.includes(100) && !ids.includes(101), 'a listed show and a show being resumed are not suggested')
  assert.equal(q.sugg.length, Number(cap![1]))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(q.sugg.length + q.pool.length, 8)
})

test('a Queue with something to resume but no suggestions is still drawn', () => {
  const q = queueOf([resume(1)], { myList: [], picked: null, because: null, sections: [] })
  assert.ok(q && q.sugg.length === 0 && q.used === null)
})

test('shows with downloads are their own group and are not suggested again', () => {
  const q = queueOf([], { myList: [], ready: shows(100, 2), picked: shows(100, 10), sections: [] })
  assert.deepEqual(q.ready.map((s: any) => s.id), [100, 101])
  assert.ok(![...q.sugg, ...q.pool].some((s: any) => s.id === 100 || s.id === 101))
  assert.equal(queueOf([], { myList: [], ready: [], picked: null, sections: [] }), null)
})

test('resume and Ready to Watch share the top rail; Your list and the suggestions are the rail under it', () => {
  const html = app.match(/function queueHtml\(st\) \{[\s\S]*?\n\}\n/)
  assert.ok(html, 'queueHtml is still in public/app.js')
  const stub = (cls: string) => (s: any) => `<button class="tile ${cls}" data-s="${s.seriesId ?? s.id}"></button>`
  const queueHtml = new Function('qcard', 'wideTile', 'contTile', 'tile', 'rowShell', `${html![0]}; return queueHtml`)(
    (inner: string, id: number, kind = '') => `<div class="qcard${kind ? ' ' + kind : ''}" data-id="${id}">${inner}</div>`,
    stub('wide'), stub('cont'), stub('p'), (inner: string, cls: string) => `<rail class="${cls}">${inner}</rail>`) as (st: any) => string
  const q = queueOf([resume(1)], { myList: shows(10, 1), ready: shows(20, 2), picked: shows(30, 3), sections: [] })
  const rails = [...queueHtml(q).matchAll(/<rail class="(\w+)">([\s\S]*?)<\/rail>/g)].map((m) => [m[1], [...m[2].matchAll(/data-id="(\d+)"/g)].map((x) => Number(x[1]))])
  assert.deepEqual(rails, [['qtop', [1, 20, 21]], ['q', [10, 30, 31, 32]]])
  assert.match(queueHtml(q), /data-g="Ready to Watch" class="qcard gl gs" data-id="20"/)
  const onlyReady = queueHtml(queueOf([], { myList: [], ready: shows(20, 1), picked: null, sections: [] }))
  assert.match(onlyReady, /data-g="Ready to Watch" class="qcard gl" data-id="20"/)
})
