// Release-name parsing for anime-style file names, used to label files as
// episodes and to port Stremio's GuessFileIdx season/episode matching.

export const MEDIA_EXT = /\.(mkv|avi|mp4|m4v|wmv|mov|mpg|ts|m2ts|webm|flac|mp3|wav|aac|ogg|opus)$/i;
export const VIDEO_EXT = /\.(mkv|avi|mp4|m4v|wmv|mov|mpg|ts|m2ts|webm)$/i;

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:v\d)?\b/i, // S01E05
  /\b(\d{1,2})x(\d{1,3})\b/, // 1x05
  /(?:^|[\s_.])-[\s_.]+(\d{1,4})(?:v\d)?(?=[\s_.]|\[|\(|$)/, // "Title - 05 [1080p]"
  /\b(?:E|EP|Ep|Episode)[\s._]?(\d{1,4})(?:v\d)?\b/, // EP05
  /第(\d{1,4})[話话集]/, // 第05話
  /\[(\d{1,4})(?:v\d)?\]/, // [05]
];

const SEASON_PATTERNS = [/\bS(\d{1,2})\b/i, /\b(\d{1,2})(?:st|nd|rd|th) Season\b/i, /\bSeason[\s._]?(\d{1,2})\b/i];

/** Parse { season, episode } out of a file name; either may be null. */
export function parseEpisode(fileName) {
  const base = fileName.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  // Drop resolution/codec/year tokens so they are not mistaken for episodes.
  const clean = base.replace(/\b(?:\d{3,4}p|[xh]\.?26[45]|10.?bit|8.?bit|19\d\d|20\d\d)\b/gi, ' ');
  let season = null;
  let episode = null;
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(clean);
    if (!m) continue;
    if (m.length > 2) {
      season = Number(m[1]);
      episode = Number(m[2]);
    } else {
      episode = Number(m[1]);
    }
    break;
  }
  if (season === null) {
    for (const re of SEASON_PATTERNS) {
      const m = re.exec(base);
      if (m) { season = Number(m[1]); break; }
    }
  }
  return { season, episode };
}

/**
 * Port of Stremio's GuessFileIdx: keep media files, prefer those matching the
 * requested episode, then pick the largest. Returns -1 when nothing fits.
 */
export function guessFileIdx(files, hint = {}) {
  const media = files.filter((f) => MEDIA_EXT.test(f.path || f.name));
  if (!media.length) return -1;
  let pool = media;
  if (hint.episode) {
    const matching = media.filter((f) => {
      const info = parseEpisode(f.path || f.name);
      return info.episode === hint.episode && (!hint.season || !info.season || info.season === hint.season);
    });
    if (matching.length) pool = matching;
  }
  const largest = pool.reduce((best, f) => (!best || f.length > best.length ? f : best), null);
  return files.indexOf(largest);
}

// Pre-release sources are reported even when a resolution is present, since
// "CamRip 720p" is still a cam. Other sources are only a fallback.
const LOW_SOURCES = [
  [/\b(?:HD)?CAM(?:Rip)?\b/i, 'CamRip'],
  // Uppercase only, and not a ".ts" file extension.
  [/\b(?:HD-?TS|TELESYNC|PDVD)\b|(?<!\.)\bTS\b/, 'Telesync'],
  [/\b(?:DVD)?SCR(?:EENER)?\b/i, 'Screener'],
];
const OTHER_SOURCES = [
  [/\bBlu-?Ray\b|\bBD(?:Rip|Remux|MV)?\b/i, 'BD'],
  [/\bWEB(?:-?DL|-?Rip)?\b/i, 'WEB'],
  [/\b(?:AMZN|DSNP|NF|HULU|HMAX|ATVP|CR)\b/, 'WEB'],
  [/\bHDTV(?:Rip)?\b/i, 'HDTV'],
  [/\bDVD(?:Rip|5|9)?\b/i, 'DVD'],
  [/\bVHS(?:Rip)?\b/i, 'VHSRip'],
  [/\bLD(?:Rip)?\b|\bLaserDisc\b/i, 'LaserDisc'],
];

/** Quality label for a release title: CamRip, 2160p, 1080p, …, BD, or "Unknown". */
export function parseQuality(title) {
  for (const [re, label] of LOW_SOURCES) if (re.test(title)) return label;
  if (/\b(?:2160p|4K|UHD)\b/i.test(title)) return '2160p';
  const p = /\b(\d{3,4})[pi]\b/i.exec(title);
  if (p) return `${p[1]}p`;
  const wh = /\b\d{3,4}\s?[x×]\s?(\d{3,4})\b/.exec(title);
  if (wh) return `${wh[1]}p`;
  for (const [re, label] of OTHER_SOURCES) if (re.test(title)) return label;
  return 'Unknown';
}

const SEASON_RE = [
  /\bS(\d{1,2})(?=E\d|\b)/i,
  /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i,
  /\bSeason\s*(\d{1,2})\b/i,
];
const SEASON_STRIP = /\bS\d{1,2}(?=E\d|\b)|\b\d{1,2}(?:st|nd|rd|th)\s+Season\b|\bSeason\s*\d{1,2}\b/gi;
// Bracketed/parenthesised text that is release info rather than an alternate title.
const TAG_WORDS = /\b(\d{3,4}p|bd|bdrip|web|web-?dl|webrip|hevc|avc|x26[45]|h\.?26[45]|aac|flac|opus|ac3|dual|multi|batch|complete|dub|sub|raw|hdr|weekly|10.?bit|remux|v\d|eng|jpn|uncensored|vostfr|\d+-\d+)\b/i;

/** Season number in a title ("S2", "2nd Season", "Season 2"); 1 when absent. */
export function parseSeason(title) {
  for (const re of SEASON_RE) {
    const m = re.exec(title);
    if (m) return Number(m[1]);
  }
  return 1;
}

// Written as explicit ranges rather than \p{L}/\p{N}: the Android build's Node
// (nodejs-mobile) has no Unicode property data, so \p{…} regexes fail there.
// Separators: ASCII/Latin-1 punctuation and symbols, general punctuation,
// arrows/symbols/dingbats, CJK and fullwidth punctuation, katakana middle dot.
const SEPARATORS = /[\s\u0000-/:-@[-`{-¿×÷ -⁯←-⯿⸀-⹿　-〿・︐-﹯！-／：-＠［-｀｛-･]+/g;
// Two or more letters in a common script (Latin, Greek, Cyrillic, kana, CJK, Hangul).
const HAS_WORD = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヺー-ヿ㐀-鿿가-힯]{2,}/;

const nfkc = (s) => {
  try { return s.normalize('NFKC'); } catch { return s; }
};

/** Lower-case, punctuation-free, season-free form used to compare titles. */
export function normalizeTitle(s) {
  return nfkc(s)
    .replace(SEASON_STRIP, ' ')
    .replace(/['’`]/g, '')
    .toLowerCase()
    .replace(SEPARATORS, ' ')
    .trim();
}

/**
 * Break a release name into what the series matcher needs:
 *   names     candidate series titles (normalised); alternatives after "|" or in parentheses
 *   season    1 unless the title says otherwise
 *   episode   single episode number, or null
 *   range     [from, to] for multi-episode packs, or null
 *   batch     true for packs (ranges, "Batch", "Complete", whole-season releases)
 */
export function parseRelease(title) {
  const group = groupOf(title);
  let t = title.replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/\.(mkv|mp4|avi)$/i, '');
  const season = parseSeason(t);

  let episode = null;
  let range = null;
  let m;
  if ((m = /\bS\d{1,2}E(\d{1,4})(?:\s?[-~]\s?(?:S\d{1,2})?E?(\d{1,4}))?/i.exec(t))) {
    if (m[2]) range = [Number(m[1]), Number(m[2])];
    else episode = Number(m[1]);
  } else if ((m = /(?:\s-\s|\(|\[|\bE(?:p|pisodes?)?\.?\s?)(\d{1,4})\s?(?:-|~|to)\s?(\d{1,4})(?:v\d)?(?=\s|\)|\]|$)/i.exec(t))) {
    range = [Number(m[1]), Number(m[2])];
  } else if ((m = /\s-\s(\d{1,4})(?:v\d)?(?=\s|\[|\(|$)/.exec(t))) {
    episode = Number(m[1]);
  } else if ((m = /\b(?:E|EP|Episode)\.?\s?(\d{1,4})(?:v\d)?\b/i.exec(t))) {
    episode = Number(m[1]);
  }
  if (range && range[0] === range[1]) { episode = range[0]; range = null; }
  if (range && range[0] > range[1]) range = null;
  const batch = !!range || (episode === null && (/\b(batch|complete|bd|bdrip|blu-?ray|season)\b/i.test(t) || /\bS\d{1,2}\b/i.test(t)));

  // The title is everything before the first episode/season/tag marker.
  const alternatives = [];
  for (const seg of t.split(/\s\|\s|\s\/\s/)) {
    for (const p of seg.matchAll(/\(([^()]+)\)/g)) {
      if (HAS_WORD.test(p[1]) && !TAG_WORDS.test(p[1])) alternatives.push(p[1]);
    }
    // " - " only ends the title when an episode/season/pack marker follows it,
    // so "Frieren - Beyond Journey's End" stays whole.
    const cut = seg.search(/\s-\s(?=S\d|E\d|\d|BD\b|Batch|Season|Vol|Complete)|\[|\(|\bS\d{1,2}E\d|\bE\d{1,4}\b|\b\d{3,4}p\b|\bS\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+Season\b|\bSeason\s*\d/i);
    alternatives.push(cut > 0 ? seg.slice(0, cut) : seg);
  }
  const names = [...new Set(alternatives.map(normalizeTitle).filter((n) => n.length >= 2))];
  return { group, names, season, episode, range, batch };
}

/** Strip "[Group]" and trailing tag blocks for a friendlier display title. */
export function prettyTitle(name) {
  const t = name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/^\s*(\[[^\]]*\]\s*)+/, '')
    .replace(/(\s*[[(][^\])]*[\])])+\s*$/, '')
    .replace(/[_.]/g, ' ')
    .trim();
  return t || name;
}

export function groupOf(name) {
  return /^\s*\[([^\]]+)\]/.exec(name)?.[1] || null;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
