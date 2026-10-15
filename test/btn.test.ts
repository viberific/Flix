// The BTN v1 client and the catalog's use of it, against a stub that behaves like BTN's own API.
// BTN v1 is JSON-RPC 1.0-shaped: `id` present and non-empty (an empty or absent id makes the
// request a notification, answered with an empty 200), no `jsonrpc` field, auth in `params.key`,
// and `search` is required by getTorrents -- a request without it is refused before dispatch with
// an empty 500. Error replies carry `result: null` beside `error`. See apidocs.broadcasthe.net.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-btn-'))
const PORT = 18891
let stub: Server
let last: any = null
let answer: () => { status: number; body: string } = () => ({ status: 200, body: '{}' })

// env has to be set before the modules are imported: config reads it at import time.
process.env.DB_PATH = ':memory:'
process.env.DATA_DIR = tmp
process.env.BTN_API_KEY = 'testkey'
process.env.BTN_API_URL = `http://127.0.0.1:${PORT}/`

const { getTorrents, btnCall, RateLimitError } = await import('../src/btn/client.ts')
const { searchBtn, syncSeries, storeTorrents } = await import('../src/catalog.ts')

before(async () => {
  stub = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      last = JSON.parse(body)
      const a = answer()
      res.statusCode = a.status
      res.setHeader('content-type', 'application/json')
      res.end(a.body)
    })
  })
  await new Promise<void>((r) => stub.listen(PORT, '127.0.0.1', r))
})

after(() => { stub?.close() })

const ok = (result: unknown) => () => ({ status: 200, body: JSON.stringify({ id: 1, result }) })
const err = (code: number, message: string) => () =>
  ({ status: 200, body: JSON.stringify({ id: 1, result: null, error: { code, message } }) })

test('the request is a v1 envelope: an id, the key in params, no jsonrpc field', async () => {
  answer = ok({ results: '0' })
  await getTorrents({ series: '%Test%' }, 10, 0)
  assert.equal(last.jsonrpc, undefined)
  assert.ok(last.id, 'id must be present and non-empty or BTN answers as a notification')
  assert.equal(last.method, 'getTorrents')
  assert.equal(last.params.key, 'testkey')
  assert.equal(last.params.search.series, '%Test%')
  assert.equal(last.params.results, 10)
  assert.equal(last.params.offset, 0)
})

test('search is always sent, even when there is nothing to filter on', async () => {
  answer = ok({ results: '0' })
  await getTorrents({}, 100, 0)
  assert.deepEqual(last.params.search, {})
})

test('results are clamped to the 1000 BTN allows', async () => {
  answer = ok({ results: '0' })
  await getTorrents({ series: '%T%' }, 5000, 0)
  assert.equal(last.params.results, 1000)
})

test('DownloadURL becomes TorrentLink, and both object and array replies normalize', async () => {
  answer = ok({ results: '2', torrents: { a: { TorrentID: '1', DownloadURL: 'http://x/dl/1?pass=SECRET' }, b: { TorrentID: '2' } } })
  const { torrents } = await getTorrents({ series: '%Test%' }, 10, 0)
  assert.equal(torrents.length, 2)
  assert.equal(torrents[0].TorrentLink, 'http://x/dl/1?pass=SECRET')
  assert.equal(torrents[1].TorrentLink, undefined)

  answer = ok({ results: '1', torrents: [{ TorrentID: '3', DownloadURL: 'http://x/dl/3' }] })
  const arr = await getTorrents({ series: '%Test%' }, 10, 0)
  assert.equal(arr.torrents[0].TorrentLink, 'http://x/dl/3')
})

test('no torrents at all comes back as an empty list, not undefined', async () => {
  answer = ok({ results: '0' })
  const { torrents } = await getTorrents({ series: '%nothing%' }, 10, 0)
  assert.deepEqual(torrents, [])
})

test('every documented error code says something actionable', async () => {
  answer = err(-32001, 'Invalid API Key')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), /invalid API key/i)

  answer = err(-32003, 'Account is disabled')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), /disabled/i)

  answer = err(-32005, 'HTTPS is required')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), /HTTPS/)

  // BTN's own two -32004 messages, verbatim from https://apidocs.broadcasthe.net/v1/ :
  // the address it has never seen (logged as pending) and the one it knows and has denied.
  answer = err(-32004, 'IP address needs authorization - please check your notices on BTN')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), (e: any) => /pending/.test(e.message) && !/denied/i.test(e.message))

  answer = err(-32004, 'Unauthorized IP address')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), (e: any) => /denied/.test(e.message) && !/pending/.test(e.message))

  // wording BTN has not used before: name both meanings, and do not send the user off to
  // approve an address that may have been refused outright.
  answer = err(-32004, 'something new')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), (e: any) => /notices/.test(e.message) && !/then retry/.test(e.message))

  answer = err(-32002, 'Call limit exceeded')
  await assert.rejects(() => getTorrents({ series: '%T%' }, 10, 0), (e: any) => e instanceof RateLimitError)
})

test('the search hint belongs to getTorrents only, not to every method', async () => {
  answer = () => ({ status: 500, body: '' })
  // Only reachable through btnCall itself: getTorrents always sends search (that is the 0.1.2 fix),
  // so the hint is for a direct caller that skipped the documented required argument.
  await assert.rejects(() => btnCall('getTorrents'), /getTorrents requires a search argument/)
  await assert.rejects(() => getTorrents({}, 10, 0), (e: any) => !/search/.test(e.message))
  await assert.rejects(() => btnCall('getTorrentsUrl', { TorrentID: '1' }), (e: any) => !/search/.test(e.message))
})

test('the catalog wraps its series filter: BTN applies no wildcards of its own', async () => {
  answer = ok({ results: '0' })
  await searchBtn('Test')
  assert.equal(last.params.search.series, '%Test%')

  // the back-catalogue sync, which is the place this was missed
  storeTorrents([{
    GroupName: 'Test Show - S01E01', GroupID: '100', TorrentID: '1', SeriesID: '77', Series: 'Test Show',
    ReleaseName: 'test.720p', Category: 'Episode', Codec: 'H.264', Container: 'MKV', Source: 'WEB-DL',
    Resolution: '720p', Origin: 'P2P', Size: '1000', Time: '1700000000', InfoHash: 'ab'.repeat(20),
  }])
  await syncSeries(77, true)
  assert.equal(last.method, 'getTorrents')
  assert.equal(last.params.search.series, '%Test Show%')
})
