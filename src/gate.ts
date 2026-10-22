import type { Episode } from './episodes.ts'

/** How far into an episode counts as "they have started it".  */
export const STARTED_AT = 30

/** "S01E03" reads as "E03" in a note; anything else is left as it is. */
export function shortEp(label: string): string {
  const m = /^S\d+\s*E(\d+)/i.exec(label)
  return m ? `E${m[1]}` : label
}
