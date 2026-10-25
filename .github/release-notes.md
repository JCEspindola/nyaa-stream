## What's new in 1.0.3

- **Back from the player goes where you started:** after watching several episodes in a row with Next (or auto-play), Back now returns straight to the page where you picked the first one, instead of stepping back through every episode. Works the same in the Windows/browser player and the Android app, including the phone's Back button.
- **Android, devices with 16 KB memory pages:** the app's own native code is now built for them. The bundled Node.js runtime isn't yet (waiting on an upstream release), so Android may still show an "isn't 16 KB compatible" notice when the app opens; tap OK and the app works normally.

## Downloads

| File | For |
|---|---|
| `NyaaStream-<version>-windows.exe` | Windows 10/11 (64-bit). Run it; the app opens in your browser. Keep the console window open while watching. |
| `NyaaStream-<version>-arm64-v8a.apk` | Most Android phones and tablets (2017 and newer) |
| `NyaaStream-<version>-armeabi-v7a.apk` | Older 32-bit Android phones |
| `NyaaStream-<version>-x86_64.apk` | Android emulators and x86 Chromebooks |

**Windows:** the .exe is not code-signed, so SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

**Android:** open the APK on the phone and allow "Install unknown apps" for your browser or file manager when asked. Android 7.0 or newer. If Android says "App not installed": make sure you picked the `arm64-v8a` file (the other two only fit older or emulated devices), uninstall any older copy of Nyaa Stream first, check you have at least 300 MB free, and download the APK again directly from this page.

Torrenting uploads data to other peers while you watch. Only stream content you have the right to access where you live.
