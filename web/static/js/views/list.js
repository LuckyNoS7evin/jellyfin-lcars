// Genre, studio and tag pages (the official list.js): everything with that genre, studio
// or tag across the libraries, one deck per type, with Play all and Shuffle.
//   #/list?genre=<id>&name=Horror&type=Movie,Series
//   #/list?studio=<id>&name=…   #/list?tag=zombie
import { h } from '../h.js';
import { deck, card, empty, btn, loading, whenVisible, toast } from '../ui.js';

const LABELS = { Movie: 'Films', Series: 'Series', MusicAlbum: 'Albums', MusicArtist: 'Artists', BoxSet: 'Collections', Book: 'Books', Video: 'Videos', MusicVideo: 'Music videos' };
const COLORS = ['orange', 'sky', 'lilac', 'peach'];
const PAGE = 60;

/** The query for "everything with this genre/studio/tag" (used by app.playableItems too). */
export function listFilter(kind, value) {
  return kind === 'genre' ? { genreIds: value } : kind === 'studio' ? { studioIds: value } : { tags: value };
}

export async function list(ctx) {
  const { api, app, query, signal } = ctx;
  const kind = ['genre', 'studio', 'tag'].find(k => query.get(k));
  if (!kind) return empty('Nothing to list');
  const value = query.get(kind);
  const name = query.get('name') || value;
  const types = (query.get('type') || 'Movie,Series').split(',').filter(t => LABELS[t]);
  ctx.setTitle(name);
  const filter = listFilter(kind, value);
  // From a library's Genres or Networks tab: only that library.
  const parent = query.get('parent');
  const parentView = parent && app.views.find(v => v.Id === parent);
  const what = { genre: 'Genre', studio: 'Studio', tag: 'Tag' }[kind];

  // One deck per type that has anything, each paging in as you scroll.
  const decks = await Promise.all(types.map(async (type, i) => {
    const q = { ...filter, parentId: parent || undefined, includeItemTypes: type, recursive: true, sortBy: 'SortName', excludeLocationTypes: 'Virtual' };
    const first = await api.items({ ...q, limit: PAGE }, { signal });
    if (!first.TotalRecordCount) return null;
    const square = type === 'MusicAlbum' || type === 'MusicArtist';
    const grid = h('div.grid', { class: square ? 'square' : '' }, first.Items.map(it => card(api, it)));
    const sentinel = h('div.sentinel');
    let start = first.Items.length;
    const total = first.TotalRecordCount;
    let busy = false;
    const status = h('div', start < total ? loading() : null);
    async function more() {
      if (busy || start >= total) return;
      busy = true;
      try {
        const r = await api.items({ ...q, startIndex: start, limit: PAGE }, { signal });
        start = r.Items.length ? start + r.Items.length : total;
        grid.append(...r.Items.map(it => card(api, it)));
        if (start >= total) status.replaceChildren();
      } catch { /* left for the next scroll */ } finally { busy = false; }
    }
    if (start < total) {
      const stop = whenVisible(sentinel, more);
      signal.addEventListener('abort', stop);
    }
    return deck(LABELS[type], { color: COLORS[i % COLORS.length], code: String(total).padStart(4, '0') }, grid, status, sentinel);
  }));

  const pseudo = { Type: what, Name: name, filter: parent ? { ...filter, parentId: parent } : filter, types };
  const found = decks.filter(Boolean);
  return h('div.home',
    deck(parentView ? `${parentView.Name} · ${name}` : `${what} · ${name}`, { color: 'orange' },
      found.length ? h('div.actions',
        btn('Play all', async () => app.playList(await app.playableItems(pseudo)), { color: 'orange' }),
        btn('Shuffle', () => app.shuffle(pseudo).catch(e => toast('Unable to comply', e.message, 'red')), { color: 'peach' })) : empty(`Nothing tagged “${name}”`)),
    found);
}
