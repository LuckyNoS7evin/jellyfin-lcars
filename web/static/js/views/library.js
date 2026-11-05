// A library: poster grid with sort, order and the full set of Jellyfin filters, loaded 100 at
// a time as you scroll. The default sort is the one saved for that library by the official
// clients (DisplayPreferences "<libraryId>-<tab>"), and changing it here saves it back.
import { h, fill } from '../h.js';
import { Api } from '../api.js';
import { deck, card, empty, errorBox, loading, whenVisible, code, toast, btn } from '../ui.js';
import { movieSuggestions, tvSuggestions, musicSuggestions, upcoming, networks, genres } from './libtabs.js';
import { photoMap } from './photomap.js';
import { selectAllSource } from '../select.js';
import { newPlaylist, newCollection, canManageCollections } from '../menu.js';

// key -> [label, SortBy]
const SORTS = {
  name: ['Name', 'SortName'],
  added: ['Date added', 'DateCreated,SortName'],
  episodeAdded: ['Episode added', 'DateLastContentAdded,SortName'],
  released: ['Release date', 'PremiereDate,ProductionYear,SortName'],
  year: ['Year', 'ProductionYear,SortName'],
  rating: ['Community rating', 'CommunityRating,SortName'],
  critic: ['Critic rating', 'CriticRating,SortName'],
  parental: ['Parental rating', 'OfficialRating,SortName'],
  played: ['Date played', 'DatePlayed,SortName'],
  playCount: ['Play count', 'PlayCount,SortName'],
  runtime: ['Runtime', 'Runtime,SortName'],
  artist: ['Artist', 'AlbumArtist,SortName'],
  album: ['Album', 'Album,SortName'],
  random: ['Random', 'Random'],
  series: ['Series', 'SeriesSortName,ParentIndexNumber,IndexNumber'],
};
// Sorts that read naturally newest/highest first.
const DESC_FIRST = new Set(['added', 'episodeAdded', 'released', 'year', 'rating', 'critic', 'played', 'playCount']);

// Filter groups: [key, label, choices: [[value, label, query]]]. Within a group the choices
// combine the way Jellyfin combines them (statuses AND, features AND, ratings/years OR).
const STATUS = ['status', 'Status', [
  ['IsPlayed', 'Played', { filters: 'IsPlayed' }], ['IsUnplayed', 'Unplayed', { filters: 'IsUnplayed' }],
  ['IsResumable', 'In progress', { filters: 'IsResumable' }], ['IsFavorite', 'Favourites', { filters: 'IsFavorite' }],
  ['Likes', 'Liked', { filters: 'Likes' }], ['Dislikes', 'Disliked', { filters: 'Dislikes' }],
]];
const FEATURES = ['feat', 'Features', [
  ['sub', 'Subtitles', { hasSubtitles: true }], ['trailer', 'Trailer', { hasTrailer: true }],
  ['extras', 'Special features', { hasSpecialFeature: true }], ['song', 'Theme song', { hasThemeSong: true }],
  ['video', 'Theme video', { hasThemeVideo: true }],
]];
const VIDEO = ['vid', 'Video', [
  ['4k', '4K', { is4K: true }], ['hd', 'HD', { isHd: true }], ['sd', 'SD', { isHd: false }], ['3d', '3D', { is3D: true }],
]];
const SERIES_STATUS = ['ss', 'Series status', [
  ['Continuing', 'Continuing', { seriesStatus: 'Continuing' }], ['Ended', 'Ended', { seriesStatus: 'Ended' }],
]];

// Per library type: tabs, each with what to list, which sorts/filters make sense, and the
// key the official web client saves its sort under.
const VIDEO_SORTS = ['name', 'added', 'released', 'year', 'rating', 'critic', 'parental', 'played', 'playCount', 'runtime', 'random'];
// Tabs with `render` are pages of their own (libtabs.js); the rest are filterable grids.
// Order follows the official clients' tab bars.
const TYPES = {
  movies: [
    { id: 'films', landing: 'movies', label: 'Films', types: 'Movie', pref: 'movies', sorts: VIDEO_SORTS, groups: [STATUS, FEATURES, VIDEO], dynamic: true },
    { id: 'suggestions', landing: 'suggestions', label: 'Suggestions', render: movieSuggestions },
    { id: 'favourites', landing: 'favorites', label: 'Favourites', types: 'Movie', fixed: { filters: 'IsFavorite' }, sorts: VIDEO_SORTS, groups: [FEATURES, VIDEO] },
    { id: 'collections', landing: 'collections', label: 'Collections', types: 'BoxSet', pref: 'moviecollections', create: 'collection', sorts: ['name', 'added', 'released', 'random'], groups: [STATUS] },
    { id: 'genres', landing: 'genres', label: 'Genres', render: (ctx, view) => genres(ctx, view, 'Movie') },
  ],
  tvshows: [
    { id: 'series', landing: 'series', label: 'Series', types: 'Series', pref: 'series', sorts: ['name', 'episodeAdded', 'added', 'released', 'year', 'rating', 'critic', 'parental', 'played', 'random'], groups: [STATUS, SERIES_STATUS, FEATURES], dynamic: true },
    { id: 'suggestions', landing: 'suggestions', label: 'Suggestions', render: tvSuggestions },
    { id: 'upcoming', landing: 'upcoming', label: 'Upcoming', render: upcoming },
    { id: 'genres', landing: 'genres', label: 'Genres', render: (ctx, view) => genres(ctx, view, 'Series') },
    { id: 'networks', landing: 'studios', label: 'Networks', render: networks },
    { id: 'episodes', landing: 'episodes', label: 'Episodes', types: 'Episode', pref: 'episodes', wide: true, sorts: ['series', 'name', 'added', 'released', 'rating', 'parental', 'played', 'playCount', 'runtime', 'random'], groups: [STATUS, FEATURES, VIDEO] },
  ],
  music: [
    { id: 'albums', landing: 'albums', label: 'Albums', types: 'MusicAlbum', pref: 'musicalbums', sorts: ['name', 'artist', 'added', 'released', 'year', 'rating', 'random'], groups: [STATUS], dynamic: true },
    { id: 'suggestions', landing: 'suggestions', label: 'Suggestions', render: musicSuggestions },
    { id: 'artists', landing: 'albumartists', label: 'Album artists', artists: '/Artists/AlbumArtists', sorts: ['name'], groups: [] },
    { id: 'allartists', landing: 'artists', label: 'Artists', artists: '/Artists', sorts: ['name'], groups: [] },
    { id: 'playlists', landing: 'playlists', label: 'Playlists', types: 'Playlist', noParent: true, fixed: { mediaTypes: 'Audio' }, create: 'audio', sorts: ['name', 'added'], groups: [] },
    { id: 'songs', landing: 'songs', label: 'Songs', types: 'Audio', pref: 'songs', sorts: ['name', 'artist', 'album', 'added', 'played', 'playCount', 'runtime', 'random'], groups: [STATUS] },
    { id: 'genres', landing: 'genres', label: 'Genres', render: (ctx, view) => genres(ctx, view, 'MusicAlbum') },
  ],
  boxsets: [{ id: 'sets', label: 'Collections', types: 'BoxSet', pref: 'boxsets', create: 'collection', sorts: ['name', 'added', 'released', 'random'], groups: [STATUS] }],
  // Books libraries are folders of series; browse those like the official client.
  books: [
    { id: 'series', label: 'Series', folders: true, sorts: ['name', 'added'], groups: [STATUS] },
    { id: 'books', label: 'All books', types: 'Book,AudioBook', pref: 'books', sorts: ['name', 'added', 'released', 'year', 'random'], groups: [STATUS], dynamic: true },
  ],
  playlists: [{ id: 'lists', label: 'Playlists', types: 'Playlist', folders: true, create: 'playlist', sorts: ['name', 'added'], groups: [] }],
  default: [{ id: 'all', label: 'Contents', folders: true, sorts: ['name', 'added'], groups: [STATUS] }],
};
// Photos (and home videos, which can hold photos): the folders, and a map of where they were taken.
TYPES.photos = [...TYPES.default, { id: 'map', label: 'Map', render: photoMap }];
TYPES.homevideos = TYPES.photos;

const PAGE = 100;

/**
 * The tabs a library type has, for the "Opens on" setting: [{label, landing}]. The first tab
 * is the default (landing ''). landing values are the official LibraryTab ones, saved as
 * `landing-<library id>` like the official client, so both open on the same tab.
 */
export function libraryTabs(collectionType) {
  const tabs = TYPES[collectionType] || TYPES.default;
  return tabs.map((t, i) => ({ label: t.label, landing: i === 0 ? '' : t.landing })).filter((t, i) => i === 0 || t.landing);
}

// View modes, saved per library and tab as the official `<library id>-<tab>-_view`. Official
// values we don't draw map onto ours.
const VIEWS = [['Poster', 'Posters'], ['Thumb', 'Thumbnails'], ['List', 'List']];
const VIEW_ALIASES = { PosterCard: 'Poster', ThumbCard: 'Thumb', Banner: 'Thumb' };

/** Map a saved official-client sort ("SortName,ProductionYear") onto ours. */
function prefSort(app, view, tab) {
  if (!tab.pref) return null;
  const raw = app.homePrefs?.[`${view.Id}-${tab.pref}`];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const first = (p.SortBy || '').split(',')[0];
    const key = tab.sorts.find(k => SORTS[k][1].split(',')[0] === first);
    return key ? { sort: key, order: p.SortOrder === 'Descending' ? 'desc' : 'asc' } : null;
  } catch { return null; }
}

export async function library(ctx) {
  const { api, app, params, query, signal } = ctx;
  const view = (app.views || []).find(v => v.Id === params.id) || await api.item(params.id);
  ctx.setTitle(view.Name);
  const tabs = TYPES[view.CollectionType] || TYPES.default;
  // No tab in the address: the library's saved default ("Opens on" in Settings).
  const landing = app.homePrefs?.[`landing-${view.Id}`];
  const tab = tabs.find(t => t.id === query.get('tab')) || (landing && tabs.find(t => t.landing === landing)) || tabs[0];
  const tabBar = () => (tabs.length > 1 ? h('div.tabs.lib-tabs', tabs.map(t => h('a.tab', { href: `#/lib/${view.Id}?tab=${t.id}`, class: t.id === tab.id ? 'on' : '' }, t.label))) : null);
  // Coming back to a library tab (the rail, the tab bar) brings back its filters and sort, as
  // the official client does (saveQuerySettings): saved per device for each library and tab,
  // restored when the address carries nothing but the tab. The letter jump isn't kept.
  const queryKey = `libquery.${view.Id}-${tab.id}`;
  if (!tab.render && [...query.keys()].every(k => k === 'tab')) {
    const last = app.us.local(queryKey, null);
    if (last && Object.keys(last).length) {
      location.replace(`#/lib/${view.Id}?${new URLSearchParams({ tab: tab.id, ...last })}`);
      return h('div');
    }
  }
  const saved = prefSort(app, view, tab);
  const sort = (tab.sorts || []).includes(query.get('sort')) ? query.get('sort') : saved?.sort || tab.sorts?.[0];
  const order = ['asc', 'desc'].includes(query.get('order')) ? query.get('order')
    : saved && saved.sort === sort ? saved.order : DESC_FIRST.has(sort) ? 'desc' : 'asc';
  const color = app.viewColor(view.Id);
  const letter = /^[#A-Z]$/.test(query.get('letter') || '') ? query.get('letter') : '';

  // Full-page backdrops: random art from this library (official client behaviour).
  if (app.us.backdrops) {
    app.backdrops(api.items({
      parentId: view.Id, recursive: true, includeItemTypes: tab.types || 'Movie,Series,MusicAlbum,MusicArtist',
      sortBy: 'Random', limit: 12, imageTypes: 'Backdrop', enableImageTypes: 'Backdrop', imageTypeLimit: 1, fields: 'PrimaryImageAspectRatio',
    }, { signal }).then(r => r.Items.map(i => api.img(i.Id, 'Backdrop', { tag: i.BackdropImageTags?.[0], index: 0, w: 1920 }))));
  }

  if (tab.render) {
    ctx.setTitle(view.Name);
    const body = h('div.home', loading());
    Promise.resolve(tab.render(ctx, view)).then(n => fill(body, n)).catch(e => fill(body, errorBox(e)));
    return h('div.home', deck(`${view.Name} · ${tab.label}`, { color: app.viewColor(view.Id), code: code(view.Id) }, tabBar()), body);
  }

  // Active filters: one query param per group, comma-separated values.
  const active = {};
  for (const [key] of tab.groups) active[key] = new Set((query.get(key) || '').split(',').filter(Boolean));
  for (const key of ['genres', 'years', 'ratings', 'tags']) active[key] = new Set((query.get(key) || '').split('|').filter(Boolean));
  for (const key of ['alang', 'slang']) active[key] = new Set((query.get(key) || '').split(',').filter(Boolean));
  const activeCount = Object.values(active).reduce((n, s) => n + s.size, 0);

  const state = () => {
    const p = { tab: tab.id, sort, order };
    if (letter) p.letter = letter;
    for (const [key, set] of Object.entries(active)) {
      if (set.size) p[key] = [...set].join(['genres', 'years', 'ratings', 'tags'].includes(key) ? '|' : ',');
    }
    return p;
  };
  const link = changes => `#/lib/${view.Id}?${new URLSearchParams({ ...state(), ...changes })}`;
  {
    const { tab: _t, letter: _l, ...keep } = state();
    app.us.setLocal(queryKey, keep);
  }

  // ---- the query --------------------------------------------------------------------------
  const filterQuery = {};
  const filterList = [];
  for (const [key, , choices] of tab.groups) {
    for (const v of active[key]) {
      const q = choices.find(c => c[0] === v)?.[2] || {};
      if (q.filters) filterList.push(q.filters);
      else if (q.seriesStatus) filterQuery.seriesStatus = [filterQuery.seriesStatus, q.seriesStatus].filter(Boolean).join(',');
      else Object.assign(filterQuery, q);
    }
  }
  if (tab.fixed?.filters) filterList.push(tab.fixed.filters);
  if (filterList.length) filterQuery.filters = filterList.join(',');
  if (active.genres.size) filterQuery.genres = [...active.genres].join('|');
  if (active.years.size) filterQuery.years = [...active.years].join(',');
  if (active.ratings.size) filterQuery.officialRatings = [...active.ratings].join('|');
  if (active.tags.size) filterQuery.tags = [...active.tags].join('|');
  if (active.alang.size) filterQuery.audioLanguages = [...active.alang].join(',');
  if (active.slang.size) filterQuery.subtitleLanguages = [...active.slang].join(',');
  // Letter bar: names starting with the letter; '#' is everything before 'A' (digits, symbols).
  if (letter === '#') filterQuery.nameLessThan = 'A';
  else if (letter) filterQuery.nameStartsWith = letter;

  const base = {
    ...(tab.fixed || {}),
    parentId: tab.noParent ? undefined : view.Id,
    sortBy: SORTS[sort][1],
    sortOrder: order === 'desc' ? 'Descending' : 'Ascending',
    recursive: !tab.folders,
    includeItemTypes: tab.types,
    ...filterQuery,
  };
  // Episodes come from every series: don't fold them into their seasons.
  if (tab.types === 'Episode') base.isMissing = false;

  // ---- view mode ----------------------------------------------------------------------------
  const viewKey = `${view.Id}-${tab.pref || tab.id}-_view`;
  const savedView = app.homePrefs?.[viewKey];
  const mode = VIEWS.some(([v]) => v === (VIEW_ALIASES[savedView] || savedView)) ? (VIEW_ALIASES[savedView] || savedView) : tab.wide ? 'Thumb' : 'Poster';
  const viewChips = h('span.lib-views', VIEWS.map(([v, label]) => h('button.tab', {
    type: 'button', class: v === mode ? 'on' : '', title: `Show as ${label.toLowerCase()}`,
    onclick: () => { if (v === mode) return; app.saveDisplayPref(viewKey, v).then(() => app.refresh()).catch(e => toast('View not saved', e.message, 'salmon')); },
  }, label)));
  const cardOpts = mode === 'Thumb' ? { shape: 'wide', episodeImages: app.us.episodeImages }
    : mode === 'List' ? { details: true, ...(tab.wide ? { shape: 'wide', episodeImages: app.us.episodeImages } : {}) } : {};

  const countEl = h('span.count');
  const countEl2 = h('span.count'); // the phone's summary line (below)
  const grid = h('div.grid', { class: [mode === 'Thumb' ? 'wide' : '', mode === 'List' ? 'list' : '', mode === 'List' && tab.wide ? 'wide' : ''].filter(Boolean).join(' ') });
  const status = h('div', loading());
  const sentinel = h('div.sentinel');
  let start = 0;
  let total = Infinity;
  let busy = false;
  // Select all: everything this view would list, not just the pages loaded so far.
  selectAllSource(grid, {
    done: () => start >= total,
    load: async () => (tab.artists
      ? await api.get(tab.artists, { userId: api.userId, parentId: view.Id, sortBy: 'SortName', sortOrder: base.sortOrder, nameStartsWith: filterQuery.nameStartsWith, nameLessThan: filterQuery.nameLessThan }, { signal })
      : await api.items({ ...base, startIndex: 0, limit: undefined }, { signal })).Items || [],
  });

  async function more() {
    if (busy || start >= total || signal.aborted) return;
    busy = true;
    try {
      const r = tab.artists
        ? await api.get(tab.artists, { userId: api.userId, parentId: view.Id, startIndex: start, limit: PAGE, sortBy: 'SortName', sortOrder: base.sortOrder, fields: 'PrimaryImageAspectRatio', enableImageTypes: 'Primary', imageTypeLimit: 1, nameStartsWith: filterQuery.nameStartsWith, nameLessThan: filterQuery.nameLessThan }, { signal })
        : await api.items({ ...base, startIndex: start, limit: PAGE, ...(mode === 'List' ? { fields: `${Api.FIELDS},Genres,OfficialRating,CommunityRating,RunTimeTicks` } : {}) }, { signal });
      total = r.TotalRecordCount ?? r.Items.length;
      start += r.Items.length;
      if (r.Items.length < PAGE) total = start;
      grid.append(...r.Items.map(i => card(api, i, { color, ...cardOpts })));
      countEl.textContent = countEl2.textContent = `${total.toLocaleString()} records`;
      if (playBtns) playBtns.hidden = total === 0;
      fill(status, total === 0 ? empty('No records match') : null);
    } catch (e) {
      fill(status, errorBox(e));
      total = start;
    } finally {
      busy = false;
    }
    if (start < total) requestAnimationFrame(nearEnd);
  }
  // Load more once the end of the grid is within 800 px of the screen. Measured here as well as
  // by the IntersectionObserver below: in a cross-origin frame (Jellyfin's LG TV app shows LCARS
  // in one) the observer ignores its margin, and a remote can't scroll past the last row.
  function nearEnd() {
    if (start < total && sentinel.isConnected && sentinel.getBoundingClientRect().top < window.innerHeight + 800) more();
  }

  // ---- play all / shuffle ---------------------------------------------------------------------
  // What's on screen (filters, letter and sort included) where that's a list of things to play;
  // album tabs play those albums' tracks, the series tab shuffles episodes.
  const leaf = { Movie: 'video', Episode: 'video', Audio: 'audio' }[tab.types];
  const playable = !tab.artists && !tab.folders && (leaf || tab.types === 'MusicAlbum' || tab.types === 'Series');
  const LIMIT = { video: 300, audio: 1000 };
  function playQuery(shuffle) {
    if (leaf) return { ...base, limit: LIMIT[leaf], excludeLocationTypes: 'Virtual', ...(shuffle ? { sortBy: 'Random', sortOrder: undefined } : {}) };
    const common = { parentId: view.Id, recursive: true, excludeLocationTypes: 'Virtual', genres: filterQuery.genres, years: filterQuery.years };
    if (tab.types === 'MusicAlbum') {
      return { ...common, includeItemTypes: 'Audio', limit: LIMIT.audio,
        sortBy: shuffle ? 'Random' : 'AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName' };
    }
    return { ...common, includeItemTypes: 'Episode', isMissing: false, limit: LIMIT.video, sortBy: 'Random' };
  }
  async function playAll(shuffle) {
    try {
      const r = await api.items(playQuery(shuffle), { signal });
      const items = r.Items || [];
      if (!items.length) { toast('Nothing to play', '', 'salmon'); return; }
      const audio = items.every(i => i.MediaType === 'Audio');
      // Music from Shuffle lights the queue's shuffle toggle (and can be put back in order).
      if (audio && shuffle) app.queue.play(items, 0, { shuffle: true });
      else app.playList(items, 0);
      if (r.TotalRecordCount > items.length) toast(shuffle ? 'Shuffling' : 'Playing', `The first ${items.length.toLocaleString()} of ${r.TotalRecordCount.toLocaleString()}`, 'sky', 3500);
    } catch (e) { if (e.name !== 'AbortError') toast('Unable to comply', e.message, 'red'); }
  }
  const playBtns = playable ? h('span.lib-play', { hidden: true },
    tab.types !== 'Series' ? btn('Play all', () => playAll(false), { small: true, color: 'orange', title: 'Play these, in this order' }) : null,
    btn(tab.types === 'Series' ? 'Shuffle episodes' : 'Shuffle', () => playAll(true), { small: true, color: 'peach' })) : null;

  // ---- controls ---------------------------------------------------------------------------
  const sortSel = h('select.sel', {
    attrs: { 'aria-label': 'Sort by' },
    onchange: e => {
      const s = e.target.value;
      saveSort(s, DESC_FIRST.has(s) ? 'desc' : 'asc');
      location.hash = link({ sort: s, order: DESC_FIRST.has(s) ? 'desc' : 'asc' });
    },
  }, tab.sorts.map(k => h('option', { value: k, attrs: { selected: k === sort } }, SORTS[k][0])));

  function saveSort(s, o) {
    if (!tab.pref) return;
    app.saveDisplayPref(`${view.Id}-${tab.pref}`, JSON.stringify({ SortBy: SORTS[s][1], SortOrder: o === 'desc' ? 'Descending' : 'Ascending' }))
      .catch(e => toast('Sort not saved', e.message, 'salmon'));
  }

  const orderBtn = h('a.tab', {
    href: link({ order: order === 'desc' ? 'asc' : 'desc' }),
    title: order === 'desc' ? 'Descending' : 'Ascending',
    onclick: () => saveSort(sort, order === 'desc' ? 'asc' : 'desc'),
  }, order === 'desc' ? '▼ Desc' : '▲ Asc');

  const panel = h('div.filters', { attrs: { hidden: query.get('panel') !== '1' } });
  const filterBtn = tab.groups.length || tab.dynamic
    ? h('button.tab', {
      type: 'button', class: activeCount ? 'on' : '',
      onclick: () => { panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); },
    }, activeCount ? `Filters · ${activeCount}` : 'Filters')
    : null;

  const chip = (key, value, label, sep = ',') => {
    const set = new Set(active[key]);
    const on = set.has(value);
    if (on) set.delete(value); else set.add(value);
    return h('a.tab', { class: on ? 'on' : '', href: link({ [key]: [...set].join(sep), panel: '1' }) }, label);
  };

  let dynamicLoaded = false;
  const dynamicEl = h('div');
  function drawPanel() {
    if (!tab.dynamic || dynamicLoaded) return;
    dynamicLoaded = true;
    fill(dynamicEl, loading('Indexing'));
    const q = { userId: api.userId, parentId: view.Id, includeItemTypes: tab.types };
    // Filters has ratings and years; Filters2 adds the audio and subtitle languages.
    Promise.all([
      api.get('/Items/Filters', q, { signal }),
      api.get('/Items/Filters2', q, { signal }).catch(() => ({})),
    ]).then(([r, r2]) => {
      const group = (label, key, values, sep = '|') => values?.length
        ? h('div.fgroup', h('span.flabel', label), h('div.fchips', values.map(([v, l]) => chip(key, String(v), String(l), sep)))) : null;
      const plain = list => (list || []).map(v => [v, v]);
      const langs = list => (list || []).map(l => [l.Value, l.Name.replace(/\s*\([a-z]{2,3}\)$/i, '')]);
      fill(dynamicEl,
        group('Genres', 'genres', plain(r.Genres)),
        group('Audio language', 'alang', langs(r2.AudioLanguages), ','),
        group('Subtitle language', 'slang', langs(r2.SubtitleLanguages), ','),
        group('Parental ratings', 'ratings', plain(r.OfficialRatings)),
        group('Years', 'years', plain([...(r.Years || [])].sort((a, b) => b - a))),
        group('Tags', 'tags', plain(r.Tags)));
    }).catch(e => fill(dynamicEl, errorBox(e)));
  }
  fill(panel,
    tab.groups.map(([key, label, choices]) => h('div.fgroup', h('span.flabel', label), h('div.fchips', choices.map(([v, l]) => chip(key, v, l))))),
    dynamicEl,
    activeCount ? h('div.fgroup', h('a.tab.clear', { href: `#/lib/${view.Id}?${new URLSearchParams({ tab: tab.id, sort, order })}` }, 'Clear all filters')) : null);
  if (!panel.hidden) drawPanel();

  // On a phone the controls fold into an Options panel behind one summary line: the sort, Filters
  // and the count (css/jf.css). Opening it from Filters opens the filters too.
  // New collection (for those allowed to manage them) and New playlist, as official.
  const newBtn = tab.create === 'collection' ? (canManageCollections(app.me) ? btn('New collection', () => newCollection(ctx), { small: true, color: 'sky' }) : null)
    : tab.create ? btn('New playlist', () => newPlaylist(ctx, { mediaType: tab.create === 'audio' ? 'Audio' : undefined }), { small: true, color: 'sky' }) : null;
  const opts = h('div.tabs.lib-opts',
      newBtn,
      playBtns,
      tab.sorts.length > 1 ? [h('span.lbl', 'Sort'), sortSel, sort !== 'random' ? orderBtn : null] : null,
      filterBtn,
      h('a.tab', { href: `#/search?in=${view.Id}`, title: `Search ${view.Name}` }, 'Search'),
      viewChips,
      countEl);
  const toggleOpts = withFilters => {
    const open = !node.classList.contains('opts-open');
    node.classList.toggle('opts-open', open);
    if (open && withFilters && panel.hidden) { panel.hidden = false; drawPanel(); }
  };
  const sortLabel = sort === 'random' ? SORTS[sort][0] : `${SORTS[sort]?.[0] || 'Sort'} ${order === 'desc' ? '▼' : '▲'}`;
  const summary = h('div.tabs.lib-sum',
    tab.sorts.length > 1 ? h('button.tab', { type: 'button', onclick: () => toggleOpts(false), attrs: { 'aria-label': 'Sort and options' } }, sortLabel)
      : h('button.tab', { type: 'button', onclick: () => toggleOpts(false) }, 'Options'),
    filterBtn ? h('button.tab', { type: 'button', class: activeCount ? 'on' : '', onclick: () => toggleOpts(true) }, activeCount ? `Filters · ${activeCount}` : 'Filters') : null,
    countEl2);
  const node = deck(tabs.length > 1 ? `${view.Name} · ${tab.label}` : view.Name, { color, code: code(view.Id) },
    tabBar(),
    summary,
    opts,
    panel,
    h('div.lib-body', h('div.lib-main', grid, status, sentinel), alphaBar()));
  // Back from picking a filter chip: the filters are open, so the phone's panel is too.
  if (!panel.hidden) node.classList.add('opts-open');

  function alphaBar() {
    const letters = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    return h('nav.alpha', { attrs: { 'aria-label': 'Jump to letter' } },
      letters.map(l => h('a', {
        class: l === letter ? 'on' : '',
        href: link({ letter: l === letter ? '' : l }), // pressing the active letter clears it
        title: l === '#' ? 'Numbers and symbols' : l,
      }, l)));
  }

  const stop = whenVisible(sentinel, more);
  let scrollTimer = null;
  const onScroll = () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(nearEnd, 100); };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true }); // any scroller (main, the window)
  grid.addEventListener('focusin', onScroll); // a remote moving down the rows
  signal.addEventListener('abort', () => { stop(); clearTimeout(scrollTimer); document.removeEventListener('scroll', onScroll, { capture: true }); });
  more();
  return node;
}
