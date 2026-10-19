import type { Episode } from './episodes.ts'

/** How far into an episode counts as "they have started it". One number for the gate and for the downloader's own rule. */
export const STARTED_AT = 30

export interface Gate {
  /** True when the episode may not be started yet. */
  locked: boolean
  /** The episode that has to be watched first, by label ("S01E03"), or null when it is not locked. */
  after: string | null
}

/** "S01E03" reads as "E03" in a note; anything else is left as it is. */
export function shortEp(label: string): string {
  const m = /^S\d+\s*E(\d+)/i.exec(label)
  return m ? `E${m[1]}` : label
}

/** The one line a locked episode says when it is pressed: short, and it names the episode that comes first. */
export const gatedNote = (after: string) => `Watch ${shortEp(after)} first`

/**
 * One, two, three. An episode may be started when it is the first of the show, or the episode just before it has been
 * watched or started, or this one has been started itself (so a resume is never blocked by its own gate). Nothing else
 * is: the point is that nobody skips ahead and leaves a download nobody is going to watch holding the disk.
 *
 * Progress only -- what a device has saved offline is the client's own business, because that copy plays without the
 * server. `eps` must be in playing order, which is what buildEpisodes returns.
 */
export function gatesFor(eps: Pick<Episode, 'watched' | 'position' | 'label'>[]): Gate[] {
  return eps.map((e, i) => {
    if (i === 0 || e.watched || e.position > STARTED_AT) return { locked: false, after: null }
    const prev = eps[i - 1]
    if (prev.watched || prev.position > STARTED_AT) return { locked: false, after: null }
    return { locked: true, after: prev.label }
  })
}
