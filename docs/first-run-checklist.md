# First run on the real server: a 20-minute checklist

Everything here was tested against a fake BTN and a stubbed download engine. These are the things only your real Umbrel can
confirm. Do them in this order; each says what a failure usually means.

## 1. Health (2 min)
Open **account menu → Torrents & seeding**. At the top is a status box. Everything should say healthy, except for items you
chose to skip (no TMDB key = "ratings are manual").
- *No BroadcasTheNet key / BTN is refusing this server's address*: Settings → paste the key, approve the server's IP on BTN.
- *The download engine is not answering*: qBittorrent isn't running or the address under Settings → qBittorrent is wrong.
- *The download port looks closed*: see "Seeding" below. Not urgent for playing, but it slows the 1:1 ratio.
- *Storage*: a bar shows free space. Downloads are refused below `MIN_FREE_GB`.

## 2. The library fills in (5 min)
The home page starts empty and says "Checking N shows…". That is the background read of BTN; shows appear as they finish.
If nothing appears after ~10 minutes, check step 1 (key / IP), then the Flix log for `[crawl]` lines.

## 3. Play one of each (10 min)
1. A show whose season has **single episodes**: press play. It should start within about a minute and show a title, summary and picture.
2. A show that is **only a season pack**: the episodes list as "Part of the full season download". Play one, then look at Torrents & seeding: the whole pack should be downloading, not just that episode.
3. A **4K or HDR** release if you have one: colours should look normal, not washed out. (If they do look washed out, the container's ffmpeg has no `zscale` filter; tell me.)
4. While something plays, open Torrents & seeding: the **next episode** should appear in the list within a couple of minutes (that's the pre-fetch).
5. Press **Next/Up next** at the end of an episode. It should start instantly.

## 4. Phones, tablets and TVs
- Create a family member (Family → add), then **Sign-in link** → open it on their phone. They should land on Flix signed in, with no password.
- On that phone: add to home screen (needs the trusted HTTPS address from the README; the account menu has **Install app**).
- Open Flix from the home-screen icon on a device with two profiles: it should ask **Who's watching?**.
- A TV browser: arrow keys should move between tiles and Back should go back. A cast button shows only if the TV and Flix are on the same network.

## 5. Seeding (the BTN rule)
BTN needs each torrent seeded for 130 hours **or** a 1:1 ratio. The 130 hours always works. The ratio needs other people to be able
to connect in, which needs the peer port forwarded. In Torrents & seeding, each torrent shows both bars. If the ratio bar barely moves
but the hours bar does, the port is closed: forward qBittorrent's peer port on your router and publish it in the Umbrel app's
docker-compose. Torrents are never deleted before one of the two is met.

## 6. When something fails
Tap the **flag** in the player ("Something's wrong"): it tries another source and files a report. Reports (and playback that failed
by itself) appear under *Reported problems* on the Torrents page with the exact release and its seeders. Send me a few of those
and I can tune source selection.
