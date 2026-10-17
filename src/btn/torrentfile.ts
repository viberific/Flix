/** Just enough bencode to read the file list out of a .torrent, so a season pack can be listed without downloading it. */
type B = number | Buffer | B[] | { [k: string]: B }

function decode(buf: Buffer, at = 0): [B, number] {
  const c = buf[at]
  if (c === 0x69) { // i<n>e
    const e = buf.indexOf(0x65, at)
    return [Number(buf.toString('latin1', at + 1, e)), e + 1]
  }
  if (c === 0x6c || c === 0x64) { // l...e / d...e
    const list: B[] = []
    let i = at + 1
    while (buf[i] !== 0x65) { if (i >= buf.length) throw new Error('truncated torrent'); const [v, n] = decode(buf, i); list.push(v); i = n }
    if (c === 0x6c) return [list, i + 1]
    const d: { [k: string]: B } = {}
    for (let k = 0; k < list.length; k += 2) d[(list[k] as Buffer).toString('utf8')] = list[k + 1]
    return [d, i + 1]
  }
  const colon = buf.indexOf(0x3a, at)
  const len = Number(buf.toString('latin1', at, colon))
  if (!Number.isInteger(len) || colon < 0 || colon + 1 + len > buf.length) throw new Error('bad torrent')
  return [buf.subarray(colon + 1, colon + 1 + len), colon + 1 + len]
}

export interface TorrentFile { path: string; size: number }

/** Files of a .torrent as "<name>/<path>" (the layout qBittorrent saves them in), in torrent order. */
export function torrentFiles(torrent: Buffer): TorrentFile[] {
  const [root] = decode(torrent)
  const info = (root as { [k: string]: B }).info as { [k: string]: B } | undefined
  if (!info || Buffer.isBuffer(info) || typeof info !== 'object') throw new Error('not a torrent')
  const name = Buffer.isBuffer(info.name) ? info.name.toString('utf8') : ''
  if (!Array.isArray(info.files)) return [{ path: name, size: Number(info.length ?? 0) }]
  return (info.files as { [k: string]: B }[]).map((f) => ({
    path: [name, ...(f.path as Buffer[]).map((p) => p.toString('utf8'))].join('/'),
    size: Number(f.length ?? 0),
  }))
}
