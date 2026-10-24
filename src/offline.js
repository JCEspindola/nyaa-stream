// Offline Catalog: whole torrent files downloaded to the device so they can be
// watched without a connection (the Android app's "Add to Offline Catalog").
// Each torrent gets a torrent-stream engine of its own whose storage folder is
// the final location, so a finished file is just a file on disk; the streaming
// engine's cache is size-capped and trimmed, so it cannot hold them.
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import torrentStream from 'torrent-stream';
import parseTorrent from 'parse-torrent';
import mime from 'mime-types';
import { getTorrent } from './nyaa.js';
import { findSeriesForRelease } from './series.js';
import * as anilist from './anilist.js';
import { parseEpisode, formatBytes } from './names.js';
import { DATA_DIR } from './sync.js';
import { NYAA_TRACKERS, spoofedPeerId } from './engine.js';

export const OFFLINE_DIR = path.join(DATA_DIR, 'offline');
const INDEX_FILE = path.join(OFFLINE_DIR, 'index.json');
const POSTER_DIR = path.join(OFFLINE_DIR, 'posters');
// Space left untouched for the rest of the device.
const RESERVE = 200 * 1024 ** 2;
// While downloading: below this much free space, cancel instead of filling the disk.
const MIN_FREE = 64 * 1024 ** 2;
const SPACE_CHECK_MS = 2000;

const IH_RE = /^[0-9a-f]{40}$/;
const keyOf = (ih, idx) => `${ih}:${idx}`;
const torrentDir = (ih) => path.join(OFFLINE_DIR, ih);
const torrentFile = (ih) => path.join(OFFLINE_DIR, `${ih}.torrent`);
const absPath = (item) => path.join(torrentDir(item.ih), item.filePath);

/** key -> item, as saved in index.json */
const items = new Map();
/** infoHash -> { engine, closing } for torrents with downloads in progress */
const torrents = new Map();
let spaceTimer = null;

// ---------- persistence ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${INDEX_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ items: [...items.values()] }));
      fs.renameSync(tmp, INDEX_FILE);
    } catch (err) {
      console.warn('[offline] could not save index:', err.message);
    }
  }, 200);
}

function load() {
  fs.mkdirSync(OFFLINE_DIR, { recursive: true });
  let saved = [];
  try {
    saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).items || [];
  } catch { /* first run */ }
  for (const item of saved) {
    items.set(item.key, item);
    if (item.status === 'done') {
      const size = fs.statSync(absPath(item), { throwIfNoEntry: false })?.size;
      if (size !== item.length) markFailed(item, 'The downloaded file is missing from the device.');
    }
  }
  for (const item of items.values()) if (item.status === 'downloading') startDownload(item);
}

// ---------- disk space ----------
export function freeSpace() {
  try {
    const s = fs.statfsSync(OFFLINE_DIR);
    return s.bavail * s.bsize;
  } catch {
    return null; // statfs unsupported: no space checks
  }
}

function bytesLeft(item) {
  return Math.max(0, item.length - Math.round(progressOf(item) * item.length));
}

function checkSpace() {
  const free = freeSpace();
  if (free === null || free >= MIN_FREE) return;
  for (const item of items.values()) {
    if (item.status === 'downloading') {
      cancelForSpace(item);
    }
  }
}

function cancelForSpace(item) {
  console.warn(`[offline] out of space, cancelling ${item.key}`);
  markFailed(item, 'Cancelled: the device ran out of storage space.');
  stopDownload(item).then(() => deleteFiles(item));
}

// ---------- downloading ----------
function pieceRange(engine, idx) {
  const file = engine.files[idx];
  const pl = engine.torrent.pieceLength;
  return [Math.floor(file.offset / pl), Math.floor((file.offset + Math.max(file.length, 1) - 1) / pl)];
}

function progressOf(item) {
  if (item.status === 'done') return 1;
  const t = torrents.get(item.ih);
  if (!t?.engine.torrent) return item.progress || 0;
  const [start, end] = pieceRange(t.engine, item.idx);
  let have = 0;
  for (let i = start; i <= end; i++) if (t.engine.bitfield.get(i)) have++;
  item.progress = have / (end - start + 1);
  return item.progress;
}

const downloadingIn = (ih) => [...items.values()].filter((i) => i.ih === ih && i.status === 'downloading');

function engineFor(ih) {
  const existing = torrents.get(ih);
  if (existing && !existing.closing) return existing;
  const buf = fs.readFileSync(torrentFile(ih));
  const announce = parseTorrent(buf).announce || [];
  const engine = torrentStream(buf, {
    id: spoofedPeerId(),
    connections: 100,
    uploads: 4,
    path: torrentDir(ih),
    tmp: process.env.NYAA_TMP_DIR || undefined,
    trackers: [...new Set([...announce, ...NYAA_TRACKERS])],
    dht: true,
    tracker: true,
  });
  const t = { engine, closing: false };
  torrents.set(ih, t);
  const checkDone = (piece) => {
    if (!engine.torrent) return;
    for (const item of downloadingIn(ih)) {
      const [start, end] = pieceRange(engine, item.idx);
      if (piece !== undefined && (piece < start || piece > end)) continue;
      if (progressOf(item) === 1) finishDownload(item);
    }
  };
  engine.on('verify', checkDone);
  engine.on('ready', () => {
    for (const item of downloadingIn(ih)) engine.files[item.idx]?.select();
    checkDone();
  });
  engine.on('error', (err) => {
    console.error(`[offline ${ih}] error:`, err.message);
    if (err.code === 'ENOSPC') for (const item of downloadingIn(ih)) cancelForSpace(item);
  });
  console.log(`[offline] downloading from ${ih}`);
  return t;
}

function startDownload(item) {
  try {
    const t = engineFor(item.ih);
    if (t.engine.torrent) t.engine.files[item.idx]?.select();
  } catch (err) {
    markFailed(item, `Could not start the download: ${err.message}`);
    return;
  }
  if (!spaceTimer) spaceTimer = setInterval(checkSpace, SPACE_CHECK_MS);
}

/** Stop downloading this item; closes the torrent's engine when nothing else needs it. */
async function stopDownload(item) {
  const t = torrents.get(item.ih);
  if (!t) return;
  if (t.engine.torrent) t.engine.files[item.idx]?.deselect();
  if (downloadingIn(item.ih).length) return;
  t.closing = true;
  torrents.delete(item.ih);
  await new Promise((resolve) => t.engine.destroy(() => resolve()));
  if (!torrents.size) {
    clearInterval(spaceTimer);
    spaceTimer = null;
  }
}

async function finishDownload(item) {
  item.status = 'done';
  item.progress = 1;
  item.doneAt = Date.now();
  save();
  console.log(`[offline] finished ${item.key} (${item.fileName})`);
  await stopDownload(item);
  if (!torrents.has(item.ih)) await tidyFolder(item.ih);
}

function markFailed(item, message) {
  item.status = 'failed';
  item.error = message;
  item.failedAt = Date.now();
  item.progress = 0;
  save();
}

/**
 * Pieces that straddle two files also write the start or end of the
 * neighbouring files; once a torrent is idle, keep only the catalog's files.
 */
async function tidyFolder(ih) {
  const keep = new Set([...items.values()].filter((i) => i.ih === ih && i.status !== 'failed').map(absPath));
  if (!keep.size) {
    await fs.promises.rm(torrentDir(ih), { recursive: true, force: true });
    await fs.promises.rm(torrentFile(ih), { force: true });
    return;
  }
  const walk = async (dir) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        await fs.promises.rmdir(p).catch(() => {}); // only succeeds when empty
      } else if (!keep.has(p)) {
        await fs.promises.rm(p, { force: true });
      }
    }
  };
  await walk(torrentDir(ih));
}

async function deleteFiles(item) {
  await fs.promises.rm(absPath(item), { force: true });
  if (!torrents.has(item.ih)) await tidyFolder(item.ih);
}

// ---------- catalog info ----------
async function seriesFor(torrentName, hint) {
  if (hint?.id && /^\d{1,9}$/.test(String(hint.id))) {
    return { id: Number(hint.id), name: String(hint.name || '').slice(0, 300) || null, posterUrl: hint.poster || null };
  }
  try {
    const m = await findSeriesForRelease(torrentName);
    if (m) return { id: m.id, name: anilist.displayTitle(m), posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || null };
  } catch { /* offline catalog still works without a series */ }
  return null;
}

/** Keep the series cover on the device too, so the catalog looks right offline. */
async function savePoster(series) {
  if (!series) return false;
  const file = path.join(POSTER_DIR, `${series.id}.img`);
  if (fs.existsSync(file)) return true;
  if (!series.posterUrl) return false;
  try {
    const url = new URL(series.posterUrl);
    if (url.protocol !== 'https:' || !/(^|\.)anilist\.co$/.test(url.hostname)) return false;
    const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) return false;
    await fs.promises.mkdir(POSTER_DIR, { recursive: true });
    await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

function publicItem(item) {
  const t = torrents.get(item.ih);
  return {
    ...item,
    progress: progressOf(item),
    speed: t ? t.engine.swarm.downloadSpeed() : 0,
    peers: t ? t.engine.swarm.wires.length : 0,
    size: formatBytes(item.length),
  };
}

/** Path of a finished offline file, so streaming it needs no peers. */
export function offlineFile(ih, idx) {
  const item = items.get(keyOf(ih, idx));
  return item?.status === 'done' ? absPath(item) : null;
}

// ---------- adding ----------
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const adding = new Set();

async function addItem(body) {
  const nyaaId = String(body.nyaaId || '');
  const idx = Number(body.idx);
  if (!/^\d{1,9}$/.test(nyaaId) || !Number.isInteger(idx) || idx < 0) throw new HttpError(400, 'nyaaId and idx are required');

  const torrent = await getTorrent(nyaaId);
  const ih = torrent.infoHash;
  const file = torrent.files[idx];
  if (!file) throw new HttpError(404, `This torrent has no file ${idx}`);
  const key = keyOf(ih, idx);
  const existing = items.get(key);
  if (existing && existing.status !== 'failed') return existing;
  if (adding.has(key)) throw new HttpError(409, 'Already being added');
  adding.add(key);
  try {
    // Room for the file, the pieces it shares with neighbouring files, and
    // whatever the downloads already running still need.
    const { pieceLength } = parseTorrent(torrent.buffer);
    const pending = [...items.values()].filter((i) => i.status === 'downloading').reduce((n, i) => n + bytesLeft(i), 0);
    const needed = file.length + 2 * pieceLength;
    const free = freeSpace();
    const usable = free === null ? Infinity : Math.max(0, free - RESERVE - pending);
    if (usable < needed) {
      throw new HttpError(507, `Not enough free space on this device. This video is ${formatBytes(file.length)}, but only ${formatBytes(usable)} is free${pending ? ' once the downloads in progress finish' : ''}. Nothing was downloaded.`, { needed, free: usable });
    }

    await fs.promises.mkdir(OFFLINE_DIR, { recursive: true });
    await fs.promises.writeFile(torrentFile(ih), torrent.buffer);
    const series = existing?.series || await seriesFor(torrent.name, body.series);
    const parsedEp = parseEpisode(file.path || file.name).episode;
    const item = {
      key,
      ih,
      idx,
      nyaaId,
      torrentName: torrent.name,
      fileName: file.name,
      filePath: file.path,
      length: file.length,
      title: String(body.title || existing?.title || file.name).slice(0, 300),
      episode: Number(body.episode) || existing?.episode || parsedEp || null,
      series: series ? { id: series.id, name: series.name, hasPoster: await savePoster(series) } : null,
      status: 'downloading',
      progress: 0,
      addedAt: existing?.addedAt || Date.now(),
    };
    items.set(key, item);
    save();
    startDownload(item);
    return item;
  } finally {
    adding.delete(key);
  }
}

async function removeItem(key) {
  const item = items.get(key);
  if (!item) return false;
  items.delete(key);
  save();
  await stopDownload(item);
  await deleteFiles(item);
  if (item.series && ![...items.values()].some((i) => i.series?.id === item.series.id)) {
    await fs.promises.rm(path.join(POSTER_DIR, `${item.series.id}.img`), { force: true });
  }
  console.log(`[offline] removed ${key}`);
  return true;
}

// ---------- routes ----------
export function offlineRouter() {
  load();
  const router = Router();

  router.get('/offline', (req, res) => {
    const list = [...items.values()].map(publicItem);
    res.json({
      items: list,
      free: freeSpace(),
      used: list.filter((i) => i.status === 'done').reduce((n, i) => n + i.length, 0),
      downloading: list.filter((i) => i.status === 'downloading').length,
    });
  });

  router.post('/offline', express.json({ limit: '16kb' }), async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
    try {
      res.status(201).json(publicItem(await addItem(req.body || {})));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, ...(err.extra || {}) });
    }
  });

  router.param('ih', (req, res, next, ih) => {
    if (!IH_RE.test(ih)) return res.status(400).json({ error: 'invalid info hash' });
    next();
  });

  router.delete('/offline/:ih/:idx', async (req, res) => {
    const ok = await removeItem(keyOf(req.params.ih, Number(req.params.idx)));
    res.status(ok ? 204 : 404).end();
  });

  router.get('/offline/:ih/:idx/file', (req, res) => {
    const file = offlineFile(req.params.ih, Number(req.params.idx));
    if (!file) return res.status(404).json({ error: 'not downloaded' });
    res.sendFile(file, { headers: { 'Content-Type': mime.lookup(file) || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  });

  router.get('/offline/poster/:id', (req, res) => {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).end();
    const file = path.join(POSTER_DIR, `${req.params.id}.img`);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' } });
  });

  return router;
}
