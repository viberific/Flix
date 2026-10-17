import { config } from './config.ts'

export interface QbTorrent {
  hash: string; name: string; state: string; progress: number; size: number; total_size: number
  amount_left: number; uploaded: number; downloaded: number; ratio: number; seeding_time: number
  dlspeed: number; upspeed: number; eta?: number; num_seeds: number; num_leechs: number; save_path: string; content_path?: string; added_on: number; tags?: string
}
export interface QbFile { index: number; name: string; size: number; progress: number; priority: number; piece_range: [number, number] }

let cookie = ''

async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const res = await fetch(config.qb.url + path, {
    ...init,
    headers: { ...(init.headers as any), ...(cookie ? { cookie } : {}), referer: config.qb.url },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  if (res.status === 403 && retry) {
    await login()
    return raw(path, init, false)
  }
  return res
}

async function login() {
  const res = await fetch(config.qb.url + '/api/v2/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: config.qb.url },
    body: new URLSearchParams({ username: config.qb.user, password: config.qb.pass }),
  })
  const text = await res.text()
  if (!res.ok || /fail/i.test(text)) throw new Error('qBittorrent login failed (check QB_USER / QB_PASS)')
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
}

async function json<T>(path: string): Promise<T> {
  const res = await raw(path)
  if (!res.ok) throw new Error(`qBittorrent ${path} -> HTTP ${res.status}`)
  return res.json() as Promise<T>
}
async function post(path: string, form: Record<string, string>) {
  const res = await raw(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  if (!res.ok) throw new Error(`qBittorrent ${path} -> HTTP ${res.status}: ${await res.text()}`)
}

/**
 * What `/api/v2/torrents/add` said, read as a refusal or not.
 *
 * qBittorrent 4 answers the add in plain text: "Ok." or "Fails.". 5.0 answers JSON such as
 * `{"added_torrent_ids":["…"],"success_count":1,"failure_count":0,"pending_count":0}` -- and
 * "failure_count":0 contains "fail", so the old /fail/i test called every good add a refusal.
 * Returns the reason when it really was refused, null when the torrent was taken.
 */
export function addRefusal(ok: boolean, body: string): string | null {
  const text = (body ?? '').trim()
  if (!ok) return text || 'HTTP error'
  if (/^fails\.?$/i.test(text)) return text
  if (text.startsWith('{') || text.startsWith('[')) {
    let j: any
    try { j = JSON.parse(text) } catch { return null } // unreadable body on a 200: the torrent was still taken
    const added = (Array.isArray(j?.added_torrent_ids) ? j.added_torrent_ids.length : 0) + Number(j?.success_count ?? 0) + Number(j?.pending_count ?? 0)
    if (!added && Number(j?.failure_count ?? 0) > 0) return text
  }
  return null
}

export const qb = {
  /** Drop the old session and prove the current URL/credentials work, then apply the engine preferences. */
  async reconnect(): Promise<string> {
    cookie = ''
    await login()
    await qb.setup()
    return qb.version()
  },
  async setup() {
    // Files must be readable in place while downloading: no ".!qB" suffix, no separate temp dir.
    await post('/api/v2/app/setPreferences', { json: JSON.stringify({
      incomplete_files_ext: false, temp_path_enabled: false, preallocate_all: false,
      auto_tmm_enabled: false, max_ratio_enabled: false, max_seeding_time_enabled: false,
      // The Downloads folder is qBittorrent's default too, so anything added by hand lands where Flix looks.
      save_path: config.downloadDir,
      // Peers have to be able to reach us for BTN's 1:1 ratio. A random port
      // moves every start, so no port forward on the router survives it: pin
      // it (QB_LISTEN_PORT, same number the container publishes) and ask the
      // router to open it with UPnP/NAT-PMP where the router can.
      listen_port: config.p2pPort, random_port: false, upnp: true,
    }) })
  },
  async version(): Promise<string> { return (await raw('/api/v2/app/version').then((r) => r.text())) },
  async info(hash: string): Promise<QbTorrent | undefined> {
    return (await json<QbTorrent[]>(`/api/v2/torrents/info?hashes=${hash}`))[0]
  },
  /** 'connected' (others can reach us), 'firewalled' (we can download but nobody can connect to us) or 'disconnected', plus the peer port. */
  async reachability(): Promise<{ status: string; port: number | null; upnp: boolean }> {
    const [t, p] = await Promise.all([json<{ connection_status?: string }>('/api/v2/transfer/info'), json<{ listen_port?: number; upnp?: boolean }>('/api/v2/app/preferences').catch(() => ({} as any))])
    return { status: t.connection_status ?? 'unknown', port: p.listen_port ?? null, upnp: !!p.upnp }
  },
  async infoAll(): Promise<QbTorrent[]> { return json('/api/v2/torrents/info?tag=flix') },
  /** Every torrent in the engine, whoever added it. */
  async listAll(): Promise<QbTorrent[]> { return json('/api/v2/torrents/info') },
  async addTags(hash: string, tags: string) { await post('/api/v2/torrents/addTags', { hashes: hash, tags }) },
  async setLocation(hash: string, location: string) { await post('/api/v2/torrents/setLocation', { hashes: hash, location }) },
  async files(hash: string): Promise<QbFile[]> { return json(`/api/v2/torrents/files?hash=${hash}`) },
  async pieceStates(hash: string): Promise<number[]> { return json(`/api/v2/torrents/pieceStates?hash=${hash}`) },
  async properties(hash: string): Promise<{ piece_size: number; save_path: string }> { return json(`/api/v2/torrents/properties?hash=${hash}`) },

  async add(torrentFile: Buffer, savePath: string) {
    const form = new FormData()
    form.set('torrents', new Blob([new Uint8Array(torrentFile)], { type: 'application/x-bittorrent' }), 'x.torrent')
    form.set('savepath', savePath)
    form.set('tags', 'flix')
    form.set('sequentialDownload', 'true')
    form.set('firstLastPiecePrio', 'true')
    form.set('autoTMM', 'false')
    const res = await raw('/api/v2/torrents/add', { method: 'POST', body: form })
    const text = await res.text()
    const refused = addRefusal(res.ok, text)
    if (refused) throw new Error(`qBittorrent refused the torrent: ${refused}`)
  },
  async filePrio(hash: string, ids: number[], priority: number) {
    if (ids.length) await post('/api/v2/torrents/filePrio', { hash, id: ids.join('|'), priority: String(priority) })
  },
  async resume(hash: string) { await post('/api/v2/torrents/resume', { hashes: hash }).catch(() => post('/api/v2/torrents/start', { hashes: hash })) },
  async remove(hash: string, deleteFiles: boolean) { await post('/api/v2/torrents/delete', { hashes: hash, deleteFiles: String(deleteFiles) }) },
}
