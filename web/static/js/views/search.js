// Search across the libraries, or inside one (#/search?in=<library id>), grouped by type.
// With an empty box it offers suggestions: favourite or liked titles first, then random ones
// (official useSearchSuggestions.ts, but descending: ascending puts the favourites last).
import { h, fill } from '../h.js';
import { Api } from '../api.js';
import { deck, card, empty, errorBox, loading, itemHref } from '../ui.js';

// [title, type(s), colour, shelf shape]
const GROUPS = [
  ['Films', 'Movie', 'orange'], ['Series', 'Series', 'sky'], ['Episodes', 'Episode', 'lilac', 'wide'],
  ['Videos', 'Video', 'peach', 'wide'], ['Music videos', 'MusicVideo', 'blue', 'wide'],
  ['Collections', 'BoxSet', 'peach'], ['Playlists', 'Playlist', 'blue', 'square'],
  ['Artists', 'MusicArtist', 'blue', 'square'], ['Albums', 'MusicAlbum', 'salmon', 'square'], ['Songs', 'Audio', 'sky', 'square'],
  ['Books', 'Book', 'orange'], ['Audiobooks', 'AudioBook', 'lilac', 'square'],
  ['People', 'Person', 'lilac'],
];
const ITEM_TYPES = GROUPS.map(g => g[1]).filter(t => t !== 'Person').join(',');

export async function search(ctx) {
  const { api, app, query } = ctx;
  ctx.setTitle('Search');
  const term = query.get('q') || '';
  // Scope: every library, or one.
  let scope = (app.views || []).some(v => v.Id === query.get('in')) ? query.get('in') : '';
  const results = h('div.results');
  let ctrl = null;
  let timer = null;

  const url = q => `#/search?${new URLSearchParams({ ...(q ? { q } : {}), ...(scope ? { in: scope } : {}) })}`;

  async function suggestions() {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    results.replaceChildren(loading());
    try {
      const r = await api.items({ sortBy: 'IsFavoriteOrLiked,Random', sortOrder: 'Descending', includeItemTypes: 'Movie,Series,MusicArtist', limit: 20, recursive: true, parentId: scope || undefined, enableImages: false, imageTypeLimit: 0, enableTotalRecordCount: false, fields: '' }, { signal });
      results.replaceChildren(r.Items.length
        ? deck('Suggestions', { color: 'lilac' }, h('div.suggest', r.Items.map(it => h('a', { href: itemHref(it) }, it.Name))))
        : empty('Awaiting query'));
    } catch (e) {
      if (e.name !== 'AbortError') results.replaceChildren(errorBox(e));
    }
  }

  async function run(q) {
    ctrl?.abort();
    if (!q.trim()) { suggestions(); return; }
    if (q.trim().length < 2) { results.replaceChildren(empty('Enter at least two characters')); return; }
    ctrl = new AbortController();
    const signal = ctrl.signal;
    ctx.signal.addEventListener('abort', () => ctrl.abort());
    results.replaceChildren(loading('Scanning'));
    try {
      const parentId = scope || undefined;
      const [items, people] = await Promise.all([
        api.items({ searchTerm: q, recursive: true, limit: 200, includeItemTypes: ITEM_TYPES, parentId }, { signal }),
        // People aren't in a library, so a library search leaves them out.
        scope ? { Items: [] } : api.get('/Persons', { searchTerm: q, limit: 24, userId: api.userId, fields: Api.FIELDS }, { signal }).catch(() => ({ Items: [] })),
      ]);
      const all = [...items.Items, ...people.Items];
      const decks = GROUPS.map(([title, type, color, shape], i) => {
        const list = all.filter(x => x.Type === type);
        return list.length ? deck(title, { color, num: i + 1, code: String(list.length).padStart(4, '0') },
          h('div.shelf', { class: shape || '' }, list.map(x => card(api, x, shape === 'wide' ? { shape: 'wide' } : {})))) : null;
      }).filter(Boolean);
      results.replaceChildren(...(decks.length ? decks : [empty(`No records match “${q}”`)]));
    } catch (e) {
      if (e.name !== 'AbortError') results.replaceChildren(errorBox(e));
    }
  }

  const input = h('input.inp', {
    type: 'search', value: term, placeholder: 'Search the library computer', attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search' },
    oninput: e => {
      clearTimeout(timer);
      const q = e.target.value;
      timer = setTimeout(() => {
        history.replaceState(history.state, '', url(q));
        run(q);
      }, 300);
    },
  });

  const scopes = h('div.tabs.search-scope');
  function drawScopes() {
    const views = app.views || [];
    fill(scopes, h('span.lbl', 'Search in'),
      [{ Id: '', Name: 'All libraries' }, ...views].map(v => h('button.tab', {
        type: 'button', class: v.Id === scope ? 'on' : '',
        onclick: () => { scope = v.Id; drawScopes(); history.replaceState(history.state, '', url(input.value)); run(input.value); input.focus(); },
      }, v.Name)));
  }
  drawScopes();

  setTimeout(() => input.focus(), 0);
  run(term);
  return h('div.view-search',
    h('div.search-bar', h('span.cap'), input),
    scopes,
    results);
}
