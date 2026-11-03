// LCARS Jellyfin client: the frame (header elbow, rail, decks, footer), a hash router, the
// server WebSocket (remote control) and the players.
import { h, fill } from './h.js';
import { Api, connectSocket, store, TICKS, CLIENT } from './api.js';
import * as f from './fmt.js';
import { btn, arrow, colorAt, toast, canMarkPlayed, canRate, canRefreshMetadata, loading, errorBox, pickImage, image, setCardHooks, volumeBar } from './ui.js';
import { openItemMenu, addToPlaylist, addToCollection, canManageCollections, COLLECTABLE, refreshDialog, confirmDialog } from './menu.js';
import { selectable, addSelectAction, clearSelection } from './select.js';
import { startSound } from './sound.js';
import { UserSettings } from './settings.js';
import { AudioQueue } from './player/audio.js';
import { playVideo } from './player/video.js';
import { beginRoute, endRoute, stopTheme } from './player/theme.js';
import { home } from './views/home.js';
import { library } from './views/library.js';
import { item } from './views/item.js';
import { search } from './views/search.js';
import { settings } from './views/settings.js';
import { queue as queueView, REPEAT_LABEL } from './views/queue.js';
import { list } from './views/list.js';
import { favourites } from './views/favourites.js';
import { login } from './views/login.js';
import { wizard } from './views/wizard.js';
import { native, nativeVideoPlayer, exposeRouter } from './shell.js';
import { tvSetup } from './tv.js';
import { remote as remoteView } from './views/remote.js';
import { quickConnect } from './views/quickconnect.js';
import { Remote } from './remote.js';

// Assets live in .../static/<version>/ wherever LCARS is served from: /static/ by its own server,
// /web/static/ (under any base URL) when Jellyfin hosts it as its web client.
const ASSETS = new URL('../', import.meta.url).href;
const VERSION = new URL(ASSETS).pathname.split('/').filter(Boolean).pop() || 'dev';

// Where the Jellyfin API is: index.html says (its server fills it in). "/jf" through LCARS's own
// server; "same-origin" when Jellyfin hosts LCARS, the API then being the path before /web/.
function apiBase() {
  if (window.JFL_SERVER) return window.JFL_SERVER; // the desktop app
  const said = document.querySelector('meta[name="lcars-api"]')?.content || '/jf';
  if (said !== 'same-origin') return said;
  const i = location.pathname.indexOf('/web/');
  return i >= 0 ? location.pathname.slice(0, i) : '';
}


const ROUTES = [
  [/^\/home$/, home],
  [/^\/lib\/([0-9a-f]{32})$/i, library, ['id']],
  [/^\/item\/([0-9a-f]{32})$/i, item, ['id']],
  [/^\/search$/, search],
  [/^\/list$/, list],
  [/^\/favourites$/, favourites],
  [/^\/queue$/, queueView],
  [/^\/settings$/, settings],
  [/^\/remote$/, remoteView],
  [/^\/quickconnect$/, quickConnect],
  // The admin dashboard, loaded on first use (js/admin/).
  [/^\/admin(?:\/(.*))?$/, adminRoute, ['sub']],
];

async function adminRoute(ctx) {
  const m = await import('./admin/admin.js');
  app.adminRail = p => m.rail(p, app);
  drawRail(currentPath());
  const page = await m.admin(ctx);
  drawRail(currentPath()); // plugin pages for the rail arrive with the first page
  return page;
}
const isAdminUser = () => !!app.me?.Policy?.IsAdministrator;

const app = {
  version: VERSION,
  assets: ASSETS, // ends in /
  // Jellyfin hosts LCARS as its web client: there's no jellyfin-web beside it.
  hosted: document.querySelector('meta[name="lcars-api"]')?.content === 'same-origin',
  api: new Api(apiBase()),
  us: null,       // UserSettings, loaded after sign-in
  sound: startSound(),
  views: [],
  player: null,   // active video controller
  socket: null,
  link: 'connecting',

  get homePrefs() { return this.us?.display || {}; },
  get me() { return this.us?.me; },
  saveDisplayPref(key, value) { return this.us.setPref(key, value); },

  /** Re-read the libraries after their order or visibility changed. */
  async reloadViews() {
    const r = await this.api.views();
    this.views = r.Items || [];
    drawRail(currentPath());
  },

  viewColor(id) {
    const i = this.views.findIndex(v => v.Id === id);
    return colorAt(i + 1);
  },

  /**
   * The playable items under anything, in play order: an album's or artist's tracks, a
   * playlist, a series' or season's episodes, a collection's or folder's videos.
   * shuffle asks the server for a random pick of big folders.
   */
  async playableItems(it, { shuffle = false } = {}) {
    const api = this.api;
    if (it.Type === 'Audio' || ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'].includes(it.Type)) return [it];
    const tracks = q => api.items({ includeItemTypes: 'Audio', recursive: true, limit: 1000, ...q }).then(r => r.Items);
    if (it.Type === 'MusicAlbum') return tracks({ parentId: it.Id, sortBy: 'ParentIndexNumber,IndexNumber,SortName' });
    if (it.Type === 'MusicArtist') return tracks({ artistIds: it.Id, sortBy: 'PremiereDate,Album,ParentIndexNumber,IndexNumber' });
    if (it.Type === 'MusicGenre') return tracks({ genreIds: it.Id, sortBy: shuffle ? 'Random' : 'AlbumArtist,Album,SortName' });
    if (it.Type === 'Playlist') return (await api.get(`/Playlists/${it.Id}/Items`, { userId: api.userId, fields: Api.FIELDS })).Items || [];
    if (it.Type === 'Series' || it.Type === 'Season') {
      const r = await api.get(`/Shows/${it.Type === 'Series' ? it.Id : it.SeriesId}/Episodes`, {
        userId: api.userId, seasonId: it.Type === 'Season' ? it.Id : undefined, fields: Api.FIELDS });
      return (r.Items || []).filter(e => e.LocationType !== 'Virtual');
    }
    // Genre, studio and tag pages: films, episodes or tracks carrying it.
    if (it.filter) {
      const leaf = { Movie: 'Movie', Series: 'Episode', Video: 'Video', MusicVideo: 'MusicVideo', MusicAlbum: 'Audio', MusicArtist: 'Audio' };
      const types = [...new Set(it.types.map(t => leaf[t]).filter(Boolean))].join(',');
      if (!types) return [];
      return (await api.items({ ...it.filter, includeItemTypes: types, recursive: true, limit: 300, excludeLocationTypes: 'Virtual',
        sortBy: shuffle ? 'Random' : 'SortName' })).Items;
    }
    // Collections, libraries and folders: videos, or failing that, music.
    const q = { parentId: it.Id, recursive: true, isFolder: false, collapseBoxSetItems: false, limit: 300, excludeLocationTypes: 'Virtual',
      sortBy: shuffle ? 'Random' : it.Type === 'BoxSet' ? 'PremiereDate,SortName' : 'SortName' };
    const vids = (await api.items({ ...q, includeItemTypes: 'Movie,Episode,Video,MusicVideo' })).Items;
    return vids.length ? vids : (await api.items({ ...q, includeItemTypes: 'Audio' })).Items;
  },

  /** Play a list: all audio goes to the music queue, otherwise a video queue. */
  playList(items, index = 0, { resume = false } = {}) {
    if (!items.length) { toast('Nothing to play', '', 'salmon'); return; }
    if (items.every(i => i.MediaType === 'Audio' || i.Type === 'Audio')) { this.queue.play(items, index); return; }
    const vids = items.filter(i => i.MediaType !== 'Audio' && i.Type !== 'Audio');
    this.play(vids[index] || vids[0], { list: vids, index: vids[index] ? index : 0, resume });
  },

  async shuffle(it) {
    const list = [...await this.playableItems(it, { shuffle: true })];
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    this.playList(list);
  },

  async instantMix(it) {
    const r = await this.api.get(`/Items/${it.Id}/InstantMix`, { userId: this.api.userId, limit: 200, fields: Api.FIELDS });
    if (!r.Items?.length) { toast('No mix available', it.Name, 'salmon'); return; }
    this.queue.play(r.Items);
    toast('Instant mix', `${r.Items.length} tracks from ${it.Name}`, 'sky');
  },

  /** "Add to queue" and "Play next" for the music queue. */
  async enqueue(it, next = false) {
    const list = (await this.playableItems(it)).filter(i => i.MediaType === 'Audio' || i.Type === 'Audio');
    if (!list.length) return;
    if (next) this.queue.playNext(list); else this.queue.add(list);
    toast(next ? 'Playing next' : 'Added to queue', list.length > 1 ? `${it.Name} · ${list.length} tracks` : it.Name, 'sky', 2200);
  },

  /** Play anything: videos open the player, audio goes to the queue. */
  play(it, opts = {}) {
    if (it.MediaType === 'Audio' || it.Type === 'Audio') {
      // Audiobooks (and anything else with a position) resume where they were.
      const startTicks = opts.startTicks ?? (opts.resume || it.Type === 'AudioBook' ? (it.UserData?.Played ? 0 : it.UserData?.PlaybackPositionTicks || 0) : 0);
      this.queue.play([it], 0, { startTicks });
      return;
    }
    if (it.Type === 'Book') { this.read(it, opts); return; }
    if (this.remote.active) {
      // Play on another device: send it the same list, start point and tracks.
      const list = opts.list?.length ? opts.list : [it];
      this.remote.play(list, {
        index: opts.list?.length ? opts.index || 0 : 0,
        startTicks: opts.startTicks ?? (opts.resume ? it.UserData?.PlaybackPositionTicks || 0 : 0),
        mediaSourceId: opts.mediaSourceId, audioIndex: opts.audioIndex, subIndex: opts.subIndex,
      });
      return;
    }
    this.queue.pause();
    stopTheme();
    this.player?.close();
    this.player = playVideo(this, it, opts);
    drawHeader();
  },

  /** Open a book in the reader (loaded on first use). Music keeps playing. */
  async read(it, opts = {}) {
    const { openReader } = await import('./reader/reader.js');
    stopTheme();
    this.player?.close();
    this.player = openReader(this, it, opts);
    drawHeader();
  },

  /** ctl: the player that closed. One replaced by a newer player is already gone from here. */
  onPlayerClosed(_item, ctl) {
    if (ctl && this.player && this.player !== ctl) return;
    this.player = null;
    drawHeader();
    route({ keepScroll: true }); // refresh resume points and watched marks
  },

  async logout() {
    stopTheme();
    this.remote.disconnect();
    this.socket?.close();
    this.player?.close();
    this.queue.stop();
    await this.api.logout();
    showLogin();
  },

  start() { start(); },
  /** After first-run setup: the sign-in screen, with the new administrator's name filled in. */
  afterSetup(name) { showLogin(name); },

  /**
   * Full-page backdrops (the official "Backdrops" setting): a list of image URLs, or a
   * promise of one, rotated behind the page. Pages that don't call this get none.
   */
  backdrops(urls) { showBackdrops(urls); },
  refreshBackdrops() { route({ keepScroll: true }); },
  /**
   * Play whatever a card's ▶ points at: videos resume, audio goes to the queue, albums,
   * artists and audio playlists queue their tracks, series and seasons play the next
   * unwatched episode.
   */
  async playItem(it) {
    const api = this.api;
    const VIDEO = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'];
    if (VIDEO.includes(it.Type)) { this.play(it, { resume: true }); return; }
    if (it.Type === 'Audio') { this.queue.play([it]); return; }
    if (it.Type === 'Book') { this.read(it); return; }
    if (it.Type === 'MusicAlbum' || it.Type === 'MusicArtist' || it.Type === 'Playlist') { this.playList(await this.playableItems(it), 0, { resume: true }); return; }
    if (it.Type === 'Series' || it.Type === 'Season') {
      const seriesId = it.Type === 'Series' ? it.Id : it.SeriesId;
      let ep = null;
      if (it.Type === 'Series') {
        const r = await api.get('/Shows/NextUp', { userId: api.userId, seriesId, limit: 1, fields: Api.FIELDS, enableResumable: true });
        ep = r.Items[0];
      }
      if (!ep) {
        const r = await api.get(`/Shows/${seriesId}/Episodes`, { userId: api.userId, seasonId: it.Type === 'Season' ? it.Id : undefined, fields: Api.FIELDS });
        const have = r.Items.filter(e => e.LocationType !== 'Virtual');
        ep = have.find(e => !e.UserData?.Played) || have[0];
      }
      if (ep) this.play(ep, { resume: true }); else toast('No episodes', it.Name, 'salmon');
    }
  },

  /** Re-render the current page in place (after watched/favourite/delete changes). */
  refresh() { route({ keepScroll: true }); },
};
app.queue = new AudioQueue(app);
app.remote = new Remote(app);
app.remote.on(() => { drawHeader(); drawRail(currentPath()); });

// Cards: what their ▶ can play, and the ⋯ menu.
const PLAYABLE_CARDS = new Set(['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer', 'Audio', 'AudioBook', 'MusicAlbum', 'MusicArtist', 'Playlist', 'Series', 'Season', 'Book']);
setCardHooks({
  selectable,
  canPlay: it => PLAYABLE_CARDS.has(it.Type) && it.LocationType !== 'Virtual' && !it.IsPlaceHolder,
  play: it => app.playItem(it),
  menu: (it, anchor, onChange) => openItemMenu({ api: app.api, app }, it, anchor, onChange),
});
// Multi-select actions (select.js). Stage 3 adds the rest of the bulk actions.
const LEAF = new Set(['Movie', 'Episode', 'Video', 'MusicVideo', 'Audio', 'Trailer']);
const CONTAINERS = new Set(['MusicAlbum', 'Series', 'Season', 'BoxSet', 'Playlist', 'Folder']);
addSelectAction({
  id: 'play', label: 'Play', color: 'orange',
  when: items => items.every(i => LEAF.has(i.Type) && i.LocationType !== 'Virtual'),
  run: items => app.playList(items, 0),
});
async function setPlayedAll(items, played) {
  await Promise.all(items.map(i => app.api.setPlayed(i.Id, played)));
  toast(played ? 'Marked watched' : 'Marked unwatched', `${items.length} item${items.length > 1 ? 's' : ''}`, 'sky', 2500);
  app.refresh();
}
addSelectAction({ id: 'watched', label: 'Mark watched', color: 'sky', when: items => items.every(canMarkPlayed), run: items => setPlayedAll(items, true) });
addSelectAction({ id: 'unwatched', label: 'Mark unwatched', color: 'sky', when: items => items.every(canMarkPlayed), run: items => setPlayedAll(items, false) });
addSelectAction({
  id: 'next', label: 'Play next', color: 'orange',
  when: items => app.queue.active && items.every(i => i.Type === 'Audio' || i.Type === 'MusicAlbum'),
  run: async items => { const t = (await Promise.all(items.map(i => app.playableItems(i)))).flat(); app.queue.playNext(t); toast('Playing next', `${t.length} tracks`, 'sky', 2200); },
});
addSelectAction({
  id: 'queue', label: 'Add to queue', color: 'orange',
  when: items => app.queue.active && items.every(i => i.Type === 'Audio' || i.Type === 'MusicAlbum'),
  run: async items => { const t = (await Promise.all(items.map(i => app.playableItems(i)))).flat(); app.queue.add(t); toast('Added to queue', `${t.length} tracks`, 'sky', 2200); },
});
async function setFavAll(items, on) {
  await Promise.all(items.map(i => app.api.setFavorite(i.Id, on)));
  toast(on ? 'Added to favourites' : 'Removed from favourites', `${items.length} item${items.length > 1 ? 's' : ''}`, 'sky', 2500);
  app.refresh();
}
addSelectAction({ id: 'fav', label: 'Favourite', color: 'salmon', when: items => items.every(canRate) && items.some(i => !i.UserData?.IsFavorite), run: items => setFavAll(items, true) });
addSelectAction({ id: 'unfav', label: 'Unfavourite', color: 'salmon', when: items => items.every(canRate) && items.some(i => i.UserData?.IsFavorite), run: items => setFavAll(items, false) });
addSelectAction({
  id: 'collection', label: 'Add to collection', color: 'lilac',
  when: items => canManageCollections(app.me) && items.every(i => COLLECTABLE.has(i.Type)),
  run: items => { addToCollection({ api: app.api, app }, items); },
});
addSelectAction({
  id: 'refresh', label: 'Refresh metadata', color: 'blue',
  when: items => items.every(i => canRefreshMetadata(i, app.me)),
  run: items => { refreshDialog({ api: app.api, app }, items); },
});
addSelectAction({
  id: 'delete', label: 'Delete', color: 'red',
  when: items => items.every(i => i.CanDelete),
  run: async items => {
    const names = items.slice(0, 5).map(i => i.Name).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '');
    const ok = await confirmDialog('Delete media', `Delete ${items.length} item${items.length > 1 ? 's' : ''} (${names}) from the server and the disk? This cannot be undone.`, 'Delete');
    if (!ok) return { keep: true };
    let done = 0;
    for (const it of items) {
      try { await app.api.del(`/Items/${it.Id}`); done++; } catch (e) { toast('Not deleted', `${it.Name}: ${e.message}`, 'red'); }
    }
    toast('Deleted', `${done} of ${items.length}`, 'red');
    app.refresh();
    return null;
  },
});
// Admins: make several films (or videos) versions of one item (official multiSelect).
addSelectAction({
  id: 'versions', label: 'Group versions', color: 'lilac',
  when: items => isAdminUser() && items.length > 1 && (items.every(i => i.Type === 'Movie') || items.every(i => i.Type === 'Video')),
  run: async items => {
    const { groupVersions } = await import('./admin/edit.js');
    if (await groupVersions({ api: app.api, app }, items)) app.refresh();
    else return { keep: true };
    return null;
  },
});
addSelectAction({
  id: 'playlist', label: 'Add to playlist', color: 'lilac',
  // Playlists hold one kind of media; albums, series and the like add their contents.
  when: items => items.every(i => LEAF.has(i.Type) || CONTAINERS.has(i.Type)) && new Set(items.map(i => (i.MediaType === 'Audio' || i.Type === 'MusicAlbum' ? 'a' : 'v'))).size === 1,
  run: items => { addToPlaylist({ api: app.api, app }, items); },
});

app.api.onUnauthorized = () => { toast('Session ended', 'Please sign in again', 'red'); showLogin(); };

// ---- frame ----------------------------------------------------------------------------------

const root = document.getElementById('app');
const frameEl = h('div.lcars');
const statusEl = h('div.hdr-status');
const titleEl = h('h1');
const clockEl = h('div.hdr-clock');
// Play on sits at the end of the header bar, under the stardate, as a block between the last
// segment and a rounded cap (like the code block on a deck header).
const playOnEl = h('a.fr.bar-btn', { href: '#/remote' });
const railEl = h('nav.rail-slot', { attrs: { 'aria-label': 'Navigation' } });
const mainEl = h('main.decks', { attrs: { tabindex: -1 } });
const backdropEl = h('div.backdrop', { attrs: { 'aria-hidden': 'true' } });
const footEl = h('div.foot-slot');

frameEl.append(
  h('header.hdr',
    h('div.elbow.fr.e-hdr', h('span.elbow-label', 'LCARS'), h('span.elbow-code', '47-1701')),
    h('div.hdr-slot', h('div.hdr-content', statusEl, h('div.hdr-title', titleEl, clockEl))),
    h('div.bar.hbar', h('span.fr.b1'), h('span.fr.b2'), h('span.fr.b3'), h('span.fr.b4'), h('span.fr.b5'), playOnEl, h('span.fr.bar-cap'))),
  h('div.frame',
    h('div.elbow.fr.e-top', h('span.elbow-code', 'MEDIA')),
    h('div.bar.tbar', h('span.fr.b2'), h('span.fr.b1'), h('span.fr.b4'), h('span.fr.b3')),
    railEl,
    backdropEl,
    mainEl,
    h('div.elbow.fr.e-bot', h('span.elbow-code', '0-0-0')),
    h('div.bar.bbar', h('span.fr.b3'), h('span.fr.b5'), h('span.fr.b1'), h('span.fr.b2')),
    footEl));
fill(root, frameEl);

function tickClock() {
  const now = new Date();
  fill(clockEl, 
    h('span.sd', `Stardate ${f.stardate(now)}`),
    h('span.tm', now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
}
tickClock();
setInterval(tickClock, 1000);

function setTitle(t) {
  titleEl.textContent = t || '';
  document.title = t ? `${t} · LCARS` : 'LCARS';
}

function drawHeader() {
  const s = app.api.session;
  const rem = app.remote.active ? app.remote.target : null;
  const now = app.player?.item() || (rem ? rem.NowPlayingItem : app.queue.current);
  const verb = app.player?.kind === 'book' ? 'Reading' : rem ? `On ${app.remote.name}` : 'Now playing';
  fill(statusEl, 
    h('div.who', s ? s.userName : 'Access control'),
    s ? h('div.line', h('b', s.serverName || 'Jellyfin'), ` · ${CLIENT} ${VERSION}`) : null,
    now ? h('div.line.marq', h('span', `${verb}: `, h('b', [now.SeriesName, now.Name].filter(Boolean).join(' · ')))) : null);
  // Play on (the bar's end segment): the chosen device's name while one is chosen. Signed
  // out, it's a plain segment again.
  const on = app.remote.active;
  playOnEl.classList.toggle('off', !s);
  playOnEl.classList.toggle('casting', on);
  playOnEl.classList.toggle('here', currentPath() === '/remote');
  playOnEl.title = on ? `Playing on ${app.remote.name}` : 'Play on another device';
  if (s) playOnEl.setAttribute('href', '#/remote'); else playOnEl.removeAttribute('href');
  fill(playOnEl, s ? (on ? `On ${app.remote.name}` : 'Play on') : null);
}

const LINK = { live: ['live', 'Link active'], connecting: ['wait', 'Establishing'], offline: ['lost', 'Link lost'] };

function drawRail(path = '') {
  const authed = app.api.authed;
  const pill = (href, n, label, color, active) => h('a.pill', { href, class: `c-${color}${active ? ' active' : ''}`, attrs: active ? { 'aria-current': 'page' } : {} },
    h('span.pill-n', n), h('span.pill-t', label));
  const [lcls, ltxt] = LINK[app.link] || LINK.connecting;
  // In the dashboard: its own sections and the engineering palette.
  const eng = authed && path.startsWith('/admin') && app.adminRail;
  frameEl.classList.toggle('eng', !!eng);
  fill(railEl, h('div.rail',
    eng ? [
      h('button.pill.c-blue.back-btn', {
        type: 'button', onclick: goBack, disabled: !canGoBack(path),
        title: 'Back (Backspace)', attrs: { 'aria-label': 'Back' },
      }, arrow('l'), h('span.pill-t', 'Back')),
      app.adminRail(path).map(p => pill(p.href, p.n, p.label, p.color, p.active)),
      pill('#/home', 'EXT', 'Leave engineering', 'peach', false),
    ] : authed ? [
      h('button.pill.c-blue.back-btn', {
        type: 'button', onclick: goBack, disabled: !canGoBack(path),
        title: 'Back (Backspace)', attrs: { 'aria-label': 'Back' },
      }, arrow('l'), h('span.pill-t', 'Back')),
      pill('#/home', '01', 'Home', 'orange', path === '/home'),
      app.views.map((v, i) => pill(`#/lib/${v.Id}`, String(i + 2).padStart(2, '0'), v.Name, colorAt(i + 1), path.startsWith(`/lib/${v.Id}`))),
      pill('#/favourites', 'FAV', 'Favourites', 'salmon', path === '/favourites'),
      pill('#/search', 'SRC', 'Search', 'peach', path === '/search'),
      app.queue.active ? pill('#/queue', 'AUD', 'Audio queue', 'sky', path === '/queue') : null,
      pill('#/settings', 'CFG', 'Settings', 'red', path === '/settings'),
      isAdminUser() ? pill('#/admin/overview', 'ENG', 'Engineering', 'orange', path.startsWith('/admin')) : null,
    ] : pill('#/', 'ACC', 'Access', 'orange', true),
    h('div.pill.filler.fr'),
    authed ? h('div.pill.link', { class: lcls, attrs: { role: 'status' } }, h('span.pill-n', 'LNK'), h('span.pill-t', ltxt)) : null));
}

// footer: the music mini player, or the system line
let miniPos = null, miniTime = null;
function drawFoot() {
  const q = app.queue;
  if (!q.active) {
    miniPos = miniTime = null;
    fill(footEl, h('div.foot', `${CLIENT} ${VERSION} · Library computer access/retrieval system`));
    return;
  }
  const cur = q.current;
  miniPos = h('div.pos');
  miniTime = h('div.mini-time');
  const scrub = h('div.scrub', { attrs: { role: 'slider', 'aria-label': 'Track position' } }, miniPos);
  scrub.addEventListener('pointerdown', e => {
    const r = scrub.getBoundingClientRect();
    q.seekTo(((e.clientX - r.left) / r.width) * q.duration);
  });
  fill(footEl, h('div.mini',
    h('a', { href: '#/queue', title: 'Audio queue' }, image(app.api, pickImage(cur, 'square'), { shape: 'square' })),
    h('div', h('div.mini-t', cur.Name), h('div.mini-s', [cur.AlbumArtist || (cur.Artists || []).join(', '), cur.Album].filter(Boolean).join(' · '))),
    h('div.mini-p', scrub, miniTime),
    h('div.mini-b',
      btn(arrow('l', 2), () => q.prev(), { small: true, color: 'peach', title: 'Previous' }),
      btn(q.paused ? 'Play' : 'Pause', () => q.toggle(), { small: true, color: 'orange' }),
      btn(arrow('r', 2), () => q.next(), { small: true, color: 'peach', title: 'Next' }),
      btn('Shuffle', () => q.setShuffle(), { small: true, color: 'sky', ghost: !q.shuffle, title: q.shuffle ? 'Shuffle on' : 'Shuffle off' }),
      btn(q.repeat === 'RepeatOne' ? 'Repeat 1' : 'Repeat', () => q.cycleRepeat(), { small: true, color: 'sky', ghost: q.repeat === 'RepeatNone', title: REPEAT_LABEL[q.repeat] }),
      volumeControl(q),
      btn('Stop', () => q.stop(), { small: true, color: 'red', ghost: true }))));
  footEl.querySelector('.mini > a > *')?.classList.add('mini-img');
  drawMiniTime();
}
/** The music queue's volume bar (ui.js volumeBar). */
function volumeControl(q) {
  const bar = volumeBar({
    volume: () => q.el.volume, muted: () => q.el.muted,
    set: v => q.setVolume(v), toggleMute: () => q.toggleMute(),
  });
  volDraw = bar.draw;
  return bar;
}
let volDraw = null;

function drawMiniTime() {
  if (!miniPos) return;
  const q = app.queue;
  const d = q.duration;
  miniPos.style.width = d ? `${Math.min(100, (q.position / d) * 100)}%` : '0';
  fill(miniTime, h('span', f.clock(q.position)), h('span', d ? f.clock(d) : ''));
}
app.queue.on(w => {
  if (w === 'time') { drawMiniTime(); return; }
  if (w === 'volume') { volDraw?.(); return; }
  if (app.queue.active && !app.queue.paused) stopTheme();
  drawFoot();
  drawHeader();
  drawRail(currentPath());
});

// ---- backdrops --------------------------------------------------------------------------------

let bdKey = '';
let bdTimer = null;
let bdClaimed = false;
let bdToken = 0;

function swapBackdrop(url) {
  const img = new Image();
  img.className = 'bd';
  img.decoding = 'async';
  img.alt = '';
  img.onload = () => {
    for (const old of backdropEl.querySelectorAll('.bd')) {
      old.classList.remove('on');
      setTimeout(() => old.remove(), 1600);
    }
    backdropEl.append(img);
    requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('on')));
  };
  img.src = url;
}

async function showBackdrops(urls) {
  bdClaimed = true;
  const token = ++bdToken;
  if (urls && typeof urls.then === 'function') {
    try { urls = await urls; } catch { urls = []; }
    if (token !== bdToken) return; // the page changed meanwhile
  }
  urls = app.us?.backdrops ? (urls || []).filter(Boolean) : [];
  const key = urls.join('|');
  if (key === bdKey) return;
  bdKey = key;
  clearInterval(bdTimer);
  if (!urls.length) {
    for (const old of backdropEl.querySelectorAll('.bd')) { old.classList.remove('on'); setTimeout(() => old.remove(), 1600); }
    return;
  }
  let i = Math.floor(Math.random() * urls.length);
  swapBackdrop(urls[i]);
  if (urls.length > 1) {
    bdTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      i = (i + 1) % urls.length;
      swapBackdrop(urls[i]);
    }, 12000);
  }
}

// ---- history: Back and scroll memory ------------------------------------------------------------
// Each history entry gets a sequence number in history.state. Entry 1 is where this tab
// entered the app, so Back from there (a fresh link or bookmark) goes up a level instead:
// episode -> season -> series -> library -> home. Each entry also remembers its scroll
// position, restored when you come back to it.

const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* blocked */ } },
};
let seq = Number(ss.get('jfl.seq')) || 0;
let parentHref = '#/home';

/** Stamp the current entry; returns its saved scroll if we've been here before. */
function stampEntry() {
  const st = history.state;
  if (st?.jfl) return st.scroll || 0;
  seq += 1;
  ss.set('jfl.seq', String(seq));
  history.replaceState({ jfl: seq, scroll: 0 }, '');
  return 0;
}

const canGoBack = path => (history.state?.jfl > 1) || (path && path !== '/home');

function goBack() {
  if (history.state?.jfl > 1) history.back();
  else location.hash = parentHref;
}

const scrollPos = () => Math.max(mainEl.scrollTop, window.scrollY);
let saveTimer = null;
function rememberScroll() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (history.state?.jfl) history.replaceState({ ...history.state, scroll: scrollPos() }, '');
  }, 150);
}
mainEl.addEventListener('scroll', rememberScroll, { passive: true });
window.addEventListener('scroll', rememberScroll, { passive: true });

/**
 * Scroll back to where you were. Library grids load in pages as you scroll, so keep
 * nudging down while the page grows, until we get there, you scroll yourself, or 6 s pass.
 */
function restoreScroll(target, signal) {
  if (!target) return;
  const until = performance.now() + 6000;
  let stop = false;
  const cancel = () => { stop = true; };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) window.addEventListener(ev, cancel, { once: true, passive: true });
  const step = () => {
    if (stop || signal.aborted) return;
    mainEl.scrollTop = target;
    window.scrollTo(0, target);
    if (scrollPos() >= target - 2 || performance.now() > until) return;
    setTimeout(step, 120);
  };
  step();
}

// Backspace = Back, unless you're typing.
document.addEventListener('keydown', e => {
  if (e.key !== 'Backspace' || e.altKey || e.ctrlKey || e.metaKey || app.player) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (canGoBack(currentPath())) goBack();
});

// ---- router ---------------------------------------------------------------------------------

let navCtrl = null;
/**
 * jellyfin-web's routes (official components/router/appRouter.js), as LCARS's: "#!/" and
 * ".html" from older versions, details, the library pages, lists, search, settings, the
 * dashboard. Returns the LCARS hash, or null when the path is already LCARS's.
 */
function legacyRoute(path, q) {
  let p = path.replace(/^!/, '').replace(/\.html$/, '');
  if (p !== path && ROUTES.some(([re]) => re.test(p))) return `#${p}${q.toString() ? `?${q}` : ''}`;
  const id = v => (v || '').replace(/-/g, '').toLowerCase();
  const isView = v => (app.views || []).some(x => x.Id === v);
  const page = p.replace(/^\//, '');
  switch (page) {
    case 'details': {
      const i = id(q.get('id'));
      if (!/^[0-9a-f]{32}$/.test(i)) return '#/home';
      return isView(i) ? `#/lib/${i}` : `#/item/${i}`;
    }
    case 'tv': case 'movies': case 'music': case 'books': case 'homevideos': case 'musicvideos': case 'boxsets': case 'playlists': case 'livetv': {
      const i = id(q.get('topParentId') || q.get('parentId'));
      return /^[0-9a-f]{32}$/.test(i) ? `#/lib/${i}` : '#/home';
    }
    case 'list': {
      if (q.get('genre') || q.get('studio') || q.get('tag')) return null; // already ours
      const out = new URLSearchParams();
      if (q.get('genreId') || q.get('musicGenreId')) out.set('genre', q.get('genreId') || q.get('musicGenreId'));
      else if (q.get('studioId')) out.set('studio', q.get('studioId'));
      else if (q.get('type') === 'tag' && q.get('tag')) out.set('tag', q.get('tag'));
      else if (q.get('parentId')) { const i = id(q.get('parentId')); return isView(i) ? `#/lib/${i}` : `#/item/${i}`; }
      else return '#/home';
      if (q.get('musicGenreId')) out.set('type', 'MusicAlbum');
      return `#/list?${out}`;
    }
    case 'search':
      return q.get('query') && !q.get('q') ? `#/search?q=${encodeURIComponent(q.get('query'))}` : null;
    case 'mypreferencesmenu': case 'mypreferencesdisplay': case 'mypreferenceshome': case 'mypreferencesplayback':
    case 'mypreferencessubtitles': case 'mypreferencescontrols': case 'mypreferencesquickconnect': case 'userprofile':
      return '#/settings';
    case 'video': case 'nowplaying': return '#/queue';
    case 'login': case 'selectserver': case 'addserver': case 'wizard': case 'wizardstart': case 'startup': case 'forgotpassword': case 'forgotpasswordpin':
      return '#/home';
    case 'configurationpage': {
      const n = q.get('name');
      return n ? `#/admin/plugins/settings/${encodeURIComponent(n)}` : '#/admin/plugins';
    }
    default:
      if (page === 'dashboard' || page.startsWith('dashboard/')) return '#/admin';
      return null;
  }
}

const currentPath = () => (location.hash.slice(1) || '/home').split('?')[0];

async function route({ keepScroll = false } = {}) {
  if (!app.api.authed) { showLogin(); return; }
  const raw = location.hash.slice(1) || '/home';
  const [path, qs = ''] = raw.split('?');
  adoptShell(); // the LG app's shell may have arrived since the last page
  // Links in jellyfin-web's form (bookmarks, shared links, other apps' "open in Jellyfin").
  const old = legacyRoute(path, new URLSearchParams(qs));
  if (old) { location.replace(old); return; }
  let match = null;
  for (const [re, view, names = []] of ROUTES) {
    const m = path.match(re);
    if (m) { match = { view, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) }; break; }
  }
  if (!match) { location.replace('#/home'); return; }

  navCtrl?.abort();
  navCtrl = new AbortController();
  lastHash = location.hash;
  if (!keepScroll) { app.leaveGuard?.clear(); app.leaveGuard = null; }
  if (!keepScroll) clearSelection(); // a selection belongs to the page it was made on
  const signal = navCtrl.signal;
  const saved = stampEntry();
  parentHref = '#/home';
  drawRail(path);
  drawHeader();
  const scroll = keepScroll ? mainEl.scrollTop : 0;
  if (!keepScroll) fill(mainEl, loading());
  const setParent = href => { parentHref = href || '#/home'; drawRail(path); };
  const ctx = { api: app.api, app, params: match.params, query: new URLSearchParams(qs), signal, setTitle, setParent };
  beginRoute();
  bdClaimed = false;
  try {
    const node = await match.view(ctx);
    if (signal.aborted) return;
    endRoute();
    if (!bdClaimed) showBackdrops([]);
    fill(mainEl, node);
    mainEl.scrollTop = scroll;
    if (!keepScroll) window.scrollTo(0, 0);
    if (!keepScroll) restoreScroll(saved, signal);
  } catch (e) {
    if (signal.aborted || e.name === 'AbortError') return;
    console.error(e);
    app.sound.play('deny');
    fill(mainEl, errorBox(e));
  }
}
// A dashboard page with unsaved changes asks before you leave it (admin/form.js sets the guard).
let lastHash = location.hash;
let skipHash = false;
window.addEventListener('hashchange', async () => {
  if (skipHash) { skipHash = false; return; }
  const g = app.leaveGuard;
  if (g?.dirty()) {
    const target = location.hash;
    skipHash = true;
    location.replace(lastHash || '#/home'); // stay put while asking
    if (!(await g.confirmLeave())) return;
    g.clear();
    location.hash = target;
    return;
  }
  route();
});

// ---- remote control (server WebSocket) -------------------------------------------------------
// Commands other Jellyfin apps (and the server dashboard) send to this one, as the official
// client handles them (scripts/serverNotifications.js). Video player first, then music.

const SUPPORTED_COMMANDS = ['DisplayMessage', 'Play', 'Playstate', 'PlayNext', 'PlayMediaSource', 'PlayTrailers',
  'SetRepeatMode', 'SetShuffleQueue', 'SetVolume', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute',
  'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen', 'DisplayContent', 'GoHome', 'GoToSettings',
  'GoToSearch', 'Back'];

/** Volume, mute, repeat and shuffle for whichever player is up. True when handled. */
function playerCommand(name, a) {
  const p = app.player?.kind === 'video' ? app.player : null;
  const q = app.queue;
  if (p) {
    switch (name) {
      case 'SetVolume': p.setVolume((Number(a.Volume) || 0) / 100); return true;
      case 'VolumeUp': p.setVolume(p.volume + 0.05); return true;
      case 'VolumeDown': p.setVolume(p.volume - 0.05); return true;
      case 'Mute': p.setMuted(true); return true;
      case 'Unmute': p.setMuted(false); return true;
      case 'ToggleMute': p.toggleMute(); return true;
      case 'SetAudioStreamIndex': p.setAudio(Number(a.Index)); return true;
      case 'SetSubtitleStreamIndex': p.setSubs(Number(a.Index)); return true;
      case 'ToggleFullscreen': p.fullscreen(); return true;
      default: return false;
    }
  }
  if (!q.active) return false;
  switch (name) {
    case 'SetRepeatMode': q.cycleRepeat(a.RepeatMode); return true;
    case 'SetShuffleQueue': q.setShuffle(a.ShuffleMode === 'Shuffle'); return true;
    case 'SetVolume': q.setVolume((Number(a.Volume) || 0) / 100); return true;
    case 'VolumeUp': q.setVolume(q.el.volume + 0.05); return true;
    case 'VolumeDown': q.setVolume(q.el.volume - 0.05); return true;
    case 'Mute': q.el.muted = true; return true;
    case 'Unmute': q.el.muted = false; return true;
    case 'ToggleMute': q.toggleMute(); return true;
    default: return false;
  }
}

/** Commands that move around the app rather than control playback. */
async function generalCommand(name, a) {
  const go = hash => { if (location.hash !== hash) location.hash = hash; };
  switch (name) {
    case 'DisplayMessage':
      toast(a.Header || 'Message', a.Text || '', 'blue', Number(a.TimeoutMs) || 8000);
      return;
    // Not while a video or book is open, as official: you're watching.
    case 'DisplayContent': if (a.ItemId && !app.player) go(`#/item/${a.ItemId}`); return;
    case 'GoHome': app.player?.close(); go('#/home'); return;
    case 'GoToSettings': app.player?.close(); go('#/settings'); return;
    case 'GoToSearch': app.player?.close(); go('#/search'); return;
    case 'Back': if (app.player) app.player.close(); else if (canGoBack(currentPath())) goBack(); return;
    case 'ToggleFullscreen':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    case 'PlayTrailers': {
      if (!a.ItemId) return;
      const r = await app.api.get(`/Items/${a.ItemId}/LocalTrailers`, { userId: app.api.userId });
      if (r?.length) app.playList(r);
      else toast('No trailer', 'This title has no local trailer', 'salmon');
      return;
    }
    default:
  }
}

// ---- socket subscriptions ---------------------------------------------------------------------
// The server pushes some data while asked to: <Type>Start with "initial delay,interval" in ms, and
// <Type>Stop. Sessions (Play on, the admin overview), ScheduledTasksInfo, ActivityLogEntry. Several
// parts of the app can want the same one; the server is asked once, and again after a reconnect.
const subs = new Map(); // type -> {fns: Set, interval}
app.subscribe = (type, fn, interval = '0,1500') => {
  let s = subs.get(type);
  if (!s) {
    s = { fns: new Set(), interval };
    subs.set(type, s);
    app.socket?.send(`${type}Start`, interval);
  }
  s.fns.add(fn);
  return () => {
    s.fns.delete(fn);
    if (!s.fns.size && subs.get(type) === s) { subs.delete(type); app.socket?.send(`${type}Stop`); }
  };
};
function resubscribe() { for (const [type, s] of subs) app.socket?.send(`${type}Start`, s.interval); }
// Messages the server pushes without being asked (RefreshProgress to admins, for one).
const listeners = new Map(); // type -> Set of fns
app.listen = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
};

async function onSocket(m) {
  const sub = subs.get(m.MessageType);
  if (sub) { for (const fn of [...sub.fns]) fn(m.Data); return; }
  const ls = listeners.get(m.MessageType);
  if (ls?.size) { for (const fn of [...ls]) fn(m.Data); return; }
  const d = m.Data || {};
  const p = app.player;
  const q = app.queue;
  switch (m.MessageType) {
    case 'Playstate': {
      const c = d.Command;
      const t = p || (q.active ? { toggle: () => q.toggle(), pause: () => q.pause(), play: () => q.resume(), close: () => q.stop(), seekTo: s => q.seekTo(s), seekBy: s => q.seekTo(q.position + s), next: () => q.next(), prev: () => q.prev() } : null);
      if (!t) return;
      if (c === 'PlayPause') t.toggle();
      else if (c === 'Pause') t.pause();
      else if (c === 'Unpause') t.play();
      else if (c === 'Stop') t.close();
      else if (c === 'NextTrack') t.next?.();
      else if (c === 'PreviousTrack') t.prev?.();
      else if (c === 'Seek') t.seekTo((d.SeekPositionTicks || 0) / TICKS);
      else if (c === 'Rewind') t.seekBy?.(-10);
      else if (c === 'FastForward') t.seekBy?.(30);
      return;
    }
    case 'Play': {
      const ids = d.ItemIds || [];
      if (!ids.length) return;
      // Someone sent this device something to play, so it plays here.
      if (app.remote.active) app.remote.disconnect();
      if (d.PlayCommand === 'PlayInstantMix') { await app.instantMix({ Id: ids[0], Name: 'remote request' }); return; }
      const r = await app.api.items({ ids: ids.join(','), fields: Api.FIELDS });
      let items = ids.map(id => r.Items.find(i => i.Id === id)).filter(Boolean);
      if (!items.length) return;
      // Containers (an album, a series) expand to what's in them.
      if (items.length === 1 && !items[0].MediaType) items = await app.playableItems(items[0], { shuffle: d.PlayCommand === 'PlayShuffle' });
      if (d.PlayCommand === 'PlayShuffle') {
        for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      }
      if (!items.length) return;
      if (items.every(i => i.MediaType === 'Audio')) {
        if (d.PlayCommand === 'PlayNext') q.playNext(items);
        else if (d.PlayCommand === 'PlayLast') q.add(items);
        else q.play(items, d.PlayCommand === 'PlayShuffle' ? 0 : d.StartIndex || 0);
      } else {
        const i = d.PlayCommand === 'PlayShuffle' ? 0 : Math.min(d.StartIndex || 0, items.length - 1);
        app.play(items[i], {
          startTicks: d.StartPositionTicks || 0, list: items.length > 1 ? items : null, index: i,
          mediaSourceId: d.MediaSourceId, audioIndex: d.AudioStreamIndex, subIndex: d.SubtitleStreamIndex,
        });
      }
      return;
    }
    case 'GeneralCommand': {
      const a = d.Arguments || {};
      if (playerCommand(d.Name, a)) return;
      await generalCommand(d.Name, a);
      return;
    }
    default:
  }
}

function connect() {
  app.socket?.close();
  app.socket = connectSocket(app.api, m => onSocket(m).catch(e => console.warn('remote command failed', e)), st => {
    app.link = st;
    drawRail(currentPath());
    if (st === 'live') {
      resubscribe();
      app.api.post('/Sessions/Capabilities/Full', {
        PlayableMediaTypes: ['Audio', 'Video'],
        SupportedCommands: SUPPORTED_COMMANDS,
        SupportsMediaControl: true,
      }).catch(() => {});
    }
  });
}

// ---- start ----------------------------------------------------------------------------------

function showLogin(username = '') {
  navCtrl?.abort();
  app.socket?.close();
  app.views = [];
  drawHeader();
  drawRail();
  drawFoot();
  fill(mainEl, loading('Establishing link'));
  // A server that hasn't been set up has no one to sign in as: run its first-run setup.
  app.api.publicInfo().then(info => {
    const ctx = { api: app.api, app, setTitle };
    fill(mainEl, info?.StartupWizardCompleted === false ? wizard(ctx) : login({ ...ctx, username }));
  }).catch(() => fill(mainEl, login({ api: app.api, app, setTitle, username })));
}

/**
 * Inside Jellyfin's iPhone or LG TV app: its name for the device in the server's device list,
 * its player plugins (the iPhone's native player), and the router hooks its Home tab uses. The
 * LG app adds its shell after the page starts, so this runs again at each sign-in and start.
 */
function adoptShell() {
  if (!native.present) return;
  const name = native.deviceName();
  if (name) app.api.device = name;
  nativeVideoPlayer({ onStop: () => app.player?.close?.() }).catch(() => {});
}
app.adoptShell = adoptShell;
exposeRouter({
  canGoBack: () => !app.player && canGoBack(currentPath()),
  back: () => { if (app.player) app.player.close(); else goBack(); },
  goHome: () => { app.player?.close?.(); location.hash = '#/home'; },
});
/** A remote's media keys: the video player or reader takes them as its own keys, else music. */
app.mediaKey = what => {
  const p = app.player;
  if (p?.kind === 'video') {
    ({ play: p.play, pause: p.pause, playpause: p.toggle, stop: p.close, next: p.next, previous: p.prev,
      rewind: () => p.seekBy(-(app.us?.skipBack || 10)), fastforward: () => p.seekBy(app.us?.skipForward || 30) }[what])?.();
    return;
  }
  if (p) return; // the reader: its own keys
  const q = app.queue;
  if (!q?.current) return;
  if (what === 'play') q.el.play().catch(() => {});
  else if (what === 'pause') q.pause();
  else if (what === 'playpause') q.toggle();
  else if (what === 'stop') q.stop();
  else if (what === 'next' || what === 'fastforward') q.next();
  else if (what === 'previous' || what === 'rewind') q.prev();
};
tvSetup(app, { canGoBack: () => canGoBack(currentPath()), goBack });
// Inside the iPhone app, links that open a new tab do nothing; its own browser opens them.
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href][target=_blank]');
  if (!a || !native.present || native.supports('targetblank')) return;
  if (native.openUrl(a.href)) e.preventDefault();
}, true);

async function start() {
  adoptShell();
  if (!app.api.authed) { showLogin(); return; }
  drawHeader();
  drawFoot();
  fill(mainEl, loading('Establishing link'));
  try {
    // Library order comes from the user's settings (UserViews is already sorted by them);
    // home sections from the display preferences the official clients share.
    app.us = new UserSettings(app.api);
    const [r] = await Promise.all([app.api.views(), app.us.load()]);
    app.views = r.Items || [];
  } catch (e) {
    if (!app.api.authed) return; // 401: the login screen is already up
    fill(mainEl, errorBox(e, 'Library computer unreachable'), h('div.actions', btn('Retry', start)));
    return;
  }
  connect();
  app.remote.restore();
  route();
}

start();
