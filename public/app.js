// Nyaa Stream UI. Talks to the Nyaa addon through the Stremio addon protocol
// (catalog / meta / stream), then plays the returned {infoHash, fileIdx} through
// the local streaming engine, the same flow stremio-web follows.

const ADDON = '/addon';
// Inside the Android app, Java exposes window.NyaaAndroid (native player, files, clipboard).
const ANDROID = !!window.NyaaAndroid;
const view = document.getElementById('view');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORIES = {
  'Anime - English-translated': '1_2',
  'Anime - Non-English-translated': '1_3',
  'Anime - Raw': '1_4',
  Anime: '1_0',
  'Live Action': '4_0',
  'All categories': '0_0',
};
const SORTS = { id: 'Newest', seeders: 'Most seeders', downloads: 'Most downloads', size: 'Largest' };
// Suggestions for the fansub box; groups seen in loaded results are added too.
const POPULAR_FANSUBS = [
  'SubsPlease', 'Erai-raws', 'EMBER', 'Judas', 'ASW', 'Yameii', 'ToonsHub', 'DKB', 'VARYG',
  'Anime Time', 'Tsundere-Raws', 'LostYears', 'Commie', 'GJM', 'Kawaiika-Raws', 'New-raws',
  'Ohys-Raws', 'LoliHouse', 'Nekomoe kissaten', 'Sakurato', 'Kirion', 'Salieri', 'kikuri', 'DB',
];

// ---------- storage (best effort) ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};
const getProgress = () => store.get('progress', {});
const PROGRESS_KEEP = 200;

/** Keep only the most recently updated progress entries. */
function trimProgress(all) {
  const keys = Object.keys(all).sort((a, b) => (all[b].ts || 0) - (all[a].ts || 0));
  for (const k of keys.slice(PROGRESS_KEEP)) delete all[k];
  return all;
}

function saveProgress(key, entry) {
  const all = getProgress();
  all[key] = { ...all[key], ...entry, ts: Date.now() };
  store.set('progress', trimProgress(all));
  // Progress changes every few seconds while playing; sync it lazily.
  scheduleSync(20e3);
}

// ---------- addon client ----------
async function addon(resource, type, id, extra) {
  // Drop empty values first: "{search: '', skip: ''}" means no extra segment at all.
  const qs = new URLSearchParams(Object.entries(extra || {}).filter(([, v]) => v !== '' && v != null)).toString();
  const extraStr = qs ? `/${qs}` : '';
  const res = await fetch(`${ADDON}/${resource}/${type}/${encodeURIComponent(id)}${extraStr}.json`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `addon ${resource} failed (${res.status})`);
  return body;
}

// ---------- router ----------
let cleanup = null;
const routes = [
  [/^#?\/?$/, seriesHome],
  [/^#\/series$/, seriesList],
  [/^#\/series\/(\d+)$/, seriesDetail],
  [/^#\/series\/(\d+)\/(\d+)$/, episodeView],
  [/^#\/browse$/, discover],
  [/^#\/search$/, discover],
  [/^#\/library$/, libraryView],
  [/^#\/continue$/, () => replaceHash('#/library')], // old tab address
  [/^#\/about$/, about],
  [/^#\/t\/(\d+)$/, detail],
  [/^#\/play\/(\d+)\/(\d+)$/, player],
];

// Which tab a page belongs to; the top search box searches that section.
function sectionOf(pathPart) {
  if (/^#?\/?$|^#\/series/.test(pathPart)) return 'series';
  if (/^#\/(browse|search|t\/)/.test(pathPart)) return 'browse';
  return /^#\/(\w+)/.exec(pathPart)?.[1] || 'series';
}
let section = 'series';

// ---------- in-app history ----------
// Every page lives in the URL hash (Browse filters included), so the browser's
// own history already knows the exact previous page. What it cannot keep is
// what was on screen: pages added with "Load more", scroll position, and
// filters held in memory. Each view can hand that over through `snapshot`,
// and gets it back in `restoring` when the user returns with Back.
const trail = []; // hashes visited in this tab, oldest first
const pageState = new Map(); // hash -> { scrollY, ...snapshot() }
let snapshot = null; // set by the current view: () => extra state worth keeping
let restoring = null; // saved state for the view being rendered, when going back
let lastHash = null;
let replacingHash = false;

const currentHash = () => location.hash || '#/';

/** Back to the previous in-app page, or to `fallback` when there is none. */
function goBack(fallback) {
  if (trail.length > 1) history.back();
  else location.hash = fallback;
}

const backButton = (fallback) => `<button class="btn back-btn" type="button" data-back="${esc(fallback)}">← Back</button>`;

view.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-back]');
  if (btn) goBack(btn.dataset.back);
});

/** Navigate without leaving the current page in history (e.g. auto-play redirects). */
function replaceHash(url) {
  replacingHash = true;
  location.replace(url);
}

/** Scroll back to where the user was, once the view has rebuilt its content. */
function finishRestore(saved, alive = () => true) {
  if (saved && alive()) window.scrollTo(0, saved.scrollY || 0);
}

function trackHistory() {
  const hash = currentHash();
  if (lastHash && lastHash !== hash) {
    pageState.set(lastHash, { scrollY: window.scrollY, ...(snapshot ? snapshot() : {}) });
  }
  snapshot = null;
  const isBack = trail.length > 1 && trail[trail.length - 2] === hash;
  if (replacingHash) {
    trail[trail.length - 1] = hash;
    replacingHash = false;
  } else if (isBack) {
    trail.pop();
  } else if (trail[trail.length - 1] !== hash) {
    trail.push(hash);
  }
  restoring = isBack ? pageState.get(hash) || null : null;
  lastHash = hash;
}

function route() {
  trackHistory();
  if (cleanup) {
    // A failing cleanup must never block navigation.
    try { cleanup(); } catch (err) { console.warn('cleanup failed', err); }
    cleanup = null;
  }
  document.body.classList.remove('playing');
  document.title = 'Nyaa Stream';
  const [pathPart, query = ''] = location.hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  section = sectionOf(pathPart);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === section);
  const input = $('#search-input');
  input.placeholder = section === 'browse' ? 'Search nyaa.si torrents…' : 'Search anime series…';
  input.value = params.q || '';
  for (const [re, fn] of routes) {
    const m = re.exec(pathPart);
    if (m) {
      window.scrollTo(0, 0);
      return fn(params, ...m.slice(1));
    }
  }
  view.innerHTML = '<div class="empty">Not found</div>';
}
window.addEventListener('hashchange', route);

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (section === 'browse') {
    const current = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
    location.hash = `#/search?${new URLSearchParams({ ...current, q })}`;
  } else {
    location.hash = q ? `#/series?${new URLSearchParams({ q })}` : '#/';
  }
});

// ---------- series (AniList catalog, nyaa torrents per episode) ----------
const FORMAT_LABEL = { TV: 'TV', TV_SHORT: 'TV short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' };
const STATUS_LABEL = { FINISHED: 'Finished', RELEASING: 'Airing', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
const SERIES_LISTS = {
  season: { id: 'anilist-season', title: 'Airing this season' },
  trending: { id: 'anilist-trending', title: 'Trending now' },
  popular: { id: 'anilist-popular', title: 'All-time popular' },
};
const seriesNum = (id) => String(id).replace(/^anilist:/, '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function posterCard(m) {
  const a = m.anilist || {};
  const sub = [FORMAT_LABEL[a.format], m.releaseInfo, a.episodes ? `${a.episodes} eps` : null].filter(Boolean).join(' · ');
  const airing = a.nextAiringEpisode ? `<span class="pill airing">Ep ${a.nextAiringEpisode.episode} soon</span>` : '';
  return `<a class="poster" href="#/series/${seriesNum(m.id)}" title="${esc(m.name)}">
    <div class="cover" style="background:${esc(a.color || 'var(--bg-3)')}">
      ${m.poster ? `<img src="${esc(m.poster)}" alt="" loading="lazy">` : ''}
      ${a.score ? `<span class="pill score">★ ${(a.score / 10).toFixed(1)}</span>` : ''}${airing}
    </div>
    <div class="pbody"><div class="name">${esc(m.name)}</div><div class="muted small">${esc(sub)}</div></div>
  </a>`;
}

async function seriesHome() {
  view.innerHTML = `${continueStrip(6)}
    ${Object.entries(SERIES_LISTS).map(([key, l]) => `
      <div class="section-head"><h2>${l.title}</h2><a href="#/series?list=${key}">See all →</a></div>
      <div class="posters" id="list-${key}"><div class="empty"><div class="spinner"></div></div></div>`).join('')}`;
  const restore = restoring;
  let alive = true;
  cleanup = () => { alive = false; };
  // One at a time: AniList allows ~30 requests a minute.
  for (const [key, l] of Object.entries(SERIES_LISTS)) {
    const box = $(`#list-${key}`);
    try {
      const { metas } = await addon('catalog', 'series', l.id);
      if (!alive) return;
      box.innerHTML = metas.slice(0, 12).map(posterCard).join('') || '<div class="empty">Nothing here.</div>';
    } catch (err) {
      if (alive) box.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  }
  finishRestore(restore, () => alive);
}

function seriesList(params) {
  const list = SERIES_LISTS[params.list] || SERIES_LISTS.trending;
  const q = params.q || '';
  const restore = restoring;
  view.innerHTML = `${backButton('#/')}
    <h1>${q ? `Series matching “${esc(q)}”` : list.title}</h1>
    <p class="muted small">Series data from AniList. Torrents come from nyaa.si.</p>
    <div class="posters" id="grid"></div>
    <div class="more"><button class="btn" id="more" hidden>Load more</button></div>`;
  const grid = $('#grid');
  const more = $('#more');
  let skip = 0;
  let alive = true;
  cleanup = () => { alive = false; };
  async function load() {
    more.disabled = true;
    const spinner = document.createElement('div');
    spinner.className = 'empty';
    spinner.innerHTML = '<div class="spinner"></div>';
    grid.after(spinner);
    try {
      const page = await addon('catalog', 'series', list.id, { search: q, skip: skip || '' });
      if (!alive) return;
      grid.insertAdjacentHTML('beforeend', page.metas.map(posterCard).join(''));
      if (!skip && !page.metas.length) grid.outerHTML = '<div class="empty">No series found.</div>';
      skip = page.nextSkip;
      more.hidden = !page.hasMore;
    } catch (err) {
      grid.insertAdjacentHTML('afterend', `<div class="error">${esc(err.message)}</div>`);
    } finally {
      spinner.remove();
      more.disabled = false;
    }
  }
  more.addEventListener('click', load);
  snapshot = () => ({ skip });
  (async () => {
    await load();
    // Coming back: reload the pages that "Load more" had added, then scroll.
    while (restore?.skip && alive && skip < restore.skip && !more.hidden) await load();
    finishRestore(restore, () => alive);
  })();
}

async function seriesDetail(params, id) {
  const restore = restoring;
  view.innerHTML = '<div class="empty"><div class="spinner"></div>Loading series…</div>';
  let meta;
  try {
    ({ meta } = await addon('meta', 'series', `anilist:${id}`));
  } catch (err) {
    view.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    return;
  }
  const a = meta.anilist;
  const progress = getProgress();
  const saved = isInLibrary(id);
  const facts = [
    FORMAT_LABEL[a.format], meta.releaseInfo, STATUS_LABEL[a.status],
    a.episodes ? `${a.episodes} episodes` : null, meta.runtime, a.studio,
    a.score ? `★ ${(a.score / 10).toFixed(1)}` : null,
  ].filter(Boolean);
  const nextAir = a.nextAiringEpisode
    ? `<div class="pill airing">Episode ${a.nextAiringEpisode.episode} airs ${fmtDate(a.nextAiringEpisode.airingAt * 1000)}</div>` : '';
  const resume = meta.videos.find((v) => {
    const p = progress[`anilist:${id}:${v.episode}`];
    return !p || !p.d || p.t < p.d - 90;
  }) || meta.videos[0];

  view.innerHTML = `${backButton('#/')}
    <div class="series-hero" style="--banner:url('${esc(meta.background || '')}')">
      <img class="cover-lg" src="${esc(meta.poster || '')}" alt="">
      <div>
        <h1>${esc(meta.name)}</h1>
        ${a.romaji && a.romaji !== meta.name ? `<div class="muted">${esc(a.romaji)}${a.native ? ` · ${esc(a.native)}` : ''}</div>` : ''}
        <div class="meta-line">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        <div class="genres">${(meta.genres || []).map((g) => `<span class="pill">${esc(g)}</span>`).join('')}</div>
        ${nextAir}
        ${resume ? `<a class="btn primary" href="#/series/${id}/${resume.episode}">${progress[`anilist:${id}:${resume.episode}`] ? 'Continue' : 'Start'}: Episode ${resume.episode}</a>` : ''}
        ${libraryButton(id, saved, { name: meta.name, poster: meta.poster })}
        <a class="btn" href="${esc(meta.links[0].url)}" target="_blank" rel="noopener">AniList ↗</a>
        <div class="desc" id="desc">${esc(meta.description)}</div>
      </div>
    </div>
    ${a.relations.length ? `<h2>Related</h2><div class="relations">${a.relations.map((r) => `
      <a class="relation" href="#/series/${seriesNum(r.id)}"><img src="${esc(r.poster || '')}" alt="" loading="lazy">
      <div><div class="muted small">${esc(r.relation.replace('_', ' ').toLowerCase())} · ${esc(FORMAT_LABEL[r.format] || '')}</div><div>${esc(r.name)}</div></div></a>`).join('')}</div>` : ''}
    <h2>Episodes${meta.videos.length ? ` (${meta.videos.length})` : ''}</h2>
    ${meta.videos.length ? `<div class="episodes" id="eps">${meta.videos.map((v) => {
      const p = progress[`anilist:${id}:${v.episode}`];
      const pct = p?.d ? Math.min(100, (p.t / p.d) * 100) : 0;
      return `<a class="ep2" href="#/series/${id}/${v.episode}">
        <div class="thumb">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : ''}<span>${v.episode}</span></div>
        <div class="t"><div class="et">${esc(v.title)}</div><div class="muted small">${esc(fmtDate(v.released))}</div></div>
        <div class="tsum" data-ep="${v.episode}"><span class="muted small">searching…</span></div>
        ${pct ? `<i class="watched" style="width:${pct.toFixed(1)}%"></i>` : ''}
      </a>`;
    }).join('')}</div>` : `<div class="empty">${a.status === 'NOT_YET_RELEASED' ? 'Not aired yet.' : 'No episode information.'}</div>`}
    <div id="packs"></div>`;
  const desc = $('#desc');
  desc.addEventListener('click', () => desc.classList.toggle('open'));

  let alive = true;
  cleanup = () => { alive = false; };
  try {
    const res = await fetch(`${ADDON}/series-torrents/anilist:${id}.json`);
    const sum = await res.json();
    if (!alive) return;
    if (!res.ok) throw new Error(sum.error || 'search failed');
    for (const cell of view.querySelectorAll('.tsum')) {
      const s = sum.episodes[cell.dataset.ep];
      cell.innerHTML = s
        ? `<span class="count">${s.count} torrent${s.count > 1 ? 's' : ''}</span>
           <span class="quals">${sortQualities(s.qualities).slice(0, 3).map((q) => `<span class="quality ${qualityClass(q)}">${esc(q)}</span>`).join('')}</span>
           <span class="seed small">▲ ${s.seeders}</span>`
        : '<span class="muted small">search on open</span>';
    }
    if (sum.packs.length) {
      $('#packs').innerHTML = `<h2>Season packs (${sum.packs.length})</h2>
        <div class="results">${torrentHead(false)}${sum.packs.map((t) => torrentRow(t, `#/t/${t.id}`)).join('')}</div>`;
    }
  } catch (err) {
    for (const cell of view.querySelectorAll('.tsum')) cell.innerHTML = '';
    $('#packs').innerHTML = `<div class="error">Could not search nyaa: ${esc(err.message)}</div>`;
  }
  finishRestore(restore, () => alive);
}

const QUALITY_ORDER = ['2160p', '1440p', '1080p', '900p', '720p', '576p', '540p', '480p', '360p', 'BD', 'WEB', 'HDTV', 'DVD'];
const sortQualities = (qs) => [...qs].sort((a, b) => (QUALITY_ORDER.indexOf(a) + 1 || 99) - (QUALITY_ORDER.indexOf(b) + 1 || 99));

function torrentHead(withEpisode) {
  return `<div class="row head trow"><div>Release</div><div class="qual">Quality</div><div class="num hide-sm">Size</div><div class="num">Seed</div><div class="num hide-sm">${withEpisode ? 'Type' : 'Date'}</div></div>`;
}

function torrentRow(t, href, extra = '') {
  return `<a class="row trow" href="${href}" title="${esc(t.title)}" ${extra}>
    <div class="title">${t.group ? `<span class="badge group">${esc(t.group)}</span>` : ''}${esc(t.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div>
    <div class="qual"><span class="quality ${qualityClass(t.quality)}">${esc(t.quality)}</span></div>
    <div class="num hide-sm">${esc(t.size)}</div>
    <div class="num seed">${t.seeders}</div>
    <div class="num muted hide-sm">${t.batch ? `<span class="pill">pack${t.range ? ` ${t.range[0]}–${t.range[1]}` : ''}</span>` : esc((t.date || '').slice(0, 10))}</div>
  </a>`;
}

/** Open a torrent at the right file for an episode, then play it. */
async function playEpisodeTorrent(t, seriesId, ep, bingeGroup, replace = false) {
  let idx = t.fileIdx;
  if (idx === undefined) {
    // Single-episode torrents: look at the file list (fetches the .torrent).
    const { meta } = await addon('meta', 'series', `nyaa:${t.id}`);
    const vids = meta.videos;
    const match = vids.find((v) => v.episodeParsed && v.episode === ep && vids.length > 1)
      || [...vids].sort((x, y) => y.length - x.length)[0];
    if (!match) throw new Error('No video file in this torrent');
    idx = match.fileIdx;
  }
  const url = `#/play/${t.id}/${idx}?${new URLSearchParams({ series: seriesId, ep, bg: bingeGroup })}`;
  if (replace) replaceHash(url); else location.hash = url;
}

async function episodeView(params, id, epStr) {
  const ep = Number(epStr);
  const restore = restoring;
  view.innerHTML = '<div class="empty"><div class="spinner"></div>Loading episode…</div>';
  let meta;
  try {
    ({ meta } = await addon('meta', 'series', `anilist:${id}`));
  } catch (err) {
    view.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    return;
  }
  const v = meta.videos.find((x) => x.episode === ep) || { episode: ep, title: `Episode ${ep}` };
  const hasPrev = ep > 1;
  const hasNext = meta.videos.some((x) => x.episode === ep + 1);
  view.innerHTML = `${backButton(`#/series/${id}`)}
    <div class="ep-head">
      <div class="thumb lg">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="">` : `<img src="${esc(meta.poster || '')}" alt="" class="fit">`}</div>
      <div>
        <a href="#/series/${id}" class="muted">← ${esc(meta.name)}</a>
        <h1>Episode ${ep}${v.title && v.title !== `Episode ${ep}` ? `: ${esc(v.title)}` : ''}</h1>
        <div class="meta-line">${v.released ? `<span>Aired ${esc(fmtDate(v.released))}</span>` : ''}</div>
        <div class="ep-nav">
          ${hasPrev ? `<a class="btn" href="#/series/${id}/${ep - 1}">← Episode ${ep - 1}</a>` : ''}
          ${hasNext ? `<a class="btn" href="#/series/${id}/${ep + 1}">Episode ${ep + 1} →</a>` : ''}
        </div>
      </div>
    </div>
    <div class="filters" id="ep-filters" hidden>
      <div class="chips" id="q-chips"></div>
      <select id="g-filter"><option value="">All fansubs</option></select>
    </div>
    <div id="torrents"><div class="empty"><div class="spinner"></div>Searching nyaa.si for episode ${ep}…</div></div>`;

  let alive = true;
  cleanup = () => { alive = false; };
  let streams;
  try {
    ({ streams } = await addon('stream', 'series', `anilist:${id}:${ep}`));
  } catch (err) {
    if (alive) $('#torrents').innerHTML = `<div class="error">${esc(err.message)}</div>`;
    return;
  }
  if (!alive) return;
  const items = streams.map((s) => ({ ...s.nyaa, fileIdx: s.fileIdx, bingeGroup: s.behaviorHints.bingeGroup }));

  // Binge-watching: the player sends us here with the previous episode's
  // group+quality; jump straight to the matching release if there is one.
  if (params.auto) {
    const same = items.find((t) => t.bingeGroup === params.auto);
    if (same) {
      $('#torrents').innerHTML = `<div class="empty"><div class="spinner"></div>Opening ${esc(same.group || 'release')} ${esc(same.quality)}…</div>`;
      try { return await playEpisodeTorrent(same, id, ep, same.bingeGroup, true); } catch { /* fall through to list */ }
    }
  }

  if (!items.length) {
    $('#torrents').innerHTML = `<div class="empty">No torrents found for episode ${ep}. Try <a href="#/search?${new URLSearchParams({ q: `${meta.anilist.romaji || meta.name} ${String(ep).padStart(2, '0')}` })}">searching nyaa directly</a>.</div>`;
    return;
  }
  const state = { quality: restore?.quality || '', group: restore?.group || '' };
  snapshot = () => ({ quality: state.quality, group: state.group });
  const qualities = sortQualities(new Set(items.map((t) => t.quality)));
  const groups = [...new Set(items.map((t) => t.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#ep-filters').hidden = false;
  $('#q-chips').innerHTML = ['', ...qualities].map((q) => `<button class="chip" data-q="${esc(q)}">${q ? esc(q) : 'All qualities'}</button>`).join('');
  $('#g-filter').insertAdjacentHTML('beforeend', groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join(''));

  function render() {
    for (const c of view.querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.q === state.quality);
    const shown = items.filter((t) => (!state.quality || t.quality === state.quality) && (!state.group || t.group === state.group));
    const singles = shown.filter((t) => !t.batch);
    const packs = shown.filter((t) => t.batch);
    const block = (title, list) => (list.length
      ? `<h2>${title} (${list.length})</h2><div class="results">${torrentHead(true)}${list.map((t) => torrentRow(t, '#', `data-i="${items.indexOf(t)}"`)).join('')}</div>` : '');
    $('#torrents').innerHTML = block('Episode releases', singles) + block('In season packs', packs)
      || '<div class="empty">No torrents match these filters.</div>';
  }
  $('#q-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { state.quality = chip.dataset.q; render(); }
  });
  $('#g-filter').addEventListener('change', (e) => { state.group = e.target.value; render(); });
  $('#torrents').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    e.preventDefault();
    const t = items[Number(row.dataset.i)];
    row.classList.add('busy');
    try {
      await playEpisodeTorrent(t, id, ep, t.bingeGroup);
    } catch (err) {
      row.classList.remove('busy');
      alert(`Could not open torrent: ${err.message}`);
    }
  });
  $('#g-filter').value = state.group;
  render();
  finishRestore(restore, () => alive);
}

// ---------- discover / search ----------
function discover(params) {
  const restore = restoring;
  const q = params.q || '';
  const opts = {
    genre: params.genre || 'Anime - English-translated',
    s: params.s || 'id',
  };
  $('#search-input').value = q;
  const select = (name, map, value) =>
    `<select data-k="${name}">${Object.entries(map).map(([k, v]) => {
      const val = name === 'genre' ? k : k;
      return `<option value="${esc(val)}" ${String(val) === String(value) ? 'selected' : ''}>${esc(name === 'genre' ? k : v)}</option>`;
    }).join('')}</select>`;

  const words = params.w || '';
  const fansub = params.fansub || '';
  const filtered = q || words || fansub;
  const heading = [
    q ? `Results for “${esc(q)}”` : filtered ? 'Torrents' : 'Latest on nyaa.si',
    fansub ? `from <span class="badge group">${esc(fansub)}</span>` : '',
  ].filter(Boolean).join(' ');

  view.innerHTML = `
    <h1>${heading}</h1>
    <p class="muted small">Pick a torrent to see its episodes. Sorting and filters are applied by nyaa.si.</p>
    <div class="filters">
      <input class="text-filter" id="f-words" type="search" value="${esc(words)}" placeholder="Filter words: 1080p -batch &quot;2nd season&quot;" title="Words that must appear. Prefix with - to exclude, quote for an exact phrase. Press Enter to apply.">
      <input class="text-filter fansub" id="f-fansub" type="search" value="${esc(fansub)}" list="fansub-list" placeholder="Fansub group" title="Only show releases tagged [Group]. Press Enter to apply.">
      <datalist id="fansub-list"></datalist>
      ${select('genre', CATEGORIES, opts.genre)}
      ${select('s', SORTS, opts.s)}
      ${words || fansub ? '<button class="btn" id="f-clear" type="button">Clear filters</button>' : ''}
    </div>
    <div class="results" id="results">
      <div class="row head"><div>Name</div><div class="qual">Quality</div><div class="num hide-sm">Size</div><div class="num">Seed</div><div class="num hide-sm">Leech</div><div class="num hide-sm">Date</div></div>
    </div>
    <div class="more"><button class="btn" id="more" hidden>Load more</button></div>`;

  const applyFilters = (changes) => {
    const next = { ...params, ...changes };
    for (const k of Object.keys(next)) if (next[k] === '') delete next[k];
    location.hash = `#/search?${new URLSearchParams(next)}`;
  };
  for (const sel of view.querySelectorAll('.filters select')) {
    sel.addEventListener('change', () => applyFilters({ [sel.dataset.k]: sel.value }));
  }
  // "change" fires on Enter, on blur, and when a datalist suggestion is picked.
  $('#f-words').addEventListener('change', (e) => applyFilters({ w: e.target.value.trim() }));
  $('#f-fansub').addEventListener('change', (e) => applyFilters({ fansub: e.target.value.trim() }));
  $('#f-clear')?.addEventListener('click', () => applyFilters({ w: '', fansub: '' }));

  const results = $('#results');
  const more = $('#more');
  // Clicking a group badge filters by that fansub instead of opening the torrent.
  results.addEventListener('click', (e) => {
    const badge = e.target.closest('.badge.group');
    if (!badge) return;
    e.preventDefault();
    applyFilters({ fansub: badge.textContent });
  });

  const seenGroups = new Map();
  const renderFansubList = () => {
    const seen = [...seenGroups].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    const all = [...new Set([...seen, ...POPULAR_FANSUBS])];
    $('#fansub-list').innerHTML = all.map((g) => `<option value="${esc(g)}">${seenGroups.has(g) ? `${seenGroups.get(g)} on screen` : ''}</option>`).join('');
  };
  renderFansubList();

  let skip = 0;
  let shown = 0;
  let alive = true;
  cleanup = () => { alive = false; };

  async function load() {
    more.disabled = true;
    more.textContent = 'Loading…';
    const placeholder = document.createElement('div');
    placeholder.className = 'empty';
    placeholder.innerHTML = '<div class="spinner"></div>Asking nyaa.si…';
    if (!shown) results.append(placeholder);
    try {
      const catalogId = opts.s === 'seeders' ? 'nyaa-popular' : 'nyaa-latest';
      let metas = [];
      let hasMore = true;
      // The strict fansub check can empty a whole nyaa page; read up to three
      // pages before giving up so the list is not left blank.
      for (let pages = 0; pages < 3 && hasMore && metas.length < 20; pages++) {
        const page = await addon('catalog', 'series', catalogId, {
          search: q, words, fansub, genre: opts.genre, skip: skip || '', s: opts.s,
        });
        if (!alive) return;
        metas = metas.concat(page.metas);
        hasMore = page.hasMore;
        skip = page.nextSkip ?? skip + page.metas.length;
        if (!fansub) break;
      }
      placeholder.remove();
      shown += metas.length;
      if (!shown && !hasMore) results.insertAdjacentHTML('beforeend', '<div class="empty">Nothing found. Try fewer filter words or another fansub.</div>');
      results.insertAdjacentHTML('beforeend', metas.map(resultRow).join(''));
      for (const m of metas) {
        const g = /^\s*\[([^\]]+)\]/.exec(m.nyaa.title)?.[1];
        if (g) seenGroups.set(g, (seenGroups.get(g) || 0) + 1);
      }
      renderFansubList();
      more.hidden = !hasMore;
    } catch (err) {
      placeholder.remove();
      results.insertAdjacentHTML('beforeend', `<div class="error">${esc(err.message)}</div>`);
    } finally {
      more.disabled = false;
      more.textContent = 'Load more';
    }
  }
  more.addEventListener('click', load);
  // The filters live in the URL, so Back already restores them; this brings
  // back the extra pages and the scroll position as well.
  snapshot = () => ({ skip });
  (async () => {
    await load();
    while (restore?.skip && alive && skip < restore.skip && !more.hidden) await load();
    finishRestore(restore, () => alive);
  })();
}

function qualityClass(q) {
  if (!q || q === 'Unknown') return 'q-unknown';
  if (['CamRip', 'Telesync', 'Screener'].includes(q)) return 'q-low';
  const p = parseInt(q, 10);
  if (p >= 2160) return 'q-uhd';
  if (p >= 1080) return 'q-hd';
  return '';
}

function resultRow(m) {
  const r = m.nyaa;
  const group = /^\s*\[([^\]]+)\]/.exec(r.title)?.[1];
  return `<a class="row" href="#/t/${r.id}" title="${esc(r.title)}">
    <div class="title">${group ? `<span class="badge group clickable" title="Show only ${esc(group)} releases">${esc(group)}</span>` : ''}${esc(r.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div>
    <div class="qual"><span class="quality ${qualityClass(r.quality)}">${esc(r.quality || 'Unknown')}</span></div>
    <div class="num hide-sm">${esc(r.size)}</div>
    <div class="num seed">${r.seeders}</div>
    <div class="num leech hide-sm">${r.leechers}</div>
    <div class="num muted hide-sm">${esc((r.date || '').slice(0, 10))}</div>
  </a>`;
}

// ---------- continue watching ----------
function continueEntries() {
  const all = getProgress();
  return Object.entries(all)
    // Only torrent-file entries ("nyaaId:fileIdx"); "anilist:" keys are per-episode marks.
    .filter(([key, p]) => /^\d+:\d+$/.test(key) && p.d && p.t > 30 && p.t < p.d - 60)
    .sort((a, b) => b[1].ts - a[1].ts);
}

function continueCard([key, p]) {
  const [id, idx] = key.split(':');
  const qs = p.series ? `?${new URLSearchParams({ series: p.series, ep: p.ep, bg: p.bg || '' })}` : '';
  const img = p.poster || `${ADDON}/poster.svg?t=${encodeURIComponent((p.show || p.title || '').slice(0, 80))}`;
  return `<a class="card" href="#/play/${id}/${idx}${qs}">
    <img src="${esc(img)}" alt=""${p.poster ? ' class="poster-crop"' : ''}>
    <div class="progress"><i style="width:${Math.min(100, (p.t / p.d) * 100).toFixed(1)}%"></i></div>
    <div class="body"><div class="name">${esc(p.title)}</div><div class="muted small">${fmtTime(p.t)} / ${fmtTime(p.d)}</div></div>
  </a>`;
}

function continueStrip(n) {
  const entries = continueEntries().slice(0, n);
  if (!entries.length) return '';
  return `<h2>Continue watching</h2><div class="cards">${entries.map(continueCard).join('')}</div>`;
}

// ---------- your library ----------
// The library lives in this browser (localStorage), next to watch progress.
// Removed series are kept for a while as { removed: true } entries so that,
// when two copies are merged (import, sync), a removal on one device beats an
// older copy of the same series on another instead of resurrecting it.
const TOMBSTONE_DAYS = 90;
const libraryEntries = () => store.get('library', []);
const libraryItems = () => libraryEntries().filter((e) => !e.removed);
const isInLibrary = (id) => libraryItems().some((e) => e.id === String(id));

function setInLibrary(id, on, info = {}) {
  const entries = libraryEntries();
  const i = entries.findIndex((e) => e.id === String(id));
  const prev = entries[i];
  const now = Date.now();
  const next = {
    id: String(id),
    name: info.name || prev?.name,
    poster: info.poster || prev?.poster,
    addedAt: on && (!prev || prev.removed) ? now : prev?.addedAt ?? now,
    updatedAt: now,
    ...(on ? {} : { removed: true }),
  };
  if (i >= 0) entries[i] = next; else entries.push(next);
  store.set('library', entries);
  scheduleSync(1500);
}

/** Merge two copies: per series the newer change wins, per progress key the newer position. */
function mergeData(a, b) {
  const lib = new Map();
  for (const e of [...(a.library || []), ...(b.library || [])]) {
    const cur = lib.get(e.id);
    if (!cur || (e.updatedAt || 0) > (cur.updatedAt || 0)) lib.set(e.id, e);
  }
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400e3;
  const library = [...lib.values()].filter((e) => !e.removed || e.updatedAt > cutoff);
  const progress = { ...(a.progress || {}) };
  for (const [k, p] of Object.entries(b.progress || {})) {
    if (!progress[k] || (p.ts || 0) > (progress[k].ts || 0)) progress[k] = p;
  }
  return { library, progress: trimProgress(progress) };
}

/** Stable text form for "did anything change?" checks (key order, nulls ignored). */
function canonical(data) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] != null).map((k) => [k, norm(v[k])]));
    }
    return v;
  };
  return JSON.stringify(norm({ library: [...(data.library || [])].sort((x, y) => x.id.localeCompare(y.id)), progress: data.progress || {} }));
}

const localData = () => ({ library: libraryEntries(), progress: getProgress() });

/** Replace local data; tells the open page when something actually changed. */
function applyLocal(data) {
  const changed = canonical(data) !== canonical(localData());
  store.set('library', data.library);
  store.set('progress', data.progress);
  if (changed) window.dispatchEvent(new Event('library-changed'));
  return changed;
}

// ---------- export / import ----------
function exportLibrary() {
  const data = { app: 'nyaa-stream', kind: 'library-backup', v: 1, exportedAt: new Date().toISOString(), library: libraryItems(), progress: getProgress() };
  const name = `nyaa-stream-library-${new Date().toISOString().slice(0, 10)}.json`;
  const text = JSON.stringify(data, null, 2);
  // A WebView ignores download links; the Android app shows a "save as" screen instead.
  if (ANDROID) return window.NyaaAndroid.saveFile(name, text);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Validate a backup file and merge it in; returns how many series it added. */
function importLibrary(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This is not a JSON file.'); }
  if (!data || !Array.isArray(data.library)) throw new Error('This file is not a Nyaa Stream library backup.');
  const now = Date.now();
  // Importing is an explicit "add these": imported series count as added now,
  // so they come back even if they were removed here earlier.
  const library = data.library
    .filter((e) => e && /^\d{1,9}$/.test(String(e.id)) && !e.removed)
    .map((e) => ({
      id: String(e.id),
      name: typeof e.name === 'string' ? e.name.slice(0, 300) : undefined,
      poster: /^https:\/\//.test(e.poster || '') ? String(e.poster).slice(0, 500) : undefined,
      addedAt: Number.isFinite(e.addedAt) ? e.addedAt : now,
      updatedAt: now,
    }));
  const progress = {};
  for (const [k, p] of Object.entries(data.progress && typeof data.progress === 'object' ? data.progress : {})) {
    if (/^(\d+:\d+|anilist:\d+:\d+)$/.test(k) && p && Number.isFinite(p.t)) progress[k] = p;
  }
  const before = new Set(libraryItems().map((e) => e.id));
  applyLocal(mergeData(localData(), { library, progress }));
  scheduleSync(500);
  return { total: library.length, added: library.filter((e) => !before.has(e.id)).length };
}

// ---------- sync codes ----------
// Optional: a copy of library + progress on the server under a random code.
// Each sync pulls the server copy, merges it with this browser's, and pushes
// the result on top of the revision it pulled; if another device saved in
// between, the server says 409 and we merge again.
const sync = { running: null, timer: null, status: 'idle', error: null };

const syncCode = () => store.get('syncCode', null);

async function syncRequest(method, path, body) {
  const res = await fetch(`/api/sync${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

function setSyncStatus(status, error = null) {
  sync.status = status;
  sync.error = error;
  window.dispatchEvent(new Event('sync-status'));
}

function scheduleSync(delay) {
  if (!syncCode()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), delay);
}

function syncNow() {
  const code = syncCode();
  if (!code) return Promise.resolve();
  if (sync.running) return sync.running;
  sync.running = (async () => {
    setSyncStatus('syncing');
    try {
      for (let attempt = 0; ; attempt++) {
        const remote = await syncRequest('GET', `/${encodeURIComponent(code)}`);
        if (remote.status === 404) throw new Error('This sync code no longer exists on the server.');
        if (!remote.ok) throw new Error(remote.body.error || `sync failed (${remote.status})`);
        const merged = mergeData(localData(), remote.body.data);
        applyLocal(merged);
        if (canonical(merged) === canonical(remote.body.data)) break; // nothing new to send
        const put = await syncRequest('PUT', `/${encodeURIComponent(code)}`, { baseRev: remote.body.rev, data: merged });
        if (put.status === 409 && attempt < 3) continue; // another device saved first: merge again
        if (!put.ok) throw new Error(put.body.error || `sync failed (${put.status})`);
        break;
      }
      store.set('syncLast', Date.now());
      setSyncStatus('ok');
    } catch (err) {
      setSyncStatus('error', err.message);
    } finally {
      sync.running = null;
    }
  })();
  return sync.running;
}

async function createSyncCode() {
  const res = await syncRequest('POST', '', { data: localData() });
  if (!res.ok) throw new Error(res.body.error || 'could not create a code');
  store.set('syncCode', res.body.code);
  store.set('syncLast', Date.now());
  setSyncStatus('ok');
}

async function joinSyncCode(raw) {
  const res = await syncRequest('GET', `/${encodeURIComponent(raw.trim())}`);
  if (!res.ok) throw new Error(res.body.error || 'could not open that code');
  store.set('syncCode', res.body.code);
  await syncNow(); // merges this browser's library into the synced one
}

function stopSync() {
  store.set('syncCode', null);
  clearTimeout(sync.timer);
  setSyncStatus('idle');
}

async function deleteSyncCopy() {
  const code = syncCode();
  if (code) await syncRequest('DELETE', `/${encodeURIComponent(code)}`, {});
  stopSync();
}

// Keep in step with other devices: on start, every few minutes, and on return to the tab.
if (syncCode()) syncNow();
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 3 * 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });

// ---------- library UI ----------
const libraryButton = (id, on, info = {}) => `<button class="btn lib-btn${on ? ' in' : ''}" type="button" data-lib="${esc(id)}"
  data-name="${esc(info.name || '')}" data-poster="${esc(info.poster || '')}" title="${on ? 'Remove from your library' : 'Add this series to your library'}">
  ${on ? '<span class="lib-on">✓ In your library</span><span class="lib-off">✕ Remove from library</span>' : '＋ Add to library'}</button>`;

// One handler for every library toggle (series page, torrent page).
view.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lib]');
  if (!btn) return;
  e.preventDefault();
  const on = !btn.classList.contains('in');
  const info = { name: btn.dataset.name, poster: btn.dataset.poster };
  setInLibrary(btn.dataset.lib, on, info);
  btn.outerHTML = libraryButton(btn.dataset.lib, on, info);
});

function relTime(ms) {
  const days = Math.floor((Date.now() - ms) / 86400e3);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return fmtDate(ms);
}

function relTimeShort(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return relTime(ms);
}

/** Highest episode of a series watched to the end (any torrent), or 0. */
function lastWatchedEpisode(id) {
  let max = 0;
  for (const [key, p] of Object.entries(getProgress())) {
    const m = /^anilist:(\d+):(\d+)$/.exec(key);
    if (m && m[1] === String(id) && p.d && p.t >= p.d - 90) max = Math.max(max, Number(m[2]));
  }
  return max;
}

function libraryCard(it) {
  const watched = lastWatchedEpisode(it.id);
  const unseen = it.latest && watched ? it.latest.episode - watched : 0;
  const latest = it.latest
    ? `Ep ${it.latest.episode} · ${relTime(it.latest.airingAt)}`
    : STATUS_LABEL[it.status] || '';
  const next = it.nextAiringEpisode ? `Next: Ep ${it.nextAiringEpisode.episode} · ${fmtDate(it.nextAiringEpisode.airingAt)}` : '';
  return `<div class="poster lib-item" data-id="${esc(it.id)}">
    <a href="#/series/${esc(it.id)}" class="cover" style="background:${esc(it.color || 'var(--bg-3)')}" title="${esc(it.name)}">
      ${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy">` : ''}
      ${unseen > 0 ? `<span class="pill airing">${unseen} new</span>` : ''}
    </a>
    <button class="lib-remove" type="button" data-unlib="${esc(it.id)}" title="Remove from your library">✕</button>
    <a href="#/series/${esc(it.id)}" class="pbody">
      <div class="name">${esc(it.name || `Series ${it.id}`)}</div>
      <div class="muted small">${esc(latest)}</div>
      ${next ? `<div class="small accent">${esc(next)}</div>` : ''}
      ${watched ? `<div class="muted small">Watched up to Ep ${watched}</div>` : ''}
    </a>
  </div>`;
}

function syncPanelHtml() {
  const code = syncCode();
  if (!code) {
    return `<h3>Sync with other devices</h3>
      <p class="muted small">Your library is saved in this browser. A sync code keeps a copy on the server so you can open
      the same library on another device or browser. There is no account: <b>anyone with the code can see and change this
      library</b>, so keep it private.</p>
      <div class="sync-actions">
        <button class="btn primary" type="button" id="sync-create">Create a sync code</button>
        <span class="muted small">or</span>
        <form id="sync-join" class="sync-join">
          <input class="text-filter" id="sync-code-input" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="Sync code">
          <button class="btn" type="submit">Use code</button>
        </form>
      </div>
      <p class="muted small">Using a code from another device merges this browser's library into the synced one.</p>
      <p class="error small" id="sync-msg"></p>`;
  }
  const last = store.get('syncLast', null);
  const status = sync.status === 'syncing' ? 'Syncing…'
    : sync.status === 'error' ? `<span class="leech">Sync failed: ${esc(sync.error)}</span>`
      : last ? `Last synced ${relTimeShort(last)}` : 'Not synced yet';
  return `<h3>Synced with code</h3>
    <div class="sync-code"><code id="sync-code">${esc(code)}</code><button class="btn" type="button" id="sync-copy">Copy</button></div>
    <p class="muted small">Enter this code on another device under Your Library → Sync to open the same library.
    Anyone with the code can see and change it.</p>
    <p class="small">${status}</p>
    <div class="sync-actions">
      <button class="btn" type="button" id="sync-now">Sync now</button>
      <button class="btn" type="button" id="sync-stop" title="This browser keeps its library; the synced copy stays for other devices">Stop syncing here</button>
      <button class="btn danger" type="button" id="sync-delete">Delete synced copy</button>
    </div>`;
}

async function libraryView(params) {
  const restore = restoring;
  view.innerHTML = `<div class="lib-head">
      <div>
        <h1>Your Library</h1>
        <p class="muted small">Series you added, newest episode first. Saved in this browser.</p>
      </div>
      <div class="lib-tools">
        <button class="btn" type="button" id="lib-export" title="Download your library and watch progress as a file">⤓ Export</button>
        <label class="btn" title="Add the series from a backup file to this library">⤒ Import<input type="file" id="lib-import" accept=".json,application/json" hidden></label>
        <button class="btn" type="button" id="sync-toggle"></button>
      </div>
    </div>
    <div class="sync-panel" id="sync-panel" ${params.sync ? '' : 'hidden'}></div>
    <div id="lib-notice"></div>
    <div id="lib"><div class="empty"><div class="spinner"></div></div></div>`;
  let alive = true;

  const panel = $('#sync-panel');
  const renderSync = () => {
    $('#sync-toggle').textContent = syncCode() ? (sync.status === 'error' ? '⟳ Sync: error' : '⟳ Synced') : '⟳ Sync';
    $('#sync-toggle').classList.toggle('in', !!syncCode());
    const typed = $('#sync-code-input')?.value;
    panel.innerHTML = syncPanelHtml();
    if (typed && $('#sync-code-input')) $('#sync-code-input').value = typed;
  };
  const notice = (html) => { $('#lib-notice').innerHTML = html ? `<div class="notice">${html}</div>` : ''; };

  async function load() {
    const items = libraryItems();
    if (!items.length) {
      $('#lib').innerHTML = `<div class="empty">Your library is empty.<br>Open a series from <a href="#/">Series</a> or a torrent from
        <a href="#/browse">Browse torrents</a> and press “＋ Add to library”, import a backup, or use a sync code.</div>`;
      return;
    }
    let info = {};
    let offline = false;
    try {
      const res = await fetch(`/api/library-info?ids=${items.map((e) => e.id).join(',')}`);
      if (!res.ok) throw new Error();
      info = await res.json();
    } catch {
      offline = true;
    }
    if (!alive) return;
    const list = items.map((e) => ({ ...e, ...(info[e.id] || {}), id: e.id, addedAt: e.addedAt }));
    // Newest episode first; series with nothing aired yet go last, newest added first.
    list.sort((a, b) => (b.lastEpisodeAt ?? -1) - (a.lastEpisodeAt ?? -1) || (b.addedAt || 0) - (a.addedAt || 0));
    $('#lib').innerHTML = `${offline ? '<p class="muted small">Could not reach AniList, so release dates are missing and the order is by date added.</p>' : ''}
      <div class="posters">${list.map(libraryCard).join('')}</div>`;
  }

  // Changes from sync/import while the page is open.
  const onChange = () => { if (alive) load(); };
  const onStatus = () => { if (alive) renderSync(); };
  window.addEventListener('library-changed', onChange);
  window.addEventListener('sync-status', onStatus);
  cleanup = () => {
    alive = false;
    window.removeEventListener('library-changed', onChange);
    window.removeEventListener('sync-status', onStatus);
  };

  $('#lib-export').onclick = exportLibrary;
  $('#lib-import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { total, added } = importLibrary(await file.text());
      notice(`Imported ${total} series from “${esc(file.name)}” (${added} new).`);
      load();
    } catch (err) {
      notice(`<span class="leech">${esc(err.message)}</span>`);
    }
  };
  $('#sync-toggle').onclick = () => { panel.hidden = !panel.hidden; };

  panel.addEventListener('click', async (e) => {
    const id = e.target.id;
    try {
      if (id === 'sync-create') {
        e.target.disabled = true;
        await createSyncCode();
      } else if (id === 'sync-copy') {
        if (ANDROID) window.NyaaAndroid.copyText(syncCode());
        else await navigator.clipboard.writeText(syncCode());
        e.target.textContent = 'Copied';
        return;
      } else if (id === 'sync-now') {
        await syncNow();
      } else if (id === 'sync-stop') {
        stopSync();
        notice('This browser stopped syncing. Its library stays here, and the synced copy stays available to your other devices.');
      } else if (id === 'sync-delete') {
        if (!confirm('Delete the synced copy from the server?\n\nThis browser keeps its library. Other devices using this code will stop syncing.')) return;
        await deleteSyncCopy();
        notice('The synced copy was deleted from the server. This browser kept its library.');
      } else {
        return;
      }
      renderSync();
    } catch (err) {
      renderSync();
      if ($('#sync-msg')) $('#sync-msg').textContent = err.message;
      else notice(`<span class="leech">${esc(err.message)}</span>`);
    }
  });
  panel.addEventListener('submit', async (e) => {
    if (e.target.id !== 'sync-join') return;
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await joinSyncCode($('#sync-code-input').value);
      renderSync();
      notice('This browser now uses the synced library.');
      load();
    } catch (err) {
      btn.disabled = false;
      $('#sync-msg').textContent = err.message;
    }
  });

  $('#lib').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unlib]');
    if (!btn) return;
    const card = btn.closest('.lib-item');
    const id = btn.dataset.unlib;
    const entry = libraryItems().find((x) => x.id === id) || {};
    const name = card.querySelector('.name').textContent;
    setInLibrary(id, false);
    card.remove();
    notice(`Removed “${esc(name)}”. <button class="btn" type="button" id="lib-undo">Undo</button>`);
    $('#lib-undo').onclick = () => {
      notice('');
      setInLibrary(id, true, { name: entry.name, poster: entry.poster });
      load();
    };
    if (!view.querySelector('.lib-item')) load();
  });

  renderSync();
  await load();
  finishRestore(restore, () => alive);
}

// ---------- torrent detail ----------
async function detail(params, id) {
  // Back returns to wherever the torrent was picked (Browse with its filters,
  // a series' pack list, …); Browse is the fallback for a direct link.
  const back = backButton('#/browse');
  view.innerHTML = `${back}<div class="empty"><div class="spinner"></div>Loading torrent…</div>`;
  let meta;
  try {
    ({ meta } = await addon('meta', 'series', `nyaa:${id}`));
  } catch (err) {
    view.innerHTML = `${back}<div class="error">${esc(err.message)}</div>`;
    return;
  }
  const progress = getProgress();
  const seasons = [...new Set(meta.videos.map((v) => v.season))];
  const multiSeason = seasons.length > 1;
  const epRow = (v) => {
    const p = progress[`${id}:${v.fileIdx}`];
    const pct = p?.d ? Math.min(100, (p.t / p.d) * 100) : 0;
    return `<a class="ep" href="#/play/${id}/${v.fileIdx}" title="${esc(v.fileName)}">
      <div class="n">${v.episodeParsed ? `E${String(v.episode).padStart(2, '0')}` : '▶'}</div>
      <div class="t"><div>${esc(v.title)}</div><div class="muted small">${esc(v.filePath)}</div></div>
      <div class="size muted small" style="text-align:right">${esc(v.size)}</div>
      <div class="play">▶</div>
      ${pct ? `<i class="watched" style="width:${pct.toFixed(1)}%"></i>` : ''}
    </a>`;
  };
  view.innerHTML = `${back}
    <div class="hero">
      <img src="${esc(meta.poster)}" alt="">
      <div>
        <h1>${esc(meta.name)}</h1>
        <div class="meta-line">
          ${meta.nyaa.submitter ? `<span>by ${esc(meta.nyaa.submitter)}</span>` : ''}
          <span>${esc(meta.nyaa.totalSize)}</span>
          <span>${meta.nyaa.fileCount} file(s)</span>
          <a href="${esc(meta.nyaa.url)}" target="_blank" rel="noopener">View on nyaa.si ↗</a>
        </div>
        ${meta.videos.length ? `<a class="btn primary" href="#/play/${id}/${resumeTarget(id, meta.videos).fileIdx}">${resumeLabel(id, meta.videos)}</a>` : ''}
        <div class="series-link" id="series-link"><span class="muted small">Finding which series this is…</span></div>
        <div class="desc" id="desc">${esc(meta.description)}</div>
      </div>
    </div>
    ${meta.videos.length ? seasons.map((s) => `
      <h2>${multiSeason ? `Season ${s}` : `Episodes (${meta.videos.length})`}</h2>
      <div class="episodes">${meta.videos.filter((v) => v.season === s).map(epRow).join('')}</div>`).join('')
    : '<div class="empty">This torrent has no playable media files.</div>'}`;
  const desc = $('#desc');
  desc.addEventListener('click', () => desc.classList.toggle('open'));

  // Which catalog series this torrent belongs to, so it can go in the library.
  let alive = true;
  cleanup = () => { alive = false; };
  const box = $('#series-link');
  try {
    const res = await fetch(`/api/resolve-series?${new URLSearchParams({ title: meta.name })}`);
    if (!alive) return;
    if (res.status === 404) {
      const guess = meta.name.replace(/^\s*(\[[^\]]*\]\s*)+/, '').split(/\s-\s|\[|\(|\bS\d{1,2}E?\d*\b/)[0].trim();
      box.innerHTML = `<span class="muted small">Not matched to a series in the catalog.</span>
        ${guess ? `<a class="small" href="#/series?${new URLSearchParams({ q: guess })}">Search series for “${esc(guess)}”</a>` : ''}`;
      return;
    }
    const s = await res.json();
    if (!res.ok) throw new Error(s.error);
    if (!alive) return;
    box.innerHTML = `${s.poster ? `<img src="${esc(s.poster)}" alt="">` : ''}
      <div><div class="muted small">Series</div><a href="#/series/${s.id}">${esc(s.name)}</a></div>
      ${libraryButton(s.id, isInLibrary(s.id), { name: s.name, poster: s.poster })}`;
  } catch (err) {
    if (alive) box.innerHTML = `<span class="muted small">Could not look up the series: ${esc(err.message)}</span>`;
  }
}

function resumeTarget(id, videos) {
  const progress = getProgress();
  const watched = videos.filter((v) => progress[`${id}:${v.fileIdx}`]);
  if (!watched.length) return videos[0];
  const last = watched.sort((a, b) => progress[`${id}:${b.fileIdx}`].ts - progress[`${id}:${a.fileIdx}`].ts)[0];
  const p = progress[`${id}:${last.fileIdx}`];
  if (p.d && p.t > p.d - 90) return videos[videos.indexOf(last) + 1] || last;
  return last;
}
function resumeLabel(id, videos) {
  const v = resumeTarget(id, videos);
  const started = getProgress()[`${id}:${v.fileIdx}`];
  const label = v.episodeParsed ? `E${String(v.episode).padStart(2, '0')}` : '';
  return started ? `▶ Resume ${label}` : `▶ Play ${label}`;
}

// ---------- player ----------
function fmtTime(s) {
  if (!Number.isFinite(s)) return '--:--';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
const fmtSpeed = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${(b / 1024).toFixed(0)} KB/s`);
const langName = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code); } catch { return code; }
};
const hevcSupported = () => {
  const types = ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'];
  return types.some((t) => (window.MediaSource?.isTypeSupported?.(t)) || document.createElement('video').canPlayType(t) === 'probably');
};

function canDirectPlay(info) {
  if (!info) return true; // no ffprobe: just try
  if (!/matroska|mp4|mov|webm/.test(info.container || '')) return false;
  const v = info.video;
  const videoOk = !v || (v.codec === 'h264' && !/10/.test(v.pixFmt || ''))
    || (v.codec === 'hevc' && hevcSupported()) || ['vp8', 'vp9', 'av1'].includes(v.codec);
  return videoOk && info.directAudio;
}

async function player(params, id, idxStr) {
  const idx = Number(idxStr);
  const key = `${id}:${idx}`;
  document.body.classList.add('playing');
  view.innerHTML = `
    <div class="player" id="player">
      <video id="video" playsinline preload="auto"></video>
      <div class="overlay" id="overlay"><div class="box"><div class="spinner"></div><div id="ov-text">Loading…</div><div class="small muted" id="ov-sub"></div></div></div>
      <div class="p-top">
        <button class="iconbtn" id="back" title="Back (Esc)">←</button>
        <div class="ttl" id="ttl"></div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="p-bottom">
        <div class="seek" id="seek"><div class="track"><div class="buf" id="buf"></div><div class="cur" id="cur"></div></div><div class="hover-time" id="hover-time"></div></div>
        <div class="ctrls">
          <button class="iconbtn" id="pp" title="Play/Pause (Space)">▶</button>
          <button class="iconbtn" id="back10" title="Back 10s (←)">⟲</button>
          <button class="iconbtn" id="fwd10" title="Forward 10s (→)">⟳</button>
          <button class="iconbtn" id="next" title="Next episode" hidden>⏭</button>
          <input type="range" id="vol" min="0" max="1" step="0.05" title="Volume">
          <span class="time" id="time">0:00 / --:--</span>
          <select id="audio" title="Audio track" hidden></select>
          <select id="subs" title="Subtitles" hidden></select>
          <select id="mode" title="Playback mode">
            <option value="direct">Direct</option>
            <option value="compat">Compatible (ffmpeg)</option>
          </select>
          <select id="ext" title="Open in external player"><option value="">External…</option></select>
          <button class="iconbtn" id="fs" title="Fullscreen (F)">⛶</button>
        </div>
      </div>
    </div>`;

  const el = (id_) => document.getElementById(id_);
  const video = el('video');
  const ui = {
    overlay: el('overlay'), ovText: el('ov-text'), ovSub: el('ov-sub'), stats: el('stats'),
    pp: el('pp'), time: el('time'), cur: el('cur'), buf: el('buf'), seek: el('seek'), hover: el('hover-time'),
    audio: el('audio'), subs: el('subs'), mode: el('mode'), ext: el('ext'), next: el('next'), vol: el('vol'),
  };
  const state = {
    meta: null, stream: null, info: null, mode: 'direct', offset: 0, audio: 0, sub: -1,
    sid: Math.random().toString(36).slice(2, 12), cuesSeen: 0, alive: true, ffmpeg: false, triedCompat: false,
  };
  const timers = [];
  const showOverlay = (text, sub = '') => {
    ui.overlay.hidden = false;
    ui.ovText.textContent = text;
    ui.ovSub.textContent = sub;
  };
  const hideOverlay = () => { ui.overlay.hidden = true; };
  const toast = (msg) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    el('player').append(t);
    setTimeout(() => t.remove(), 3500);
  };

  cleanup = () => {
    state.alive = false;
    timers.forEach(clearInterval);
    savePos();
    video.pause();
    video.removeAttribute('src');
    video.load();
    fetch(`/transcode/session/${state.sid}/stop`, { method: 'POST' }).catch(() => {});
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  // Opened from a series episode page: back/next follow the series, not the torrent.
  const series = params.series ? { id: params.series, ep: Number(params.ep), bg: params.bg || '' } : null;
  const backHash = series ? `#/series/${series.id}/${series.ep}` : `#/t/${id}`;
  // History-aware, so the page we return to keeps its filters and scroll.
  el('back').onclick = () => goBack(backHash);

  // 1. Meta + stream from the addon, as Stremio does.
  showOverlay('Loading torrent…');
  try {
    const [{ meta }, { streams }, seriesMeta] = await Promise.all([
      addon('meta', 'series', `nyaa:${id}`),
      addon('stream', 'series', `nyaa:${id}:${idx}`),
      series ? addon('meta', 'series', `anilist:${series.id}`).then((r) => r.meta).catch(() => null) : null,
    ]);
    state.meta = meta;
    state.stream = streams[0];
    state.seriesMeta = seriesMeta;
  } catch (err) {
    showOverlay('Could not load torrent', err.message);
    return;
  }
  if (!state.alive) return;
  if (!state.stream) return showOverlay('No stream for this file');
  const { infoHash: ih } = state.stream;
  let goNext = null;
  if (series && state.seriesMeta) {
    const sm = state.seriesMeta;
    const cur = sm.videos.find((v) => v.episode === series.ep);
    const next = sm.videos.find((v) => v.episode === series.ep + 1);
    const epTitle = cur && cur.title !== `Episode ${series.ep}` ? `: ${cur.title}` : '';
    el('ttl').textContent = `${sm.name} · Episode ${series.ep}${epTitle}`;
    if (next) {
      // Like Stremio's bingeGroup: prefer the same fansub and quality next time.
      goNext = () => { location.hash = `#/series/${series.id}/${next.episode}?${new URLSearchParams({ auto: series.bg })}`; };
      ui.next.title = `Next: Episode ${next.episode}`;
    }
  } else {
    const vIndex = state.meta.videos.findIndex((v) => v.fileIdx === idx);
    const videoEntry = state.meta.videos[vIndex];
    const nextEntry = state.meta.videos[vIndex + 1];
    el('ttl').textContent = videoEntry ? `${videoEntry.title}` : state.stream.behaviorHints.filename;
    if (nextEntry) {
      goNext = () => { location.hash = `#/play/${id}/${nextEntry.fileIdx}`; };
      ui.next.title = `Next: ${nextEntry.title}`;
    }
  }
  document.title = `${el('ttl').textContent} · Nyaa Stream`;
  if (goNext) {
    ui.next.hidden = false;
    ui.next.onclick = goNext;
  }
  const engineUrl = `/engine/${ih}/${idx}`;

  // 2. Start the engine, then probe codecs/tracks.
  showOverlay('Connecting to peers…', 'Fetching torrent metadata');
  const pollStats = async () => {
    try {
      const s = await (await fetch(`${engineUrl}/stats.json`)).json();
      if (!s) return;
      ui.stats.textContent = `${s.peers} peers · ↓ ${fmtSpeed(s.downloadSpeed)} · ${((s.streamProgress || 0) * 100).toFixed(1)}% cached`;
      if (!ui.overlay.hidden) ui.ovSub.textContent = `${s.peers} peers · ↓ ${fmtSpeed(s.downloadSpeed)}`;
    } catch { /* engine not ready */ }
  };
  timers.push(setInterval(pollStats, 2000));
  const created = await fetch(`/engine/${ih}/create`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (!state.alive) return;
  if (created.error) return showOverlay('Could not start torrent', created.error);

  // Android app: the native libVLC player plays the stream (every codec,
  // styled subtitles) and reports where it stopped, so progress and
  // next-episode work the same as in the browser player.
  if (ANDROID) {
    el('player').classList.add('native');
    const saved = getProgress()[key];
    const resumeAt = saved && saved.d && saved.t < saved.d - 30 ? saved.t : 0;
    showOverlay('Playing in the video player…', 'Leave the player to come back here.');
    window.nyaaNativeResult = (r) => {
      window.nyaaNativeResult = null;
      if (!state.alive) return;
      const d = r.duration > 0 ? r.duration / 1000 : null;
      const t = r.finished && d ? d : r.position / 1000;
      if (t >= 5) recordProgress(t, d);
      if (r.error) return showOverlay('Playback error', r.error);
      if (r.finished && goNext) goNext(); else goBack(backHash);
    };
    window.NyaaAndroid.play(JSON.stringify({
      url: new URL(engineUrl, location.href).href,
      title: el('ttl').textContent,
      startMs: Math.round(resumeAt * 1000),
      subLang: store.get('subLang', 'eng'),
    }));
    return;
  }

  const tools = await fetch('/transcode/status.json').then((r) => r.json()).catch(() => ({}));
  state.ffmpeg = !!tools.ffmpeg;
  if (tools.ffprobe) {
    showOverlay('Reading video info…');
    try {
      const r = await fetch(`/transcode/${ih}/${idx}/probe.json`);
      if (r.ok) state.info = await r.json();
    } catch { /* fall back to direct */ }
  }
  if (!state.alive) return;
  const info = state.info;

  // Track menus.
  if (info?.audio.length > 1) {
    ui.audio.hidden = false;
    ui.audio.innerHTML = info.audio.map((a) => `<option value="${a.index}">🔊 ${esc(a.title || langName(a.lang) || `Track ${a.index + 1}`)}${a.lang ? ` (${a.lang})` : ''}</option>`).join('');
  }
  const textSubs = (info?.subtitles || []).filter((s) => s.text);
  if (textSubs.length && state.ffmpeg) {
    ui.subs.hidden = false;
    ui.subs.innerHTML = '<option value="-1">💬 Subtitles off</option>'
      + textSubs.map((s) => `<option value="${s.index}">💬 ${esc(langName(s.lang) || 'Unknown')}${s.title ? ` · ${esc(s.title)}` : ''}</option>`).join('');
    const prefLang = store.get('subLang', 'eng');
    const pick = textSubs.find((s) => s.lang === prefLang && !s.forced) || textSubs.find((s) => s.default) || textSubs[0];
    state.sub = store.get('subOff', false) ? -1 : pick.index;
    ui.subs.value = String(state.sub);
  }
  if (!state.ffmpeg) ui.mode.querySelector('[value=compat]').disabled = true;

  // External players.
  const players = await fetch('/api/players').then((r) => r.json()).catch(() => []);
  ui.ext.innerHTML = '<option value="">External…</option>'
    + players.map((p) => `<option value="${p.id}">Open in ${esc(p.name)}</option>`).join('')
    + '<option value="m3u">Download .m3u</option><option value="copy">Copy stream URL</option>';
  ui.ext.onchange = async () => {
    const choice = ui.ext.value;
    ui.ext.value = '';
    const title = el('ttl').textContent;
    if (choice === 'copy') {
      await navigator.clipboard.writeText(new URL(engineUrl, location.href).href).catch(() => {});
      toast('Stream URL copied: paste it into VLC/mpv');
    } else if (choice === 'm3u') {
      location.href = `/api/playlist.m3u?${new URLSearchParams({ ih, idx, title })}`;
    } else if (choice) {
      video.pause();
      const r = await fetch('/api/external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: choice, ih, idx, title }) });
      toast(r.ok ? 'Opened in external player' : 'Could not launch player');
    }
  };

  // 3. Subtitle cues come from a growing WebVTT file on the server.
  const textTrack = video.addTextTrack('subtitles', 'Subtitles', 'en');
  textTrack.mode = 'showing';
  const resetCues = () => {
    while (textTrack.cues && textTrack.cues.length) textTrack.removeCue(textTrack.cues[0]);
    state.cuesSeen = 0;
  };
  const parseVttTime = (s) => {
    const p = s.trim().split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  let subsBusy = false;
  async function pollSubs() {
    if (state.sub < 0 || subsBusy) return;
    subsBusy = true;
    try {
      const r = await fetch(`/transcode/session/${state.sid}/subs.vtt`, { cache: 'no-store' });
      if (!r.ok) return;
      const blocks = (await r.text()).replace(/\r/g, '').split(/\n\n+/).filter((b) => b.includes('-->'));
      // The last block may be half-written; leave it for the next poll.
      const complete = r.headers.get('X-Extracting') === 'true' ? blocks.slice(0, -1) : blocks;
      for (const block of complete.slice(state.cuesSeen)) {
        const lines = block.split('\n');
        const ti = lines.findIndex((l) => l.includes('-->'));
        const [a, b] = lines[ti].split('-->');
        const text = lines.slice(ti + 1).join('\n');
        // ffmpeg's -ss makes compat-mode cue times relative to the seek offset,
        // matching the <video> clock, so no shift is needed in either mode.
        try { textTrack.addCue(new VTTCue(parseVttTime(a), parseVttTime(b.trim().split(' ')[0]), text)); } catch { /* bad cue */ }
      }
      state.cuesSeen = Math.max(state.cuesSeen, complete.length);
    } catch { /* retry next tick */ } finally {
      subsBusy = false;
    }
  }
  timers.push(setInterval(pollSubs, 2000));

  // In compat mode the <video> clock restarts at 0 on every seek.
  const now = () => (state.mode === 'compat' ? state.offset + video.currentTime : video.currentTime);
  const duration = () => info?.duration || (Number.isFinite(video.duration) ? video.duration : NaN);

  function startSubsDirect() {
    resetCues();
    if (state.sub < 0) return;
    fetch(`/transcode/${ih}/${idx}/subs?s=${state.sub}&sid=${state.sid}`, { method: 'POST' }).catch(() => {});
  }

  function load(mode, t = 0) {
    state.mode = mode;
    ui.mode.value = mode;
    showOverlay(mode === 'compat' ? 'Preparing stream (ffmpeg)…' : 'Buffering…');
    resetCues();
    if (mode === 'direct') {
      state.offset = 0;
      video.src = engineUrl;
      video.currentTime = t;
      startSubsDirect();
    } else {
      state.offset = t;
      const q = new URLSearchParams({ t: t.toFixed(2), a: state.audio, sid: state.sid, hevc: hevcSupported() ? '1' : '0' });
      if (state.sub >= 0) q.set('s', state.sub);
      video.src = `/transcode/${ih}/${idx}/video.mp4?${q}`;
    }
    video.play().catch(() => {});
  }

  function seek(t) {
    const d = duration();
    t = Math.max(0, Number.isFinite(d) ? Math.min(t, d - 1) : t);
    if (state.mode === 'direct') video.currentTime = t;
    else load('compat', t);
  }

  function savePos() {
    // Leaving before playback started: nothing to save (and the helpers below
    // are not initialised yet).
    if (!state.started) return;
    const d = duration();
    const t = now();
    if (!Number.isFinite(t) || t < 5) return;
    recordProgress(t, Number.isFinite(d) ? d : null);
  }

  function recordProgress(t, dur) {
    if (series && state.seriesMeta) {
      saveProgress(key, { t, d: dur, title: el('ttl').textContent, show: state.seriesMeta.name, poster: state.seriesMeta.poster, series: series.id, ep: series.ep, bg: series.bg });
      // Per-episode progress for the series page, whichever torrent was used.
      saveProgress(`anilist:${series.id}:${series.ep}`, { t, d: dur });
    } else {
      const show = (state.meta?.name || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/(\s*[[(][^\])]*[\])])+\s*$/, '');
      saveProgress(key, { t, d: dur, title: el('ttl').textContent, show });
    }
  }
  timers.push(setInterval(savePos, 5000));

  // Video events.
  video.addEventListener('waiting', () => showOverlay('Buffering…'));
  video.addEventListener('playing', hideOverlay);
  video.addEventListener('canplay', () => { if (!video.paused) hideOverlay(); });
  video.addEventListener('play', () => { ui.pp.textContent = '❚❚'; });
  video.addEventListener('pause', () => { ui.pp.textContent = '▶'; hideOverlay(); });
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('progress', renderTime);
  video.addEventListener('ended', () => {
    savePos();
    if (goNext) goNext();
  });
  video.addEventListener('error', () => {
    if (!state.alive || !video.getAttribute('src')) return;
    if (state.mode === 'direct' && state.ffmpeg && !state.triedCompat) {
      state.triedCompat = true;
      toast('Browser cannot play this file directly: switching to ffmpeg mode');
      load('compat', video.currentTime || state.resumeAt || 0);
    } else {
      showOverlay('Playback error', video.error?.message || 'The browser cannot decode this file. Try an external player.');
    }
  });

  function renderTime() {
    const d = duration();
    const t = now();
    ui.time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    if (Number.isFinite(d) && d > 0) {
      ui.cur.style.width = `${(t / d) * 100}%`;
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
      }
      const bufAbs = (state.mode === 'compat' ? state.offset : 0) + end;
      ui.buf.style.width = `${Math.min(100, (bufAbs / d) * 100)}%`;
    }
  }

  // Controls.
  ui.pp.onclick = () => (video.paused ? video.play() : video.pause());
  video.onclick = ui.pp.onclick;
  video.ondblclick = () => toggleFs();
  el('back10').onclick = () => seek(now() - 10);
  el('fwd10').onclick = () => seek(now() + 10);
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : el('player').requestFullscreen()).catch(() => {});
  el('fs').onclick = toggleFs;
  ui.vol.value = store.get('volume', 1);
  video.volume = Number(ui.vol.value);
  ui.vol.oninput = () => { video.volume = Number(ui.vol.value); store.set('volume', video.volume); };
  const seekPos = (e) => {
    const r = ui.seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration();
  };
  ui.seek.onclick = (e) => { const t = seekPos(e); if (Number.isFinite(t)) seek(t); };
  ui.seek.onmousemove = (e) => {
    const t = seekPos(e);
    ui.hover.textContent = fmtTime(t);
    ui.hover.style.left = `${e.clientX - ui.seek.getBoundingClientRect().left}px`;
  };
  ui.mode.onchange = () => load(ui.mode.value, now());
  ui.audio.onchange = () => {
    state.audio = Number(ui.audio.value);
    // Browsers cannot switch audio tracks of a direct stream; ffmpeg can.
    load('compat', now());
  };
  ui.subs.onchange = () => {
    state.sub = Number(ui.subs.value);
    store.set('subOff', state.sub < 0);
    const s = info.subtitles[state.sub];
    if (s?.lang) store.set('subLang', s.lang);
    if (state.mode === 'compat') load('compat', now());
    else startSubsDirect();
  };

  function onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); ui.pp.onclick(); }
    else if (e.key === 'ArrowLeft') seek(now() - 10);
    else if (e.key === 'ArrowRight') seek(now() + 10);
    else if (e.key === 'f') toggleFs();
    else if (e.key === 'm') video.muted = !video.muted;
    else if (e.key === 'Escape' && !document.fullscreenElement) goBack(backHash);
  }
  document.addEventListener('keydown', onKey);

  // Hide chrome when idle.
  let idleTimer;
  const wake = () => {
    el('player').classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) el('player').classList.add('idle'); }, 2500);
  };
  el('player').addEventListener('mousemove', wake);
  wake();

  // 4. Go.
  const saved = getProgress()[key];
  state.resumeAt = saved && saved.d && saved.t < saved.d - 30 ? saved.t : 0;
  const mode = canDirectPlay(info) || !state.ffmpeg ? 'direct' : 'compat';
  state.started = true;
  load(mode, state.resumeAt);
  if (state.resumeAt) toast(`Resuming at ${fmtTime(state.resumeAt)}`);
}

// ---------- about ----------
async function about() {
  const manifest = await fetch(`${ADDON}/manifest.json`).then((r) => r.json()).catch(() => null);
  const tools = await fetch('/transcode/status.json').then((r) => r.json()).catch(() => ({}));
  const players = await fetch('/api/players').then((r) => r.json()).catch(() => []);
  const manifestUrl = new URL(`${ADDON}/manifest.json`, location.href).href;
  view.innerHTML = `<div class="prose">
    <h1>About Nyaa Stream</h1>
    <p>A small Stremio clone with one torrent source, <a href="https://nyaa.si" target="_blank" rel="noopener">nyaa.si</a>.
    The Series catalog (titles, posters, episodes) comes from <a href="https://anilist.co" target="_blank" rel="noopener">AniList</a>.
    It keeps the same pieces as Stremio: an <b>addon</b> that answers catalog/meta/stream requests,
    a <b>streaming engine</b> that downloads torrent pieces in the order the player asks for them,
    and a <b>player</b>.</p>
    <h2>Status</h2>
    <p>Addon: ${manifest ? `${esc(manifest.name)} v${esc(manifest.version)}` : 'unavailable'}<br>
    ffmpeg: ${tools.ffmpeg ? `<code>${esc(tools.ffmpeg)}</code>` : 'not found: “Compatible” mode and subtitles are disabled'}<br>
    External players: ${players.length ? players.map((p) => esc(p.name)).join(', ') : 'none found (install mpv or VLC, or use “Copy stream URL”)'}</p>
    <h2>Use the addon in Stremio</h2>
    <p>While this app is running, paste <code>${esc(manifestUrl)}</code> into Stremio's addon search box to install it.</p>
    <h2>Playback modes</h2>
    <p><b>Direct</b> streams the original file into the browser, with instant seeking. It works for H.264/HEVC/VP9 video with AAC/Opus/FLAC audio.
    <b>Compatible</b> runs ffmpeg to remux (or transcode) to MP4. Use it for AC3/DTS audio, 10-bit H.264, or switching audio tracks; seeking restarts ffmpeg.
    In both modes, soft subtitles are pulled out of the file as it downloads.</p>
    <p class="small">Keys: Space play/pause · ←/→ 10 s · F fullscreen · M mute · Esc back</p>
  </div>`;
}

route();
