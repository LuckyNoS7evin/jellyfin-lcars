// Favourites (official favorites.js): one shelf per type, each loading on its own and
// disappearing when empty.
import { h, fill } from '../h.js';
import { Api } from '../api.js';
import { deck, card, empty, errorBox, loading, colorAt } from '../ui.js';

// [title, item types or a loader key, shelf shape]
const SECTIONS = [
  ['Films', 'Movie'],
  ['Series', 'Series'],
  ['Episodes', 'Episode', 'wide'],
  ['Videos', 'Video,MusicVideo', 'wide'],
  ['Collections', 'BoxSet'],
  ['Playlists', 'Playlist', 'square'],
  ['People', 'people'],
  ['Artists', 'artists', 'square'],
  ['Albums', 'MusicAlbum', 'square'],
  ['Songs', 'Audio', 'square'],
  ['Books', 'Book,AudioBook'],
];

export async function favourites(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Favourites');
  const fields = Api.FIELDS + ',MediaSourceCount';
  const load = what => {
    if (what === 'people') return api.get('/Persons', { userId: api.userId, isFavorite: true, fields, limit: 100 }, { signal }).then(r => r.Items);
    if (what === 'artists') return api.get('/Artists', { userId: api.userId, isFavorite: true, fields, limit: 100, sortBy: 'SortName' }, { signal }).then(r => r.Items);
    return api.items({ includeItemTypes: what, filters: 'IsFavorite', recursive: true, sortBy: 'SortName', limit: 100, collapseBoxSetItems: false, fields }, { signal }).then(r => r.Items);
  };
  const none = h('div', { hidden: true }, empty('No favourites yet: use ♡ on anything to add it here'));
  let pending = SECTIONS.length;
  let shown = 0;
  const done = () => { if (--pending === 0 && !shown) none.hidden = false; };
  const decks = SECTIONS.map(([title, what, shape], i) => {
    const body = h('div', loading());
    const el = deck(title, { color: colorAt(i) }, body);
    load(what).then(items => {
      if (!items?.length) { el.remove(); done(); return; }
      shown++;
      // Un-favouriting from a card redraws it; the shelf keeps it until the page is reopened.
      fill(body, h('div.shelf', { class: shape || '' }, items.map(it => card(api, it, shape === 'wide' ? { shape: 'wide', episodeImages: app.us.episodeImages } : {}))));
      done();
    }).catch(e => { fill(body, errorBox(e)); done(); });
    return el;
  });
  return h('div.home', none, decks);
}
