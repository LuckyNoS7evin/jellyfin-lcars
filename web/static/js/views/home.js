// Home: the sections and order from the user's Jellyfin home screen settings
// (homesection0..9), the same ones the official clients use. Empty sections are hidden.
import { h, fill } from '../h.js';
import { Api } from '../api.js';
import { deck, card, errorBox, colorAt, loading } from '../ui.js';

const DEFAULT_ORDER = ['smalllibrarytiles', 'resume', 'resumeaudio', 'resumebook', 'livetv', 'nextup', 'latestmedia'];
const LATEST_TYPES = { movies: 'Movie', tvshows: 'Episode', music: 'MusicAlbum', homevideos: 'Video', musicvideos: 'MusicVideo', books: 'Book' };

export async function home(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Main Library');
  const views = app.views || [];
  const prefs = app.homePrefs || {};
  let order = [];
  for (let i = 0; i < 10; i++) {
    const s = prefs[`homesection${i}`];
    if (s && s !== 'none') order.push(s);
  }
  if (!order.length) order = DEFAULT_ORDER;
  const excluded = new Set(app.me?.Configuration?.LatestItemsExcludes || []);
  const episodeImages = app.us.episodeImages;

  // Full-page backdrops: random art from across the libraries, like the official home screen.
  if (app.us.backdrops) {
    app.backdrops(api.items({
      recursive: true, includeItemTypes: 'Movie,Series,MusicArtist', sortBy: 'Random', limit: 12,
      imageTypes: 'Backdrop', enableImageTypes: 'Backdrop', imageTypeLimit: 1, fields: 'PrimaryImageAspectRatio',
    }, { signal }).then(r => r.Items.map(i => api.img(i.Id, 'Backdrop', { tag: i.BackdropImageTags?.[0], index: 0, w: 1920 }))));
  }

  const fields = Api.FIELDS + ',MediaSourceCount';
  const images = { enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1 };
  let n = 0;
  let color = 0;

  // Each deck loads on its own so a slow one doesn't hold up the rest; a section with
  // nothing in it removes itself.
  const slot = (title, load, shape) => {
    const body = h('div', loading());
    const el = deck(title, { color: colorAt(color++), num: ++n }, body);
    load().then(items => {
      if (!items.length) { el.remove(); renumber(); return; }
      fill(body, h('div.shelf', { class: shape?.cls || '' }, items.map(i => card(api, i, shape?.opts || {}))));
    }).catch(e => fill(body, errorBox(e)));
    return el;
  };
  const resume = mediaTypes => api.get('/UserItems/Resume', { userId: api.userId, limit: 16, mediaTypes, fields, ...images }, { signal }).then(r => r.Items);

  const SECTIONS = {
    smalllibrarytiles: () => views.length ? deck('Libraries', { color: colorAt(color++), num: ++n },
      h('div.shelf.wide', views.map(v => card(api, v, { shape: 'wide', color: app.viewColor(v.Id) })))) : null,
    resume: () => slot('Continue watching', () => resume('Video'), { cls: 'wide', opts: { shape: 'wide', episodeImages, onPlay: i => app.play(i, { resume: true }) } }),
    resumeaudio: () => slot('Continue listening', () => resume('Audio'), { cls: 'square', opts: { onPlay: i => app.play(i) } }),
    resumebook: () => slot('Continue reading', () => resume('Book')),
    nextup: () => slot('Next up', () => api.get('/Shows/NextUp', { userId: api.userId, limit: 16, fields, ...images, enableResumable: false, ...app.us.nextUpQuery() }, { signal }).then(r => r.Items),
      { cls: 'wide', opts: { shape: 'wide', episodeImages, onPlay: i => app.play(i) } }),
    latestmedia: () => views.filter(v => LATEST_TYPES[v.CollectionType] && !excluded.has(v.Id)).map(v => slot(`Latest · ${v.Name}`,
      () => api.get('/Items/Latest', { userId: api.userId, parentId: v.Id, limit: 24, fields, groupItems: true, includeItemTypes: LATEST_TYPES[v.CollectionType], ...images }, { signal }),
      v.CollectionType === 'music' ? { cls: 'square' } : null)),
  };
  SECTIONS.librarybuttons = SECTIONS.smalllibrarytiles;

  const root = h('div.home', order.map(s => SECTIONS[s]?.()).flat().filter(Boolean));
  function renumber() {
    root.querySelectorAll(':scope > .deck .num').forEach((e, i) => { e.textContent = String(i + 1).padStart(2, '0'); });
  }
  return root;
}
