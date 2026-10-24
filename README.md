# Nyaa Stream

A simplified Stremio clone with a single source: [nyaa.si](https://nyaa.si).
Browse or search nyaa, open a torrent, pick an episode, and it streams while it
downloads.

Built by reverse engineering the installed Stremio for Windows; see
[docs/STREMIO-ARCHITECTURE.md](docs/STREMIO-ARCHITECTURE.md) for how Stremio is put
together and which parts this project keeps.

## Download

Get the latest build from the [Releases page](https://github.com/JCEspindola/nyaa-stream/releases/latest).

* **Windows:** `NyaaStream-<version>-windows.exe`. Run it and the app opens in your
  browser at `http://127.0.0.1:11471`. Keep its console window open while watching;
  close it to quit. Everything is included (ffmpeg too); on first run it unpacks about
  190 MB to `%LOCALAPPDATA%\NyaaStream`. The .exe isn't code-signed, so SmartScreen
  may warn: **More info → Run anyway**.
* **Android 7+:** `NyaaStream-<version>-arm64-v8a.apk` for nearly all phones
  (`armeabi-v7a` for old 32-bit ones). Allow "install unknown apps" when asked. The
  app runs the same server inside the phone, shows the same interface, and plays
  video in a built-in VLC player (every codec, styled subtitles).

## Run from source

```bash
npm install
npm start
```

Then open http://127.0.0.1:11471 (or run `npm run open` to open it automatically).

Requirements: Node 20+. ffmpeg/ffprobe are optional but recommended; they are found
on `PATH`, in the Stremio install folder, or via `FFMPEG_PATH` / `FFPROBE_PATH`.
Without them you get direct playback only, with no subtitles and no audio-track switching.

## Build the downloads

* **Windows .exe** (on Windows, Node 24): `npm run build:exe` → `dist/NyaaStream.exe`.
  It's a Node [single-executable app](https://nodejs.org/api/single-executable-applications.html):
  `src/exe.js` plus the server bundled by esbuild, with the UI and a Windows ffmpeg
  build embedded as assets (`scripts/build-exe.mjs`).
* **Android APKs** (JDK 17, Android SDK with platform 36, build-tools 36, NDK
  27.2.12479018, CMake 3.22.1): `node scripts/build-android-assets.mjs`, then
  `cd android && ./gradlew assembleRelease` → `android/app/build/outputs/apk/release/`.
  The app embeds Node 18 ([nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile))
  running `src/android.js`, shows `public/` in a WebView, and plays video with libVLC
  (`android/app/src/main/java/com/nyaastream/app/`).
* **Releases:** pushing a tag like `v1.0.0` runs `.github/workflows/release.yml`, which
  builds both and publishes them. APK signing uses the repository secrets
  `NYAA_KEYSTORE_BASE64`, `NYAA_KEYSTORE_PASSWORD`, `NYAA_KEY_ALIAS` and
  `NYAA_KEY_PASSWORD`; keep the same key forever, or installed apps can't update.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses of ffmpeg,
libVLC and Node.js included in the builds.

## How it maps to Stremio

| Stremio | Here | Path |
|---|---|---|
| Addons (catalog/meta/stream protocol) | Built-in Nyaa addon | `src/addon.js` → `/addon/*` |
| Cinemeta/Kitsu (series metadata) + Torrentio (torrents per episode) | AniList catalog + nyaa release matcher | `src/anilist.js`, `src/series.js` |
| Streaming server, EngineFS on :11470 | torrent-stream engine with Range requests, GuessFileIdx, idle timeouts, 2 GiB cache | `src/engine.js` → `/engine/*` |
| `/hlsv2` transcoder + embedded mpv | ffmpeg remux/transcode to fragmented MP4, live soft-subtitle extraction, mpv/VLC hand-off | `src/transcode.js`, `src/external.js` |
| stremio-web UI | Series catalog, torrent browser, player, Your Library | `public/` |
| Library (stored in the Stremio account) | Browser storage, export/import, optional sync codes | `public/app.js`, `src/sync.js` → `/api/sync` |

The addon follows the real Stremio protocol, so you can also install it into
Stremio itself: paste `http://127.0.0.1:11471/addon/manifest.json` into Stremio's
addon search while this app is running.

## Series

The **Series** tab (home) is a catalog of anime series from [AniList](https://anilist.co):
airing this season, trending, all-time popular, and search. AniList only provides
metadata; every torrent still comes from nyaa.si.

* A **series page** lists its episodes with titles, thumbnails and air dates, and for
  each episode shows how many nyaa torrents were found, their qualities and the best
  seeder count. Season packs are listed below, and related seasons (prequel/sequel)
  are linked.
* An **episode page** lists every torrent for that episode: single-episode releases
  first, then season packs that contain it. You can filter by quality and fansub.
  Picking a pack plays the right file inside it.
* **Next episode** in the player keeps the same fansub and quality when that release
  exists (like Stremio's `bingeGroup`). Otherwise it shows the episode's torrent list.

Torrents are matched to a series by comparing release names with every title AniList
knows (romaji, English, synonyms) and by season markers (`S2`, `2nd Season`,
`Season 2`), so different seasons stay apart. Limits: releases that number a later
season continuously from season 1 (e.g. "- 33" for S2E05) are not matched, and very
long series may need the per-episode search, which runs when you open an episode.

## Your Library

Press **＋ Add to library** on a series page, or on a torrent page (the app works out
which catalog series the torrent belongs to). **Your Library** lists those series with
the newest episode release first, and shows the next air date, how far you've watched,
and how many aired episodes you haven't seen. Remove a series with ✕ on its card (with
Undo) or from its page.

The library and watch progress are stored **in the browser** (localStorage); the server
keeps nothing per user. Two ways to keep them safe or take them elsewhere:

* **Export / Import** (Your Library page): a `.json` backup of the library and watch
  progress. Importing merges into the current library; it never replaces it.
* **Sync codes** (Your Library → Sync): *Create a sync code* stores a copy on the server
  under a random code like `JD2H-NGR5-RVWF-XJQY`; enter it on another device to use the
  same library there. There is no account, so anyone with the code can read and change
  that library. Devices merge their changes (newer change per series wins, removals
  included), and the server rejects a save based on an outdated copy so one device can't
  overwrite another. *Stop syncing here* keeps the local library; *Delete synced copy*
  removes it from the server.

Synced copies are files in `~/.nyaa-stremio/sync/` (set `DATA_DIR` to move them), named
by a hash of the code, so a copy of that folder doesn't reveal working codes.

## Offline Catalog (Android app)

Torrent pages, and each release on a series' episode page, have an **Add to Offline
Catalog** switch (off by default). Switching it on downloads the whole video to the
phone; season packs get one switch per episode. Downloads keep running in the background
with a progress notification, and resume when the app is reopened.

The **Offline Catalog** tab lists saved videos grouped by series, with download progress,
**Play** (no connection needed; the app opens here when started offline) and **Remove**,
which deletes the file from the device. Switching the toggle off does the same.

Before downloading, the app checks free space and refuses with a warning when the video
does not fit (keeping 200 MB free for the phone). If space runs out during a download, it
is cancelled, its partial data is deleted, and the app warns with a notification.

Files are kept in the app's private storage (`files/data/offline`); uninstalling the app
deletes them.

## Browsing

The **Browse torrents** tab lists the latest uploads, sortable by date, seeders,
downloads or size, with nyaa's category filter. Two text filters
narrow it further:

* **Filter words** uses nyaa's search syntax: `1080p` must appear, `-batch` must
  not, `"2nd season"` is an exact phrase. It runs on nyaa.si, so *Load more* keeps
  paging through every match.
* **Fansub group** shows only releases tagged `[Group]` at the start of the title.
  The suggestions include common groups and the groups currently on screen. Clicking
  a group badge in the list applies it.

## Playback

* **Direct**: the browser reads the original file from `/engine/<infoHash>/<fileIdx>`
  using byte ranges, so seeking is instant. Works for H.264 (8-bit), HEVC (if the
  browser supports it), VP9 or AV1 video with AAC, Opus, FLAC or MP3 audio, in MKV or MP4.
* **Compatible**: ffmpeg copies the video when it can and re-encodes when it must
  (10-bit H.264, AC3/DTS audio, other audio tracks). Seeking restarts ffmpeg at the new
  time. The player switches to this mode automatically if direct playback fails.
* **Subtitles**: text tracks (ASS/SRT) are extracted to WebVTT as the file
  downloads and shown in the player. ASS styling is not kept; for styled subs use
  an external player.
* **External**: "Open in mpv/VLC" if one is installed, or copy the stream URL /
  download an `.m3u`.

Keys: Space play/pause · ←/→ 10 s · F fullscreen · M mute · Esc back.

## API

| Endpoint | Purpose |
|---|---|
| `GET /addon/manifest.json` | Addon manifest |
| `GET /addon/catalog/series/{anilist-season\|anilist-trending\|anilist-popular}/{search=…&skip=…}.json` | Series catalog (AniList) |
| `GET /addon/meta/series/anilist:{id}.json` | Series details; episodes as `videos` |
| `GET /addon/stream/series/anilist:{id}:{episode}.json` | nyaa torrents for that episode |
| `GET /addon/series-torrents/anilist:{id}.json` | Per-episode torrent summary and season packs |
| `GET /addon/catalog/series/{nyaa-latest\|nyaa-popular}/{search=…&skip=…&genre=…}.json` | Search/browse (75 per page) |
| `GET /addon/meta/series/nyaa:{id}.json` | Torrent details; media files as `videos` |
| `GET /addon/stream/series/nyaa:{id}:{fileIdx}.json` | `{infoHash, fileIdx, sources}` |
| `GET /engine/{infoHash}/{fileIdx}` | File bytes (Range supported; `-1` = guess the main file) |
| `GET /engine/{infoHash}/create` | Start the engine; returns stats and `guessedFileIdx` |
| `GET /engine/{infoHash}/{fileIdx}/stats.json` | Peers, speed, cached fraction |
| `GET /engine/stats.json`, `/engine/{infoHash}/remove`, `/engine/removeAll` | Engine management |
| `GET /api/library-info?ids=1,2,…` | Card data and latest episode for library ids (max 200) |
| `POST /api/sync` | Create a sync code from `{data}` |
| `GET /api/sync/{code}` | Synced copy `{rev, updatedAt, data}` |
| `PUT /api/sync/{code}` | Save `{baseRev, data}`; 409 with the current copy if `baseRev` is outdated |
| `DELETE /api/sync/{code}` | Delete the synced copy |
| `GET /api/resolve-series?title=…` | Catalog series a release name belongs to |
| `GET /api/offline` | Offline Catalog: saved and downloading videos, free space |
| `POST /api/offline` | Download `{nyaaId, idx, title?, episode?, series?}`; 507 when it does not fit |
| `DELETE /api/offline/{infoHash}/{fileIdx}` | Cancel or remove, deleting the file |
| `GET /api/offline/{infoHash}/{fileIdx}/file` | A saved file (Range supported) |
| `GET /transcode/{infoHash}/{fileIdx}/probe.json` | Codecs, duration, audio/subtitle tracks |
| `GET /transcode/{infoHash}/{fileIdx}/video.mp4?t=&a=&s=&sid=&hevc=` | Browser-safe stream |

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `PORT` / `HOST` | `11471` / `127.0.0.1` (listens on this machine only) |
| `CACHE_DIR` | `%TEMP%/nyaa-stremio-cache` |
| `DATA_DIR` | `~/.nyaa-stremio` (synced copies) |
| `TRUST_PROXY` | unset; behind a reverse proxy set e.g. `1` so rate limits see client IPs |
| `CACHE_SIZE` | `2147483648` (bytes; oldest torrents are removed first) |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `MPV_PATH`, `VLC_PATH` | auto-detected |
| `X264_PRESET` | `veryfast` |
| `NYAA_URL` | `https://nyaa.si` |

## Notes

Torrenting uploads data to other peers while you watch. Only stream content you
have the right to access where you live.
