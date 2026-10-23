// Finds the nyaa torrents for an AniList series and sorts them by episode:
// the job Torrentio does for Stremio, with nyaa as the only source.
import * as nyaa from './nyaa.js';
import * as anilist from './anilist.js';
import { titlesOf } from './anilist.js';
import { parseRelease, parseSeason, normalizeTitle, parseQuality } from './names.js';

/** Titles to search nyaa with: romaji and English, minus season markers. */
function searchTerms(media) {
  const terms = [media.title.romaji, media.title.english]
    .filter(Boolean)
    .map((t) => t.replace(/\b\d{1,2}(?:st|nd|rd|th)\s+Season\b|\bSeason\s*\d{1,2}\b|\bS\d{1,2}\b/gi, '').replace(/[:!?]/g, ' ').replace(/\s+/g, ' ').trim());
  return [...new Set(terms.map((t) => t.toLowerCase()))].filter((t) => t.length >= 2);
}

// parseSeason defaults to 1, so take whichever title states a higher season.
const seasonOf = (media) => Math.max(parseSeason(media.title.romaji || ''), parseSeason(media.title.english || ''));

/**
 * The AniList series a release belongs to (the reverse of seriesTorrents):
 * search AniList with the release's title candidates and accept a result only
 * when one of its titles and its season match exactly. Null when unsure.
 */
export async function findSeriesForRelease(title) {
  const rel = parseRelease(title);
  // AniList search is picky about punctuation ("journeys" finds nothing for
  // "Journey's"), so also try the first words; the exact title check below
  // still decides the match. Capped to stay inside AniList's rate limit.
  const queries = [];
  for (const name of rel.names.slice(0, 2)) {
    const words = name.split(' ');
    queries.push(name);
    if (words.length > 2) queries.push(words.slice(0, 2).join(' '));
    if (words.length > 1 && words[0].length >= 4) queries.push(words[0]);
  }
  for (const q of [...new Set(queries)].slice(0, 5)) {
    const { media } = await anilist.list('search', { search: q });
    const hit = media.find((m) => seasonOf(m) === rel.season
      && titlesOf(m).some((t) => rel.names.includes(normalizeTitle(t))));
    if (hit) return hit;
  }
  return null;
}

function matcher(media) {
  const bases = new Set(titlesOf(media).map(normalizeTitle).filter(Boolean));
  const season = seasonOf(media);
  const isMovie = media.format === 'MOVIE';
  return (r) => {
    const rel = parseRelease(r.title);
    if (rel.season !== season) return null;
    if (!rel.names.some((n) => bases.has(n))) return null;
    let { episode, range, batch } = rel;
    // A movie release has no episode marker; treat it as "episode 1".
    if (isMovie && episode === null && !range) { episode = 1; batch = false; }
    if (episode === null && !batch) return null;
    return {
      id: r.id,
      title: r.title,
      infoHash: r.infoHash,
      group: rel.group,
      quality: parseQuality(r.title),
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      downloads: r.downloads,
      date: r.date,
      episode,
      range,
      batch,
    };
  };
}

async function collect(queries, match) {
  const pages = await Promise.all(queries.map(([q, opts]) => nyaa.search(q, opts).catch(() => [])));
  const byId = new Map();
  for (const r of pages.flat()) {
    if (byId.has(r.id)) continue;
    const t = match(r);
    if (t) byId.set(r.id, t);
  }
  return [...byId.values()];
}

const bySeeders = (a, b) => b.seeders - a.seeders || (b.date || '').localeCompare(a.date || '');

/**
 * All matched torrents for the series: the two best-seeded pages, the most
 * downloaded page (older seasons) and the newest page (airing episodes) for
 * each search title. Long-running shows can have more than this finds;
 * episodeTorrents() adds a targeted search per episode.
 */
export async function seriesTorrents(media, { category = '1_2' } = {}) {
  const queries = [];
  for (const term of searchTerms(media)) {
    for (const [s, p] of [['seeders', 1], ['seeders', 2], ['downloads', 1], ['id', 1]]) {
      queries.push([term, { c: category, s, p }]);
    }
  }
  const torrents = (await collect(queries, matcher(media))).sort(bySeeders);
  const episodes = {};
  for (const t of torrents) {
    if (t.episode === null) continue;
    (episodes[t.episode] ||= []).push(t);
  }
  return { episodes, batches: torrents.filter((t) => t.batch) };
}

const covers = (t, ep) => t.batch && (!t.range || (ep >= t.range[0] && ep <= t.range[1]));

/** Torrents for one episode: single-episode releases first, then packs that contain it. */
export async function episodeTorrents(media, ep, { category = '1_2' } = {}) {
  const pad = String(ep).padStart(2, '0');
  const targeted = searchTerms(media).slice(0, 2).map((term) => [`${term} ${pad}`, { c: category, s: 'seeders', p: 1 }]);
  const [all, extra] = await Promise.all([seriesTorrents(media, { category }), collect(targeted, matcher(media))]);
  const seen = new Set();
  const singles = [];
  for (const t of [...(all.episodes[ep] || []), ...extra.filter((x) => x.episode === ep)]) {
    if (!seen.has(t.id)) { seen.add(t.id); singles.push(t); }
  }
  const packs = [...all.batches, ...extra.filter((x) => x.batch)].filter((t) => covers(t, ep) && !seen.has(t.id) && seen.add(t.id));
  return { singles: singles.sort(bySeeders), packs: packs.sort(bySeeders) };
}
