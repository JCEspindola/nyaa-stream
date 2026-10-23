// Builds dist/NyaaStream.exe: a Node single-executable app that contains the
// server (bundled with esbuild), the web UI and a Windows ffmpeg build.
//   node scripts/build-exe.mjs
// Runs on Windows (it copies the running node.exe as the base executable).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const work = path.join(dist, 'build');
const cache = path.join(root, '.cache');

// GPL build: "Compatible" mode needs libx264. "shared" = ffmpeg and ffprobe
// share one set of DLLs, roughly halving the size.
const FFMPEG_ZIP = 'ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip';
const FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_ZIP}`;

if (process.platform !== 'win32') throw new Error('Build the .exe on Windows.');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// 1. ffmpeg (downloaded once, then cached)
const ffDir = path.join(cache, FFMPEG_ZIP.replace(/\.zip$/, ''));
if (!fs.existsSync(path.join(ffDir, 'bin', 'ffmpeg.exe'))) {
  fs.mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, FFMPEG_ZIP);
  if (!fs.existsSync(zip)) {
    console.log(`Downloading ${FFMPEG_URL}`);
    const res = await fetch(FFMPEG_URL);
    if (!res.ok) throw new Error(`ffmpeg download failed: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  // Windows' own bsdtar reads zip files; a GNU tar earlier on PATH (Git Bash) does not.
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', cache], { stdio: 'inherit' });
}
const ffFiles = fs.readdirSync(path.join(ffDir, 'bin'))
  .filter((f) => /^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(f))
  .map((f) => ({ src: path.join(ffDir, 'bin', f), path: `ffmpeg/${f}` }));
ffFiles.push({ src: path.join(ffDir, 'LICENSE.txt'), path: 'ffmpeg/LICENSE.txt' });

// 2. server bundle
console.log('Bundling server…');
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'exe.js')],
  outfile: path.join(work, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'none',
  logLevel: 'warning',
  // index.js only reads import.meta.url when PUBLIC_DIR is unset, which never happens in the .exe.
  logOverride: { 'empty-import-meta': 'silent' },
});

// 3. assets: UI files as-is, ffmpeg gzipped (the .exe stores assets uncompressed)
const files = [
  ...fs.readdirSync(path.join(root, 'public')).map((f) => ({ src: path.join(root, 'public', f), path: `public/${f}` })),
  ...ffFiles.map((f) => ({ ...f, gzip: true })),
];
const assets = {};
const hash = crypto.createHash('sha256').update(pkg.version);
const manifestFiles = [];
for (const [i, f] of files.entries()) {
  let data = fs.readFileSync(f.src);
  hash.update(f.path).update(data);
  if (f.gzip) data = zlib.gzipSync(data, { level: 9 });
  const assetFile = path.join(work, 'assets', `${i}.bin`);
  fs.mkdirSync(path.dirname(assetFile), { recursive: true });
  fs.writeFileSync(assetFile, data);
  const name = `file-${i}`;
  assets[name] = assetFile;
  manifestFiles.push({ path: f.path, asset: name, gzip: !!f.gzip });
}
const manifest = { version: pkg.version, build: `${pkg.version}-${hash.digest('hex').slice(0, 12)}`, files: manifestFiles };
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest));
assets['manifest.json'] = path.join(work, 'manifest.json');

// 4. SEA blob
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(work, 'app.cjs'),
  output: path.join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 5. icon + version info on a copy of node.exe, then inject the blob
const exe = path.join(dist, 'NyaaStream.exe');
fs.copyFileSync(process.execPath, exe);
const icon = await makeIco(path.join(root, 'assets', 'icon.svg'), path.join(work, 'icon.ico'));
const { rcedit } = require('rcedit');
await rcedit(exe, {
  icon,
  'file-version': pkg.version,
  'product-version': pkg.version,
  'version-string': {
    ProductName: 'Nyaa Stream',
    FileDescription: 'Nyaa Stream',
    CompanyName: 'Nyaa Stream',
    OriginalFilename: 'NyaaStream.exe',
    LegalCopyright: 'MIT License',
  },
});
const { inject } = require('postject');
await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(work, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});
console.log(`\nBuilt ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB), build ${manifest.build}`);

/** Multi-size .ico from an SVG (PNG-compressed entries, as Windows Vista+ accepts). */
async function makeIco(svgFile, out) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((s) => sharp(svgFile, { density: 384 }).resize(s, s).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(out, Buffer.concat([header, ...pngs]));
  return out;
}
