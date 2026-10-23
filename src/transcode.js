// ffmpeg side of the player, a much smaller stand-in for Stremio's /hlsv2
// router: probe a torrent file, remux/transcode it to fragmented MP4 for the
// browser, and extract soft subtitles to a growing WebVTT file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Router } from 'express';
import { createEngine } from './engine.js';

const SUBS_DIR = path.join(os.tmpdir(), 'nyaa-stremio-subs');
fs.mkdirSync(SUBS_DIR, { recursive: true });

const TEXT_SUB_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'mov_text', 'webvtt', 'text']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const fromEnv = process.env[`${name.toUpperCase()}_PATH`];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).find(Boolean);
    if (found) return found.trim();
  } catch { /* not on PATH */ }
  // Stremio for Windows ships ffmpeg/ffprobe next to its shell.
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Stremio', exe),
    'C:\\Program Files\\ffmpeg\\bin\\' + exe,
    '/usr/bin/' + exe,
    '/usr/local/bin/' + exe,
    '/opt/homebrew/bin/' + exe,
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export const FFMPEG = findTool('ffmpeg');
export const FFPROBE = findTool('ffprobe');

let localBase = 'http://127.0.0.1:11471';
export const setLocalBase = (b) => { localBase = b; };
const fileUrl = (ih, idx) => `${localBase}/engine/${ih}/${idx}`;

const probes = new Map();

export function probe(ih, idx) {
  const key = `${ih}:${idx}`;
  if (!probes.has(key)) {
    const p = runProbe(ih, idx);
    probes.set(key, p);
    p.catch(() => probes.delete(key));
  }
  return probes.get(key);
}

async function runProbe(ih, idx) {
  if (!FFPROBE) throw new Error('ffprobe not found (set FFPROBE_PATH)');
  await createEngine(ih);
  const out = await new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', fileUrl(ih, idx)]);
    let data = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('probe timed out')); }, 90e3);
    proc.stdout.on('data', (d) => { data += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(JSON.parse(data));
      else reject(new Error(err.trim() || `ffprobe exited ${code}`));
    });
  });
  const streams = out.streams || [];
  const ofType = (type) => streams.filter((s) => s.codec_type === type);
  const tag = (s, k) => s.tags?.[k] || s.tags?.[k.toUpperCase()] || null;
  const video = ofType('video').find((s) => !s.disposition?.attached_pic) || null;
  const info = {
    duration: Number(out.format?.duration) || null,
    container: out.format?.format_name,
    video: video && {
      codec: video.codec_name,
      profile: video.profile,
      pixFmt: video.pix_fmt,
      width: video.width,
      height: video.height,
    },
    audio: ofType('audio').map((s, i) => ({
      index: i,
      codec: s.codec_name,
      channels: s.channels,
      lang: tag(s, 'language'),
      title: tag(s, 'title'),
      default: !!s.disposition?.default,
    })),
    subtitles: ofType('subtitle').map((s, i) => ({
      index: i,
      codec: s.codec_name,
      lang: tag(s, 'language'),
      title: tag(s, 'title'),
      default: !!s.disposition?.default,
      forced: !!s.disposition?.forced,
      text: TEXT_SUB_CODECS.has(s.codec_name),
    })),
  };
  // Stremio's streamShouldTransmux: copy h264 (8-bit only for browsers) and
  // hevc when the client supports it; copy aac audio, otherwise transcode.
  info.videoCopyable = !!video && video.codec_name === 'h264' && !/10/.test(video.pix_fmt || '');
  info.hevc = !!video && video.codec_name === 'hevc';
  info.directAudio = info.audio.length === 0 || BROWSER_AUDIO.has(info.audio[0].codec);
  return info;
}

// sid -> { procs: Set<ChildProcess>, vtt, lastSeen }
const sessions = new Map();

function session(sid) {
  if (!/^[a-z0-9-]{6,40}$/i.test(sid || '')) throw new Error('invalid sid');
  let s = sessions.get(sid);
  if (!s) {
    s = { procs: new Set(), vtt: path.join(SUBS_DIR, `${sid}.vtt`), lastSeen: Date.now() };
    sessions.set(sid, s);
  }
  s.lastSeen = Date.now();
  return s;
}

function stopSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  for (const p of s.procs) p.kill('SIGKILL');
  sessions.delete(sid);
  fs.rm(s.vtt, { force: true }, () => {});
}

// Sessions whose page went away without saying goodbye.
setInterval(() => {
  for (const [sid, s] of sessions) if (Date.now() - s.lastSeen > 90e3 && !s.streaming) stopSession(sid);
}, 30e3).unref();

function subtitleOutput(s, subIdx) {
  fs.writeFileSync(s.vtt, '');
  return ['-map', `0:s:${subIdx}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', '-y', s.vtt];
}

function track(s, proc, label) {
  s.procs.add(proc);
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  proc.on('close', (code, signal) => {
    s.procs.delete(proc);
    if (code && !signal) console.warn(`[ffmpeg ${label}] exited ${code}: ${err.trim().split('\n').pop()}`);
  });
}

export function transcodeRouter() {
  const router = Router();

  router.get('/status.json', (req, res) => res.json({ ffmpeg: FFMPEG, ffprobe: FFPROBE }));

  router.get('/:ih/:idx/probe.json', async (req, res) => {
    try {
      res.json(await probe(req.params.ih.toLowerCase(), Number(req.params.idx)));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Browser-safe stream: fragmented MP4 from offset t (seconds). Seeking means
  // requesting again with a new t, like Stremio restarting ffmpeg with -ss.
  // Optional s = subtitle track, written alongside to the session's VTT file.
  router.get('/:ih/:idx/video.mp4', async (req, res) => {
    if (!FFMPEG) return res.status(501).json({ error: 'ffmpeg not found (set FFMPEG_PATH)' });
    const ih = req.params.ih.toLowerCase();
    const idx = Number(req.params.idx);
    let info;
    let s;
    try {
      info = await probe(ih, idx);
      s = session(String(req.query.sid));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // One video pipeline per session: a new request (seek) replaces the old one.
    for (const p of s.procs) p.kill('SIGKILL');

    const t = Math.max(0, Number(req.query.t) || 0);
    const a = Math.min(Math.max(0, Number(req.query.a) || 0), Math.max(0, info.audio.length - 1));
    const sub = req.query.s !== undefined && req.query.s !== '' ? Number(req.query.s) : -1;
    const copyVideo = info.videoCopyable || (info.hevc && req.query.hevc === '1');
    const copyAudio = info.audio[a] && info.audio[a].codec === 'aac' && info.audio[a].channels <= 2;

    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', fileUrl(ih, idx),
      '-map', '0:v:0?', '-map', `0:a:${a}?`];
    if (copyVideo) {
      args.push('-c:v', 'copy');
      if (info.hevc) args.push('-tag:v', 'hvc1');
    } else {
      args.push('-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', '21',
        '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
    }
    if (copyAudio) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
    args.push('-sn', '-dn', '-map_chapters', '-1', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    if (sub >= 0 && info.subtitles[sub]?.text) args.push(...subtitleOutput(s, sub));

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    track(s, proc, `video ${ih.slice(0, 8)}:${idx}@${t}`);
    s.streaming = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Transcode', `${copyVideo ? 'copy' : 'x264'}/${copyAudio ? 'copy' : 'aac'}`);
    proc.stdout.pipe(res);
    res.on('close', () => {
      proc.kill('SIGKILL');
      s.streaming = false;
      s.lastSeen = Date.now();
    });
  });

  // Subtitles for direct play: read the whole file once, in order, writing cues
  // as they appear. Playback from the start stays ahead of the extraction as
  // long as the swarm downloads faster than real time.
  router.post('/:ih/:idx/subs', async (req, res) => {
    if (!FFMPEG) return res.status(501).json({ error: 'ffmpeg not found' });
    try {
      const ih = req.params.ih.toLowerCase();
      const idx = Number(req.params.idx);
      const s = session(String(req.query.sid));
      const sub = Number(req.query.s);
      const info = await probe(ih, idx);
      if (!info.subtitles[sub]?.text) return res.status(400).json({ error: 'not a text subtitle track' });
      for (const p of s.procs) p.kill('SIGKILL');
      const args = ['-hide_banner', '-loglevel', 'error', '-i', fileUrl(ih, idx), ...subtitleOutput(s, sub)];
      track(s, spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }), `subs ${ih.slice(0, 8)}:${idx}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/session/:sid/subs.vtt', (req, res) => {
    const s = sessions.get(req.params.sid);
    if (!s) return res.status(404).end();
    s.lastSeen = Date.now();
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Extracting', String(s.procs.size > 0));
    fs.createReadStream(s.vtt).on('error', () => res.end()).pipe(res);
  });

  router.post('/session/:sid/stop', (req, res) => {
    stopSession(req.params.sid);
    res.json({});
  });

  return router;
}
