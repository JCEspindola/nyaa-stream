// Nyaa Stream UI. Talks to the Nyaa addon through the Stremio addon protocol
// (catalog / meta / stream), then plays the returned {infoHash, fileIdx} through
// the local streaming engine, the same flow stremio-web follows.

const ADDON = '/addon';
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
const FILTERS = { 0: 'No filter', 1: 'No remakes', 2: 'Trusted only' };

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
function saveProgress(key, entry) {
  const all = getProgress();
  all[key] = { ...all[key], ...entry, ts: Date.now() };
  // Keep the 100 most recent.
  const keys = Object.keys(all).sort((a, b) => all[b].ts - all[a].ts);
  for (const k of keys.slice(100)) delete all[k];
  store.set('progress', all);
}

// ---------- addon client ----------
async function addon(resource, type, id, extra) {
  const extraStr = extra && Object.keys(extra).length
    ? '/' + new URLSearchParams(Object.entries(extra).filter(([, v]) => v !== '' && v != null)).toString()
    : '';
  const res = await fetch(`${ADDON}/${resource}/${type}/${encodeURIComponent(id)}${extraStr}.json`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `addon ${resource} failed (${res.status})`);
  return body;
}

// ---------- router ----------
let cleanup = null;
const routes = [
  [/^#?\/?$/, discover],
  [/^#\/search$/, discover],
  [/^#\/continue$/, continueView],
  [/^#\/about$/, about],
  [/^#\/t\/(\d+)$/, detail],
  [/^#\/play\/(\d+)\/(\d+)$/, player],
];

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  document.body.classList.remove('playing');
  document.title = 'Nyaa Stream';
  const [pathPart, query = ''] = location.hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', (pathPart || '#/').startsWith(a.getAttribute('href')) && (a.dataset.nav !== 'discover' || /^#?\/?(search)?$/.test(pathPart)));
  }
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
  const current = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  location.hash = `#/search?${new URLSearchParams({ ...current, q })}`;
});

// ---------- discover / search ----------
function discover(params) {
  const q = params.q || '';
  const opts = {
    genre: params.genre || 'Anime - English-translated',
    s: params.s || 'id',
    f: params.f || '0',
  };
  $('#search-input').value = q;
  const select = (name, map, value) =>
    `<select data-k="${name}">${Object.entries(map).map(([k, v]) => {
      const val = name === 'genre' ? k : k;
      return `<option value="${esc(val)}" ${String(val) === String(value) ? 'selected' : ''}>${esc(name === 'genre' ? k : v)}</option>`;
    }).join('')}</select>`;

  view.innerHTML = `
    ${q ? '' : continueStrip(6)}
    <h1>${q ? `Results for “${esc(q)}”` : 'Latest on nyaa.si'}</h1>
    <p class="muted small">Pick a torrent to see its episodes. Sorting and filters are applied by nyaa.si.</p>
    <div class="filters">
      ${select('genre', CATEGORIES, opts.genre)}
      ${select('s', SORTS, opts.s)}
      ${select('f', FILTERS, opts.f)}
    </div>
    <div class="results" id="results">
      <div class="row head"><div>Name</div><div class="num hide-sm">Size</div><div class="num">Seed</div><div class="num hide-sm">Leech</div><div class="num">Date</div></div>
    </div>
    <div class="more"><button class="btn" id="more" hidden>Load more</button></div>`;

  for (const sel of view.querySelectorAll('.filters select')) {
    sel.addEventListener('change', () => {
      const next = { ...params, [sel.dataset.k]: sel.value };
      location.hash = `#/search?${new URLSearchParams(next)}`;
    });
  }

  const results = $('#results');
  const more = $('#more');
  let skip = 0;
  let alive = true;
  cleanup = () => { alive = false; };

  async function load() {
    more.disabled = true;
    more.textContent = 'Loading…';
    const placeholder = document.createElement('div');
    placeholder.className = 'empty';
    placeholder.innerHTML = '<div class="spinner"></div>Asking nyaa.si…';
    if (!skip) results.append(placeholder);
    try {
      const catalogId = opts.s === 'seeders' ? 'nyaa-popular' : 'nyaa-latest';
      const { metas, hasMore } = await addon('catalog', 'series', catalogId, {
        search: q, genre: opts.genre, skip: skip || '', s: opts.s, f: opts.f,
      });
      if (!alive) return;
      placeholder.remove();
      if (!metas.length && !skip) results.insertAdjacentHTML('beforeend', '<div class="empty">Nothing found.</div>');
      results.insertAdjacentHTML('beforeend', metas.map(resultRow).join(''));
      skip += metas.length;
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
  load();
}

function resultRow(m) {
  const r = m.nyaa;
  const group = /^\s*\[([^\]]+)\]/.exec(r.title)?.[1];
  return `<a class="row" href="#/t/${r.id}" title="${esc(r.title)}">
    <div class="title">${r.trusted ? '<span class="badge trusted">trusted</span>' : ''}${r.remake ? '<span class="badge remake">remake</span>' : ''}${group ? `<span class="badge group">${esc(group)}</span>` : ''}${esc(r.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</div>
    <div class="num hide-sm">${esc(r.size)}</div>
    <div class="num seed">${r.seeders}</div>
    <div class="num leech hide-sm">${r.leechers}</div>
    <div class="num muted">${esc((r.date || '').slice(0, 10))}</div>
  </a>`;
}

// ---------- continue watching ----------
function continueEntries() {
  const all = getProgress();
  return Object.entries(all)
    .filter(([, p]) => p.d && p.t > 30 && p.t < p.d - 60)
    .sort((a, b) => b[1].ts - a[1].ts);
}

function continueCard([key, p]) {
  const [id, idx] = key.split(':');
  return `<a class="card" href="#/play/${id}/${idx}">
    <img src="${ADDON}/poster.svg?t=${encodeURIComponent((p.show || p.title || '').slice(0, 80))}" alt="">
    <div class="progress"><i style="width:${Math.min(100, (p.t / p.d) * 100).toFixed(1)}%"></i></div>
    <div class="body"><div class="name">${esc(p.title)}</div><div class="muted small">${fmtTime(p.t)} / ${fmtTime(p.d)}</div></div>
  </a>`;
}

function continueStrip(n) {
  const entries = continueEntries().slice(0, n);
  if (!entries.length) return '';
  return `<h2>Continue watching</h2><div class="cards">${entries.map(continueCard).join('')}</div><h2>Browse</h2>`;
}

function continueView() {
  const entries = continueEntries();
  view.innerHTML = `<h1>Continue watching</h1>
    ${entries.length ? `<div class="cards" style="margin-top:16px">${entries.map(continueCard).join('')}</div>`
    : '<div class="empty">Nothing in progress yet.</div>'}`;
}

// ---------- torrent detail ----------
async function detail(params, id) {
  view.innerHTML = '<div class="empty"><div class="spinner"></div>Loading torrent…</div>';
  let meta;
  try {
    ({ meta } = await addon('meta', 'series', `nyaa:${id}`));
  } catch (err) {
    view.innerHTML = `<div class="error">${esc(err.message)}</div>`;
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
  view.innerHTML = `
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
        <div class="desc" id="desc">${esc(meta.description)}</div>
      </div>
    </div>
    ${meta.videos.length ? seasons.map((s) => `
      <h2>${multiSeason ? `Season ${s}` : `Episodes (${meta.videos.length})`}</h2>
      <div class="episodes">${meta.videos.filter((v) => v.season === s).map(epRow).join('')}</div>`).join('')
    : '<div class="empty">This torrent has no playable media files.</div>'}`;
  const desc = $('#desc');
  desc.addEventListener('click', () => desc.classList.toggle('open'));
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

  el('back').onclick = () => { location.hash = `#/t/${id}`; };

  // 1. Meta + stream from the addon, as Stremio does.
  showOverlay('Loading torrent…');
  try {
    const [{ meta }, { streams }] = await Promise.all([
      addon('meta', 'series', `nyaa:${id}`),
      addon('stream', 'series', `nyaa:${id}:${idx}`),
    ]);
    state.meta = meta;
    state.stream = streams[0];
  } catch (err) {
    showOverlay('Could not load torrent', err.message);
    return;
  }
  if (!state.alive) return;
  if (!state.stream) return showOverlay('No stream for this file');
  const { infoHash: ih } = state.stream;
  const vIndex = state.meta.videos.findIndex((v) => v.fileIdx === idx);
  const videoEntry = state.meta.videos[vIndex];
  const nextEntry = state.meta.videos[vIndex + 1];
  el('ttl').textContent = videoEntry ? `${videoEntry.title}` : state.stream.behaviorHints.filename;
  document.title = `${el('ttl').textContent} · Nyaa Stream`;
  if (nextEntry) {
    ui.next.hidden = false;
    ui.next.title = `Next: ${nextEntry.title}`;
    ui.next.onclick = () => { location.hash = `#/play/${id}/${nextEntry.fileIdx}`; };
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
    const d = duration();
    const t = now();
    if (!Number.isFinite(t) || t < 5) return;
    const show = (state.meta?.name || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/(\s*[[(][^\])]*[\])])+\s*$/, '');
    saveProgress(key, { t, d: Number.isFinite(d) ? d : null, title: el('ttl').textContent, show });
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
    if (nextEntry) location.hash = `#/play/${id}/${nextEntry.fileIdx}`;
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
    else if (e.key === 'Escape' && !document.fullscreenElement) location.hash = `#/t/${id}`;
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
    <p>A small Stremio clone with one source, <a href="https://nyaa.si" target="_blank" rel="noopener">nyaa.si</a>.
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
