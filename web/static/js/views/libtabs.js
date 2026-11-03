// Library tabs that aren't a plain grid, after the official clients: Suggestions (films, TV,
// music), Upcoming and Networks (TV), and Genres (any library).
import { h, fill } from '../h.js';
import { Api } from '../api.js';
import { deck, card, empty, errorBox, loading, whenVisible } from '../ui.js';

const FIELDS = Api.FIELDS + ',MediaSourceCount';
const IMAGES = { enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1 };
const COLORS = ['sky', 'lilac', 'peach', 'blue', 'salmon', 'orange'];

/**
 * A deck with a shelf of cards that loads by itself and removes itself when empty.
 * shape: 'wide' | 'square' | undefined (posters).
 */
function shelf(ctx, title, load, { shape, color, more } = {}) {
  const { api } = ctx;
  const body = h('div', loading());
  const el = deck(title, { color, actions: more ? [h('a.act', { href: more }, 'All ›')] : [] }, body);
  load().then(items => {
    if (!items?.length) { el.remove(); return; }
    // Episodes follow "episode images in Next up and Continue watching", like Home.
    const opts = shape === 'wide' ? { shape: 'wide', episodeImages: ctx.app.us.episodeImages } : {};
    fill(body, h('div.shelf', { class: shape || '' }, items.map(i => card(api, i, opts))));
  }).catch(e => fill(body, errorBox(e)));
  return el;
}

// ---- Suggestions ------------------------------------------------------------------------------

/** Films: continue watching, latest, then "Because you watched…" (Movies/Recommendations). */
export function movieSuggestions(ctx, view) {
  const { api, signal } = ctx;
  const q = { userId: api.userId, parentId: view.Id, fields: FIELDS, ...IMAGES };
  const recs = h('div.home');
  api.get('/Movies/Recommendations', { ...q, categoryLimit: 6, itemLimit: 12 }, { signal }).then(list => {
    const title = r => ({
      SimilarToRecentlyPlayed: `Because you watched ${r.BaselineItemName}`,
      SimilarToLikedItem: `Because you like ${r.BaselineItemName}`,
      HasDirectorFromRecentlyPlayed: `Directed by ${r.BaselineItemName}`,
      HasLikedDirector: `Directed by ${r.BaselineItemName}`,
      HasActorFromRecentlyPlayed: `Starring ${r.BaselineItemName}`,
      HasLikedActor: `Starring ${r.BaselineItemName}`,
    }[r.RecommendationType] || r.BaselineItemName);
    fill(recs, (list || []).filter(r => r.Items?.length).map((r, i) =>
      deck(title(r), { color: COLORS[(i + 2) % COLORS.length] }, h('div.shelf', r.Items.map(it => card(api, it))))));
  }).catch(() => {});
  return [
    shelf(ctx, 'Continue watching', () => api.items({ ...q, includeItemTypes: 'Movie', filters: 'IsResumable', sortBy: 'DatePlayed', sortOrder: 'Descending', recursive: true, collapseBoxSetItems: false, limit: 12 }, { signal }).then(r => r.Items), { shape: 'wide', color: 'orange' }),
    shelf(ctx, 'Latest films', () => api.get('/Items/Latest', { ...q, includeItemTypes: 'Movie', limit: 24 }, { signal }), { color: 'sky' }),
    recs,
  ];
}

/** TV: continue watching, latest episodes, next up. */
export function tvSuggestions(ctx, view) {
  const { api, app, signal } = ctx;
  const q = { userId: api.userId, parentId: view.Id, fields: FIELDS, ...IMAGES };
  return [
    shelf(ctx, 'Continue watching', () => api.items({ ...q, includeItemTypes: 'Episode', filters: 'IsResumable', sortBy: 'DatePlayed', sortOrder: 'Descending', recursive: true, limit: 12 }, { signal }).then(r => r.Items), { shape: 'wide', color: 'orange' }),
    shelf(ctx, 'Latest episodes', () => api.get('/Items/Latest', { ...q, includeItemTypes: 'Episode', limit: 30 }, { signal }), { color: 'sky' }),
    shelf(ctx, 'Next up', () => api.get('/Shows/NextUp', { ...q, limit: 24, enableResumable: false, ...app.us.nextUpQuery() }, { signal }).then(r => r.Items), { shape: 'wide', color: 'lilac' }),
  ];
}

/** Music: latest albums, recently played and most played songs. */
export function musicSuggestions(ctx, view) {
  const { api, signal } = ctx;
  const q = { userId: api.userId, parentId: view.Id, fields: FIELDS, ...IMAGES };
  const songs = (sortBy, filters) => api.items({ ...q, includeItemTypes: 'Audio', recursive: true, sortBy, sortOrder: 'Descending', filters, limit: 18 }, { signal }).then(r => r.Items);
  return [
    shelf(ctx, 'Latest music', () => api.get('/Items/Latest', { ...q, includeItemTypes: 'Audio', limit: 24 }, { signal }), { shape: 'square', color: 'orange' }),
    shelf(ctx, 'Recently played', () => songs('DatePlayed', 'IsPlayed'), { shape: 'square', color: 'sky' }),
    shelf(ctx, 'Most played', () => songs('PlayCount', 'IsPlayed'), { shape: 'square', color: 'lilac' }),
  ];
}

// ---- Upcoming (TV) ----------------------------------------------------------------------------

/** Episodes airing soon, grouped by day (official tvupcoming.js). */
export async function upcoming(ctx, view) {
  const { api, signal } = ctx;
  const r = await api.get('/Shows/Upcoming', { userId: api.userId, parentId: view.Id, limit: 48, fields: FIELDS, ...IMAGES, enableTotalRecordCount: false }, { signal });
  const items = r.Items || [];
  if (!items.length) return empty('Nothing scheduled');
  const day = d => {
    if (!d) return 'Date unknown';
    const date = new Date(d);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(date).setHours(0, 0, 0, 0) - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const groups = Map.groupBy(items, i => day(i.PremiereDate));
  return [...groups].map(([label, list], i) => deck(label, { color: COLORS[i % COLORS.length] },
    h('div.shelf.wide', list.map(it => card(api, it, { shape: 'wide', episodeImages: ctx.app.us.episodeImages, missing: false })))));
}

// ---- Networks (TV studios) --------------------------------------------------------------------

export async function networks(ctx, view) {
  const { api, signal } = ctx;
  const r = await api.get('/Studios', { userId: api.userId, parentId: view.Id, includeItemTypes: 'Series', sortBy: 'SortName', fields: 'PrimaryImageAspectRatio', enableImageTypes: 'Thumb,Primary', imageTypeLimit: 1 }, { signal });
  const items = r.Items || [];
  if (!items.length) return empty('No networks');
  return h('div.grid.wide', items.map(s => {
    const tag = s.ImageTags?.Thumb || s.ImageTags?.Primary;
    const type = s.ImageTags?.Thumb ? 'Thumb' : 'Primary';
    return h('a.net', { href: `#/list?${new URLSearchParams({ studio: s.Id, name: s.Name, type: 'Series', parent: view.Id })}`, title: s.Name },
      tag ? h('img', { src: api.img(s.Id, type, { tag, w: 480 }), alt: s.Name, attrs: { loading: 'lazy' } }) : h('span.net-name', s.Name));
  }));
}

// ---- Genres -----------------------------------------------------------------------------------

/**
 * One row per genre with a random sample, loading as it scrolls into view, and a link to
 * everything in that genre in this library (official moviegenres.js / tvgenres.js).
 */
export async function genres(ctx, view, type) {
  const { api, signal } = ctx;
  const music = type === 'MusicAlbum';
  const r = await api.get(music ? '/MusicGenres' : '/Genres', { userId: api.userId, parentId: view.Id, includeItemTypes: type, sortBy: 'SortName' }, { signal });
  const list = r.Items || [];
  if (!list.length) return empty('No genres');
  return list.map((g, i) => {
    const body = h('div', loading());
    const href = `#/list?${new URLSearchParams({ genre: g.Id, name: g.Name, type, parent: view.Id })}`;
    const el = deck(g.Name, { color: COLORS[i % COLORS.length], actions: [h('a.act', { href }, 'All ›')] }, body);
    const stop = whenVisible(el, async () => {
      stop();
      try {
        const res = await api.items({ parentId: view.Id, genreIds: g.Id, includeItemTypes: type, recursive: true, sortBy: 'Random', limit: 16, fields: FIELDS, ...IMAGES }, { signal });
        if (!res.Items.length) { el.remove(); return; }
        fill(body, h('div.shelf', { class: music ? 'square' : '' }, res.Items.map(it => card(api, it))));
      } catch (e) { fill(body, errorBox(e)); }
    });
    signal.addEventListener('abort', stop);
    return el;
  });
}
