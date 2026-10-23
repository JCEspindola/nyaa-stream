// Library helpers for the web UI. The library itself lives in each user's
// browser (and optionally in a sync code, see sync.js); the server only adds
// the catalog data the library page shows, so it holds no per-user state.
import { Router } from 'express';
import * as anilist from './anilist.js';
import { findSeriesForRelease } from './series.js';

const MAX_IDS = 200;

const card = (m) => ({
  id: m.id,
  name: anilist.displayTitle(m),
  poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
  color: m.coverImage?.color || null,
  format: m.format,
  status: m.status,
  episodes: m.episodes,
  nextAiringEpisode: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt * 1000 } : null,
});

export function libraryRouter() {
  const router = Router();

  // Card data and "latest episode" for the ids a browser has in its library.
  router.get('/library-info', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter((x) => /^\d{1,9}$/.test(x)).slice(0, MAX_IDS);
    if (!ids.length) return res.json({});
    try {
      const info = await anilist.libraryInfo(ids);
      const out = {};
      for (const [id, i] of info) out[id] = { ...card(i.media), latest: i.latest, lastEpisodeAt: i.updatedAt };
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Which series a torrent belongs to, for the torrent page's library button.
  router.get('/resolve-series', async (req, res) => {
    const title = String(req.query.title || '').slice(0, 300);
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const m = await findSeriesForRelease(title);
      if (!m) return res.status(404).json({ error: 'no matching series' });
      res.json(card(m));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
