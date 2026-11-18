/**
 * Search, as you type: punctuation does not count ("greys" finds Grey's Anatomy, "csi miami" finds CSI: Miami), and the best
 * matches come first -- the title itself, then titles that start with what was typed, then ones with a word that does, then
 * the rest -- rather than whatever was updated last.
 *
 * It is forgiving, too: a typo or two ("braking bad", "stranger thigns"), words in another order ("anatomy greys"), a space
 * too many or too few ("spider man" / "spiderman", "white lotus" for The White Lotus), accents ("pokemon" for Pokémon), "&"
 * for "and", and initials ("got", "hotd"). Those come after every plain match, closest first.
 */
export const SEARCH_NORM_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(series), '''', ''), '’', ''), '.', ''), ':', ''), ',', ''), '!', ''), '-', ' ')`

export function searchNorm(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’.:,!?()"]/g, '').replace(/[-/_]/g, ' ').replace(/\s+/g, ' ').trim()
}

const bare = (x: string) => x.replace(/^(the|a|an) /, '')
const compact = (x: string) => bare(x).replace(/ /g, '')
/** Words a person may type that a title can leave out, and the other way round. */
const LITTLE = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to'])

/** Edit distance with swapped neighbours counting as one edit ("thigns" -> "things"), giving up past `max`. */
export function editDistance(a: string, b: string, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let low = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur.push(v); if (v < low) low = v
    }
    if (low > max) return max + 1
    prev2 = prev; prev = cur
  }
  return prev[b.length]
}

/** How many typos a word of this length may carry and still count: none under four letters, then one, then two. */
const allowed = (len: number) => (len < 4 ? 0 : len < 7 ? 1 : 2)

/**
 * How well one typed word fits one word of a title, as a number of edits, or null when it does not. The last word being typed
 * may still be unfinished, so it is also compared with the start of the title's word ("strang" -> "stranger").
 */
function wordCost(q: string, w: string, typing: boolean) {
  if (w === q) return 0
  if (typing && w.startsWith(q)) return 0
  const max = allowed(q.length)
  if (!max) return null
  let d = editDistance(q, w, max)
  if (typing && w.length > q.length) d = Math.min(d, editDistance(q, w.slice(0, q.length), max))
  return d <= max ? d : null
}

/**
 * Where a title ranks for a query, lower first, or null when it is no match at all.
 *   0 the title itself · 1 starts with it · 2 a word starts with it · 3 found inside the title (spaces aside)
 *   4.x every typed word fits a word of the title, x = edits needed · 5 the title's initials · 6.x the whole title, misspelt
 */
const normed = new Map<string, string>()
/** A title's normal form, kept: the same few thousand titles are matched on every key press. */
function normName(name: string) {
  let n = normed.get(name)
  if (n === undefined) { if (normed.size > 50_000) normed.clear(); n = searchNorm(name); normed.set(name, n) }
  return n
}

export function searchScore(name: string, q: string): number | null {
  const n = normName(name), t = searchNorm(q)
  if (!t) return 0
  if (n === t || bare(n) === bare(t)) return 0
  if (n.startsWith(t) || bare(n).startsWith(bare(t))) return 1
  if ((' ' + n).includes(' ' + t)) return 2
  if (n.includes(t) || (compact(t).length >= 3 && compact(n).includes(compact(t)))) return 3
  const qw = t.split(' '), nw = n.split(' ')
  let total = 0, ok = true
  for (const [i, w] of qw.entries()) {
    const typing = i === qw.length - 1
    let best: number | null = null
    for (const x of nw) { const c = wordCost(w, x, typing); if (c !== null && (best === null || c < best)) best = c; if (best === 0) break }
    if (best === null) { if (LITTLE.has(w) && qw.length > 1) continue; ok = false; break }
    total += best
  }
  // A query of only little words ("the a") would otherwise match half the library.
  if (ok && qw.some((w) => !LITTLE.has(w))) return 4 + Math.min(total, 9) / 10
  const qc = t.replace(/ /g, '')
  if (qc.length >= 2 && nw.length >= 2) {
    const initials = nw.map((w) => w[0]).join(''), main = nw.filter((w) => !LITTLE.has(w)).map((w) => w[0]).join('')
    if (qc === initials || qc === main) return 5
  }
  const nc = compact(n), tc = compact(t), max = allowed(tc.length)
  if (max) {
    const d = Math.min(editDistance(tc, nc, max), nc.length > tc.length ? editDistance(tc, nc.slice(0, tc.length), max) : max + 1)
    if (d <= max) return 6 + d / 10
  }
  return null
}

/** The rank alone, for ordering titles already known to match; a title that does not match sorts last. */
export function searchRank(name: string, q: string) {
  return searchScore(name, q) ?? 99
}
