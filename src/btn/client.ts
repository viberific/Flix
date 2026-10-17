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
/** BTN answered -32004: this server's IP is unrecognised or denied. server.ts maps it to HTTP 403. */
export class IpNotAuthorizedError extends Error {}

const calls: number[] = []

/** API calls still available this hour under our own budget. */
export function btnBudgetLeft(): number {
  const cutoff = Date.now() - 3600_000
  while (calls.length && calls[0] < cutoff) calls.shift()
  return Math.max(0, config.btn.maxCallsPerHour - calls.length)
}

/** What the last BTN call told us, for the admin's health banner. Rate limits are not failures and are not recorded. */
export const btnState: { ok: boolean | null; kind?: 'ip' | 'key' | 'account' | 'offline' | 'error'; message?: string; at?: number } = { ok: null }

export async function btnCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    const r = await rawBtnCall<T>(method, params)
    btnState.ok = true; btnState.kind = undefined; btnState.message = undefined; btnState.at = Date.now()
    return r
  } catch (e: any) {
    if (!(e instanceof RateLimitError) && e.message !== 'BTN_API_KEY is not configured') {
      btnState.ok = false; btnState.at = Date.now(); btnState.message = e.message
      btnState.kind = e instanceof IpNotAuthorizedError ? 'ip' : /invalid API key/i.test(e.message) ? 'key' : /account is disabled/i.test(e.message) ? 'account'
        : /fetch failed|timed out|aborted|ENOTFOUND|ECONN/i.test(`${e.message} ${e.cause?.code ?? ''}`) ? 'offline' : 'error'
    }
    throw e
  }
}

/** Minimal BTN JSON-RPC client with a local hourly budget so we never trip the API limit (150/h). */
async function rawBtnCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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
    // -32004 covers two different things, and only one is fixed by approving the address on
    // the site. BTN sends exactly two messages here: "IP address needs authorization - please
    // check your notices on BTN" (unrecognised, logged as pending) and "Unauthorized IP address"
    // (known and explicitly denied). Note neither contains the word "denied".
    if (code === -32004) {
      const denied = /unauthorized|denied|refus|blocked/i.test(msg)
      const pending = /needs authoriz|not authoriz|pending/i.test(msg)
      throw new IpNotAuthorizedError(denied && !pending
        ? `BTN refused this IP address (${msg}). The address is known to BTN and explicitly denied: re-authorising it is a change on the BTN site, not something this client can retry past.`
        : pending
          ? `BTN will not answer this IP address (${msg}). The address has been filed as pending: approve it from your notices on BTN, then retry.`
          // Wording BTN has not used before: name both meanings rather than send the user to
          // approve an address that may have been refused.
          : `BTN will not answer this IP address (${msg}). -32004 means the address is either unrecognised (logged as pending on BTN, and approved from your notices there) or known and explicitly denied. Check your notices on BTN to see which.`)
    }
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
