# Flix

A Jellyfin-style media server whose **only** source is [BroadcasTheNet](https://broadcasthe.net) (BTN).
Nothing is pre-downloaded: the library is a catalog read from the BTN API. Press play and the torrent starts
downloading in sequential order and streaming begins as soon as the first pieces arrive.
It is an installable **PWA** (manifest + service worker; add it to your home screen).

## How it works

**For viewers it works like Netflix:** pick a show, tap an episode, it plays. Nobody ever sees a list of releases.
Behind the tap, Flix picks the source automatically (`src/pick.ts`):
1. a source that is actually alive (seeded, or already on the server's disk) beats a dead one;
2. **1080p** is preferred, **4K (2160p)** is the fallback when there is no 1080p, then 720p, then anything else;
3. ties go to a copy already on disk (instant start), then H.264, then the most seeders.

4K is always re-encoded down to 1080p for the browser. HDR is not tone-mapped yet, so HDR sources can look washed out.

- **Artwork** – posters and banners are downloaded by the server on first view and cached in `DATA_DIR/art`; browsers only ever talk to Flix (`/api/art/…`), never to BTN's image host, and BTN's image URLs never reach the client. Fetches refuse internal/private addresses, accept only JPEG/PNG/GIF/WebP (no SVG), and are capped at 8 MB.
- **Catalog** – BTN JSON-RPC API (rate-limited locally to 100 calls/h; BTN allows 150). The passkey-bearing
  `.torrent` link never leaves the server.
- **Engine** – [qBittorrent](https://www.qbittorrent.org) via its Web API (BTN only allows whitelisted clients, so
  Flix deliberately does not embed its own BitTorrent client). Torrents are added with sequential download and
  first/last-piece priority; for season packs only the episode you play is fetched.
- **Streaming** – Flix serves the partly-downloaded file over HTTP range requests, blocking until the needed pieces
  are verified. Browser-friendly MP4/WebM plays directly; everything else (e.g. MKV/AC3/HEVC) is remuxed or
  transcoded by ffmpeg to HLS on the fly.
- **Retention** – a torrent is deleted only when **all** of these hold:
  1. every user who started it has watched it (≥ 90 %) or released it,
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
- **Where ratings come from:** BTN's API has no content rating, so Flix looks the show up on [TMDB](https://www.themoviedb.org/)
  by its TVDB id (US rating; movie-style G/PG/PG-13/R are mapped to TV-G/PG/14/MA) when `TMDB_API_KEY` is set. Only the TVDB id is sent.
  Admins can set or override a show's rating on its page, or switch it back to *Automatic*.
- **Unknown rating = Unrated**, which restricted users do not see unless "Unrated" is ticked for them.

## Interface

Dark, cinematic design (with a light variant that follows the device): a hero for what you were watching, scrolling rows,
a backdrop on each show page with season tabs, and a full-screen player with a "next episode" countdown. Page changes use the
browser's View Transitions API for smooth cross-fades (plain fades elsewhere), and everything respects *reduce motion*.
System fonts only, so family devices never contact a font CDN.

## Setup

Requires Node ≥ 22.9, ffmpeg/ffprobe and qBittorrent (`qbittorrent-nox`).

1. Run qBittorrent with the Web UI enabled. Flix switches off the `.!qB` suffix and temp dir on startup so files are
   readable in place. `DOWNLOAD_DIR` must be the same path for both processes.
2. `cp .env.example .env`, fill in `BTN_API_KEY` and the qBittorrent credentials, then
   `npm install && npm start` (`npm start` reads `.env` automatically).
3. Open http://localhost:8096 – the first account you create becomes admin. Further users are created by the admin.

## Known limitations

- Seeking far beyond the downloaded part waits for the sequential download to reach it (qBittorrent cannot
  prioritise arbitrary pieces).
- Subtitles are not extracted yet.
- Season packs: if a season exists only as a pack, it shows as one "Season N" entry that resumes at the next unfinished file.
- Trailers are a plain link to YouTube (nothing is embedded, so nothing is sent to YouTube until someone taps it).
- If a viewer starts something and never finishes it, the file stays until they finish/release it. Set
  `ABANDON_DAYS` to auto-release inactive viewers.
- Keep Flix behind HTTPS (reverse proxy) when exposing it; a PWA needs a secure context to install.
- BTN API field names were written from memory of the public API; verify against a real key.

## Tests

`npm test` – unit tests plus an end-to-end test using a mock BTN API, a local tracker, a WebTorrent seeder, real
`qbittorrent-nox` and ffmpeg (needs those installed).
