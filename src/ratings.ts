import { db, now } from './db.ts'
import { config } from './config.ts'
import { backgroundRunAllowed } from './transcode.ts'
import { tvmazeLookup } from './networks.ts'

/** US TV Parental Guidelines (BTN is TV-only). Movie-style ratings are mapped onto these. */
export const RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'Unrated'] as const
export type Rating = (typeof RATINGS)[number]
export const isRating = (v: unknown): v is Rating => RATINGS.includes(v as Rating)

export function normalizeRating(raw?: string | null): Rating {
  const r = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^(TV-?Y)$/.test(r)) return 'TV-Y'
  if (/^TV-?Y7(-FV)?$/.test(r)) return 'TV-Y7'
  if (/^(TV-?G|G)$/.test(r)) return 'TV-G'
  if (/^(TV-?PG|PG)$/.test(r)) return 'TV-PG'
  if (/^(TV-?14|PG-?13|14\+?)$/.test(r)) return 'TV-14'
  if (/^(TV-?MA|R|NC-?17|MA|17\+?|18\+?)$/.test(r)) return 'TV-MA'
  return 'Unrated'
}

db.exec(`CREATE TABLE IF NOT EXISTS series_meta (
  series_id INTEGER PRIMARY KEY, rating TEXT NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL
)`)
try { db.exec('ALTER TABLE series_meta ADD COLUMN imdb_score REAL') } catch { /* already present */ }
try { db.exec('ALTER TABLE users ADD COLUMN allowed_ratings TEXT') } catch { /* already present */ }
// The backlog sweep's own bookkeeping. `rating_tries` is its cursor as well as its backoff: the shows tried longest ago
// come first, so a sweep stopped by a restart, a play or the daily cap carries on where it left off instead of starting over.
db.exec(`CREATE TABLE IF NOT EXISTS rating_tries (
  series_id INTEGER PRIMARY KEY, tries INTEGER NOT NULL DEFAULT 0, last_try INTEGER NOT NULL, last_error TEXT
)`)
// How many OMDb lookups have been spent on each day (UTC). The free plan is 1,000 and going over it is not polite.
db.exec(`CREATE TABLE IF NOT EXISTS rating_calls (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)`)
try { db.exec('ALTER TABLE series_meta ADD COLUMN imdb_id TEXT') } catch { /* already present */ }
// Ratings are always automatic now: a rating an admin once set by hand is dropped and looked up again.
db.exec(`DELETE FROM series_meta WHERE source = 'admin'`)

export function getRating(seriesId: number): { rating: Rating; source: string; score: number | null } {
  const r = db.prepare('SELECT rating, source, imdb_score FROM series_meta WHERE series_id = ?').get(seriesId) as any
  return r ? { rating: r.rating, source: r.source, score: r.imdb_score ?? null } : { rating: 'Unrated', source: 'none', score: null }
}

/** null = no restriction. An empty array blocks everything. */
export type Allowed = Rating[] | null
export function parseAllowed(json: string | null | undefined): Allowed {
  if (!json) return null
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter(isRating) : null } catch { return null }
}
export function cleanAllowed(v: unknown): Allowed {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v) || !v.every(isRating)) throw Object.assign(new Error('Invalid ratings list'), { statusCode: 400 })
  return RATINGS.every((r) => v.includes(r)) ? null : [...new Set(v)] // everything ticked == unrestricted
}

interface Viewer { is_admin: number; allowed: Allowed }
export function canView(u: Viewer | null | undefined, rating: Rating): boolean {
  return !u || !!u.is_admin || u.allowed === null || u.allowed.includes(rating)
}
export function canViewSeries(u: Viewer | null | undefined, seriesId: number): boolean {
  return canView(u, getRating(seriesId).rating)
}

/** SQL fragment restricting a query that joins `series_meta` as (m_sid, m_rating). */
export const META_JOIN = `LEFT JOIN (SELECT series_id AS m_sid, rating AS m_rating, imdb_score AS m_score FROM series_meta) m ON m.m_sid = `
export function ratingClause(u: Viewer | null | undefined): { sql: string; params: string[] } {
  if (!u || u.is_admin || u.allowed === null) return { sql: '1=1', params: [] }
  if (!u.allowed.length) return { sql: '0', params: [] }
  return { sql: `COALESCE(m.m_rating, 'Unrated') IN (${u.allowed.map(() => '?').join(',')})`, params: [...u.allowed] }
}

//---- automatic lookup (IMDb through OMDb, then TMDB) ------------------------------------------------------

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * OMDb's free plan is 1,000 lookups a day, and going over it is not polite: the key simply stops answering. The count is
 * kept in the database under the UTC day, so a restart does not start the day's thousand over again.
 */
const utcDay = (at = now()) => new Date(at * 1000).toISOString().slice(0, 10)
export function omdbCallsToday(at = now()): number {
  const r = db.prepare('SELECT calls FROM rating_calls WHERE day = ?').get(utcDay(at)) as any
  return Number(r?.calls ?? 0)
}
export const omdbBudgetLeft = (at = now()) => Math.max(0, config.ratings.omdbDailyCap - omdbCallsToday(at))
/** OMDb has refused us (a wrong key, or its own daily limit): stop asking until the day is out, not once per show. */
let omdbPausedUntil = 0
/** When the sweep last said it was standing down for a play, so it says so once an hour and not once every ten minutes. */
let heldLoggedAt = 0
const pausedError = (why: string) => Object.assign(new Error(`OMDb: ${why}`), { paused: true })
const tomorrow = (at = now()) => (Math.floor(at / 86_400) + 1) * 86_400

/** One OMDb lookup, counted against the day's cap before it is made. null: OMDb does not know this title or id. */
async function omdbGet(query: string, at = now()): Promise<any | null> {
  const { apiKey, apiUrl } = config.omdb
  if (!apiKey) throw pausedError('no key')
  if (Date.now() / 1000 < omdbPausedUntil) throw pausedError('paused after a refusal')
  if (omdbBudgetLeft(at) <= 0) { omdbPausedUntil = tomorrow(at); throw pausedError(`the ${config.ratings.omdbDailyCap} a day are used up`) }
  db.prepare('INSERT INTO rating_calls (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(utcDay(at))
  const j = await getJson(`${apiUrl}/?${query}&apikey=${encodeURIComponent(apiKey)}`)
  if (j?.Response === 'False') {
    // A refused key or the plan's own limit: nothing else will answer today either.
    if (/invalid api key|limit reached|request limit|exceeded/i.test(String(j.Error))) { omdbPausedUntil = tomorrow(at); throw pausedError(String(j.Error)) }
    return null
  }
  return j
}

/** IMDb's own certificate ("TV-MA") and score for a title. IMDb has no public API and blocks scraping; OMDb serves its data. */
export async function lookupImdb(imdb: string, at = now()): Promise<{ rating: Rating | null; score: number | null }> {
  const j = await omdbGet(`i=${encodeURIComponent(imdb)}`, at)
  return j ? splitOmdb(j) : { rating: null, score: null } // an id OMDb does not know says nothing, and costs one lookup
}

function splitOmdb(j: any) {
  const rated = String(j.Rated ?? '')
  const score = Number(j.imdbRating)
  return { rating: !rated || rated === 'N/A' ? null : normalizeRating(rated), score: Number.isFinite(score) && score > 0 ? score : null }
}

/** OMDb by title (`?t=`): what is asked when no release of a show carries an IMDb id and nothing else resolves one. */
async function lookupImdbTitle(title: string, at = now()): Promise<{ rating: Rating | null; score: number | null }> {
  const j = await omdbGet(`t=${encodeURIComponent(title)}`, at)
  return j ? splitOmdb(j) : { rating: null, score: null }
}

async function lookupTmdb(tvdbId: number): Promise<Rating | null> {
  const { apiKey, apiUrl } = config.tmdb
  const j = (path: string) => getJson(`${apiUrl}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`)
  const found = await j(`/find/${tvdbId}?external_source=tvdb_id`)
  const id = found.tv_results?.[0]?.id
  if (!id) return null
  const cr = await j(`/tv/${id}/content_ratings`)
  const us = (cr.results ?? []).find((x: any) => x.iso_3166_1 === 'US')
  return us?.rating ? normalizeRating(us.rating) : null
}

/** BTN gives either "tt0903747" or the bare number. */
const imdbId = (v: unknown) => { const m = /^(?:tt)?(\d{5,10})$/i.exec(String(v ?? '').trim()); return m ? `tt${m[1]}` : null }

const failedAt = new Map<number, number>()
const pending = new Set<number>()
let active = 0
const queue: number[] = []
/** What a lookup found: a score, a rating, both, or nothing -- and whether it was even asked. */
interface Looked { rating: Rating | null; score: number | null; source: string; asked: boolean; error: string | null; paused: boolean }

/**
 * Everything known about one show, asked in the cheapest order there is: OMDb by the IMDb id a release already carries;
 * failing that a free TVmaze lookup (by TVDB id, then by title) to find one -- 724 of the box's 2,425 shows carry no IMDb
 * id on any release, and with nothing to ask OMDb about they could never get a score; OMDb by title if that found nothing;
 * and TMDB's certificate for the rating alone, which needs a TVDB id. Nothing is written down unless something was learnt,
 * so a show asked while OMDb was refusing is not left looking answered.
 */
async function lookUp(seriesId: number, at: number): Promise<Looked> {
  const row = db.prepare('SELECT series, tvdb_id, imdb_id FROM releases WHERE series_id = ? ORDER BY tvdb_id IS NULL LIMIT 1').get(seriesId) as any
  const stored = db.prepare('SELECT imdb_id FROM series_meta WHERE series_id = ?').get(seriesId) as any
  const title = row?.series ?? null
  const tvdb = Number(row?.tvdb_id) || null
  let imdb = imdbId(stored?.imdb_id) ?? imdbId(row?.imdb_id)
  let rating: Rating | null = null, score: number | null = null, source = 'imdb', error: string | null = null, asked = false, paused = false
  const ask = async (fn: () => Promise<{ rating: Rating | null; score: number | null }>) => {
    try { const r = await fn(); asked = true; rating = rating ?? r.rating; score = score ?? r.score } catch (e: any) { asked = true; if (e?.paused) paused = true; error ??= String(e?.message ?? e) }
  }
  if (config.omdb.apiKey) {
    if (imdb) await ask(() => lookupImdb(imdb!, at))
    // No id on any release: TVmaze knows one for most shows and asks nothing of the OMDb budget.
    if (!score && !rating && !imdb && (tvdb || title)) {
      const found = await tvmazeLookup({ series: title ?? '', tvdb_id: tvdb, imdb_id: null }).catch(() => null)
      imdb = imdbId(found?.externals?.imdb)
      if (imdb) await ask(() => lookupImdb(imdb!, at))
    }
    // Still nothing known about it: ask OMDb about the title itself (`?t=`).
    if (!score && !rating && !imdb && title) await ask(() => lookupImdbTitle(title, at))
  }
  if (!rating && tvdb && config.tmdb.apiKey) {
    try { const r = await lookupTmdb(tvdb); if (r) { rating = r; source = 'tmdb' } } catch (e: any) { error ??= String(e?.message ?? e) }
  }
  if ((rating || score) && !paused) {
    db.prepare(`INSERT OR REPLACE INTO series_meta (series_id, rating, source, fetched_at, imdb_score, imdb_id) VALUES (?,?,?,?,?,?)`)
      .run(seriesId, rating ?? 'Unrated', rating ? source : 'imdb', at, score, imdb)
  }
  return { rating, score, source, asked, error, paused }
}

/** The shows with no score, never tried first and then the ones tried longest ago: the sweep's cursor, kept in the table.
    The retry windows in the SQL below are the same schedule retryAfterSec documents: a day, then two, four, eight, sixteen. */
export const retryAfterSec = (tries: number) => 86_400 * Math.min(16, 2 ** Math.max(0, tries - 1))
export function nextRatingCandidates(limit: number, at = now()) {
  return db.prepare(`SELECT r.series_id AS id, MAX(r.series) AS series, COALESCE(t.tries, 0) AS tries, t.last_try AS last_try
    FROM releases r
    LEFT JOIN series_meta m ON m.series_id = r.series_id
    LEFT JOIN rating_tries t ON t.series_id = r.series_id
    WHERE r.series_id IS NOT NULL AND m.imdb_score IS NULL
      AND (t.last_try IS NULL OR t.last_try + 86_400 * CASE WHEN t.tries <= 1 THEN 1 WHEN t.tries = 2 THEN 2 WHEN t.tries = 3 THEN 4 WHEN t.tries = 4 THEN 8 ELSE 16 END <= ?)
    GROUP BY r.series_id
    ORDER BY COALESCE(t.last_try, 0) ASC, r.series_id ASC
    LIMIT ?`).all(at, limit) as { id: number; series: string | null; tries: number; last_try: number | null }[]
}

/** How many shows still have no IMDb score at all. */
export const missingScores = () => (db.prepare(`SELECT COUNT(DISTINCT series_id) AS n FROM releases
  WHERE series_id IS NOT NULL AND series_id NOT IN (SELECT series_id FROM series_meta WHERE imdb_score IS NOT NULL)`).get() as any).n as number

export interface SweepReport { tried: number; filled: number; unrated: number; left: number; calls: number; cap: number; paused: boolean }

/**
 * One pass of the backlog: the shows with no score, oldest attempt first, two at a time, and never past OMDb's daily cap.
 * Resumable by construction -- what it learned is the `rating_tries` row that puts a show at the back of the queue -- and
 * it does nothing at all while somebody is watching, because this is background work and the box has four cores.
 */
export async function sweepRatings(opts: { limit?: number; at?: number } = {}): Promise<SweepReport | null> {
  const at = opts.at ?? now()
  if (!config.omdb.apiKey && !config.tmdb.apiKey) return null
  if (!backgroundRunAllowed({ low: true })) {
    // Once an hour at most: a line per sweep would be noise while a show is on.
    if (Date.now() - heldLoggedAt > 3600_000) { heldLoggedAt = Date.now(); console.log('[ratings] sweep: held, somebody is watching') }
    return null
  }
  // A fifth of the day is kept back for the shows somebody actually opens: a page's own score matters more than a
  // backlog row, and the page lookups share the same cap. Never more than 200, and nothing at all on a small cap.
  const reserve = Math.min(200, Math.floor(config.ratings.omdbDailyCap * 0.2))
  const budget = Math.max(0, omdbBudgetLeft(at) - reserve)
  const want = Math.max(0, Math.min(opts.limit ?? config.ratings.sweepBatch, budget))
  const batch = want ? nextRatingCandidates(want, at) : []
  let tried = 0, filled = 0, unrated = 0, paused = !!config.omdb.apiKey && budget <= 0
  for (let i = 0; i < batch.length; i += 2) {
    await Promise.all(batch.slice(i, i + 2).map(async ({ id }: { id: number }) => {
      const r = await lookUp(id, at)
      tried++
      if (r.score != null) filled++
      else if (r.rating) unrated++
      if (r.paused) { paused = true; return } // OMDb is out for the day: the rest keep their place
      // A refusal from OMDb is not this show's fault, so no try is recorded for it and it comes back first tomorrow.
      if (r.asked || r.error) db.prepare(`INSERT INTO rating_tries (series_id, tries, last_try, last_error) VALUES (?,1,?,?)
        ON CONFLICT(series_id) DO UPDATE SET tries = tries + 1, last_try = excluded.last_try, last_error = excluded.last_error`).run(id, at, r.error)
      if (r.error) console.warn(`[ratings] series ${id}: ${r.error}`)
    }))
    if (paused) break
  }
  const left = missingScores()
  db.prepare('DELETE FROM rating_calls WHERE day < ?').run(utcDay(at - 7 * 86_400))
  // One line per sweep, so the backlog can be watched in flix.log: `docker logs flix` / the log file beside the app.
  console.log(`[ratings] sweep: ${tried} asked, ${filled} scored, ${unrated} rated only, ${left} still missing, OMDb ${omdbCallsToday(at)}/${config.ratings.omdbDailyCap} today${paused ? ' (paused)' : ''}`)
  return { tried, filled, unrated, left, calls: omdbCallsToday(at), cap: config.ratings.omdbDailyCap, paused }
}

/** The sweep on its own clock: a first pass a minute and a half in (not while the box is still starting up), then every
    RATINGS_SWEEP_SEC. Nothing it does is urgent, and it never runs while the picture has the box. */
export function startRatingSweeper() {
  const run = () => sweepRatings().catch((e: any) => console.warn(`[ratings] sweep failed: ${e.message}`))
  setTimeout(run, 90_000).unref()
  setInterval(run, Math.max(60, config.ratings.sweepIntervalSec) * 1000).unref()
  return run
}

/**
 * Fire-and-forget: fetch a rating for a show if we have none, or only an old one. A row with no score is not an answer --
 * the score is what the sweep exists to fill -- so it is asked again a day later rather than a week (an 'Unrated' written
 * while OMDb was rate limited used to look fresh for a week and was never asked again).
 */
export function queueRating(seriesId: number, force = false) {
  if ((!config.omdb.apiKey && !config.tmdb.apiKey) || pending.has(seriesId)) return
  const have = db.prepare('SELECT fetched_at, imdb_score FROM series_meta WHERE series_id = ?').get(seriesId) as any
  const keep = have && have.imdb_score != null ? 7 * 86_400 : 86_400
  if (!force && have && have.fetched_at > now() - keep) return
  if (!force && (failedAt.get(seriesId) ?? 0) > Date.now() - 6 * 3600_000) return
  pending.add(seriesId); queue.push(seriesId); pump()
}
function pump() {
  while (active < 2 && queue.length) {
    const id = queue.shift()!
    active++
    ;(async () => {
      try {
        const r = await lookUp(id, now())
        if (r.asked && !r.paused) db.prepare(`INSERT INTO rating_tries (series_id, tries, last_try, last_error) VALUES (?,1,?,?)
          ON CONFLICT(series_id) DO UPDATE SET tries = tries + 1, last_try = excluded.last_try, last_error = excluded.last_error`).run(id, now(), r.error)
        if (r.error && !r.paused) console.warn(`[ratings] series ${id}: ${r.error}`)
      } catch (e: any) { failedAt.set(id, Date.now()); console.warn(`[ratings] series ${id}: ${e.message}`) }
      finally { active--; pending.delete(id); pump() }
    })()
  }
}

/**
 * Look up every show that has no IMDb score yet, whatever was fetched before. Called when an OMDb key is saved -- the
 * backlog of shows nobody has opened a page for is the sweep's job, and this drops the retry windows so it starts now
 * rather than in a day.
 */
export function refreshRatings() {
  failedAt.clear(); omdbPausedUntil = 0
  db.exec('DELETE FROM rating_tries') // a new (or fixed) key: ask about everything missing again, never-tried first
  const n = missingScores()
  void sweepRatings()
  return n
}
