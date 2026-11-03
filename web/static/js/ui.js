// LCARS building blocks shared by every view.
import { h } from './h.js';
import { TICKS } from './api.js';
import * as f from './fmt.js';

export const COLORS = ['orange', 'sky', 'lilac', 'peach', 'blue', 'salmon'];
export const colorAt = i => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];

/** A small 4-digit code from a string, for the decorative LCARS numbers. */
export function code(s) {
  let n = 0;
  for (const c of String(s)) n = (n * 31 + c.charCodeAt(0)) % 9973;
  return String(n).padStart(4, '0');
}

/** deck(title, {color, num, code, actions}, ...body) */
export function deck(title, opts = {}, ...body) {
  const { color = 'orange', num, actions = [], cls = '' } = opts;
  return h('section.deck', { class: `c-${color} ${cls}` },
    h('header.deck-head',
      h('span.cap.l'),
      num != null ? h('span.num', String(num).padStart(2, '0')) : null,
      h('h2', title),
      h('span.fill'),
      ...actions,
      h('span.code', opts.code ?? code(title)),
      h('span.cap.r')),
    h('div.deck-body', body));
}

export const deckAction = (label, onclick, title) => h('button.act', { type: 'button', onclick, title }, label);

export const ro = (label, value, cls) => h('div.ro', { class: cls }, h('span.ro-l', label), h('span.ro-v', value));
export const tag = (text, cls) => h('span.tag', { class: cls }, text);
export const empty = text => h('p.empty', text);
export const loading = (text = 'Accessing library computer') => h('p.loading', `${text}…`);

export function errorBox(e, what = 'Unable to comply') {
  if (e?.name === 'AbortError') return h('div');
  return h('p.err', what, h('small', e?.message || String(e)));
}

/**
 * Arrow drawn in CSS: Antonio's ◂ ▸ ‹ › glyphs sit low in buttons. dir 'l' | 'r', n triangles.
 */
export function arrow(dir, n = 1) {
  return h('span.arw', { class: ['l', 'u', 'd'].includes(dir) ? dir : 'r', attrs: { 'aria-hidden': 'true' } }, Array.from({ length: n }, () => h('i')));
}

export function btn(label, onclick, { color, small, ghost, title, disabled, type = 'button', ico } = {}) {
  return h('button.btn', {
    type, onclick, title, disabled,
    class: [color && `c-${color}`, small && 'small', ghost && 'ghost', ico && 'ico'].filter(Boolean).join(' '),
    attrs: ico && title ? { 'aria-label': title } : undefined,
  }, label);
}

/** Segmented LCARS meter for a 0..1 fraction (from dash). */
export function seg(frac, { n = 20, tone = 'sky' } = {}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const lit = Math.round(v * n);
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(h(i < lit ? 'i.on' : 'i'));
  return h('div.seg', { class: tone }, kids);
}

/**
 * A segmented LCARS volume bar: click or drag to set, wheel or arrow keys to nudge, M to mute.
 * v: {volume() 0..1, muted(), set(v), toggleMute()}. Call bar.draw() when the volume changes.
 */
export function volumeBar(v) {
  const pos = h('div.pos');
  const bar = h('div.scrub.vol', { attrs: { role: 'slider', 'aria-label': 'Volume', 'aria-valuemin': 0, 'aria-valuemax': 100, tabindex: 0 } }, pos);
  const draw = () => {
    const x = v.muted() ? 0 : v.volume();
    pos.style.width = `${x * 100}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(x * 100)));
    bar.title = v.muted() ? 'Muted' : `Volume ${Math.round(x * 100)}%`;
    bar.classList.toggle('muted', v.muted());
  };
  const set = e => { const r = bar.getBoundingClientRect(); v.set(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); };
  bar.addEventListener('pointerdown', e => { e.stopPropagation(); bar.setPointerCapture(e.pointerId); set(e); });
  bar.addEventListener('pointermove', e => { if (bar.hasPointerCapture(e.pointerId)) set(e); });
  bar.addEventListener('wheel', e => { e.preventDefault(); v.set(Math.max(0, Math.min(1, v.volume() + (e.deltaY < 0 ? 0.05 : -0.05)))); }, { passive: false });
  bar.addEventListener('keydown', e => {
    const step = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 }[e.key];
    if (step) v.set(Math.max(0, Math.min(1, v.volume() + step)));
    else if (e.key === 'm' || e.key === 'M') v.toggleMute();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  bar.draw = draw;
  draw();
  return bar;
}

// ---- items ----------------------------------------------------------------------------------

// ---- what a user may do with an item (jellyfin-web components/itemHelper.js) -----------------

/**
 * An episode the server knows about but has no file for (official indicators.js): 'unaired'
 * if its air date is still ahead, otherwise 'missing'. Null for anything else.
 */
export function missingState(item) {
  if (item?.Type !== 'Episode' || item.LocationType !== 'Virtual') return null;
  const d = item.PremiereDate ? Date.parse(item.PremiereDate) : NaN;
  return d > Date.now() ? 'unaired' : 'missing';
}
const MISSING_LABEL = { missing: 'Missing', unaired: 'Unaired' };
/** The Missing / Unaired tag for rows and title pages. */
export function missingTag(item) {
  const m = missingState(item);
  return m ? tag(MISSING_LABEL[m], m === 'unaired' ? 'blue' : 'alert') : null;
}

export function canMarkPlayed(item) {
  if (item.Type === 'Program') return false;
  if (item.MediaType === 'Video') { if (item.Type !== 'TvChannel') return true; }
  else if (item.MediaType === 'Audio' && item.Type === 'AudioBook') return true;
  return ['Series', 'Season', 'BoxSet', 'Folder'].includes(item.Type) || item.MediaType === 'Book';
}

export function canRate(item) {
  return !['Program', 'Timer', 'SeriesTimer', 'CollectionFolder', 'UserView', 'Channel'].includes(item.Type) && !!item.UserData;
}

export function canRefreshMetadata(item, user) {
  return !!user?.Policy?.IsAdministrator && item.CollectionType !== 'livetv'
    && !['Timer', 'SeriesTimer', 'Program', 'TvChannel'].includes(item.Type)
    && !(item.Type === 'Recording' && item.Status !== 'Completed');
}

/** May the user change their own password and Jellyfin configuration? (server RequestHelpers.AssertCanUpdateUser) */
export const canEditPreferences = user => !!(user?.Policy?.IsAdministrator || user?.Policy?.EnableUserPreferenceAccess);

export function itemHref(item) {
  if (!item) return '#/home';
  if (item.Type === 'CollectionFolder' || item.Type === 'UserView') return `#/lib/${item.Id}`;
  return `#/item/${item.Id}`;
}

export const runtime = item => (item?.RunTimeTicks ? f.dur(item.RunTimeTicks / TICKS) : '');

export function epCode(item) {
  if (item.Type !== 'Episode') return '';
  const s = item.ParentIndexNumber, e = item.IndexNumber;
  if (s == null && e == null) return '';
  // S01E01, as Sonarr names files; three or four digits only where the number needs them.
  const n = v => (v == null ? '??' : String(v).padStart(2, '0'));
  return `S${n(s)}E${n(e)}${item.IndexNumberEnd ? `-E${n(item.IndexNumberEnd)}` : ''}`;
}

export function years(item) {
  if (item.Type === 'Series' && item.ProductionYear) {
    const end = item.Status === 'Continuing' ? 'Present' : item.EndDate ? new Date(item.EndDate).getFullYear() : '';
    return end && end !== item.ProductionYear ? `${item.ProductionYear}–${end}` : String(item.ProductionYear);
  }
  return item.ProductionYear ? String(item.ProductionYear) : '';
}

/** Image {id, type, tag} for a card shape, falling back to parents. */
export function pickImage(item, shape, { episodeImages = true } = {}) {
  const t = item.ImageTags || {};
  if (shape === 'wide') {
    if (t.Thumb) return { id: item.Id, type: 'Thumb', tag: t.Thumb };
    // With "use episode images" off, episodes show their series' landscape art instead
    // (what the official clients do in Next Up / Continue Watching).
    if (item.Type === 'Episode' && !episodeImages) {
      if (item.ParentThumbItemId && item.ParentThumbImageTag) return { id: item.ParentThumbItemId, type: 'Thumb', tag: item.ParentThumbImageTag };
      if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
        return { id: item.ParentBackdropItemId, type: 'Backdrop', tag: item.ParentBackdropImageTags[0], index: 0 };
      }
    }
    if (item.Type === 'Episode' && t.Primary) return { id: item.Id, type: 'Primary', tag: t.Primary };
    if (item.BackdropImageTags?.length) return { id: item.Id, type: 'Backdrop', tag: item.BackdropImageTags[0], index: 0 };
    if (item.ParentThumbItemId) return { id: item.ParentThumbItemId, type: 'Thumb', tag: item.ParentThumbImageTag };
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
      return { id: item.ParentBackdropItemId, type: 'Backdrop', tag: item.ParentBackdropImageTags[0], index: 0 };
    }
    if (t.Primary) return { id: item.Id, type: 'Primary', tag: t.Primary };
    return null;
  }
  if (item.Type === 'Episode' && item.SeriesPrimaryImageTag) return { id: item.SeriesId, type: 'Primary', tag: item.SeriesPrimaryImageTag };
  if (t.Primary) return { id: item.Id, type: 'Primary', tag: t.Primary };
  if (item.AlbumId && item.AlbumPrimaryImageTag) return { id: item.AlbumId, type: 'Primary', tag: item.AlbumPrimaryImageTag };
  if (item.Type === 'Season' && item.SeriesId) return { id: item.SeriesId, type: 'Primary', tag: item.SeriesPrimaryImageTag };
  if (item.ParentPrimaryImageItemId) return { id: item.ParentPrimaryImageItemId, type: 'Primary', tag: item.ParentPrimaryImageTag };
  return null;
}

export function shapeFor(item) {
  if (['MusicAlbum', 'MusicArtist', 'Audio', 'Playlist', 'Photo'].includes(item.Type)) return 'square';
  if (item.Type === 'CollectionFolder' || item.Type === 'UserView') return 'wide';
  return 'poster';
}

export function image(api, im, { shape = 'poster', alt = '', label = '' } = {}) {
  if (!im) return h('div.noimg', label);
  const size = shape === 'wide' ? { w: 560 } : shape === 'square' ? { h: 320 } : { h: 420 };
  return h('img', { src: api.img(im.id, im.type, { tag: im.tag, index: im.index, ...size }), alt, attrs: { loading: 'lazy', decoding: 'async' } });
}

function cardText(item, shape) {
  if (item.Type === 'Episode') {
    return shape === 'wide'
      ? [item.SeriesName || item.Name, [epCode(item), item.SeriesName ? item.Name : ''].filter(Boolean).join(' · ')]
      : [item.SeriesName || item.Name, epCode(item) || item.Name];
  }
  if (item.Type === 'MusicAlbum') return [item.Name, item.AlbumArtist || years(item)];
  if (item.Type === 'Audio') return [item.Name, item.AlbumArtist || item.Album || ''];
  if (item.Type === 'Season') return [item.Name, item.ChildCount ? `${item.ChildCount} episodes` : item.SeriesName || ''];
  if (item.Type === 'BoxSet') return [item.Name, item.ChildCount ? `${item.ChildCount} titles` : years(item)];
  if (item.Type === 'Folder') return [item.Name, item.ChildCount ? `${item.ChildCount} items` : ''];
  return [item.Name, years(item)];
}

/**
 * A poster/wide/square card. With onPlay, the picture plays the item and the caption opens
 * its details; otherwise the whole card opens details.
 */
const COUNTED = new Set(['Playlist', 'PhotoAlbum']);

// The app registers how cards play items and open the ⋯ menu (see app.js).
let cardHooks = null;
export function setCardHooks(hooks) { cardHooks = hooks; }

/**
 * A poster/wide/square card. The picture opens the item (or plays it, with onPlay). Episodes
 * link the series name to the series. On hover (always, on touch screens) the official
 * overlay: play, watched, favourite and ⋯, each only where it applies.
 */
export function card(api, item, opts = {}) {
  const { shape = shapeFor(item), onPlay, color, episodeImages, missing = true, details = false } = opts;
  const [t, s] = cardText(item, shape);
  const ud = item.UserData || {};
  // As the official indicators.js: anything that can be watched shows how many items are
  // left (series, seasons, collections, folders), or ✓ when done. Things that can't
  // (playlists, photo albums) show how many items they hold.
  const miss = missing && missingState(item);
  const badge = miss ? h('span.badge', { class: miss }, MISSING_LABEL[miss])
    : canMarkPlayed(item)
    ? (ud.UnplayedItemCount ? h('span.badge', String(ud.UnplayedItemCount))
      : ud.Played || ud.PlayedPercentage >= 100 ? h('span.badge.done', '✓') : null)
    : COUNTED.has(item.Type) && item.ChildCount ? h('span.badge.count', String(item.ChildCount)) : null;
  const pctPlayed = !ud.Played && ud.PlayedPercentage > 0 ? ud.PlayedPercentage : 0;
  const pic = h('div.card-img', { class: `${shape}-r` },
    image(api, pickImage(item, shape, { episodeImages }), { shape, alt: '', label: item.Name }),
    badge,
    // More than one version (official mediaSourceIndicator): e.g. 4K and 1080p of the same film.
    item.MediaSourceCount > 1 ? h('span.vers', { title: `${item.MediaSourceCount} versions` }, `${item.MediaSourceCount} versions`) : null,
    pctPlayed ? h('div.prog', h('i', { style: { width: `${pctPlayed.toFixed(1)}%` } })) : null);
  const style = color ? { '--sc': `var(--${color})` } : undefined;
  const picLink = onPlay
    ? h('a.card-link', { href: itemHref(item), title: `Play ${item.Name}`, onclick: e => { e.preventDefault(); onPlay(item); } }, pic)
    : h('a.card-link', { href: itemHref(item), title: item.Name }, pic);
  // Episodes: the series name opens the series, the episode line opens the episode.
  const seriesLink = item.Type === 'Episode' && item.SeriesId && item.SeriesName;
  const captions = seriesLink
    ? [h('a.card-t', { href: `#/item/${item.SeriesId}`, title: item.SeriesName }, t), s ? h('a.card-s', { href: itemHref(item), title: item.Name }, s) : null]
    : h('a.card-cap', { href: itemHref(item), title: item.Name }, h('span.card-t', t), s ? h('span.card-s', s) : null);
  let el = null;
  const picBox = h('div.card-pic', picLink, cardOverlay(api, item, opts, () => el));
  el = h('div.card', { key: item.Id, style }, picBox, captions, details ? cardDetails(item) : null);
  // Multi-select (select.js, wired through the card hooks): libraries themselves aren't selectable.
  if (cardHooks?.selectable && item.Type !== 'CollectionFolder' && item.Type !== 'UserView') picBox.append(cardHooks.selectable(el, item));
  return el;
}

/** The extra line for list views: runtime, ratings, genres and the start of the overview. */
function cardDetails(item) {
  const meta = [
    item.RunTimeTicks && item.Type !== 'Series' && item.Type !== 'MusicArtist' ? runtimeText(item) : null,
    item.OfficialRating || null,
    item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : null,
    (item.Genres || []).slice(0, 3).join(', ') || null,
  ].filter(Boolean);
  return h('div.card-d',
    meta.length ? h('div.card-m', meta.map(m => h('span', m))) : null,
    item.Overview ? h('p.card-o', item.Overview) : null);
}
function runtimeText(item) {
  const m = Math.round(item.RunTimeTicks / TICKS / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function cardOverlay(api, item, opts, self) {
  if (!cardHooks || item.Type === 'CollectionFolder' || item.Type === 'UserView') return null;
  const ud = item.UserData || (item.UserData = {});
  const redraw = ({ deleted } = {}) => {
    const el = self();
    if (!el?.isConnected) return;
    if (deleted) el.remove(); else el.replaceWith(card(api, item, opts));
  };
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  const act = fn => async e => {
    stop(e);
    try { await fn(e); } catch (err) { toast('Unable to comply', err.message, 'red'); }
  };
  const play = cardHooks.canPlay(item)
    ? h('button.ov-play', { type: 'button', title: 'Play', attrs: { 'aria-label': `Play ${item.Name}` }, onclick: act(() => cardHooks.play(item)) }, '▶')
    : null;
  const watched = canMarkPlayed(item)
    ? h('button.ov-btn', {
      type: 'button', class: ud.Played ? 'on' : '', title: ud.Played ? 'Mark unwatched' : 'Mark watched',
      attrs: { 'aria-pressed': String(!!ud.Played) },
      onclick: act(async () => { Object.assign(ud, await api.setPlayed(item.Id, !ud.Played) || { Played: !ud.Played }); redraw(); }),
    }, '✓')
    : null;
  const fav = canRate(item)
    ? h('button.ov-btn.fav', {
      type: 'button', class: ud.IsFavorite ? 'on' : '', title: ud.IsFavorite ? 'Remove favourite' : 'Add to favourites',
      attrs: { 'aria-pressed': String(!!ud.IsFavorite) },
      onclick: act(async () => { Object.assign(ud, await api.setFavorite(item.Id, !ud.IsFavorite) || { IsFavorite: !ud.IsFavorite }); redraw(); }),
    }, ud.IsFavorite ? '♥' : '♡')
    : null;
  const more = h('button.ov-btn.ov-more', {
    type: 'button', title: 'More options', attrs: { 'aria-haspopup': 'menu' },
    onclick: e => { stop(e); cardHooks.menu(item, e.currentTarget, (it, info) => redraw(info)); },
  }, '⋯');
  return h('div.card-ov', play, h('div.card-ov-br', watched, fav, more));
}

// ---- toasts ---------------------------------------------------------------------------------

let toastBox = null;
export function toast(title, text = '', color = 'orange', ms = 5000) {
  if (!toastBox) { toastBox = h('div.toasts', { attrs: { role: 'status', 'aria-live': 'polite' } }); document.body.append(toastBox); }
  const el = h('div.toast', { class: `c-${color}` }, h('b', title), text);
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Calls fn(el) when el scrolls near view inside the deck scroller (infinite lists). */
export function whenVisible(el, fn) {
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) fn();
  }, { rootMargin: '800px 0px' });
  io.observe(el);
  // In a cross-origin frame (Jellyfin's LG TV app shows LCARS in one) the observer ignores its
  // margin, so measure on scrolling and focus moves too.
  let t = null;
  const check = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight + 800 && r.bottom > -800) fn();
    }, 120);
  };
  document.addEventListener('scroll', check, { capture: true, passive: true });
  document.addEventListener('focusin', check);
  return () => { io.disconnect(); clearTimeout(t); document.removeEventListener('scroll', check, { capture: true }); document.removeEventListener('focusin', check); };
}

/**
 * A profile picture from an image file: centre-cropped to a square, at most 512 px, as base64
 * JPEG (what Jellyfin's user image upload takes). Small enough for the proxy's body limit too.
 */
export async function squareJpeg(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(512, side);
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88).split(',')[1];
}

/**
 * A number input with an LCARS stepper: an always-visible segment on the right, ▲ and ▼ in
 * black on the border's colour. Steps keep to the input's min, max and step, and fire "input"
 * as typing would.
 */
export function numberBox(input) {
  const step = dir => {
    try { if (dir > 0) input.stepUp(); else input.stepDown(); } catch { return; }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const b = (dir, title) => h('button', { type: 'button', tabindex: -1, title, attrs: { 'aria-label': title }, onclick: () => step(dir) }, arrow(dir > 0 ? 'u' : 'd'));
  return h('span.numbox', input, h('span.steps', b(1, 'Up'), b(-1, 'Down')));
}
