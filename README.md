# Flix

A Jellyfin-style media server whose **only** source is [BroadcasTheNet](https://broadcasthe.net) (BTN).
Nothing is pre-downloaded: the library is a catalog read from the BTN API. Press play and the torrent starts
downloading in sequential order and streaming begins as soon as the first pieces arrive.
It is an installable **PWA** (manifest + service worker; add it to your home screen).

## How it works

**For viewers it works like Netflix:** pick a show, tap an episode, it plays. Nobody ever sees a list of releases.
Behind the tap, Flix picks the source automatically (`src/pick.ts`):
1. a source that is actually alive (seeded, or already on the server's disk) beats a dead one;
2. **1080p** is preferred, then 720p, then anything else; **4K (2160p)** is a last resort, used only when nothing else is alive, because it takes far more disk;
3. ties go to a copy already on disk (instant start), then H.264, then the most seeders.

4K is always re-encoded down to 1080p for the browser. HDR sources are tone-mapped to normal colours during that re-encode (needs ffmpeg's `zscale` filter, which Flix checks for at startup of the first transcode; if the container's ffmpeg lacks it, HDR is passed through unchanged).

## "Just works" for the family

- **One login, no typing.** Sessions last 180 days and renew while a device is in use. The admin can create a one-time **sign-in link** for each person (Family → *Sign-in link*); opening it signs that device in with no password. Devices remember every profile used on them and ask **Who's watching?** when the app opens. To drop Umbrel's own login in front of Flix, see `docs/umbrel-single-login.md`.
- **"Up next" arrives with the credits.** The box comes up when the end credits begin, not when the file ends. Where they start is worked out once, in the background, after the episode finishes downloading (`src/extras.ts`): ffmpeg is asked where the picture goes black and where the sound stops in the last quarter of the file, reading the picture's keyframes only, on one thread, at the lowest CPU and disk priority, and not at all while the box is busy. The answer is kept in the database. A chapter named for the credits wins over it; with neither, the box comes up for the last 3.5% of the runtime (25 seconds to a minute). Nothing is ever measured during playback. Going on to the next episode (Play now, or the countdown) counts the one before as watched, and so does leaving during its credits.
- **Seeking with pictures.** The same background pass cuts one sheet of small pictures per finished episode (keyframes only, about a second of one core), and the seek bar shows the picture for the moment under the finger, the mouse or the remote. A finished episode moves with the finger as it is dragged; a remote's held left/right walks the bar and seeks once, where it stops. Every episode can be seeked anywhere at once, backwards included: a file played as a playlist (one whose sound has to be converted) has a whole playlist cut on its own keyframes, and each piece is made where the viewer is.
- **Playback that recovers.** If the chosen release delivers nothing for ~25 s, Flix quietly switches to the next-best release of the same episode (up to twice). Once an episode is half watched (or has finished downloading), the next one starts downloading, so "Up next" is instant. Errors are written for the family ("isn't ready to play yet"), with the technical text shown to admins only.
- **Subtitles and audio.** Embedded text subtitles appear in the player's own CC menu (extracted as they download), with the choice remembered per device; English subtitles turn on by default for non-English audio. Several audio tracks give an audio button. Picture subtitles (PGS/VobSub) can't be shown in a browser. One subtitle shows at a time. Also: 10-second back/forward, keyboard shortcuts (space, left/right, F). There is no volume control in Flix: the phone's buttons or the TV remote set the volume.
- **TVs and casting.** On a TV browser (or with arrow keys once something is focused) the arrow keys move between tiles and Back goes back; the layout scales up on big screens. Where the browser supports casting (Remote Playback) a cast button appears, using a signed, cookie-free link. That only works when the TV can reach this server on the local network, not over Tailscale alone.
- **Episode titles, summaries and pictures** on each episode (TMDB when a key is set, otherwise TVmaze, which needs no key), also shown in the player and "Up next".
- **Something's wrong?** A flag in the player tries another source and tells the admin which release failed (Torrents page → *Reported problems*); playback that fails on its own is reported too.
- **Profile PINs.** The admin can put a PIN on a profile (Family → *Set PIN*); switching to it on a shared device asks for it (5 wrong tries lock it for 10 minutes). A password or sign-in link still works.
- **Continue Watching includes "Up next"** (the next episode of a show you just finished), and a show on **My List** gets a *New episode* badge until you open it. Separate `.srt`/`.ass`/`.vtt` files shipped in a torrent show up as subtitles too.
- **A home screen of ten-show rows from seven services.** Order: Continue Watching, My List, Because you watched, then **Trending shows** (TMDB's weekly trending, topped up with the most popular), **New on HBO / Crave / Showcase / Netflix / Disney+ / Apple TV+ / Paramount+** (newest premieres first), then more of those services' shows under the *one* genre each fits best. Only shows on those seven services are on the home screen (the service comes from TMDB, or TVmaze with no key; everything else is still in the library and search). Every discovery row holds exactly **10** shows: a show appears once across the screen while there are enough others, a thin row is topped up with shows already shown, and a row that still can't reach ten is left out. The top trending (or newest) show is the featured billboard. BTN is TV-only, so there is no trending-movies row.
- **My List, Because you watched, New badges** on the home page.
- **Seeding reachability.** The health box warns when qBittorrent's peer port looks closed (the 130-hour rule still works; the 1:1 ratio will be slow). The port is fixed (`QB_LISTEN_PORT`, default 6881) and the container publishes it, so only the router is left: forward that port (TCP and UDP) to the box, or leave UPnP on for it. `docs/first-run-checklist.md` walks through checking the real server.
- **Looks after itself.** New downloads are refused before the disk is nearly full (`MIN_FREE_GB`, default 10); a dead torrent that never delivered a byte is cleaned up; the database (accounts, watch history) is copied once a day to `DATA_DIR/backups` (last 7 kept). Admins get a banner on any page when BTN refuses the key or IP, qBittorrent is down, or storage is low.

- **What gets listed** (`src/seasons.ts`) – only **English-language** shows (TMDB's original language, else TVmaze's) appear, and only when their **whole first season** is available; otherwise they are hidden.
  After season 1 only the *next* season in sequence may follow, and only when it is whole: with seasons 1 and 3 on BTN but no 2, only season 1 shows.
  A season is whole when it has a season pack, or when its single episodes run from E01 with nothing missing (double episodes like `S01E05E06` count for both numbers). A lone E01 is not a season: when TMDB/TVmaze say how long the season is, single episodes only count when they reach it (otherwise the pack carries the season), and the season on the air counts what has aired so far. A show is held back until its language and season lengths have been read (a few seconds each, in the background, or at once when you search for it).
  Specials (season 0) and date-named shows (no season/episode numbers) cannot be judged, so they are never listed. Because this needs a show's full release list,
  Flix reads shows from BTN in the background (one at a time, always leaving part of the API budget free), and a show appears once it has been read.
- **Single episodes first, season packs second** – when a season has all its single episodes, those are what is listed and played. When it doesn't but a season pack exists,
  the pack is listed as individual episodes (read from the `.torrent`, nothing downloaded yet), and playing any of them downloads the **entire pack in order**,
  starting at the episode you picked and continuing through the rest of the season whether or not anyone watches it, because a half-downloaded pack can't be seeded.
  It is then kept until BTN's seeding requirement is met.
- **Artwork** – posters and banners are downloaded by the server on first view and cached in `DATA_DIR/art`; browsers only ever talk to Flix (`/api/art/…`), never to BTN's image host, and BTN's image URLs never reach the client.
  If BTN has no picture (or refuses us), Flix looks the show up on TMDB (with `TMDB_API_KEY`: poster and backdrop) and then TVmaze (no key needed: poster) and remembers the answer for a day.
  The trailer's thumbnail on the show page is fetched the same way (server-side, from YouTube's image host) and cached. Fetches refuse internal/private addresses, accept only JPEG/PNG/GIF/WebP (no SVG), and are capped at 8 MB.
- **Catalog** – BTN JSON-RPC API (rate-limited locally to 100 calls/h; BTN allows 150). The passkey-bearing
  `.torrent` link never leaves the server.
- **Engine** – [qBittorrent](https://www.qbittorrent.org) via its Web API (BTN only allows whitelisted clients, so
  Flix deliberately does not embed its own BitTorrent client). Torrents are added with sequential download and
  first/last-piece priority; for season packs only the episode you play is fetched.
- **Streaming** – Flix serves the partly-downloaded file over HTTP range requests, blocking until the needed pieces
  are verified. A file the player can take plays directly. Only copies that play as they are (H.264) are downloaded,
  so the usual exception is the sound (E-AC-3): the picture is then copied untouched and only the sound is converted, into
  HLS pieces made where the viewer is. A picture the player cannot decode at all (rare: a file taken over from the
  Downloads folder) is converted on the CPU, with nothing to allow first.
- **Retention** – a torrent is deleted only when **all** of these hold:
  1. every user who started it has watched it (played to the end, 100 %) or released it,
  2. it has finished downloading, and
  3. **BTN's seeding requirement is met: 130 hours of seeding _or_ a 1:1 ratio.** This is hard-coded
     (`src/config.ts`) and cannot be overridden – not by config, and not by the admin "force remove" (it returns 409).
     Ratio is measured against the full torrent size.

## People and content ratings

- Everyone has their own login, watch history and "continue watching". **Only an admin can create accounts**: public signup exists
  solely to create the very first account (the admin). Admins add, remove, promote and reset passwords under *Family*; there is
  always at least one admin, and a password reset signs that person out everywhere.
- **Ratings per person:** for each person the admin ticks which ratings they may watch (TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA, Unrated),
  with Kids / Teens / Everything presets. Anything outside that set is hidden completely: not in lists, search, continue-watching,
  artwork, or any stream URL (the server answers 404). Admins always see everything.
- **Where ratings come from:** always automatic, from **IMDb**. BTN's API has no content rating, and IMDb has no public API (and blocks scraping), so Flix asks [OMDb](https://www.omdbapi.com/), which serves IMDb's certificate and score, by the show's IMDb id (`OMDB_API_KEY`, free; also settable under Settings). Movie-style G/PG/PG-13/R are mapped to TV-G/PG/14/MA. If IMDb has no certificate, Flix falls back to [TMDB](https://www.themoviedb.org/) (US rating, by TVDB id, when `TMDB_API_KEY` is set). The IMDb score shows next to the rating on a show's page. There is no way to set a rating by hand.
- **Unknown rating = Unrated**, which restricted users do not see unless "Unrated" is ticked for them.

## Downloads on your device (offline)

**Downloads** in the account menu lists episodes saved on *this device* to watch without a connection. On a show's page, the arrow beside an episode saves it: Flix waits for its own copy to finish downloading, makes a single **1080p-or-lower MP4** (`src/offline.ts`: an H.264/AAC MP4 is sent as it is; anything else, including 4K and HDR, is converted once and the copy is deleted from the server after two hours), and the browser stores it in Cache Storage together with the poster and text subtitles. The service worker answers `/_offline/…` (with byte ranges, so seeking works) even with no server, and when Flix can't be reached the app opens on the Downloads page instead of an error. What you watch offline (position, finished) is sent to the server the next time the app is online. Saved episodes are per device and per browser; deleting them is under Downloads. The server keeps its own copy of a downloaded episode until it has been watched (here or on the device) and BTN's seeding rule is met.

## The Downloads folder, and downloading ahead of time

- **One folder.** Flix saves its torrents straight into the Downloads folder (qBittorrent gives each torrent its own named folder there; older versions used one hash-named folder per torrent, which Flix moves out of the way once nobody is watching). It also sets that folder as qBittorrent's default save path.
- **Kept in step.** A torrent of a BTN release Flix knows that you download by hand into that folder is **taken over** (shown on the Torrents page as "from your Downloads folder", and playable instantly). It is kept until someone has watched it; it is never deleted unwatched. When Flix removes a torrent, the engine deletes its files and Flix sweeps away the empty folders left behind. Flix never deletes a file it did not download or adopt, and never the folder itself. A torrent that disappears from qBittorrent is dropped from Flix.
- **Downloading ahead of time** (`src/autodl.ts`), so the next episode doesn't buffer: when someone is past 60 % of an episode (or it has finished downloading), the **next episode of that show** is fetched, and nothing else (not My List shows, not new uploads). It is always one whole episode file, never part of one and never a whole season: a season pack is added stopped, only the wanted episode is switched on, and then it starts, and an episode that has started downloading is never skipped or dropped half-way. Because every download has to seed 130 h / 1:1 before it can be deleted, this is cautious: at most 3 episodes per person (`AUTO_PER_USER`), nothing below 25 % free disk (`AUTO_PAUSE_FREE_PCT`), and one nobody opens lapses after 7 days (`AUTO_EXPIRE_DAYS`) and is then deleted like any other once seeded. Pressing play is never held back by these limits. `AUTO_DOWNLOADS=false` switches it off.
- **Low storage.** Flix keeps the larger of 10 GB and 10 % of the disk free (`MIN_FREE_GB`, `MIN_FREE_PCT`): below that new shows are refused. The admin sees a warning under 20 % and, under the limit, a banner asking them to remove some videos; the Torrents page then shows **Free up space**: everything finished, biggest first, with Remove buttons for what BTN's seeding rule allows, and what is still seeding listed without one.
- **Watched means 100 %.** A show counts as watched only when it has played to the end, and a torrent is deleted only after everyone who started it has done so (or released it), it is fully downloaded, and BTN's seeding requirement is met.

## Torrents & seeding page

Account menu → **Torrents & seeding** (admins): every torrent Flix has pulled, grouped as *Downloading*, *Seeding: requirement not met yet* and *Requirement met*,
with the ratio and hours-seeded bars against BTN's 1:1 / 130 h rule, upload totals, and why a torrent is being kept. Removed torrents are listed underneath.
Remove is refused until the seeding requirement is met.

## Interface

Dark, cinematic design (with a light variant that follows the device): a hero for what you were watching, scrolling rows,
a backdrop on each show page with season tabs, and a full-screen player with a "next episode" countdown. Page changes use the
browser's View Transitions API for smooth cross-fades (plain fades elsewhere), and everything respects *reduce motion*.
System fonts only, so family devices never contact a font CDN.

## Setup

Requires Node ≥ 22.9, ffmpeg/ffprobe and qBittorrent (`qbittorrent-nox`).

1. Run qBittorrent with the Web UI enabled. Flix switches off the `.!qB` suffix and temp dir on startup so files are
   readable in place. `DOWNLOAD_DIR` must be the same path for both processes. By default it is your desktop's **Downloads** folder
   (`~/Downloads`, or whatever `XDG_DOWNLOAD_DIR` says in `~/.config/user-dirs.dirs`, as on XFCE); set `DOWNLOAD_DIR` to use another.
2. `cp .env.example .env`, fill in `BTN_API_KEY` and the qBittorrent credentials, then
   `npm install && npm start` (`npm start` reads `.env` automatically).
3. Open http://localhost:8096 – the first account you create becomes admin. Further users are created by the admin.

## Known limitations

- Seeking far beyond the downloaded part waits for the sequential download to reach it (qBittorrent cannot
  prioritise arbitrary pieces).
- Subtitles come from the file itself and from `.srt`/`.ass`/`.vtt` files shipped beside it; picture subtitles (PGS, VobSub) can't be shown in a browser, and a release with no subtitles has none (Flix does not look them up elsewhere). While a file is still downloading, subtitles cover what has arrived and refresh every 90 s.
- Casting works only where the TV can reach the server directly (see above); HLS (transcoded) playback in Chrome uses MSE, which the browser can't hand to a cast device.
- "Whole season" is judged against the season's length from TMDB/TVmaze (the season on the air counts what has aired so far); when neither knows the length, single episodes running unbroken from E01 count as whole.
- Trailers are found automatically (BTN, then TMDB, then a YouTube search). The still image on the show page is fetched by the server; the viewer's browser only contacts YouTube once someone taps play.
- If a viewer starts something and never finishes it, the file stays until they finish/release it. Set
  `ABANDON_DAYS` to auto-release inactive viewers.
  A finished, fully seeded download (an episode or a season pack) that some allowed viewers have not finished shows on their Home and on the show page as "Leaving soon" (pressing play on it keeps it) for `LEAVING_DAYS` (7); after that they no longer hold it and the normal sweep removes it. The seeding rule is never bypassed. A season pack counts as finished for someone only once they have watched every episode in it. On the Torrents page the admin can mark a download "Remove when seeded" (it goes as soon as the rule is met, unless someone is partway through), see what uses the most space, and see roughly how many days of room are left at the recent pace.
- Installing the app needs HTTPS **with a certificate the browser trusts** (Chrome says "this app cannot be installed" otherwise, and on a certificate warning page it never gets that far).
  On Tailscale: enable HTTPS certificates in the admin console and run `tailscale serve --bg --https=443 http://127.0.0.1:8096`, then open `https://<machine>.<tailnet>.ts.net` (no port).
  If the app sits behind Umbrel's sign-in, the manifest has to be fetched with cookies (`crossorigin="use-credentials"`, already set).
  The account menu has an **Install app** entry that installs, or says what is missing.
- BTN API field names were written from memory of the public API; verify against a real key.

## Android TV app (APK)

`android/` is Flix as an installable app: a full-screen WebView on your Flix server, so it is exactly the web app, with the TV layout switched on when it runs on a TV. It shows up in the Android TV launcher like any other app.

- **Getting the APK:** every run of *Build Android / TV app* (GitHub Actions) uploads `flix-<version>.apk` as an artifact, and a push to `main` also attaches it to the `v<version>` release, a direct link a TV can download (the Downloader app works well).
- **Installing:** with adb, `adb connect <tv-ip>` and then `adb install -r flix-<version>.apk` (turn on Developer options → USB/network debugging on the TV first), or open the APK on the TV and allow installs from that app.
- **First launch** asks for the server address (the same one you open in a browser, e.g. `http://umbrel.local:8096`). The remote's **Menu** key, or a server that can't be reached, brings that screen back.
- **Updates in place** need every build signed with the same key. Make one once (`keytool -genkeypair -keystore flix.jks -alias flix -keyalg RSA -keysize 2048 -validity 10000`) and add the repository secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 flix.jks`), `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` (and `ANDROID_KEY_PASSWORD` if it differs). Without them the APK is signed with a throwaway debug key, so the old app has to be uninstalled (which signs you out) before a new build goes on.
- Building locally: `gradle -p android assembleRelease` with an Android SDK (`ANDROID_HOME`) and JDK 17+.

## Tests

`npm test` – unit tests plus an end-to-end test using a mock BTN API, a local tracker, a WebTorrent seeder, real
`qbittorrent-nox` and ffmpeg (needs those installed).
