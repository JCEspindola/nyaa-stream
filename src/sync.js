// Anonymous sync codes: a library (plus watch progress) stored under a random
// code, so the same library can be opened on another device without accounts.
// Whoever has the code can read and change that library, nothing else.
//
// The server never merges: each save names the revision it was based on, and a
// stale save gets 409 with the current copy so the browser merges and retries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { Router } from 'express';

export const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.nyaa-stremio');
const SYNC_DIR = path.join(DATA_DIR, 'sync');

// No 0/O, 1/I/L: codes get read aloud and typed by hand. 16 chars ≈ 79 bits.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 16;

function newCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return c.match(/.{4}/g).join('-');
}

/** Accept "k7qf 2mxp-…" as typed; null if it cannot be a code. */
function normalizeCode(raw) {
  const c = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (c.length !== CODE_LEN || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return c.match(/.{4}/g).join('-');
}

// Files are named by a hash of the code, so a copy of the data folder does not
// hand out working codes.
const fileFor = (code) => path.join(SYNC_DIR, `${crypto.createHash('sha256').update(code).digest('hex')}.json`);

function read(code) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(code), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function write(code, record) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const file = fileFor(code);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- validation: keep only the fields the app uses, bounded ----------
const MAX_LIBRARY = 2000;
const MAX_PROGRESS = 500;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function sanitize(data) {
  if (!data || typeof data !== 'object') throw new Error('invalid data');
  const library = (Array.isArray(data.library) ? data.library : [])
    .filter((e) => e && /^\d{1,9}$/.test(String(e.id)))
    .slice(0, MAX_LIBRARY)
    .map((e) => clean({
      id: String(e.id),
      name: str(e.name, 300),
      poster: /^https:\/\//.test(e.poster || '') ? str(e.poster, 500) : undefined,
      addedAt: num(e.addedAt),
      updatedAt: num(e.updatedAt) ?? 0,
      removed: e.removed === true ? true : undefined,
    }));
  const progress = {};
  const entries = Object.entries(data.progress && typeof data.progress === 'object' ? data.progress : {})
    .filter(([k, p]) => /^(\d+:\d+|anilist:\d+:\d+)$/.test(k) && p && typeof p === 'object')
    .sort((a, b) => (num(b[1].ts) ?? 0) - (num(a[1].ts) ?? 0))
    .slice(0, MAX_PROGRESS);
  for (const [k, p] of entries) {
    progress[k] = clean({
      t: num(p.t), d: num(p.d), ts: num(p.ts) ?? 0,
      title: str(p.title, 300), show: str(p.show, 300),
      poster: /^https:\/\//.test(p.poster || '') ? str(p.poster, 500) : undefined,
      series: /^\d{1,9}$/.test(String(p.series ?? '')) ? String(p.series) : undefined,
      ep: num(p.ep), bg: str(p.bg, 200),
    });
  }
  return { v: 1, library, progress };
}

// ---------- tiny per-IP rate limits (codes are unguessable; this caps abuse) ----------
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests, try again in a minute' });
    next();
  };
}

export function syncRouter() {
  const router = Router();
  const json = express.json({ limit: '512kb' });
  const jsonOnly = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'JSON required' }));
  router.use('/sync', limiter(120, 60e3));

  // Create a new code holding the given library.
  router.post('/sync', limiter(10, 60 * 60e3), json, jsonOnly, (req, res) => {
    let data;
    try { data = sanitize(req.body?.data); } catch (err) { return res.status(400).json({ error: err.message }); }
    let code;
    do code = newCode(); while (read(code));
    const record = { rev: 1, updatedAt: Date.now(), data };
    write(code, record);
    res.status(201).json({ code, rev: record.rev, updatedAt: record.updatedAt });
  });

  router.param('code', (req, res, next, raw) => {
    req.code = normalizeCode(raw);
    if (!req.code) return res.status(400).json({ error: 'That is not a valid sync code' });
    next();
  });

  router.get('/sync/:code', (req, res) => {
    const record = read(req.code);
    if (!record) return res.status(404).json({ error: 'No library with this code' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: req.code, ...record });
  });

  // Save, but only on top of the revision the browser last saw.
  router.put('/sync/:code', json, jsonOnly, (req, res) => {
    const current = read(req.code);
    if (!current) return res.status(404).json({ error: 'No library with this code' });
    if (req.body?.baseRev !== current.rev) return res.status(409).json({ error: 'changed elsewhere', code: req.code, ...current });
    let data;
    try { data = sanitize(req.body?.data); } catch (err) { return res.status(400).json({ error: err.message }); }
    const record = { rev: current.rev + 1, updatedAt: Date.now(), data };
    write(req.code, record);
    res.json({ code: req.code, rev: record.rev, updatedAt: record.updatedAt });
  });

  router.delete('/sync/:code', json, jsonOnly, (req, res) => {
    fs.rm(fileFor(req.code), { force: true }, () => res.json({ ok: true }));
  });

  return router;
}
