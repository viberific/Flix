/**
 * Search, as you type: punctuation does not count ("greys" finds Grey's Anatomy, "csi miami" finds CSI: Miami), and the best
 * matches come first -- the title itself, then titles that start with what was typed, then ones with a word that does, then
 * the rest -- rather than whatever was updated last.
 */
export const SEARCH_NORM_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(series), '''', ''), '’', ''), '.', ''), ':', ''), ',', ''), '!', ''), '-', ' ')`
export function searchNorm(s: string) { return s.toLowerCase().replace(/['’.:,!]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() }
export function searchRank(name: string, q: string) {
  const n = searchNorm(name), t = searchNorm(q)
  if (!t) return 0
  const bare = (x: string) => x.replace(/^(the|a|an) /, '')
  if (n === t || bare(n) === bare(t)) return 0
  if (n.startsWith(t) || bare(n).startsWith(bare(t))) return 1
  if ((' ' + n).includes(' ' + t)) return 2
  return 3
}
