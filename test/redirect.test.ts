// One address: with PUBLIC_URL set, Flix sends every other host name there — except the home network, which
// serves Flix itself so a TV that cannot install Tailscale still reaches it (and not the good address, loopback
// or a Docker service name either) — so a phone that lands on https://<name>:8096 can never sit on Umbrel's
// umbrel.local certificate.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'flix-redirect-'))
process.env.DB_PATH = join(tmp, 'flix.db')
process.env.DATA_DIR = join(tmp, 'data')
process.env.DOWNLOAD_DIR = join(tmp, 'downloads')
process.env.LOG_LEVEL = 'silent'
process.env.PUBLIC_URL = 'https://umbrel-1.tail16900.ts.net:9443'

const { app } = await import('../src/server.ts')
after(() => app.close())

const CANON = 'https://umbrel-1.tail16900.ts.net:9443'

test('another host name is sent to the one address, path and query kept', async () => {
  for (const host of ['umbrel-1.tail16900.ts.net:8096', '100.122.77.59:8096']) {
    const res = await app.inject({ method: 'GET', url: '/shows?tab=recent', headers: { host } })
    assert.equal(res.statusCode, 308, host)
    assert.equal(res.headers.location, `${CANON}/shows?tab=recent`, host)
  }
})

test('home-network addresses serve Flix themselves, so a TV needs no Tailscale', async () => {
  for (const host of ['10.0.0.247:8096', '192.168.1.50:8096', '172.16.4.4:8096', 'umbrel.local:8096']) {
    const res = await app.inject({ method: 'GET', url: '/shows?tab=recent', headers: { host } })
    assert.notEqual(res.statusCode, 308, host)
    assert.equal(res.headers.location, undefined, host)
  }
})

test('the good address serves Flix', async () => {
  const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'umbrel-1.tail16900.ts.net:9443' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.location, undefined)
})

test('loopback and Docker service names are left alone', async () => {
  for (const host of ['127.0.0.1:8096', 'localhost:8096', 'blofstedt-flix_app_1:8096', 'app:8096']) {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { host } })
    assert.notEqual(res.statusCode, 308, host)
  }
})

test('a POST keeps its method, so a stale cached shell can still recover', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: { host: 'umbrel-1.tail16900.ts.net:8096' }, payload: {} })
  assert.equal(res.statusCode, 308)
  assert.equal(res.headers.location, `${CANON}/api/login`)
})
