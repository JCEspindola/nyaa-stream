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
import { engineRouter, CACHE_ROOT } from './engine.js';
import { transcodeRouter, setLocalBase, FFMPEG, FFPROBE } from './transcode.js';
import * as external from './external.js';

const PORT = Number(process.env.PORT) || 11471;
const HOST = process.env.HOST || '127.0.0.1';
const root = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
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

app.use(express.static(path.join(root, '..', 'public')));

app.listen(PORT, HOST, () => {
  const base = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  setLocalBase(`http://127.0.0.1:${PORT}`);
  console.log(`Nyaa Stream running at ${base}`);
  console.log(`  addon manifest: ${base}/addon/manifest.json`);
  console.log(`  cache:          ${CACHE_ROOT}`);
  console.log(`  ffmpeg:         ${FFMPEG || 'not found (browser compatibility mode disabled)'}`);
  console.log(`  ffprobe:        ${FFPROBE || 'not found'}`);
  console.log(`  players:        ${external.players.map((p) => p.name).join(', ') || 'none detected'}`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${base}"` : process.platform === 'darwin' ? `open ${base}` : `xdg-open ${base}`;
    exec(cmd);
  }
});
