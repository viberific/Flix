import { config } from '../config.ts'

export interface BtnTorrent {
  GroupName: string; GroupID: string; TorrentID: string; SeriesID: string; Series: string
  SeriesBanner?: string; SeriesPoster?: string; YoutubeTrailer?: string
  ReleaseName: string; Category: string; Codec: string; Container: string; Source: string
  Resolution: string; Origin: string; Size: string; Time: string
  TvdbID?: string; TvrageID?: string; ImdbID?: string; InfoHash: string
  Genres?: string[]; Snatched?: string; Seeders?: string; Leechers?: string
  TorrentLink: string
}

export class RateLimitError extends Error {}
export class IpNotAuthorizedError extends Error {}

const calls: number[] = []

/** Minimal BTN JSON-RPC client with a local hourly budget so we never trip the API limit (150/h). */
export async function btnCall<T = any>(method: string, params: unknown[]): Promise<T> {
  if (!config.btn.apiKey) throw new Error('BTN_API_KEY is not configured')
  const cutoff = Date.now() - 3600_000
  while (calls.length && calls[0] < cutoff) calls.shift()
  if (calls.length >= config.btn.maxCallsPerHour) throw new RateLimitError('BTN API budget for this hour is used up; try again later')
  calls.push(Date.now())

  const res = await fetch(config.btn.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Flix/0.1' },
    body: JSON.stringify({ id: String(Date.now()), method, params: [config.btn.apiKey, ...params] }),
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 429) throw new RateLimitError('BTN rate-limited this request')
  if (!res.ok) throw new Error(`BTN API HTTP ${res.status}`)
  const body: any = await res.json()
  if (body.error) {
    // BTN signals most failures in the JSON-RPC error (HTTP is usually 200); code 0 is generic, so also rely on the message.
    if (body.error.code === -32002) throw new RateLimitError('BTN call limit exceeded; try again later')
    if (body.error.code === -32004) throw new IpNotAuthorizedError('BTN rejected this IP (-32004): approve this server\'s IP in your BTN API settings')
    throw new Error(`BTN API error: ${body.error.message ?? JSON.stringify(body.error)}`)
  }
  return body.result as T
}

/** getTorrents returns { results: "<total>", torrents: { "<id>": {...} } } (or [] when empty). */
export async function getTorrents(query: Record<string, unknown>, results = 100, offset = 0) {
  const r = await btnCall<{ results: string; torrents?: Record<string, BtnTorrent> | BtnTorrent[] }>('getTorrents', [query, results, offset])
  const list = Array.isArray(r.torrents) ? r.torrents : Object.values(r.torrents ?? {})
  return { total: Number(r.results ?? list.length), torrents: list }
}

/** Download the .torrent file server-side so the passkey-bearing URL never leaves this process. */
export async function fetchTorrentFile(link: string): Promise<Buffer> {
  const res = await fetch(link, { headers: { 'user-agent': 'Flix/0.1' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Failed to download .torrent (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf[0] !== 0x64) throw new Error('BTN did not return a valid .torrent file')
  return buf
}
