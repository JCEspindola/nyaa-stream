// Prepares what the Android build needs from this repo:
//   android/app/src/main/assets/nodejs-project/  server bundle (Node 18) + web UI
//   android/app/libnode/                          nodejs-mobile runtime (libnode.so + headers)
//   node scripts/build-android-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cache = path.join(root, '.cache');
const app = path.join(root, 'android', 'app');

// nodejs-mobile: Node 18 built for Android (arm64-v8a, armeabi-v7a, x86_64).
const NODE_MOBILE = 'v18.20.4';
const NODE_MOBILE_ZIP = `nodejs-mobile-${NODE_MOBILE}-android.zip`;
const NODE_MOBILE_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${NODE_MOBILE}/${NODE_MOBILE_ZIP}`;

const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'unzip';

// 1. runtime
const libnode = path.join(app, 'libnode');
if (!fs.existsSync(path.join(libnode, 'bin', 'arm64-v8a', 'libnode.so'))) {
  fs.mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, NODE_MOBILE_ZIP);
  if (!fs.existsSync(zip)) {
    console.log(`Downloading ${NODE_MOBILE_URL}`);
    const res = await fetch(NODE_MOBILE_URL);
    if (!res.ok) throw new Error(`nodejs-mobile download failed: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const tmp = path.join(cache, 'nodejs-mobile');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync(tar, process.platform === 'win32' ? ['-xf', zip, '-C', tmp] : ['-q', zip, '-d', tmp], { stdio: 'inherit' });
  // bin/<abi>/libnode.so and include/node, at the zip root or in one top folder.
  const top = [tmp, ...fs.readdirSync(tmp).map((d) => path.join(tmp, d))].find((d) => fs.existsSync(path.join(d, 'bin', 'arm64-v8a', 'libnode.so')));
  if (!top) throw new Error('unexpected nodejs-mobile zip layout');
  fs.rmSync(libnode, { recursive: true, force: true });
  fs.cpSync(top, libnode, { recursive: true });
}

// 2. server bundle + UI
const out = path.join(app, 'src', 'main', 'assets', 'nodejs-project');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'android.js')],
  outfile: path.join(out, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  legalComments: 'none',
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});
// nodejs-mobile ships without Unicode property data, so regexes like
// /[$_\p{ID_Start}]/u (Express's router, path-to-regexp) fail to compile there.
// Swap them for plain ranges; route names in this app are ASCII anyway.
const mainJs = path.join(out, 'main.js');
let code = fs.readFileSync(mainJs, 'utf8')
  .replaceAll('\\p{ID_Start}', 'A-Za-z\\u00C0-\\uFFFF')
  .replaceAll('\\p{ID_Continue}', '0-9A-Za-z\\u00C0-\\uFFFF\\u200C\\u200D');
const leftover = code.match(/\\p\{[A-Za-z_=]+\}/g);
if (leftover) throw new Error(`Unicode property regexes left in the Android bundle: ${[...new Set(leftover)].join(', ')}`);
fs.writeFileSync(mainJs, code);
fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
// The bundle is CommonJS; say so, whatever package.json sits above it.
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'nyaa-stream-android', private: true, type: 'commonjs', main: 'main.js' }, null, 2));
// The Java side re-copies the assets when this changes.
fs.writeFileSync(path.join(out, 'version.txt'), `${pkg.version}-${Date.now()}`);

// 3. launcher icons from assets/icon.svg: flat PNGs (Android 7) and the
// foreground layer of the adaptive icon (Android 8+; background is a gradient).
const res = path.join(app, 'src', 'main', 'res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const foregroundSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <path d="M44 34 L78 54 L44 74 Z" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>`);
for (const [name, scale] of Object.entries(densities)) {
  const dir = path.join(res, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(path.join(root, 'assets', 'icon.svg'), { density: 384 }).resize(Math.round(48 * scale)).png().toFile(path.join(dir, 'ic_launcher.png'));
  await sharp(foregroundSvg, { density: 384 }).resize(Math.round(108 * scale)).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
}
console.log(`Android assets ready (app ${pkg.version}).`);
