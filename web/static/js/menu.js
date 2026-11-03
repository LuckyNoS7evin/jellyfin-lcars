// The "⋯" item menu (the official clients' context menu) and the LCARS dialog it uses.
import { h, fill } from './h.js';
import { TICKS } from './api.js';
import * as f from './fmt.js';
import { btn, toast, loading, errorBox, canMarkPlayed, canRate, canRefreshMetadata } from './ui.js';

// ---- dialog ---------------------------------------------------------------------------------

/** An LCARS modal. Returns {el, close}. body: nodes; actions: buttons. */
export function dialog(title, body, actions = [], { color = 'orange', wide = false } = {}) {
  const el = h('dialog.lcars-dialog', { class: `c-${color}${wide ? ' wide' : ''}` },
    h('h2', title),
    h('div.dlg-body', body),
    actions.length ? h('div.actions.dlg-actions', actions) : null);
  const close = () => { el.close(); el.remove(); };
  quietPasswordManagers(el);
  el.addEventListener('close', () => el.remove());
  el.addEventListener('click', e => { if (e.target === el) close(); }); // click on the backdrop
  document.body.append(el);
  el.showModal();
  return { el, close };
}

/**
 * Tell password managers (1Password, LastPass, Bitwarden) to leave the boxes alone that aren't
 * sign-ins: a "Rename" or "Message" box shouldn't get a password pop-up.
 */
export function quietPasswordManagers(root) {
  for (const i of root.querySelectorAll('input:not([type=password]):not([autocomplete=username]), textarea')) {
    i.setAttribute('data-1p-ignore', '');
    i.setAttribute('data-lpignore', 'true');
    i.setAttribute('data-bwignore', '');
    if (!i.hasAttribute('autocomplete')) i.setAttribute('autocomplete', 'off');
  }
}

/** Promise<boolean>: a yes/no question. */
export function confirmDialog(title, text, yes = 'Confirm', color = 'red') {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; d.close(); resolve(v); } };
    const d = dialog(title, h('p.dlg-text', text), [
      btn('Cancel', () => finish(false), { color: 'lilac', ghost: true }),
      btn(yes, () => finish(true), { color }),
    ], { color });
    d.el.addEventListener('close', () => finish(false));
  });
}

const isAudio = it => it.MediaType === 'Audio' || ['MusicAlbum', 'MusicArtist', 'MusicGenre'].includes(it.Type)
  || (it.Type === 'Playlist' && it.MediaType === 'Audio');

// ---- menu -------------------------------------------------------------------------------------

let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.menu-btn, .ov-more')) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('hashchange', closeMenu);

/** The "⋯" button that opens the item menu. onChange(item) runs after watched/favourite/delete. */
export function menuButton(ctx, item, { onChange, small = true } = {}) {
  const b = h('button.btn.menu-btn', {
    type: 'button', class: `ghost c-peach${small ? ' small' : ''}`, title: 'More options', attrs: { 'aria-haspopup': 'menu' },
    onclick: e => { e.stopPropagation(); if (openMenu?.dataset.for === item.Id) closeMenu(); else showMenu(ctx, item, b, onChange); },
  }, '⋯');
  return b;
}

/** Open the menu for an item from any button (cards use this); a second press closes it. */
export function openItemMenu(ctx, item, anchor, onChange) {
  if (openMenu?.dataset.for === item.Id) { closeMenu(); return; }
  showMenu(ctx, item, anchor, onChange);
}

// What can go in a collection (official itemHelper.supportsAddingToCollection).
export const COLLECTABLE = new Set(['Movie', 'Series', 'Season', 'Episode', 'Video', 'MusicVideo', 'MusicAlbum', 'MusicArtist', 'Audio', 'Book', 'AudioBook', 'BoxSet', 'Trailer']);

function showMenu(ctx, it, anchor, onChange) {
  closeMenu();
  const { api, app } = ctx;
  const ud = it.UserData || (it.UserData = {});
  const policy = app.me?.Policy || {};
  const admin = !!policy.IsAdministrator;
  const playable = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Audio', 'Trailer'].includes(it.Type);
  const pos = ud.PlaybackPositionTicks || 0;
  // The item tools (admin/edit.js), for admins; subtitles also for subtitle managers.
  const tool = t => () => { location.hash = `#/admin/edit/${it.Id}/${t}`; };
  const video = ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'].includes(it.Type);
  const onDisk = it.LocationType !== 'Virtual';

  const items = [
    playable && pos > 0 ? ['Resume', () => app.play(it, { resume: true })] : null,
    playable ? [pos > 0 ? 'Play from start' : 'Play', () => app.play(it, { startTicks: 0 })] : null,
    it.Type === 'Episode' ? ['Play all from here', () => app.play(it, { resume: true })] : null,
    // Official itemContextMenu.js: queueing needs a player that is running (here, music),
    // shuffle is for folders and artists, instant mix for music.
    app.queue.active && isAudio(it) ? ['Play next', () => app.enqueue(it, true)] : null,
    app.queue.active && isAudio(it) ? ['Add to queue', () => app.enqueue(it)] : null,
    // Not for collections: a film series is watched in order.
    (it.IsFolder || it.Type === 'MusicArtist' || it.Type === 'MusicGenre') && it.Type !== 'BoxSet' && it.CollectionType !== 'livetv' ? ['Shuffle', () => app.shuffle(it)] : null,
    it.MediaType === 'Audio' || ['MusicAlbum', 'MusicArtist', 'MusicGenre'].includes(it.Type) ? ['Instant mix', () => app.instantMix(it)] : null,
    '-',
    canMarkPlayed(it) ? [ud.Played ? 'Mark unwatched' : 'Mark watched', async () => {
      const r = await api.setPlayed(it.Id, !ud.Played);
      Object.assign(ud, r || { Played: !ud.Played });
      onChange?.(it);
    }] : null,
    canRate(it) ? [ud.IsFavorite ? 'Remove favourite' : 'Add to favourites', async () => {
      const r = await api.setFavorite(it.Id, !ud.IsFavorite);
      Object.assign(ud, r || { IsFavorite: !ud.IsFavorite });
      onChange?.(it);
    }] : null,
    ['Add to playlist', () => addToPlaylist(ctx, [it])],
    canManageCollections(app.me) && COLLECTABLE.has(it.Type) ? ['Add to collection', () => addToCollection(ctx, [it])] : null,
    '-',
    it.SeriesId && it.Type !== 'Series' ? ['Go to series', () => { location.hash = `#/item/${it.SeriesId}`; }] : null,
    it.SeasonId && it.Type === 'Episode' ? ['Go to season', () => { location.hash = `#/item/${it.SeasonId}`; }] : null,
    it.AlbumId ? ['Go to album', () => { location.hash = `#/item/${it.AlbumId}`; }] : null,
    // Official "View album artist".
    (it.Type === 'Audio' || it.Type === 'MusicAlbum') && it.AlbumArtists?.[0]?.Id ? ['Go to artist', () => { location.hash = `#/item/${it.AlbumArtists[0].Id}`; }] : null,
    it.Type === 'Playlist' ? ['Edit playlist', () => { location.hash = `#/item/${it.Id}?edit=1`; }] : null,
    playable ? ['Media info', () => mediaInfo(ctx, it)] : null,
    playable ? ['Copy stream link', async () => {
      const url = api.url(`/Items/${it.Id}/Download`, {}, { auth: true });
      try { await navigator.clipboard.writeText(url); toast('Copied', 'Stream link on the clipboard (it contains your access token)', 'sky'); }
      catch { toast('Unable to copy', 'The browser blocked clipboard access', 'red'); }
    }] : null,
    it.CanDownload && playable ? ['Download', () => download(api, [it])] : null,
    // Official "Download all": every file under a series, season, collection or album.
    policy.EnableContentDownloading && ['Series', 'Season', 'BoxSet', 'MusicAlbum', 'Playlist'].includes(it.Type) ? ['Download all…', async () => {
      const files = (await app.playableItems(it)).filter(x => x.LocationType !== 'Virtual');
      if (!files.length) { toast('Nothing to download', it.Name, 'salmon'); return; }
      const ok = await confirmDialog('Download all', `Download ${files.length} file${files.length > 1 ? 's' : ''} from “${it.Name}”? Your browser may ask once to allow several downloads.`, 'Download');
      if (ok) download(api, files);
    }] : null,
    '-',
    canRefreshMetadata(it, app.me) ? ['Refresh metadata…', () => refreshDialog(ctx, [it])] : null,
    admin ? ['Edit metadata…', tool('metadata')] : null,
    admin ? ['Edit images…', tool('images')] : null,
    admin && onDisk && ['Movie', 'Trailer', 'Series', 'BoxSet', 'Person', 'Book', 'MusicAlbum', 'MusicArtist', 'MusicVideo'].includes(it.Type) ? ['Identify…', tool('identify')] : null,
    (admin || policy.EnableSubtitleManagement) && video && onDisk ? ['Edit subtitles…', tool('subtitles')] : null,
    admin && it.Type === 'Audio' ? ['Edit lyrics…', tool('lyrics')] : null,
    // Undo a manual Group versions (several versions on one item).
    admin && video && it.MediaSourceCount > 1 ? ['Split versions…', async () => {
      const { splitVersions } = await import('./admin/edit.js');
      if (await splitVersions(ctx, it)) onChange?.(it);
    }] : null,
    it.CanDelete ? ['Delete…', async () => {
      const ok = await confirmDialog('Delete media', `Delete “${it.Name}” from the server and the disk? This cannot be undone.`, 'Delete');
      if (!ok) return;
      await api.del(`/Items/${it.Id}`);
      toast('Deleted', it.Name, 'red');
      onChange?.(it, { deleted: true });
    }, 'danger'] : null,
  ].filter(Boolean);
  // Drop separators at the ends or doubled up.
  const clean = items.filter((x, i, a) => x !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));

  const menu = h('div.item-menu', { attrs: { role: 'menu', 'data-for': it.Id } },
    clean.map(x => x === '-' ? h('hr') : h('button', {
      type: 'button', class: x[2] || '', attrs: { role: 'menuitem' },
      onclick: async () => {
        closeMenu();
        try { await x[1](); } catch (e) { toast('Unable to comply', e.message, 'red'); }
      },
    }, x[0])));
  document.body.append(menu);
  openMenu = menu;
  // Place under the button, kept on screen.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  menu.querySelector('button')?.focus();
}

// ---- actions ----------------------------------------------------------------------------------

/** Start browser downloads one after another (browsers drop downloads started all at once). */
function download(api, items) {
  items.forEach((it, i) => setTimeout(() => {
    const a = h('a', { href: api.url(`/Items/${it.Id}/Download`, {}, { auth: true }), download: '' });
    document.body.append(a); a.click(); a.remove();
  }, i * 900));
  if (items.length > 1) toast('Downloading', `${items.length} files`, 'sky');
}

/**
 * Add items to a playlist, or make a new one from them (an item's menu, or the whole music
 * queue). label: what the toast calls them.
 */
export async function addToPlaylist(ctx, items, { label, title = 'Add to playlist' } = {}) {
  const { api } = ctx;
  const ids = items.map(i => i.Id);
  const mediaType = items[0]?.MediaType;
  const what = label || (items.length === 1 ? items[0].Name : `${items.length} items`);
  const body = h('div', loading());
  const nameIn = h('input.inp', { placeholder: 'New playlist name', attrs: { 'aria-label': 'New playlist name' } });
  const d = dialog(title, [body, h('div.dlg-new', nameIn, btn('Create', async () => {
    const name = nameIn.value.trim();
    if (!name) return;
    try {
      await api.post('/Playlists', { Name: name, Ids: ids, UserId: api.userId, MediaType: mediaType });
      d.close();
      toast('Playlist created', `${name} · ${what}`, 'sky');
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }, { color: 'sky', small: true }))], [btn('Close', () => d.close(), { color: 'lilac', ghost: true })], { color: 'sky' });
  try {
    const r = await api.items({ includeItemTypes: 'Playlist', recursive: true, sortBy: 'SortName' });
    const lists = r.Items.filter(p => !p.MediaType || !mediaType || p.MediaType === mediaType || p.MediaType === 'Unknown');
    fill(body, lists.length ? h('div.dlg-list', lists.map(p => h('button', {
      type: 'button',
      onclick: async () => {
        try {
          // In batches, so a long queue doesn't make an over-long URL.
          for (let i = 0; i < ids.length; i += 100) {
            await api.post(`/Playlists/${p.Id}/Items`, undefined, { ids: ids.slice(i, i + 100).join(','), userId: api.userId });
          }
          d.close();
          toast('Added to playlist', `${p.Name} · ${what}`, 'sky');
        } catch (e) { toast('Unable to comply', e.message, 'red'); }
      },
    }, p.Name, p.ChildCount ? h('small', ` · ${p.ChildCount}`) : null))) : h('p.dlg-text', 'No playlists yet: create one below.'));
  } catch (e) { fill(body, errorBox(e)); }
}

/** Refresh metadata, with the official dialog's modes and options. */
/** Collection changes need EnableCollectionManagement (server policy CollectionManagement; being an admin isn't enough). */
export const canManageCollections = me => !!me?.Policy?.EnableCollectionManagement;

/**
 * Add items to a collection, or start a new one with them (official collectionEditor). With
 * a filter box: libraries can have dozens of collections.
 */
export async function addToCollection(ctx, items) {
  const { api } = ctx;
  const ids = items.map(i => i.Id).join(',');
  const what = items.length === 1 ? items[0].Name : `${items.length} items`;
  const body = h('div', loading());
  const filterIn = h('input.inp', { type: 'search', placeholder: 'Filter collections', attrs: { 'aria-label': 'Filter collections' } });
  const nameIn = h('input.inp', { placeholder: 'New collection name', attrs: { 'aria-label': 'New collection name' } });
  const d = dialog('Add to collection', [filterIn, body, h('div.dlg-new', nameIn, btn('Create', async () => {
    const name = nameIn.value.trim();
    if (!name) return;
    try {
      await api.post('/Collections', undefined, { name, ids, isLocked: false });
      d.close();
      toast('Collection created', `${name} · ${what}`, 'sky');
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }, { color: 'sky', small: true }))], [btn('Close', () => d.close(), { color: 'lilac', ghost: true })], { color: 'sky' });
  try {
    const r = await api.items({ includeItemTypes: 'BoxSet', recursive: true, sortBy: 'SortName', fields: 'ChildCount', enableImages: false });
    const all = r.Items || [];
    const draw = () => {
      const f = filterIn.value.trim().toLowerCase();
      const list = f ? all.filter(c => c.Name.toLowerCase().includes(f)) : all;
      fill(body, list.length ? h('div.dlg-list', list.map(c => h('button', {
        type: 'button',
        onclick: async () => {
          try {
            await api.post(`/Collections/${c.Id}/Items`, undefined, { ids });
            d.close();
            toast('Added to collection', `${c.Name} · ${what}`, 'sky');
          } catch (e) { toast('Unable to comply', e.message, 'red'); }
        },
      }, c.Name, c.ChildCount ? h('small', ` · ${c.ChildCount}`) : null))) : h('p.dlg-text', all.length ? 'No collection matches.' : 'No collections yet: create one below.'));
    };
    filterIn.addEventListener('input', draw);
    draw();
    filterIn.focus();
  } catch (e) { fill(body, errorBox(e)); }
}

export function refreshDialog(ctx, items) {
  const { api } = ctx;
  const mode = h('select.sel', { attrs: { 'aria-label': 'Refresh mode' } },
    h('option', { value: 'scan' }, 'Scan for new and updated files'),
    h('option', { value: 'missing' }, 'Search for missing metadata'),
    h('option', { value: 'all' }, 'Replace all metadata'));
  const box = label => {
    const input = h('input', { type: 'checkbox' });
    return { input, el: h('label.dlg-check', input, h('span', label)) };
  };
  const images = box('Replace existing images');
  const trickplay = box('Replace existing trickplay images');
  const opts = h('div.dlg-opts', images.el, trickplay.el);
  const sync = () => { opts.hidden = mode.value === 'scan'; };
  mode.addEventListener('change', sync);
  sync();
  const d = dialog(items.length > 1 ? `Refresh metadata · ${items.length} items` : `Refresh metadata · ${items[0].Name}`, [
    h('label.pick', h('span', 'Refresh mode'), mode),
    opts,
    h('p.dlg-note', 'Metadata is refreshed based on the settings and internet services enabled in the Dashboard.'),
  ], [
    btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }),
    btn('Refresh', async () => {
      const full = mode.value !== 'scan';
      const q = {
        recursive: true,
        metadataRefreshMode: full ? 'FullRefresh' : 'Default',
        imageRefreshMode: full ? 'FullRefresh' : 'Default',
        replaceAllMetadata: mode.value === 'all',
        replaceAllImages: full && images.input.checked,
        regenerateTrickplay: full && trickplay.input.checked,
      };
      d.close();
      try {
        await Promise.all(items.map(i => api.post(`/Items/${i.Id}/Refresh`, undefined, q)));
        toast('Refresh queued', items.length > 1 ? `${items.length} items` : items[0].Name, 'sky');
      } catch (e) { toast('Unable to comply', e.message, 'red'); }
    }, { color: 'orange' }),
  ], { color: 'orange' });
}

async function mediaInfo(ctx, it) {
  const { api } = ctx;
  const body = h('div', loading());
  dialog(`Media info · ${it.Name}`, body, [], { color: 'blue', wide: true });
  try {
    const full = it.MediaSources ? it : await api.item(it.Id);
    fill(body, (full.MediaSources || []).map(ms => h('div.mi-src',
      h('h3', ms.Name || ms.Container),
      h('div.kv',
        h('span', 'Container'), h('span', ms.Container || '—'),
        h('span', 'Size'), h('span', ms.Size ? f.bytes(ms.Size) : '—'),
        h('span', 'Bitrate'), h('span', ms.Bitrate ? `${(ms.Bitrate / 1e6).toFixed(1)} Mbps` : '—'),
        h('span', 'Runtime'), h('span', ms.RunTimeTicks ? f.clock(ms.RunTimeTicks / TICKS) : '—'),
        ctx.app.me?.Policy?.IsAdministrator ? [h('span', 'Path'), h('span.mi-path', ms.Path || '—')] : null),
      (ms.MediaStreams || []).map(s => h('div.mi-stream',
        h('b', `${s.Type} ${s.Index}`),
        h('span', [s.DisplayTitle, s.Codec?.toUpperCase(), s.Profile, s.Width && s.Height ? `${s.Width}×${s.Height}` : '',
          s.BitRate ? `${Math.round(s.BitRate / 1000)} kbps` : '', s.ChannelLayout, s.Language, s.IsDefault ? 'default' : '', s.IsForced ? 'forced' : '', s.IsExternal ? 'external' : '']
          .filter(Boolean).join(' · ')))))));
  } catch (e) { fill(body, errorBox(e)); }
}
