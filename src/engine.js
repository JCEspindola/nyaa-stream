// Simplified EngineFS: the torrent streaming server half of Stremio.
// Mirrors server.js routes (/:infoHash/:idx with Range, /create, /stats.json,
// /remove), GuessFileIdx, the stream/engine reference counters and the cache cap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import torrentStream from 'torrent-stream';
import rangeParser from 'range-parser';
import mime from 'mime-types';
import { getTorrentByHash } from './nyaa.js';
import { guessFileIdx } from './names.js';

// Same values Stremio's server.js sets at startup.
export const STREAM_TIMEOUT = 20e3;
export const ENGINE_TIMEOUT = Number(process.env.ENGINE_TIMEOUT_MS) || 120e3;
const READY_TIMEOUT = 60e3;

export const CACHE_ROOT = process.env.CACHE_DIR || path.join(os.tmpdir(), 'nyaa-stremio-cache');
const CACHE_SIZE = Number(process.env.CACHE_SIZE) || 2 * 1024 ** 3;

// Trackers listed in nyaa.si magnets; used when we only have an info hash.
export const NYAA_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

const IH_RE = /^[0-9a-f]{40}$/i;

// Peer IDs that look like common clients, like Stremio's spoofedPeerId().
const CLIENT_PREFIXES = ['qB4600', 'DE2110', 'AZ5770', 'TR4040'];
function spoofedPeerId() {
  const prefix = CLIENT_PREFIXES[Math.floor(Math.random() * CLIENT_PREFIXES.length)];
  let rand = '';
  while (rand.length < 12) rand += Math.random().toString(36).slice(2);
  return `-${prefix}-${rand.slice(0, 12)}`;
}

/** infoHash -> { engine, ready: Promise, open: Map<idx, count>, timers } */
const engines = new Map();

export function createEngine(infoHash) {
  const ih = infoHash.toLowerCase();
  const existing = engines.get(ih);
  if (existing) {
    existing.engine.swarm.resume();
    return existing.ready;
  }

  const known = getTorrentByHash(ih);
  const trackers = [...new Set([...(known?.announce || []), ...NYAA_TRACKERS])];
  const source = known ? known.buffer : `magnet:?xt=urn:btih:${ih}`;
  const engine = torrentStream(source, {
    id: spoofedPeerId(),
    connections: 200, // Stremio peerSearch max
    uploads: 10,
    path: path.join(CACHE_ROOT, ih),
    trackers,
    dht: true,
    tracker: true,
  });

  const entry = { engine, open: new Map(), openTotal: 0, timer: null, cached: new Set() };
  entry.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out fetching torrent metadata (no peers?)')), READY_TIMEOUT);
    engine.on('ready', () => {
      clearTimeout(t);
      resolve(engine);
    });
  });
  entry.ready.catch(() => {});
  engine.on('error', (err) => console.error(`[engine ${ih}] error:`, err.message));
  engine.on('invalid-piece', (p) => console.warn(`[engine ${ih}] invalid piece ${p}`));
  engines.set(ih, entry);
  console.log(`[engine] created ${ih}${known ? ` (${known.name})` : ' (magnet)'}`);
  trimCache().catch((e) => console.warn('[engine] cache trim failed:', e.message));
  // An engine nobody streams from is torn down like an inactive one.
  scheduleInactive(ih);
  return entry.ready;
}

function scheduleInactive(ih) {
  const entry = engines.get(ih);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (process.env.DEBUG_ENGINE) console.log(`[engine] ${ih} idle, destroying in ${ENGINE_TIMEOUT / 1000}s unless reopened`);
  entry.timer = setTimeout(() => {
    if (entry.openTotal === 0) {
      console.log(`[engine] ${ih} inactive for ${ENGINE_TIMEOUT / 1000}s, destroying`);
      removeEngine(ih);
    }
  }, ENGINE_TIMEOUT);
}

/** Track an open HTTP stream; returns the close callback. */
function streamOpened(ih, idx) {
  const entry = engines.get(ih);
  entry.openTotal++;
  entry.open.set(idx, (entry.open.get(idx) || 0) + 1);
  clearTimeout(entry.timer);
  // Stremio: on first open, select the whole file at low priority so it keeps
  // downloading in the background between range requests.
  const file = entry.engine.files[idx];
  if (!entry.cached.has(idx)) {
    entry.cached.add(idx);
    file.select();
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    entry.openTotal--;
    entry.open.set(idx, entry.open.get(idx) - 1);
    if (entry.openTotal === 0) scheduleInactive(ih);
  };
}

export function removeEngine(ih) {
  const entry = engines.get(ih);
  if (!entry) return Promise.resolve();
  engines.delete(ih);
  clearTimeout(entry.timer);
  return new Promise((resolve) => entry.engine.destroy(() => resolve()));
}

export const hasEngine = (ih) => engines.has(ih.toLowerCase());

/** Keep the cache folder under CACHE_SIZE by deleting the oldest torrents. */
async function trimCache() {
  await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
  const dirs = await fs.promises.readdir(CACHE_ROOT, { withFileTypes: true });
  const items = [];
  for (const d of dirs) {
    if (!d.isDirectory() || engines.has(d.name)) continue;
    const full = path.join(CACHE_ROOT, d.name);
    items.push({ full, size: await dirSize(full), mtime: (await fs.promises.stat(full)).mtimeMs });
  }
  let total = items.reduce((n, i) => n + i.size, 0);
  items.sort((a, b) => a.mtime - b.mtime);
  for (const item of items) {
    if (total <= CACHE_SIZE) break;
    await fs.promises.rm(item.full, { recursive: true, force: true });
    total -= item.size;
    console.log(`[engine] cache: removed ${path.basename(item.full)}`);
  }
}

async function dirSize(dir) {
  let n = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await fs.promises.stat(p)).size;
  }
  return n;
}

export function getStatistics(ih, idx) {
  const entry = engines.get(ih);
  if (!entry) return null;
  const e = entry.engine;
  const unchoked = e.swarm.wires.filter((w) => !w.peerChoking).length;
  const s = {
    infoHash: ih,
    name: e.torrent?.name,
    ready: !!e.torrent,
    peers: e.swarm.wires.length,
    unchoked,
    queued: e.swarm.queued,
    downloaded: e.swarm.downloaded,
    uploaded: e.swarm.uploaded,
    downloadSpeed: e.swarm.downloadSpeed(),
    uploadSpeed: e.swarm.uploadSpeed(),
    openStreams: entry.openTotal,
    files: e.torrent ? e.files.map((f, i) => ({ idx: i, name: f.name, path: f.path, length: f.length })) : null,
  };
  if (e.torrent && idx !== undefined && e.files[idx]) {
    const file = e.files[idx];
    const pl = e.torrent.pieceLength;
    const start = Math.floor(file.offset / pl);
    const end = Math.floor((file.offset + file.length - 1) / pl);
    let have = 0;
    for (let i = start; i <= end; i++) if (e.bitfield.get(i)) have++;
    s.streamName = file.name;
    s.streamLen = file.length;
    s.streamProgress = have / (end - start + 1);
  }
  return s;
}

export const streamUrl = (base, ih, idx, name) =>
  `${base}/engine/${ih}/${idx}${name ? `/${encodeURIComponent(name)}` : ''}`;

export function engineRouter() {
  const router = Router();

  router.get('/stats.json', (req, res) => {
    const out = {};
    for (const ih of engines.keys()) out[ih] = getStatistics(ih);
    res.json(out);
  });

  router.get('/removeAll', async (req, res) => {
    await Promise.all([...engines.keys()].map(removeEngine));
    res.json({});
  });

  router.param('ih', (req, res, next, ih) => {
    if (!IH_RE.test(ih)) return res.status(400).json({ error: 'invalid info hash' });
    req.ih = ih.toLowerCase();
    next();
  });

  router.all('/:ih/create', async (req, res) => {
    try {
      const engine = await createEngine(req.ih);
      const stats = getStatistics(req.ih);
      const hint = { season: Number(req.query.season) || null, episode: Number(req.query.episode) || null };
      stats.guessedFileIdx = guessFileIdx(engine.files, hint);
      res.json(stats);
    } catch (err) {
      res.status(504).json({ error: err.message });
    }
  });

  router.get('/:ih/stats.json', (req, res) => res.json(getStatistics(req.ih)));
  router.get('/:ih/:idx/stats.json', (req, res) => res.json(getStatistics(req.ih, Number(req.params.idx))));

  router.get('/:ih/remove', async (req, res) => {
    await removeEngine(req.ih);
    res.json({});
  });

  router.get('/:ih/:idx', handleTorrent);
  router.get('/:ih/:idx/:name', handleTorrent);
  return router;
}

// Port of EngineFS handleTorrent: resolve the file and serve byte ranges.
async function handleTorrent(req, res) {
  let engine;
  try {
    engine = await createEngine(req.ih);
  } catch (err) {
    return res.status(504).json({ error: err.message });
  }
  let idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx === -1) {
    idx = guessFileIdx(engine.files, { season: Number(req.query.season) || null, episode: Number(req.query.episode) || null });
  }
  const file = engine.files[idx];
  if (!file) return res.status(404).json({ error: `Torrent does not contain file with index ${idx}` });

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime.lookup(file.name) || 'application/octet-stream');
  res.setHeader('Cache-Control', 'max-age=0, no-cache');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);

  const range = req.headers.range && rangeParser(file.length, req.headers.range)?.[0];
  if (req.headers.range && (!range || range.start === undefined)) {
    res.setHeader('Content-Range', `bytes */${file.length}`);
    return res.status(416).end();
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Length', range.end - range.start + 1);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`);
  } else {
    res.setHeader('Content-Length', file.length);
  }
  if (req.method === 'HEAD') return res.end();

  const done = streamOpened(req.ih, idx);
  req.socket.setTimeout(864e5);
  const stream = file.createReadStream(range ? { start: range.start, end: range.end } : undefined);
  const close = () => {
    stream.destroy();
    done();
  };
  res.on('close', close);
  stream.on('error', (err) => {
    console.warn(`[engine] stream error: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}
