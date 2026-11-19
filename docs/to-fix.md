# To fix

What is still open after the polish and playback work of 0.3.118–0.3.125 (2026-11-18). Most important first.

## Check on the real box

Everything below was tested with the test suite and placeholder shows in a headless browser, never with real episodes on
real devices.

- [ ] **5.1 on the TV app** (0.3.127): on the TV, an AC-3 / E-AC-3 episode should play through the app's own player:
      the log's `chose how to play` says mode `direct` with `can` including `ac3,eac3`, the TV or soundbar shows Dolby
      Digital / Dolby Digital Plus, it starts as fast as an anime episode, and seeking, pause, subtitles, resume and Up next
      all work as before. If the native player fails, the player falls back to the converted playlist by itself (look for
      `recover` with `why: "error"` and a `native:` message). Needs the new APK installed on the TV.
- [ ] **Cold 5.1 episodes** (0.3.127): a never-played AC-3/E-AC-3 episode should reach its first frame in about 15 s or
      less, with no stop-and-restart at 30 s. Look for `stuckwait` (the player waiting on a box that is still cutting
      instead of starting again), `read the subtitle out after the first pieces` (the subtitle held back while the opening
      is cut), and in the background `read the subtitle out ahead of the play`. An anime (AAC) episode must still say
      mode `direct` and start as fast as before.
- [ ] **Decode-error fallback** (0.3.124): a `PIPELINE_ERROR_DECODE` should now ask `/info?x=1` for a converted picture
      and carry on, instead of retrying the same file and showing "This episode stopped playing". Look for `recover`
      lines with `why: "decode"` in the log.
- [ ] **Slow first segments** (0.3.124): hls.js now waits 45 s for a segment's first byte instead of 10 s. There should be
      no more `fragLoadTimeOut … Timeout after 10000ms` errors.
- [ ] **Drift re-sync** (0.3.125): picture and sound 250 ms+ apart for 3 s are re-synced with a seek, at most once a
      minute. Look for `resync` lines, and check that a re-sync is not noticeable on screen.
- [ ] **Stuck controls** (0.3.123): the cross-fade (view transition) is skipped into, out of and between episodes. This was
      an informed guess at the "controls stick" reports, not confirmed by the log. If they still stick, get the log lines
      from that moment.
- [ ] **Previous / next episode pills** (0.3.122): try them on a phone, a computer and the TV remote.

## Reading the log

Since 0.3.126 the log is verbose: Settings → Torrents → **Download the log** gets every file as one `.ndjson`.
Every player line carries `sid` (one page load) and `pid` (one opening of the player), so filter on a `pid` to read one
viewing start to end: `open` → `watch` → `info` → `attach` → `firstframe` → … → `close` (with `why`). Look for `fail`
(the error screen, with everything the player knew), `error`, `jserror`, `autoplay` / `autopause` (playback changing on
its own), `longtask` (the page frozen for over a second), `apierror` / `slowapi`, and on the server side `http` (failed,
refused and slow requests, with stack), `play` → `chose how to play` (codec and why), `ffmpeg exited with an error`
(with ffmpeg's own last lines) and `server` → `crashed`.

## From the box's log, not fixed yet

- [ ] **"player waited for a segment" (1,366)**: the box is often slow to cut the next piece of an episode. The player now
      waits instead of failing, but the slowness itself is untouched. Likely causes: conversions on the CPU and a box
      short of memory.
- [ ] **"could not read the keyframes" (467)** and **"could not copy an episode ahead of the play" (588)**: why the next
      episode is not prepared ahead of time. Not investigated.
- [ ] **Encoder job cap (~110 warnings)**: the box hitting its limit on how many conversions run at once.
- [ ] **"prebuild tick failed" (1,333)**: probably the `group` alias bug fixed in 0.3.97 (once a minute for about a day).
      0.3.125 logs the failing `step` and code line (`at`), so a new one can be traced.
- [ ] **"short of memory" (637)**: the box really had under 400 MB available. Flix only skips preparing the next
      episode then. The remedy is less else running on the box, or more RAM.

## UI

- [ ] The warning banner's "(+1 more)" does not say what the other issue is: cycle through them, or link to Health.
- [ ] A show page has no on-screen Back on desktop; only the browser's own works.
- [ ] Discover's "Show more": load more on scroll, or say "Showing 60 of 340".
- [ ] The Downloads empty state says "tap **Download**", and there is no button by that name (only the ⬇ beside each
      episode).
- [ ] Up next has not been checked against the centred phone controls (play/skips in the middle of the picture since
      0.3.119).

## Decisions left open

- [ ] Player title: it stays in the top bar. Mockup B had it at the bottom left, beside the controls; moving it touches
      the car layout and the paused card.
- [ ] The quality button reads "AUTO", not "AUTO · 1080p": showing the size needs the player to know which one Auto
      settled on.
- [ ] "Get season ready" / "Get all episodes ready" on a show page are shown to kids' profiles too. Admin only?
- [ ] Search: a misspelt name finds shows Flix already knows, but the live BroadcasTheNet lookup still needs the exact
      name, so a misspelt show Flix has never seen is not brought in.

## Left as they are, on purpose

- The logo collapsing out of the player's top bar when the picture starts is intentional (and `test/tv.test.ts` checks
  it).
- No "My List" link in the account menu: there is no My List page to link to.
