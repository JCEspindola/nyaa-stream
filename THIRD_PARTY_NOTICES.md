# Third-party software in the release builds

Nyaa Stream's own code is MIT licensed (see `LICENSE`). The downloadable builds
also contain the following programs, each under its own license.

## Windows (`NyaaStream-*-windows.exe`)

| Component | License | Source |
|---|---|---|
| Node.js 24 (the executable the app runs in) | MIT and others, see its `LICENSE` | https://github.com/nodejs/node |
| FFmpeg 8.1, "gpl-shared" build by BtbN (`ffmpeg.exe`, `ffprobe.exe` and their DLLs, unpacked to `%LOCALAPPDATA%\NyaaStream`) | GPL v3 (includes libx264 and other GPL libraries); its license text is unpacked next to it as `ffmpeg\LICENSE.txt` | FFmpeg: https://ffmpeg.org/releases/ (tag `n8.1`). Exact build scripts and library versions: https://github.com/BtbN/FFmpeg-Builds. |

FFmpeg runs as a separate program that Nyaa Stream starts; it is not linked into
Nyaa Stream's code.

## Android (`NyaaStream-*.apk`)

| Component | License | Source |
|---|---|---|
| nodejs-mobile 18.20.4 (`libnode.so`) | MIT and the Node.js licenses | https://github.com/nodejs-mobile/nodejs-mobile |
| libVLC for Android 3.7.7 (`org.videolan.android:libvlc-all`) | LGPL 2.1 or later | https://code.videolan.org/videolan/vlc-android |

## npm packages (both builds)

The server bundles these packages from `node_modules` (all MIT or ISC unless
noted): express, torrent-stream and its dependencies (bittorrent-dht,
peer-wire-protocol, …), parse-torrent, range-parser, mime-types. Run
`npx license-checker --production` in the repo for the full list.
