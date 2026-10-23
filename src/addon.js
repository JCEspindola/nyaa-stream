// Nyaa as a Stremio addon (manifest / catalog / meta / stream). The bundled UI
// consumes it the same way stremio-web consumes remote addons, and it can also
// be installed into real Stremio from http://127.0.0.1:<port>/addon/manifest.json
import { Router } from 'express';
import * as nyaa from './nyaa.js';
import * as anilist from './anilist.js';
import { seriesTorrents, episodeTorrents } from './series.js';
import { NYAA_TRACKERS } from './engine.js';
import { parseEpisode, parseQuality, guessFileIdx, prettyTitle, groupOf, formatBytes, VIDEO_EXT, MEDIA_EXT } from './names.js';

const ID_PREFIX = 'nyaa:';
const SERIES_PREFIX = 'anilist:';
const CATEGORY_BY_NAME = Object.fromEntries(Object.entries(nyaa.CATEGORIES).map(([k, v]) => [v, k]));
const SERIES_CATALOGS = { 'anilist-season': 'season', 'anilist-trending': 'trending', 'anilist-popular': 'popular' };

export const manifest = {
  id: 'community.nyaa.stremio-lite',
  version: '1.1.0',
  name: 'Nyaa',
  description: 'Anime series (AniList catalog) with torrents from nyaa.si, plus raw nyaa browsing.',
  resources: [
    'catalog',
    { name: 'meta', types: ['series'], idPrefixes: [ID_PREFIX, SERIES_PREFIX] },
    { name: 'stream', types: ['series'], idPrefixes: [ID_PREFIX, SERIES_PREFIX] },
  ],
  types: ['series'],
  idPrefixes: [ID_PREFIX, SERIES_PREFIX],
  catalogs: [
    { type: 'series', id: 'anilist-season', name: 'Anime: Airing this season', extra: [{ name: 'skip' }] },
    { type: 'series', id: 'anilist-trending', name: 'Anime: Trending', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'anilist-popular', name: 'Anime: All-time popular', extra: [{ name: 'skip' }] },
    {
      type: 'series',
      id: 'nyaa-latest',
      name: 'Nyaa: Latest',
      extra: [
        { name: 'search' },
        { name: 'skip' },
        { name: 'genre', options: Object.values(nyaa.CATEGORIES) },
        { name: 'words' },
        { name: 'fansub' },
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
        { name: 'words' },
        { name: 'fansub' },
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
  const quality = parseQuality(r.title);
  return {
    id: ID_PREFIX + r.id,
    type: 'series',
    name: r.title,
    poster: posterUrl(req, prettyTitle(r.title)),
    posterShape: 'landscape',
    releaseInfo: r.date?.slice(0, 10),
    description: `${quality} · ${r.size} · ${r.seeders} seeders · ${r.leechers} leechers`,
    // Not part of the Stremio spec; the bundled UI uses it for its table view.
    nyaa: { ...r, quality },
  };
}

// ---------- series (AniList catalog + nyaa streams) ----------

function toSeriesPreview(m) {
  return {
    id: SERIES_PREFIX + m.id,
    type: 'series',
    name: anilist.displayTitle(m),
    poster: m.coverImage?.extraLarge || m.coverImage?.large,
    posterShape: 'poster',
    releaseInfo: m.seasonYear ? String(m.seasonYear) : undefined,
    genres: m.genres,
    // Not part of the Stremio spec; used by the bundled UI.
    anilist: {
      format: m.format,
      status: m.status,
      episodes: m.episodes,
      score: m.averageScore,
      nextAiringEpisode: m.nextAiringEpisode,
      romaji: m.title.romaji,
      color: m.coverImage?.color,
    },
  };
}

async function seriesCatalog(id, extra) {
  const skip = Number(extra.skip) || 0;
  const page = Math.floor(skip / anilist.PER_PAGE) + 1;
  const kind = extra.search ? 'search' : SERIES_CATALOGS[id];
  const { media, hasNextPage } = await anilist.list(kind, { page, search: extra.search });
  return { metas: media.map(toSeriesPreview), hasMore: hasNextPage, nextSkip: page * anilist.PER_PAGE };
}

async function seriesMeta(id) {
  const m = await anilist.getMedia(id.slice(SERIES_PREFIX.length).split(':')[0]);
  let episodes = anilist.episodesOf(m);
  // Finished shows without an episode count: use the highest episode on nyaa.
  if (!episodes.length && m.status !== 'NOT_YET_RELEASED') {
    const found = await seriesTorrents(m).catch(() => ({ episodes: {} }));
    episodes = anilist.episodesOf(m, Math.max(0, ...Object.keys(found.episodes).map(Number)));
  }
  const preview = toSeriesPreview(m);
  return {
    meta: {
      ...preview,
      background: m.bannerImage || preview.poster,
      description: anilist.plainDescription(m.description),
      runtime: m.duration ? `${m.duration} min` : undefined,
      links: [{ name: 'AniList', category: 'Source', url: `https://anilist.co/anime/${m.id}` }],
      videos: episodes.map((e) => ({
        id: `${SERIES_PREFIX}${m.id}:${e.episode}`,
        title: e.title,
        season: 1,
        episode: e.episode,
        released: e.released,
        thumbnail: e.thumbnail,
      })),
      anilist: {
        ...preview.anilist,
        id: m.id,
        native: m.title.native,
        studio: m.studios?.nodes?.[0]?.name,
        relations: (m.relations?.edges || [])
          .filter((e) => e.node.type === 'ANIME' && ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF'].includes(e.relationType))
          .map((e) => ({ id: SERIES_PREFIX + e.node.id, relation: e.relationType, format: e.node.format, name: e.node.title.english || e.node.title.romaji, poster: e.node.coverImage?.large })),
      },
    },
  };
}

/** Which file of a season pack holds the episode; null if none clearly does. */
async function packFileIdx(t, ep) {
  const torrent = await nyaa.getTorrent(t.id);
  const file = torrent.files.find((f) => VIDEO_EXT.test(f.path) && parseEpisode(f.path).episode === ep);
  return file ? file.idx : null;
}

const MAX_PACKS = 10;

async function seriesStream(id) {
  const [, seriesId, epStr] = id.split(':');
  const ep = Number(epStr);
  if (!Number.isInteger(ep)) return { streams: [] };
  const m = await anilist.getMedia(seriesId);
  const { singles, packs } = await episodeTorrents(m, ep);
  // Packs need their file list to point at the right episode; fetch the best-seeded few.
  const resolved = await Promise.all(packs.slice(0, MAX_PACKS).map(async (t) => {
    const fileIdx = await packFileIdx(t, ep).catch(() => null);
    return fileIdx === null ? null : { ...t, fileIdx };
  }));
  const toStream = (t) => ({
    name: `Nyaa\n${t.quality}`,
    title: `${t.title}\n👤 ${t.seeders}  💾 ${t.size}${t.batch ? '  📦 pack' : ''}`,
    infoHash: t.infoHash,
    ...(t.fileIdx !== undefined ? { fileIdx: t.fileIdx } : {}),
    sources: [...NYAA_TRACKERS.map((a) => `tracker:${a}`), `dht:${t.infoHash}`],
    behaviorHints: { bingeGroup: `nyaa|${t.group || ''}|${t.quality}` },
    nyaa: t,
  });
  return { streams: [...singles, ...resolved.filter(Boolean)].map(toStream) };
}

/**
 * Not part of the Stremio protocol: per-episode torrent summary for the
 * series page (count, best seeders, qualities, groups) plus season packs.
 */
export async function seriesSummary(id) {
  const m = await anilist.getMedia(id.slice(SERIES_PREFIX.length));
  const { episodes, batches } = await seriesTorrents(m);
  const summary = {};
  for (const [ep, list] of Object.entries(episodes)) {
    summary[ep] = {
      count: list.length,
      seeders: Math.max(...list.map((t) => t.seeders)),
      qualities: [...new Set(list.map((t) => t.quality))],
      groups: [...new Set(list.map((t) => t.group).filter(Boolean))],
    };
  }
  return { episodes: summary, packs: batches };
}

// ---------- raw nyaa catalogs ----------

export async function catalog(req, id, extra) {
  if (id in SERIES_CATALOGS) return seriesCatalog(id, extra);
  const skip = Number(extra.skip) || 0;
  const page = Math.floor(skip / nyaa.PAGE_SIZE) + 1;
  const opts = {
    c: CATEGORY_BY_NAME[extra.genre] || extra.c || '1_2',
    s: id === 'nyaa-popular' ? 'seeders' : extra.s || 'id',
    o: extra.o || 'desc',
    p: page,
  };
  // `words` uses nyaa's own syntax (word, -word, "phrase"), so it narrows the
  // search on the site and paging stays correct. The fansub name is searched
  // too, then checked strictly against the leading [Group] tag.
  const fansub = (extra.fansub || '').trim();
  const query = [extra.search, extra.words, fansub && `"${fansub.replace(/"/g, '')}"`].filter(Boolean).join(' ');
  const results = await nyaa.search(query, opts);
  const wanted = fansub.toLowerCase();
  const kept = wanted ? results.filter((r) => groupOf(r.title)?.toLowerCase() === wanted) : results;
  return {
    metas: kept.map((r) => toMetaPreview(req, r)),
    hasMore: results.length >= nyaa.PAGE_SIZE,
    // Not part of the Stremio spec: where the next page starts, since strict
    // fansub filtering can return fewer items than a full nyaa page.
    nextSkip: page * nyaa.PAGE_SIZE,
  };
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
  if (id.startsWith(SERIES_PREFIX)) return seriesMeta(id);
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
  if (id.startsWith(SERIES_PREFIX)) return seriesStream(id);
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
  router.get(/^\/series-torrents\/(anilist:\d+)\.json$/, wrap((req) => seriesSummary(decodeURIComponent(req.params[0]))));
  router.get('/poster.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'max-age=86400');
    res.send(posterSvg(String(req.query.t || 'Nyaa')));
  });
  return router;
}
