// Nyaa as a Stremio addon (manifest / catalog / meta / stream). The bundled UI
// consumes it the same way stremio-web consumes remote addons, and it can also
// be installed into real Stremio from http://127.0.0.1:<port>/addon/manifest.json
import { Router } from 'express';
import * as nyaa from './nyaa.js';
import { parseEpisode, guessFileIdx, prettyTitle, groupOf, formatBytes, VIDEO_EXT, MEDIA_EXT } from './names.js';

const ID_PREFIX = 'nyaa:';
const CATEGORY_BY_NAME = Object.fromEntries(Object.entries(nyaa.CATEGORIES).map(([k, v]) => [v, k]));

export const manifest = {
  id: 'community.nyaa.stremio-lite',
  version: '1.0.0',
  name: 'Nyaa',
  description: 'Torrents from nyaa.si: browse, search and stream episodes.',
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: [ID_PREFIX] },
    { name: 'stream', types: ['series'], idPrefixes: [ID_PREFIX] },
  ],
  types: ['series'],
  idPrefixes: [ID_PREFIX],
  catalogs: [
    {
      type: 'series',
      id: 'nyaa-latest',
      name: 'Nyaa: Latest',
      extra: [
        { name: 'search' },
        { name: 'skip' },
        { name: 'genre', options: Object.values(nyaa.CATEGORIES) },
      ],
    },
    {
      type: 'series',
      id: 'nyaa-popular',
      name: 'Nyaa: Most seeded',
      extra: [
        { name: 'search' },
        { name: 'skip' },
        { name: 'genre', options: Object.values(nyaa.CATEGORIES) },
      ],
    },
  ],
  behaviorHints: { configurable: false },
};

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const posterUrl = (req, title) => `${baseUrl(req)}/addon/poster.svg?t=${encodeURIComponent(title.slice(0, 80))}`;

// "/catalog/series/nyaa-latest/search=x&skip=75.json" -> { search: 'x', skip: '75' }
function parseExtra(str) {
  if (!str) return {};
  return Object.fromEntries(new URLSearchParams(str));
}

function toMetaPreview(req, r) {
  return {
    id: ID_PREFIX + r.id,
    type: 'series',
    name: r.title,
    poster: posterUrl(req, prettyTitle(r.title)),
    posterShape: 'landscape',
    releaseInfo: r.date?.slice(0, 10),
    description: `${r.size} · ${r.seeders} seeders · ${r.leechers} leechers${r.trusted ? ' · trusted' : ''}`,
    // Not part of the Stremio spec; the bundled UI uses it for its table view.
    nyaa: r,
  };
}

export async function catalog(req, id, extra) {
  const skip = Number(extra.skip) || 0;
  const page = Math.floor(skip / nyaa.PAGE_SIZE) + 1;
  const opts = {
    c: CATEGORY_BY_NAME[extra.genre] || extra.c || '1_2',
    f: extra.f ?? 0,
    s: id === 'nyaa-popular' ? 'seeders' : extra.s || 'id',
    o: extra.o || 'desc',
    p: page,
  };
  const results = await nyaa.search(extra.search || '', opts);
  return { metas: results.map((r) => toMetaPreview(req, r)), hasMore: results.length >= nyaa.PAGE_SIZE };
}

function videosFor(t) {
  const media = t.files.filter((f) => VIDEO_EXT.test(f.path) || MEDIA_EXT.test(f.path));
  const parsed = media.map((f) => ({ f, ...parseEpisode(f.path) }));
  parsed.sort((a, b) =>
    (a.season ?? 1) - (b.season ?? 1)
    || (a.episode ?? 1e9) - (b.episode ?? 1e9)
    || a.f.path.localeCompare(b.f.path, undefined, { numeric: true }));
  return parsed.map(({ f, season, episode }, i) => ({
    id: `${ID_PREFIX}${t.id}:${f.idx}`,
    title: prettyTitle(f.name),
    season: season ?? 1,
    episode: episode ?? i + 1,
    episodeParsed: episode !== null,
    fileName: f.name,
    filePath: f.path,
    size: formatBytes(f.length),
    length: f.length,
    fileIdx: f.idx,
  }));
}

export async function meta(req, id) {
  const nyaaId = id.slice(ID_PREFIX.length).split(':')[0];
  const [t, view] = await Promise.all([nyaa.getTorrent(nyaaId), nyaa.getView(nyaaId).catch(() => ({}))]);
  const name = view.title || t.name;
  return {
    meta: {
      id: ID_PREFIX + t.id,
      type: 'series',
      name,
      poster: posterUrl(req, prettyTitle(name)),
      posterShape: 'landscape',
      background: posterUrl(req, prettyTitle(name)),
      description: view.description?.slice(0, 2000) || `${t.files.length} file(s), ${formatBytes(t.length)}`,
      releaseInfo: groupOf(name) || undefined,
      links: [{ name: 'nyaa.si', category: 'Source', url: `${nyaa.BASE}/view/${t.id}` }],
      videos: videosFor(t),
      behaviorHints: { defaultVideoId: null },
      nyaa: {
        id: t.id,
        infoHash: t.infoHash,
        submitter: view.submitter,
        totalSize: formatBytes(t.length),
        fileCount: t.files.length,
        url: `${nyaa.BASE}/view/${t.id}`,
      },
    },
  };
}

export async function stream(req, id) {
  const [nyaaId, idxStr] = id.slice(ID_PREFIX.length).split(':');
  const t = await nyaa.getTorrent(nyaaId);
  const fileIdx = idxStr !== undefined ? Number(idxStr) : guessFileIdx(t.files);
  const file = t.files[fileIdx];
  if (!file) return { streams: [] };
  const group = groupOf(t.name);
  return {
    streams: [{
      name: 'Nyaa',
      title: `${file.name}\n💾 ${formatBytes(file.length)}`,
      infoHash: t.infoHash,
      fileIdx,
      sources: [...t.announce.map((a) => `tracker:${a}`), `dht:${t.infoHash}`],
      behaviorHints: {
        bingeGroup: `nyaa-${group || t.infoHash}`,
        filename: file.name,
        videoSize: file.length,
      },
    }],
  };
}

function posterSvg(title) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const words = title.split(/\s+/);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 22) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  const shown = lines.slice(0, 4);
  const y0 = 140 - (shown.length - 1) * 17;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},55%,32%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,16%)"/></linearGradient></defs>
<rect width="480" height="270" fill="url(#g)"/>
<text x="240" y="${y0}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="600" fill="#fff">
${shown.map((l, i) => `<tspan x="240" dy="${i ? 34 : 0}">${esc(l)}</tspan>`).join('')}</text></svg>`;
}

export function addonRouter() {
  const router = Router();
  // Stremio clients load addons cross-origin.
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'max-age=300');
      res.json(await fn(req, res));
    } catch (err) {
      console.error('[addon]', err.message);
      res.status(502).json({ error: err.message });
    }
  };

  router.get('/manifest.json', (req, res) => res.json(manifest));
  router.get(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/, wrap((req) =>
    catalog(req, req.params[1], parseExtra(req.params[2] && decodeURIComponent(req.params[2])))));
  router.get(/^\/meta\/([^/]+)\/(.+)\.json$/, wrap((req) => meta(req, decodeURIComponent(req.params[1]))));
  router.get(/^\/stream\/([^/]+)\/(.+)\.json$/, wrap((req) => stream(req, decodeURIComponent(req.params[1]))));
  router.get('/poster.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'max-age=86400');
    res.send(posterSvg(String(req.query.t || 'Nyaa')));
  });
  return router;
}
