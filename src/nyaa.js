// Nyaa.si client: search (HTML listing, which unlike the RSS feed honours sort
// and paging) and .torrent download/parse.
import parseTorrent from 'parse-torrent';

export const BASE = process.env.NYAA_URL || 'https://nyaa.si';
export const PAGE_SIZE = 75;

export const CATEGORIES = {
  '0_0': 'All categories',
  '1_0': 'Anime',
  '1_2': 'Anime - English-translated',
  '1_3': 'Anime - Non-English-translated',
  '1_4': 'Anime - Raw',
  '1_1': 'Anime - Music Video',
  '4_0': 'Live Action',
  '4_1': 'Live Action - English-translated',
  '4_3': 'Live Action - Non-English-translated',
  '4_4': 'Live Action - Raw',
};

const UA = 'nyaa-stremio/1.0 (+local streaming client)';
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`nyaa ${res.status} for ${url}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/**
 * Search nyaa. Options mirror the site's query string:
 *   c (category), f (0 none / 1 no remakes / 2 trusted only),
 *   s (id|seeders|leechers|downloads|size|comments), o (asc|desc), p (page, 1-based)
 */
export async function search(query = '', { c = '1_2', f = 0, s = 'id', o = 'desc', p = 1 } = {}) {
  const qs = new URLSearchParams({ f: String(f), c, q: query, s, o, p: String(p) });
  const html = await get(`${BASE}/?${qs}`);
  return parseListing(html);
}

export function parseListing(html) {
  const body = html.split('<tbody>')[1];
  if (!body) return [];
  const rows = body.split('</tbody>')[0].split(/<tr\b/).slice(1);
  const out = [];
  for (const row of rows) {
    const cls = /class="([^"]*)"/.exec(row)?.[1] || 'default';
    const category = /href="\/\?c=(\d_\d)"/.exec(row)?.[1];
    // The title link is the /view/ID link without "#comments".
    const title = /<a href="\/view\/(\d+)" title="([^"]*)"/.exec(row);
    const infoHash = /magnet:\?xt=urn:btih:([0-9a-fA-F]{40})/.exec(row)?.[1];
    if (!title || !infoHash) continue;
    const cells = [...row.matchAll(/<td class="text-center"[^>]*>([^<]*)<\/td>/g)].map((m) => m[1].trim());
    const ts = /data-timestamp="(\d+)"/.exec(row)?.[1];
    // cells: size, date, seeders, leechers, downloads
    out.push({
      id: title[1],
      title: decode(title[2]),
      infoHash: infoHash.toLowerCase(),
      category,
      size: cells[0],
      date: ts ? new Date(Number(ts) * 1000).toISOString() : null,
      seeders: Number(cells[2]) || 0,
      leechers: Number(cells[3]) || 0,
      downloads: Number(cells[4]) || 0,
      trusted: cls.includes('success'),
      remake: cls.includes('danger'),
    });
  }
  return out;
}

// Parsed torrents keyed by nyaa id and by info hash. The streaming engine reads
// the second map so it can start from full metadata instead of a bare magnet.
const byId = new Map();
const byHash = new Map();

export async function getTorrent(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('invalid nyaa id');
  if (byId.has(id)) return byId.get(id);
  const buf = await get(`${BASE}/download/${id}.torrent`, 'buffer');
  const parsed = parseTorrent(buf);
  const t = {
    id: String(id),
    infoHash: parsed.infoHash.toLowerCase(),
    name: parsed.name,
    announce: parsed.announce || [],
    files: parsed.files.map((file, idx) => ({ idx, name: file.name, path: file.path, length: file.length })),
    length: parsed.length,
    buffer: buf,
  };
  byId.set(t.id, t);
  byHash.set(t.infoHash, t);
  return t;
}

export const getTorrentByHash = (infoHash) => byHash.get(String(infoHash).toLowerCase());

/** Title + uploader + date from the torrent's /view page (used for meta). */
export async function getView(id) {
  const html = await get(`${BASE}/view/${id}`);
  const title = /<h3 class="panel-title">\s*([^<]+?)\s*<\/h3>/.exec(html)?.[1];
  const submitter = /Submitter:<\/div>\s*<div[^>]*>\s*(?:<a[^>]*>)?([^<\s][^<]*)/.exec(html)?.[1];
  const infoHash = /<kbd>([0-9a-f]{40})<\/kbd>/i.exec(html)?.[1];
  const descMd = /<div markdown-text class="panel-body" id="torrent-description">([\s\S]*?)<\/div>/.exec(html)?.[1];
  // The description is raw markdown; drop heading/emphasis markers and the placeholder.
  const description = descMd ? decode(descMd).replace(/^#{1,6}\s*/gm, '').replace(/\*\*|__/g, '').trim() : '';
  return {
    title: title ? decode(title) : null,
    submitter: submitter ? decode(submitter.trim()) : null,
    infoHash,
    description: /^no description\.?$/i.test(description) ? '' : description,
  };
}
