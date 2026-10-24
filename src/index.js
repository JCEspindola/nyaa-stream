// One process with the three parts Stremio splits across processes:
//   /addon     – Nyaa addon (Stremio addon protocol)
//   /engine    – torrent streaming server (EngineFS-style, Range requests)
//   /transcode – ffmpeg probe / browser-safe remux / subtitle extraction
//   /          – the web UI (public/)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import express from 'express';
import { addonRouter } from './addon.js';
import { engineRouter, useLocalFiles, CACHE_ROOT } from './engine.js';
import { transcodeRouter, setLocalBase, FFMPEG, FFPROBE } from './transcode.js';
import * as external from './external.js';
import { libraryRouter } from './library.js';
import { syncRouter, DATA_DIR } from './sync.js';
import { offlineRouter, offlineFile } from './offline.js';

let PORT = Number(process.env.PORT) || 11471;
const HOST = process.env.HOST || '127.0.0.1';
// The packaged .exe unpacks the UI elsewhere and says where via PUBLIC_DIR.
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy, set TRUST_PROXY (e.g. "1") so rate limits see the real client IP.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use('/addon', addonRouter());
app.use('/engine', engineRouter());
app.use('/transcode', transcodeRouter());

const api = express.Router();
api.get('/players', (req, res) => res.json(external.players.map(({ id, name }) => ({ id, name }))));
// JSON body requirement means a cross-site form cannot trigger a launch.
api.post('/external', express.json(), (req, res) => {
  const { player, ih, idx, title } = req.body || {};
  if (!/^[0-9a-f]{40}$/i.test(ih || '') || !Number.isInteger(idx)) return res.status(400).json({ error: 'bad request' });
  try {
    external.launch(player, `http://127.0.0.1:${PORT}/engine/${ih.toLowerCase()}/${idx}`, String(title || 'Nyaa'));
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});
api.get('/playlist.m3u', (req, res) => {
  const { ih, idx, title = 'Nyaa' } = req.query;
  if (!/^[0-9a-f]{40}$/i.test(ih || '') || !/^\d+$/.test(idx || '')) return res.status(400).end();
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', 'attachment; filename="nyaa-stream.m3u"');
  res.send(`#EXTM3U\n#EXTINF:-1,${String(title).replace(/[\r\n]/g, ' ')}\nhttp://127.0.0.1:${PORT}/engine/${ih.toLowerCase()}/${idx}\n`);
});
app.use('/api', api);
app.use('/api', libraryRouter());
app.use('/api', syncRouter());
app.use('/api', offlineRouter());
useLocalFiles(offlineFile);

app.use(express.static(PUBLIC_DIR));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd);
}

/** True when a Nyaa Stream server already answers on this port. */
async function isNyaaStream(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/addon/manifest.json`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).id === 'community.nyaa.stremio-lite';
  } catch {
    return false;
  }
}

// Port taken: if it is another copy of this app (e.g. the .exe started twice),
// just open that one; otherwise try the next few ports.
const server = app.listen(PORT, HOST);
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  if (await isNyaaStream(PORT)) {
    console.log(`Nyaa Stream is already running at http://127.0.0.1:${PORT}`);
    if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${PORT}`);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  if (process.env.PORT || PORT >= 11481) throw err;
  PORT += 1;
  server.listen(PORT, HOST);
});

server.on('listening', () => {
  const base = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  setLocalBase(`http://127.0.0.1:${PORT}`);
  console.log(`Nyaa Stream running at ${base}`);
  console.log(`  addon manifest: ${base}/addon/manifest.json`);
  console.log(`  cache:          ${CACHE_ROOT}`);
  console.log(`  sync data:      ${DATA_DIR}`);
  console.log(`  ffmpeg:         ${FFMPEG || 'not found (browser compatibility mode disabled)'}`);
  console.log(`  ffprobe:        ${FFPROBE || 'not found'}`);
  console.log(`  players:        ${external.players.map((p) => p.name).join(', ') || 'none detected'}`);
  if (process.argv.includes('--open')) openBrowser(base);
});
