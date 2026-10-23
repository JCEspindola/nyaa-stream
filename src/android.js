// Entry point inside the Android app (nodejs-mobile). The Java side starts
// Node as `node main.js <filesDir> <cacheDir>`; Android has no /tmp and no
// home folder, so every path the server uses is pointed at the app's own
// storage before the server modules load.
import fs from 'node:fs';
import path from 'node:path';

const [filesDir, cacheDir] = process.argv.slice(2);
if (!filesDir || !cacheDir) throw new Error('usage: main.js <filesDir> <cacheDir>');

const tmp = path.join(cacheDir, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, {
  // Node's os.tmpdir() ignores TMPDIR in Android app processes (it treats them
  // as privileged), so the server reads NYAA_TMP_DIR instead.
  TMPDIR: tmp,
  NYAA_TMP_DIR: tmp,
  HOME: filesDir,
  PUBLIC_DIR: path.join(path.dirname(process.argv[1]), 'public'),
  CACHE_DIR: path.join(cacheDir, 'torrents'),
  CACHE_SIZE: String(1024 ** 3), // phones have less room: 1 GiB of torrent cache
  DATA_DIR: path.join(filesDir, 'data'),
  NYAA_PLATFORM: 'android',
});
process.noDeprecation = true;

// When Node exits on Android it takes the whole app down with it, so log
// stray errors instead of crashing (a failed request must not close the app).
process.on('uncaughtException', (err) => console.error('[uncaught]', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err?.stack || err));

// Imported only now, so the server reads the settings above when it loads.
import('./index.js').catch((err) => {
  console.error('[startup failed]', err?.stack || err);
  // Keep Node (and the app) alive; the UI shows "server did not start".
  setInterval(() => {}, 1 << 30);
});
