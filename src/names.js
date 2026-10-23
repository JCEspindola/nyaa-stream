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
