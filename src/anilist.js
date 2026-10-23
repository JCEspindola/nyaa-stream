// AniList as the series catalog: the role Cinemeta/Kitsu play for Stremio.
// It only supplies metadata (titles, posters, episodes); torrents still come
// from nyaa. Public GraphQL API, no key, ~30 requests/minute, so cache hard.

const API = 'https://graphql.anilist.co';
const TTL = 60 * 60e3;
const cache = new Map();

async function gql(query, variables) {
  const key = query + JSON.stringify(variables);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) || 5;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) throw new Error(`AniList: ${body.errors?.[0]?.message || res.status}`);
    cache.set(key, { t: Date.now(), data: body.data });
    return body.data;
  }
}

const CARD_FIELDS = `
  id format status episodes season seasonYear averageScore genres synonyms
  title { romaji english native }
  coverImage { large extraLarge color }
  nextAiringEpisode { episode airingAt }`;

export const PER_PAGE = 30;

function currentSeason(d = new Date()) {
  const m = d.getUTCMonth();
  const season = m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear: d.getUTCFullYear() };
}

/**
 * list: 'season' (airing this season), 'trending', 'popular', or 'search'.
 * Returns { media, hasNextPage }.
 */
export async function list(kind, { page = 1, search } = {}) {
  const sort = { season: 'POPULARITY_DESC', trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', search: 'SEARCH_MATCH' }[kind];
  if (!sort) throw new Error(`unknown list ${kind}`);
  const vars = { page, perPage: PER_PAGE, sort: [sort] };
  const args = ['type: ANIME', 'isAdult: false', 'sort: $sort'];
  const defs = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  if (kind === 'season') {
    Object.assign(vars, currentSeason());
    args.push('season: $season', 'seasonYear: $seasonYear');
    defs.push('$season: MediaSeason', '$seasonYear: Int');
  }
  if (kind === 'search') {
    vars.search = search;
    args.push('search: $search');
    defs.push('$search: String');
  }
  const data = await gql(`query(${defs.join(', ')}) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(${args.join(', ')}) { ${CARD_FIELDS} }
    }
  }`, vars);
  return { media: data.Page.media, hasNextPage: data.Page.pageInfo.hasNextPage };
}

export async function getMedia(id) {
  const data = await gql(`query($id: Int) {
    Media(id: $id, type: ANIME) {
      ${CARD_FIELDS}
      synonyms description(asHtml: false) bannerImage duration
      startDate { year month day }
      studios(isMain: true) { nodes { name } }
      streamingEpisodes { title thumbnail }
      airingSchedule(perPage: 50) { nodes { episode airingAt } }
      relations { edges { relationType node { id type format title { romaji english } coverImage { large } } } }
    }
  }`, { id: Number(id) });
  if (!data.Media) throw new Error('series not found');
  return data.Media;
}

const dateMs = (d) => (d?.year ? Date.UTC(d.year, (d.month || 1) - 1, d.day || 1) : null);

/**
 * Card data plus "when did this series last get a new episode" for a set of
 * ids: the latest aired episode from the airing schedule, else the end or
 * start date. Upcoming series have no update yet (updatedAt null).
 */
export async function libraryInfo(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map(Number);
    const data = await gql(`query($ids: [Int]) {
      media: Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${CARD_FIELDS} startDate { year month day } endDate { year month day } } }
      aired: Page(perPage: 50) { airingSchedules(mediaId_in: $ids, notYetAired: false, sort: TIME_DESC) { mediaId episode airingAt } }
    }`, { ids: chunk });
    const latest = new Map();
    for (const s of data.aired.airingSchedules) if (!latest.has(s.mediaId)) latest.set(s.mediaId, s);
    for (const m of data.media.media) {
      const aired = latest.get(m.id);
      const past = (t) => (t && t <= Date.now() ? t : null);
      out.set(m.id, {
        media: m,
        latest: aired ? { episode: aired.episode, airingAt: aired.airingAt * 1000 } : null,
        updatedAt: aired ? aired.airingAt * 1000 : past(dateMs(m.endDate)) ?? past(dateMs(m.startDate)),
      });
    }
  }
  return out;
}

export const displayTitle = (m) => m.title.english || m.title.romaji || m.title.native;

/** Every title the series is known by: used to search nyaa and to match releases. */
export function titlesOf(m) {
  return [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])].filter(Boolean);
}

/**
 * Episode list: count from AniList (or aired-so-far for airing shows), with
 * titles/thumbnails from streamingEpisodes and air dates from the schedule.
 */
export function episodesOf(m, knownMax = 0) {
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null;
  let count = m.status === 'RELEASING' ? (aired ?? knownMax) : (m.episodes ?? aired ?? knownMax);
  if (m.format === 'MOVIE') count = Math.max(count || 0, 1);
  count = Math.max(count || 0, m.status === 'RELEASING' ? 0 : knownMax);
  const titles = new Map();
  for (const se of m.streamingEpisodes || []) {
    const mm = /^Episode\s+(\d+)\s*[-:]\s*(.*)$/i.exec(se.title || '');
    if (mm && !titles.has(Number(mm[1]))) titles.set(Number(mm[1]), { title: mm[2], thumbnail: se.thumbnail });
  }
  const airDates = new Map((m.airingSchedule?.nodes || []).map((n) => [n.episode, n.airingAt * 1000]));
  const out = [];
  for (let ep = 1; ep <= count; ep++) {
    const info = titles.get(ep);
    const air = airDates.get(ep);
    out.push({
      episode: ep,
      title: m.format === 'MOVIE' ? displayTitle(m) : info?.title || `Episode ${ep}`,
      thumbnail: info?.thumbnail || null,
      released: air ? new Date(air).toISOString() : null,
    });
  }
  return out;
}

/** AniList descriptions carry a little HTML; keep paragraphs, drop tags. */
export function plainDescription(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
