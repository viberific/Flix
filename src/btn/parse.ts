export interface Parsed { season: number | null; episode: number | null; episodeEnd: number | null; label: string; isPack: boolean }

const pad = (n: number | string) => String(n).padStart(2, '0')

/**
 * Season/episode out of a release or file name: "S02E05", a double episode "S02E05E06" / "S02E05-E06", or "2x05".
 * `episodeEnd` is the last episode a multi-episode file covers (equal to `episode` for a normal one).
 */
export function parseEpisodeTag(s: string): { season: number; episode: number; episodeEnd: number } | null {
  const m = /S(\d{1,3})[ ._-]?E(\d{1,4})(?:[ ._-]?(?:E|-E?)(\d{1,4}))?/i.exec(s) ?? /(?<![\d.])(\d{1,2})x(\d{2,3})(?![\dpi])/i.exec(s)
  if (!m) return null
  const episode = +m[2], last = m[3] ? +m[3] : episode
  return { season: +m[1], episode, episodeEnd: last >= episode && last - episode < 30 ? last : episode }
}

/** Derive season/episode from a BTN GroupName like "Show - S02E05", "Show - Season 2" or "Show - 2024.03.01". */
export function parseGroupName(groupName: string, category?: string): Parsed {
  const tail = groupName.includes(' - ') ? groupName.slice(groupName.lastIndexOf(' - ') + 3) : groupName
  const tag = parseEpisodeTag(tail)
  if (tag) {
    const label = `S${pad(tag.season)}E${pad(tag.episode)}`
    return { season: tag.season, episode: tag.episode, episodeEnd: tag.episodeEnd, label, isPack: false }
  }
  let m = /Season\s+(\d{1,3})/i.exec(tail)
  if (m || category === 'Season') return { season: m ? +m[1] : null, episode: null, episodeEnd: null, label: m ? `Season ${+m[1]}` : tail, isPack: true }
  m = /(\d{4})[.-](\d{2})[.-](\d{2})/.exec(tail)
  if (m) return { season: +m[1], episode: null, episodeEnd: null, label: `${m[1]}-${m[2]}-${m[3]}`, isPack: false }
  return { season: null, episode: null, episodeEnd: null, label: tail, isPack: category === 'Season' }
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|mov|wmv|webm)$/i
export const isVideo = (name: string) => VIDEO_EXT.test(name) && !/(^|[\\/])sample[^\\/]*$/i.test(name)
