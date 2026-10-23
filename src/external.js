// Hand-off to a native player, standing in for the libmpv that Stremio's shell
// embeds. mpv/VLC handle every codec and render ASS subtitles with styling.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

function onPath(name) {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

function detect() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const players = [];
  const mpv = process.env.MPV_PATH || onPath('mpv')
    || pf.map((d) => path.join(d, 'mpv', 'mpv.exe')).find((p) => fs.existsSync(p));
  if (mpv) players.push({ id: 'mpv', name: 'mpv', bin: mpv, args: (url, title) => [`--force-media-title=${title}`, url] });
  const vlc = process.env.VLC_PATH || onPath('vlc')
    || pf.map((d) => path.join(d, 'VideoLAN', 'VLC', 'vlc.exe')).find((p) => fs.existsSync(p))
    || ['/Applications/VLC.app/Contents/MacOS/VLC'].find((p) => fs.existsSync(p));
  if (vlc) players.push({ id: 'vlc', name: 'VLC', bin: vlc, args: (url, title) => [`--meta-title=${title}`, url] });
  return players;
}

export const players = detect();

export function launch(playerId, url, title = 'Nyaa') {
  const p = players.find((x) => x.id === playerId);
  if (!p) throw new Error(`player ${playerId} not found`);
  const child = spawn(p.bin, p.args(url, title), { detached: true, stdio: 'ignore' });
  child.unref();
}
