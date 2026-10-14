export interface Parsed { season: number | null; episode: number | null; label: string; isPack: boolean }

/** Derive season/episode from a BTN GroupName like "Show - S02E05", "Show - Season 2" or "Show - 2024.03.01". */
export function parseGroupName(groupName: string, category?: string): Parsed {
  const tail = groupName.includes(' - ') ? groupName.slice(groupName.lastIndexOf(' - ') + 3) : groupName
  let m = /S(\d{1,3})E(\d{1,4})/i.exec(tail)
  if (m) return { season: +m[1], episode: +m[2], label: `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`, isPack: false }
  m = /Season\s+(\d{1,3})/i.exec(tail)
  if (m || category === 'Season') return { season: m ? +m[1] : null, episode: null, label: m ? `Season ${+m[1]}` : tail, isPack: true }
  m = /(\d{4})[.-](\d{2})[.-](\d{2})/.exec(tail)
  if (m) return { season: +m[1], episode: null, label: `${m[1]}-${m[2]}-${m[3]}`, isPack: false }
  return { season: null, episode: null, label: tail, isPack: category === 'Season' }
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|mov|wmv|webm)$/i
export const isVideo = (name: string) => VIDEO_EXT.test(name) && !/(^|[\\/])sample[^\\/]*$/i.test(name)
