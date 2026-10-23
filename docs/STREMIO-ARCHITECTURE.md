# How Stremio works (reverse-engineering notes)

Target: the Stremio for Windows install at `%LOCALAPPDATA%\Programs\Stremio`
(shell `stremio-shell-ng.exe` 1/9/2026 build, `server.js` 6,617,033 bytes,
sha256 of the analysed folder `18d78327…`).

Method: static analysis only. REA (`analyze_javascript_application`, evidence
`ev_cf544de4…`) inventoried and parsed `server.js` but its semantic pass ran out of
heap on the 6.6 MB webpack bundle, so routes and engine logic were read directly
from the bundle text. Nothing was executed. Line numbers below refer to that
`server.js`.

## The three processes

```
┌──────────────────────────┐   loads    ┌──────────────────────────────┐
│ stremio-shell-ng.exe     │──────────▶ │ https://web.stremio.com/      │
│ Rust + WebView2 window   │            │ stremio-web UI + stremio-core │
│ embeds libmpv-2.dll      │◀── IPC ───▶│ (WASM): addons, library, UI   │
│ (native playback)        │            └──────────────┬───────────────┘
└───────────┬──────────────┘                           │ HTTP (addon protocol)
            │ spawns                                   ▼
            ▼                               remote addons (Cinemeta, Torrentio…)
┌──────────────────────────┐                manifest.json / catalog / meta / stream
│ stremio-runtime.exe      │
│ (bundled Node) server.js │◀── http://127.0.0.1:11470/{infoHash}/{fileIdx}
│ "EngineFS" streaming srv │    (player requests byte ranges)
└──────────────────────────┘
```

Observed in the shell binary's strings: `https://web.stremio.com/`, a
`webui-url` override, `http://127.0.0.1:11470`, `stremio-runtime`, `server.js`,
and the libmpv client API (`mpv_create`, `mpv_command_string`,
`mpv_observe_property`, …). So the desktop app is a thin native window: the UI is a
website, playback goes through mpv, and torrents are handled by a local Node server.

## 1. Addons: where content comes from

Stremio itself has no content. Everything comes from addons, which are plain HTTP
services that answer:

| Resource | URL | Returns |
|---|---|---|
| manifest | `/manifest.json` | id, name, `resources`, `types`, `catalogs` (with `extra` such as `search`, `skip`) |
| catalog | `/catalog/{type}/{id}/{extra}.json` | `{ metas: [MetaPreview] }` |
| meta | `/meta/{type}/{id}.json` | `{ meta: { id, name, videos: [...] } }` |
| stream | `/stream/{type}/{videoId}.json` | `{ streams: [{ infoHash, fileIdx, title, sources }] }` |

A torrent addon such as Torrentio only answers `stream` with
`{infoHash, fileIdx}`. The client turns that into
`http://127.0.0.1:11470/{infoHash}/{fileIdx}` and hands it to the player.

## 2. EngineFS: the streaming server (`server.js`)

`server.js` is a webpack bundle around **EngineFS** (lines ~18111–18470) and
Stremio's fork of **torrent-stream**
(`git+ssh://git@github.com/Stremio/torrent-stream.git#4d9eaff…`, line 35904).
It listens on **11470** (HTTP) and **12470** (HTTPS, `local.strem.io`) (line 46838).

### Torrent routes (lines 18342–18420)

| Route | Behaviour |
|---|---|
| `GET /:infoHash/:idx` | `handleTorrent`: create/reuse engine, pick file, serve with HTTP **Range** (206 + `Content-Range`), `pump(file.createReadStream(range), res)`. `idx = -1` means "guess the file". `?tr=` adds trackers, `?f=` is a file-name regex (`fileMustInclude`), `?download=1` adds Content-Disposition. |
| `GET\|POST /:infoHash/create` | Create the engine and return stats JSON. Body may carry `fileMustInclude`, `guessFileIdx: {season, episode}`, or `peerSearch`. |
| `POST /create` | Create from a `.torrent` blob (hex) or a `from` URL/path. |
| `GET /:infoHash/stats.json`, `/:infoHash/:idx/stats.json` | peers, unchoked, downloadSpeed, downloaded, files, and per-file `streamProgress`. |
| `GET /:infoHash/remove`, `/removeAll` | Destroy engines. |
| `GET /stats.json` | All engines. |

Other routers: `/hlsv2` (ffmpeg HLS transcoding), `/subtitles.:ext`,
`/subtitlesTracks`, `/opensubHash`, `/probe`, `/casting/`, archive streaming
(`/rar`, `/zip`, `/7zip`, `/tar`, `/tgz`), `/nzb`, `/ftp`, `/yt/:id`,
`/local-addon`, `/settings`, `/device-info`, `/hwaccel-profiler`.

### Engine creation (`createEngine`, line 18114)

* Default options: `peerSearch {min: 40, max: 200, sources: ["dht:"+ih]}`,
  `dht: false`, `tracker: false`. Instead of torrent-stream's built-in
  discovery, its own `PeerSearch` is driven from the torrent's `announce` list
  (`tracker:<url>`) plus `dht:<ih>`.
* Spoofed peer IDs that look like popular clients (`qB4600`, `DE2110`,
  `AZ5770`, `TR4040`, line 62060).
* Cache path: `<cacheRoot>/stremio-cache/<infoHash>`. Cache is capped by
  `cacheSize` (default **2 GiB**, line 12639) and trimmed oldest-first.
* On first `stream-open`, the **whole file** is selected at low priority
  (`e.select(start, end, false)`) so it keeps downloading in the background, while
  each HTTP read selects its own range at high priority (sequential streaming).

### File selection (`GuessFileIdx`, line 62039)

1. Keep media files (`.mkv|.avi|.mp4|.wmv|.mov|.mpg|.ts|.webm|…`).
2. If `{season, episode}` is given, keep files whose parsed name matches.
3. Pick the **largest** remaining file.

### Lifecycle (lines 18447–18470, 46864–46873)

Reference counters on `stream-open` / `stream-close`:

* no open streams for `STREAM_TIMEOUT` (20 s) → `stream-inactive`
* no open streams on the engine for `ENGINE_TIMEOUT` (120 s) → `engine-inactive`
  → **engine destroyed**
* file fully cached → `engine-idle` → swarm paused

### Transcoding decision (`streamShouldTransmux`, line 10651)

Copy (no re-encode) only if video is **h264** (or **hevc** when the client
reports HEVC support) and audio is **aac**. Anything else goes through ffmpeg
(`libx264 -preset veryfast`, `aac`). Seeking restarts ffmpeg with `-ss`
(line 62937).

## What the simplified clone keeps

| Stremio piece | Clone (`nyaa-stremio`) |
|---|---|
| Remote addons (Cinemeta, Torrentio…) | One built-in **Nyaa addon** speaking the same addon protocol (it can also be installed in real Stremio). |
| EngineFS on :11470 | `src/engine.js`: torrent-stream engine, same routes under `/engine`, Range streaming, GuessFileIdx, stream/engine counters with the same timeouts, 2 GiB cache cap. |
| `/hlsv2` + mpv | `src/transcode.js`: ffprobe + one ffmpeg process that outputs fragmented MP4 using the same copy-or-transcode rule, plus **live WebVTT subtitle extraction** (anime releases ship soft subs in MKV). An external-player hand-off (mpv or VLC) stands in for the embedded libmpv. |
| stremio-web + stremio-core | `public/`: a small UI (browse/search → torrent → file list → player). |

Dropped: accounts and sync, library, calendar, add-on catalogue, Chromecast/DLNA,
archive streaming (rar/zip), YouTube, NZB, HTTPS endpoint, hardware-acceleration
profiling.
