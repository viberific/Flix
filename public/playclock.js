/**
 * Is the show actually playing? One question, in one place, because getting it wrong is invisible in every test that uses a
 * tidy fake and glaring on a real television.
 *
 * The rule used to be "the clock went forward since the last look" (t > seenT + 0.2, and the same idea in ontimeupdate as
 * `moving ||`). That is not what playing means. A seek moves the clock BACKWARDS, a source swap restarts it, and a resumed
 * copy can jump either way -- and after any of those the old rule never fired again, so the logo overlay stayed up over a
 * picture that was plainly running, with the sound going. Single Ladies S01E01 at 19:12 was exactly that: the HLS copy plan
 * re-seeking to 1152.3 s every few seconds, the clock never going forward across a look, and the wait screen sitting there.
 *
 * What does prove it: the element is not paused, not ended, readyState says there is data at the playhead (2 =
 * HAVE_CURRENT_DATA, which is enough to show a frame), and a buffered range really does reach the playhead. The last part
 * keeps it honest on a player that reports 2 while it waits for a seek to arrive, so a genuine wait still shows its ring.
 */

/** Whether the media element holds data at `t` -- a range that ends after it, and starts at or before it. */
export function holdsDataAt(v, t) {
  if (!v || !Number.isFinite(t)) return false
  try {
    const b = v.buffered
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t + 0.05) return true
  } catch { /* no ranges yet, which is not "playing" */ }
  return false
}

/** Whether the element is playing, whatever direction its clock last moved in. */
export function isPlaying(v) {
  return !!v && !v.paused && !v.ended && v.readyState >= 2 && holdsDataAt(v, v.currentTime)
}
