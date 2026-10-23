# Nyaa Stream

A simplified Stremio clone with a single source: [nyaa.si](https://nyaa.si).
Browse or search nyaa, open a torrent, pick an episode, and it streams while it
downloads.

Built by reverse engineering the installed Stremio for Windows; see
[docs/STREMIO-ARCHITECTURE.md](docs/STREMIO-ARCHITECTURE.md) for how Stremio is put
together and which parts this project keeps.

## Run

```bash
npm install
npm start
```

Then open http://127.0.0.1:11471 (or run `npm run open` to open it automatically).

Requirements: Node 20+. ffmpeg/ffprobe are optional but recommended; they are found
on `PATH`, in the Stremio install folder, or via `FFMPEG_PATH` / `FFPROBE_PATH`.
Without them you get direct playback only, with no subtitles and no audio-track switching.

## How it maps to Stremio

| Stremio | Here | Path |
|---|---|---|
| Addons (catalog/meta/stream protocol) | Built-in Nyaa addon | `src/addon.js` → `/addon/*` |
| Streaming server, EngineFS on :11470 | torrent-stream engine with Range requests, GuessFileIdx, idle timeouts, 2 GiB cache | `src/engine.js` → `/engine/*` |
| `/hlsv2` transcoder + embedded mpv | ffmpeg remux/transcode to fragmented MP4, live soft-subtitle extraction, mpv/VLC hand-off | `src/transcode.js`, `src/external.js` |
| stremio-web UI | Discover/search, torrent page, player, Continue watching | `public/` |

The addon follows the real Stremio protocol, so you can also install it into
Stremio itself: paste `http://127.0.0.1:11471/addon/manifest.json` into Stremio's
addon search while this app is running.

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
| `GET /addon/catalog/series/{nyaa-latest\|nyaa-popular}/{search=…&skip=…&genre=…}.json` | Search/browse (75 per page) |
| `GET /addon/meta/series/nyaa:{id}.json` | Torrent details; media files as `videos` |
| `GET /addon/stream/series/nyaa:{id}:{fileIdx}.json` | `{infoHash, fileIdx, sources}` |
| `GET /engine/{infoHash}/{fileIdx}` | File bytes (Range supported; `-1` = guess the main file) |
| `GET /engine/{infoHash}/create` | Start the engine; returns stats and `guessedFileIdx` |
| `GET /engine/{infoHash}/{fileIdx}/stats.json` | Peers, speed, cached fraction |
| `GET /engine/stats.json`, `/engine/{infoHash}/remove`, `/engine/removeAll` | Engine management |
| `GET /transcode/{infoHash}/{fileIdx}/probe.json` | Codecs, duration, audio/subtitle tracks |
| `GET /transcode/{infoHash}/{fileIdx}/video.mp4?t=&a=&s=&sid=&hevc=` | Browser-safe stream |

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `PORT` / `HOST` | `11471` / `127.0.0.1` (listens on this machine only) |
| `CACHE_DIR` | `%TEMP%/nyaa-stremio-cache` |
| `CACHE_SIZE` | `2147483648` (bytes; oldest torrents are removed first) |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `MPV_PATH`, `VLC_PATH` | auto-detected |
| `X264_PRESET` | `veryfast` |
| `NYAA_URL` | `https://nyaa.si` |

## Notes

Torrenting uploads data to other peers while you watch. Only stream content you
have the right to access where you live.
