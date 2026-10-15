import { config } from '../config.ts'

export interface BtnTorrent {
  GroupName: string; GroupID: string; TorrentID: string; SeriesID: string; Series: string
  SeriesBanner?: string; SeriesPoster?: string; YoutubeTrailer?: string
  ReleaseName: string; Category: string; Codec: string; Container: string; Source: string
  Resolution: string; Origin: string; Size: string; Time: string
  TvdbID?: string; TvrageID?: string; ImdbID?: string; InfoHash: string
  Genres?: string[]; Tags?: string[]; Snatched?: string; Seeders?: string; Leechers?: string
  /** BTN v1 calls it DownloadURL; older revisions called it TorrentLink. The client fills both. */
  DownloadURL?: string
  TorrentLink?: string
}

export class RateLimitError extends Error {}

const calls: number[] = []

/** Minimal BTN JSON-RPC client with a local hourly budget so we never trip the API limit (150/h). */
export async function btnCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!config.btn.apiKey) throw new Error('BTN_API_KEY is not configured')
  const cutoff = Date.now() - 3600_000
  while (calls.length && calls[0] < cutoff) calls.shift()
  if (calls.length >= config.btn.maxCallsPerHour) throw new RateLimitError('BTN API budget for this hour is used up; try again later')
  calls.push(Date.now())

  const res = await fetch(config.btn.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Flix/0.1' },
    // Documented envelope: one object, no jsonrpc field, a non-empty id, and every argument
    // (the key included) inside params. An empty/absent id makes the call a notification and
    // the server answers 200 with no body at all.
    body: JSON.stringify({ id: 1, method, params: { key: config.btn.apiKey, ...params } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 429) throw new RateLimitError('BTN rate-limited this request')
  const text = await res.text()
  let body: any // parsed below
  try { body = JSON.parse(text) } catch {
    // A getTorrents call without `search` is refused before dispatch, with an empty 500 body,
    // so the hint belongs to that method only.
    const hint = method === 'getTorrents' && params.search === undefined ? ' - getTorrents requires a search argument' : ''
    throw new Error(`BTN API returned no JSON (HTTP ${res.status})${hint}`)
  }
  if (body?.error) {
    const code = body.error.code
    const msg = body.error.message ?? JSON.stringify(body.error)
    if (code === -32002) throw new RateLimitError(`BTN call limit exceeded: ${msg}`)
    // -32004 covers two different things: an address BTN has never seen (logged as pending) and
    // one it has seen and denied. Only the first is fixed by approving it on the site.
    if (code === -32004) throw new Error(/denied/i.test(msg)
      ? `BTN refused this IP address (${msg}). The address is known to BTN and explicitly denied: re-authorising it is a change on the BTN site, not something this client can retry past.`
      : `BTN will not answer this IP address (${msg}). The address has been filed as pending: approve it from your notices on BTN, then retry.`)
    if (code === -32005) throw new Error('BTN requires HTTPS and refused this request before dispatch: BTN_API_URL must be the https:// API endpoint.')
    if (code === -32003) throw new Error(`BTN says this account is disabled (${msg}) - BTN_API_KEY belongs to a disabled account. Check the account on the BTN site.`)
    if (code === -32001) throw new Error('BTN rejected BTN_API_KEY as an invalid API key. The key is on your profile on the BTN site — it is not your site password.')
    throw new Error(`BTN API error ${code ?? ''}: ${msg}`.trim())
  }
  return body?.result as T
}

/** getTorrents returns { results: "<total>", torrents: { "<id>": {...} } } (or [] when empty). */
export async function getTorrents(query: Record<string, unknown>, results = 100, offset = 0) {
  const r = await btnCall<{ results?: string; torrents?: Record<string, BtnTorrent> | BtnTorrent[] }>('getTorrents',
    { search: query ?? {}, results: Math.min(results, 1000), offset })
  const list = Array.isArray(r?.torrents) ? r.torrents : Object.values(r?.torrents ?? {})
  // torrents is omitted entirely when nothing matches; DownloadURL is the v1 name for the download link.
  for (const t of list) if (!t.TorrentLink && t.DownloadURL) t.TorrentLink = t.DownloadURL
  return { total: Number(r?.results ?? list.length), torrents: list }
}

/** Download the .torrent file server-side so the passkey-bearing URL never leaves this process. */
export async function fetchTorrentFile(link: string): Promise<Buffer> {
  const res = await fetch(link, { headers: { 'user-agent': 'Flix/0.1' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Failed to download .torrent (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf[0] !== 0x64) throw new Error('BTN did not return a valid .torrent file')
  return buf
}
