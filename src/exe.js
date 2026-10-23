// Entry point of the packaged Windows app (a Node single-executable app).
// The UI and ffmpeg are embedded in the .exe as assets; on first run they are
// unpacked to %LOCALAPPDATA%\NyaaStream\<build>, then the normal server starts
// and the browser opens. Running it again opens the copy that is already running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sea from 'node:sea';

// Old dependencies trigger Node deprecation notices; users can't act on them.
process.noDeprecation = true;

function unpack() {
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(base, 'NyaaStream', manifest.build);
  const marker = path.join(dir, '.complete');
  if (!fs.existsSync(marker)) {
    console.log('First run: unpacking app files…');
    for (const file of manifest.files) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = Buffer.from(sea.getAsset(file.asset));
      fs.writeFileSync(target, file.gzip ? zlib.gunzipSync(data) : data);
    }
    fs.writeFileSync(marker, new Date().toISOString());
    // Older builds' files are no longer needed.
    for (const old of fs.readdirSync(path.dirname(dir))) {
      if (old !== manifest.build) fs.rm(path.join(path.dirname(dir), old), { recursive: true, force: true }, () => {});
    }
  }
  return { dir, version: manifest.version };
}

const { dir, version } = unpack();
process.env.PUBLIC_DIR = path.join(dir, 'public');
// The bundled ffmpeg is used unless the user points elsewhere.
process.env.FFMPEG_PATH ||= path.join(dir, 'ffmpeg', 'ffmpeg.exe');
process.env.FFPROBE_PATH ||= path.join(dir, 'ffmpeg', 'ffprobe.exe');
if (!process.argv.includes('--no-open')) process.argv.push('--open');

console.log(`Nyaa Stream ${version}. Keep this window open while you use the app; close it to quit.\n`);
// Imported only now, so the server reads the settings above when it loads.
import('./index.js');
