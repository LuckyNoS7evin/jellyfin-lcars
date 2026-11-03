// Libraries (admin stage A3; official routes/libraries, mediaLibraryCreator, mediaLibraryEditor,
// libraryoptionseditor): the list, adding a library, editing one (name, folders, options), and the
// library-wide Display, Metadata and NFO settings.
import { h, fill } from '../h.js';
import { deck, btn, tag, empty, toast, errorBox, numberBox } from '../ui.js';
import { confirmDialog, dialog, refreshDialog } from '../menu.js';
import { editForm, row, pickFolder } from './form.js';

const TYPES = [['Films', 'movies'], ['Shows', 'tvshows'], ['Music', 'music'], ['Music videos', 'musicvideos'], ['Books', 'books'],
  ['Home videos and photos', 'homevideos'], ['Mixed films and shows', '']];
const typeName = t => TYPES.find(([, v]) => v === (t || ''))?.[0] || t;
const REFRESH_DAYS = [['Never', 0], ['Every 30 days', 30], ['Every 60 days', 60], ['Every 90 days', 90], ['Every 180 days', 180], ['Every year', 365]];
const EMBEDDED_SUBS = [['Allow all', 'AllowAll'], ['Text only', 'AllowText'], ['Pictures only', 'AllowImage'], ['None', 'AllowNone']];
const CHAPTER_TYPES = ['', 'movies', 'tvshows', 'musicvideos', 'homevideos'];
const SUB_TYPES = ['', 'movies', 'tvshows', 'musicvideos'];
const RESOLUTIONS = [['Same as the video', 'MatchSource'], ['144p', 'P144'], ['240p', 'P240'], ['360p', 'P360'], ['480p', 'P480'], ['720p', 'P720'],
  ['1080p', 'P1080'], ['1440p', 'P1440'], ['2160p', 'P2160']];

export async function libraries(ctx) {
  const [id] = ctx.sub;
  if (!id) return list(ctx);
  if (id === 'new') return editLibrary(ctx, null);
  if (id === 'display') return displayPage(ctx);
  if (id === 'metadata') return metadataPage(ctx);
  if (id === 'nfo') return nfoPage(ctx);
  if (id === 'manager') return import('./manager.js').then(m => m.manager(ctx, subTabs('manager')));
  return editLibrary(ctx, id);
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['', 'Libraries'], ['display', 'Display'], ['metadata', 'Metadata'], ['nfo', 'NFO'], ['manager', 'Metadata manager']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/libraries${k ? `/${k}` : ''}`, class: k === cur ? 'on' : '' }, l)));

// ---- list ---------------------------------------------------------------------------------------

async function list(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Libraries');
  const body = h('div');
  const progress = new Map();
  let folders = [];

  async function load() {
    try { folders = await api.get('/Library/VirtualFolders', undefined, { signal }); } catch (e) { fill(body, errorBox(e)); return; }
    draw();
    // A new library has no item until its first scan makes one: look again until it does.
    clearTimeout(pending);
    if (folders.some(f => !f.ItemId) && !signal.aborted) pending = setTimeout(load, 4000);
  }
  let pending = null;
  function draw() {
    fill(body, folders.length ? h('div.eng-libs', folders.map(lib => {
      // Scanning while the server says so, or while its messages give a percentage between 0 and
      // 100 (a library's last message, once it's done, says 0, which clears it).
      const pct = progress.get(lib.ItemId) ?? (lib.RefreshStatus === 'Active' ? lib.RefreshProgress : null);
      const scanning = lib.RefreshStatus === 'Active' || progress.has(lib.ItemId);
      if (!lib.ItemId) {
        return h('div.eng-lib.new',
          h('div.eng-lib-img', h('div.noimg', lib.Name)),
          h('div.eng-lib-b', h('span.eng-lib-n', lib.Name), h('div.eng-sess-m', tag(typeName(lib.CollectionType), 'lilac'), tag('Setting up', 'sky')),
            h('div.eng-lib-p', (lib.Locations || []).map(p => h('span', p))),
            h('div.eng-lib-scan', h('span', 'Waiting for its first scan…'))),
          h('div.eng-lib-a', btn('Remove', () => remove(lib), { small: true, color: 'red', ghost: true })));
      }
      return h('div.eng-lib',
        h('a.eng-lib-img', { href: `#/admin/libraries/${lib.ItemId}`, title: 'Edit' },
          lib.PrimaryImageItemId ? h('img', { src: api.img(lib.PrimaryImageItemId, 'Primary', { w: 400 }), alt: '' }) : h('div.noimg', lib.Name)),
        h('div.eng-lib-b',
          h('a.eng-lib-n', { href: `#/admin/libraries/${lib.ItemId}` }, lib.Name),
          h('div.eng-sess-m', tag(typeName(lib.CollectionType), 'lilac'), lib.LibraryOptions?.Enabled === false ? tag('Disabled', 'red') : null,
            lib.LibraryOptions?.EnableRealtimeMonitor ? tag('Watching for changes', 'sky') : null),
          h('div.eng-lib-p', (lib.Locations || []).map(p => h('span', p))),
          scanning ? h('div.eng-lib-scan', h('span', `Scanning${pct ? ` ${Math.round(pct)}%` : '…'}`)) : null),
        h('div.eng-lib-a',
          btn('Edit', () => { location.hash = `#/admin/libraries/${lib.ItemId}`; }, { small: true, color: 'orange' }),
          btn('Scan', () => refreshDialog(ctx, [{ Id: lib.ItemId, Name: lib.Name, Type: 'CollectionFolder' }]), { small: true, color: 'sky', ghost: true }),
          btn('Rename', () => rename(lib), { small: true, color: 'lilac', ghost: true }),
          btn('Images', () => { location.hash = `#/admin/edit/${lib.ItemId}/images`; }, { small: true, color: 'lilac', ghost: true }),
          btn('Remove', () => remove(lib), { small: true, color: 'red', ghost: true })));
    })) : empty('No libraries yet.'));
  }
  async function rename(lib) {
    const input = h('input.inp', { value: lib.Name, attrs: { spellcheck: 'false' } });
    let d = null;
    const go = async () => {
      const n = input.value.trim();
      if (!n || n === lib.Name) { d.close(); return; }
      try {
        await api.post('/Library/VirtualFolders/Name', undefined, { name: lib.Name, newName: n, refreshLibrary: false });
        d.close();
        toast('Renamed', n, 'sky', 2000);
        await app.reloadViews();
        load();
      } catch (e) { toast('Unable to comply', e.message, 'red'); }
    };
    d = dialog(`Rename ${lib.Name}`, h('form.dlg-form', { onsubmit: e => { e.preventDefault(); go(); } }, h('label.field', h('span', 'New name'), input)),
      [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Rename', go, { color: 'orange' })]);
    setTimeout(() => input.select(), 0);
  }
  async function remove(lib) {
    const ok = await confirmDialog('Remove library', `Remove “${lib.Name}” from Jellyfin? Its folders stay on the disk (${(lib.Locations || []).join(', ')}); watch history for its items goes.`, 'Remove');
    if (!ok) return;
    try {
      await api.del('/Library/VirtualFolders', { name: lib.Name, refreshLibrary: true });
      toast('Library removed', lib.Name, 'red');
      await app.reloadViews();
      load();
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }

  // Live scan progress: the server pushes RefreshProgress to admins (for every item refreshed,
  // and each library). Percentages show at once; the library's status (scanning or not) is read
  // again a moment after a burst of messages, and once more when they stop.
  let timer = null, settle = null;
  const off = app.listen('RefreshProgress', d => {
    if (!d?.ItemId || !folders.some(f => f.ItemId === d.ItemId)) return;
    const p = Number(d.Progress);
    if (p > 0 && p < 100) progress.set(d.ItemId, p); else progress.delete(d.ItemId);
    draw();
    if (!timer) timer = setTimeout(() => { timer = null; load(); }, 1000);
    clearTimeout(settle);
    settle = setTimeout(load, 4000);
  });
  signal.addEventListener('abort', () => { off(); clearTimeout(timer); clearTimeout(settle); clearTimeout(pending); });
  await load();
  return h('div.eng-edit', subTabs(''),
    deck('Libraries', { color: 'orange', num: 1, code: `${folders.length} on file` },
      h('div.actions',
        btn('Add library', () => { location.hash = '#/admin/libraries/new'; }, { color: 'orange' }),
        btn('Scan all libraries', async () => { await api.post('/Library/Refresh'); toast('Library scan started', '', 'sky'); }, { color: 'sky', ghost: true })),
      body));
}

// ---- add and edit ---------------------------------------------------------------------------------

async function editLibrary(ctx, itemId) {
  const { api, app, signal } = ctx;
  ctx.setParent('#/admin/libraries');
  const [all, cultures, countries] = await Promise.all([
    api.get('/Library/VirtualFolders', undefined, { signal }),
    api.get('/Localization/Cultures', undefined, { signal }).catch(() => []),
    api.get('/Localization/Countries', undefined, { signal }).catch(() => []),
  ]);
  const lib = itemId ? all.find(f => f.ItemId === itemId) : null;
  if (itemId && !lib) { location.replace('#/admin/libraries'); return h('div'); }
  ctx.setTitle(lib ? lib.Name : 'New library');
  const isNew = !lib;
  let contentType = lib ? lib.CollectionType || '' : 'movies';

  // Folders: on an existing library they change straight away (as official); a new one keeps a list.
  const newPaths = [];
  const foldersEl = h('div.eng-folders');
  function drawFolders() {
    const paths = isNew ? newPaths : lib.Locations || [];
    fill(foldersEl,
      paths.length ? paths.map(p => h('div.eng-folder', h('span', p),
        btn('✕', () => removeFolder(p), { small: true, ico: true, color: 'red', ghost: true, title: `Remove ${p}` }))) : h('p.dlg-note', 'No folders yet.'),
      btn('Add a folder', async () => {
        const p = await pickFolder(api, '');
        if (!p) return;
        if (isNew) { if (!newPaths.includes(p)) newPaths.push(p); drawFolders(); return; }
        try {
          await api.post('/Library/VirtualFolders/Paths', { Name: lib.Name, PathInfo: { Path: p } }, { refreshLibrary: true });
          lib.Locations = [...(lib.Locations || []), p];
          toast('Folder added', `${p}: scanning`, 'sky', 2500);
          drawFolders();
        } catch (e) { toast('Unable to comply', e.message, 'red'); }
      }, { small: true, color: 'blue' }));
  }
  async function removeFolder(p) {
    if (isNew) { newPaths.splice(newPaths.indexOf(p), 1); drawFolders(); return; }
    if (!(await confirmDialog('Remove folder', `Stop using ${p} in ${lib.Name}? The folder stays on the disk; its items leave the library.`, 'Remove'))) return;
    try {
      await api.del('/Library/VirtualFolders/Paths', { name: lib.Name, path: p, refreshLibrary: true });
      lib.Locations = lib.Locations.filter(x => x !== p);
      toast('Folder removed', p, 'red', 2000);
      drawFolders();
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  drawFolders();

  // The options form, rebuilt when a new library's type changes (the providers differ).
  const optsEl = h('div');
  let fo = null;
  const name = h('input.inp', { value: lib?.Name || '', attrs: { spellcheck: 'false', required: true } });
  const typeSel = isNew ? h('select.sel', TYPES.map(([l, v]) => h('option', { value: v, attrs: { selected: v === contentType } }, l))) : null;

  async function buildOptions() {
    fill(optsEl, h('p.loading', 'Reading the available options…'));
    const avail = await api.get('/Libraries/AvailableOptions', { libraryContentType: contentType || undefined, isNewLibrary: isNew }, { signal });
    fo = editForm({
      app,
      load: () => prepareOptions(lib?.LibraryOptions, avail),
      save: async o => {
        if (isNew) return; // a new library is saved by Create
        await api.post('/Library/VirtualFolders/LibraryOptions', { Id: lib.ItemId, LibraryOptions: o });
      },
    });
    await fo.ready;
    fill(optsEl, optionsEditor(fo, avail, contentType, cultures, countries));
    if (isNew) fo.bar.remove(); // a new library is saved by Create
    return fo;
  }
  typeSel?.addEventListener('change', () => { contentType = typeSel.value; buildOptions(); });
  await buildOptions();

  async function create() {
    const n = name.value.trim();
    if (!n) { name.focus(); toast('Name needed', 'Give the library a name', 'red'); return; }
    if (!newPaths.length) { toast('No folders', 'Add at least one folder', 'red'); return; }
    try {
      await api.post('/Library/VirtualFolders', { LibraryOptions: { ...fo.draft, PathInfos: newPaths.map(Path => ({ Path })) } },
        { name: n, collectionType: contentType || undefined, refreshLibrary: true, paths: newPaths });
      app.leaveGuard?.clear();
      toast('Library added', `${n}: scanning`, 'sky');
      await app.reloadViews();
      location.hash = '#/admin/libraries';
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  async function renameHere() {
    const n = name.value.trim();
    if (!n || n === lib.Name) return;
    try {
      await api.post('/Library/VirtualFolders/Name', undefined, { name: lib.Name, newName: n, refreshLibrary: false });
      lib.Name = n;
      ctx.setTitle(n);
      toast('Renamed', n, 'sky', 2000);
      await app.reloadViews();
    } catch (e) { toast('Unable to comply', e.message, 'red'); name.value = lib.Name; }
  }

  const general = deck(isNew ? 'New library' : lib.Name, { color: 'orange', num: 1 },
    isNew ? row('Type', typeSel) : row('Type', h('span.eng-ro', typeName(contentType))),
    row('Name', isNew ? name : h('div.eng-path', name, btn('Rename', renameHere, { small: true, color: 'lilac' }))),
    h('h3.set-h', 'Folders'), foldersEl,
    isNew ? h('div.actions', btn('Create library', create, { color: 'orange' }), btn('Cancel', () => { location.hash = '#/admin/libraries'; }, { color: 'lilac', ghost: true })) : null);
  return h('div.eng-edit', general, optsEl);
}

/** The library's options with every type the server offers filled in (official defaults). */
export function prepareOptions(opts, avail) {
  const o = JSON.parse(JSON.stringify(opts || {}));
  o.TypeOptions = o.TypeOptions || [];
  for (const t of avail.TypeOptions || []) {
    let to = o.TypeOptions.find(x => x.Type === t.Type);
    if (!to) {
      to = { Type: t.Type, MetadataFetchers: t.MetadataFetchers.filter(x => x.DefaultEnabled).map(x => x.Name), MetadataFetcherOrder: t.MetadataFetchers.map(x => x.Name),
        ImageFetchers: t.ImageFetchers.filter(x => x.DefaultEnabled).map(x => x.Name), ImageFetcherOrder: t.ImageFetchers.map(x => x.Name), ImageOptions: [] };
      o.TypeOptions.push(to);
    }
    if (!to.ImageOptions?.length) to.ImageOptions = JSON.parse(JSON.stringify(t.DefaultImageOptions || []));
  }
  // New libraries: the official defaults.
  if (opts == null) Object.assign(o, { Enabled: true, EnableRealtimeMonitor: true, EnableLUFSScan: true, EnableInternetProviders: true, SaveLocalMetadata: false,
    EnableEmbeddedTitles: false, EnableEmbeddedExtrasTitles: false, EnableEmbeddedEpisodeInfos: false, AllowEmbeddedSubtitles: 'AllowAll',
    EnableChapterImageExtraction: false, ExtractChapterImagesDuringLibraryScan: false, EnableTrickplayImageExtraction: false,
    ExtractTrickplayImagesDuringLibraryScan: false, AutomaticRefreshIntervalDays: 0, SeasonZeroDisplayName: 'Specials',
    MetadataSavers: (avail.MetadataSavers || []).filter(x => x.DefaultEnabled).map(x => x.Name) });
  return o;
}

/** The options editor (official libraryoptionseditor), sections by content type. */
function optionsEditor(fo, avail, ct, cultures, countries) {
  const t = k => fo.toggle(k);
  const show = (cond, ...r) => (cond ? r : null);
  const langs = [['Default', ''], ...cultures.map(c => [c.DisplayName, c.TwoLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0]))];
  const ctry = [['Default', ''], ...countries.map(c => [c.DisplayName, c.TwoLetterISORegionName]).sort((a, b) => a[0].localeCompare(b[0]))];
  const subLangs = cultures.filter(c => c.ThreeLetterISOLanguageName).map(c => [c.DisplayName, c.ThreeLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0]));
  const names = list => (list || []).map(x => x.Name);
  const defaults = list => (list || []).filter(x => x.DefaultEnabled).map(x => x.Name);
  const typeLabel = ty => ({ Movie: 'Films', Series: 'Series', Season: 'Seasons', Episode: 'Episodes', MusicAlbum: 'Albums', MusicArtist: 'Artists',
    Audio: 'Tracks', MusicVideo: 'Music videos', Video: 'Videos', Book: 'Books', AudioBook: 'Audiobooks', BoxSet: 'Collections', Photo: 'Photos', PhotoAlbum: 'Photo albums', Person: 'People', Trailer: 'Trailers' }[ty] || ty);

  const general = deck('Library', { color: 'peach', num: 2 },
    row('Enabled', t('Enabled'), 'Off: the library is hidden and not scanned'),
    row('Watch for changes', t('EnableRealtimeMonitor'), 'Pick up new and changed files straight away'),
    row('Refresh metadata', fo.select('AutomaticRefreshIntervalDays', REFRESH_DAYS)),
    row('Metadata language', fo.select('PreferredMetadataLanguage', langs)),
    row('Metadata country', fo.select('MetadataCountryCode', ctry)),
    show(ct === 'tvshows', row('Name for season 0', fo.text('SeasonZeroDisplayName', { placeholder: 'Specials' })),
      row('Group series spread over folders', t('EnableAutomaticSeriesGrouping'))),
    show(!['books', 'music'].includes(ct), row('Use titles embedded in files', t('EnableEmbeddedTitles')),
      row('… for extras too', t('EnableEmbeddedExtrasTitles'))),
    show(ct === 'tvshows', row('Use episode details embedded in files', t('EnableEmbeddedEpisodeInfos'))),
    show(ct === 'homevideos', row('Include photos', t('EnablePhotos'))),
    show(ct === 'movies' || ct === '', row('Add films to their collections', t('AutomaticallyAddToCollection'), 'Collections from the metadata provider')),
    show(ct === 'music', row('Measure loudness (LUFS)', t('EnableLUFSScan'), 'For volume normalisation')),
    row('Save artwork and NFO in the media folders', t('SaveLocalMetadata')));

  const meta = deck('Metadata', { color: 'lilac', num: 3 },
    h('h3.set-h', 'Local metadata readers'),
    fo.providers({ names: names(avail.MetadataReaders), defaults: names(avail.MetadataReaders), orderKey: 'LocalMetadataReaderOrder', disabledKey: 'DisabledLocalMetadataReaders' }),
    h('h3.set-h', 'Metadata savers'),
    fo.providers({ names: names(avail.MetadataSavers), defaults: defaults(avail.MetadataSavers), enabledKey: 'MetadataSavers' }),
    (avail.TypeOptions || []).map(ty => {
      const i = fo.draft.TypeOptions.findIndex(x => x.Type === ty.Type);
      return [h('h3.set-h', `${typeLabel(ty.Type)}: metadata downloaders`),
        fo.providers({ names: names(ty.MetadataFetchers), defaults: defaults(ty.MetadataFetchers), orderKey: `TypeOptions.${i}.MetadataFetcherOrder`, enabledKey: `TypeOptions.${i}.MetadataFetchers` })];
    }));

  const images = deck('Images', { color: 'sky', num: 4 },
    (avail.TypeOptions || []).map(ty => {
      const i = fo.draft.TypeOptions.findIndex(x => x.Type === ty.Type);
      return [h('h3.set-h', `${typeLabel(ty.Type)}: image downloaders`),
        fo.providers({ names: names(ty.ImageFetchers), defaults: defaults(ty.ImageFetchers), orderKey: `TypeOptions.${i}.ImageFetcherOrder`, enabledKey: `TypeOptions.${i}.ImageFetchers` }),
        imageOptions(fo, i, ty)];
    }));

  const subs = SUB_TYPES.includes(ct) ? deck('Subtitles', { color: 'blue', num: 5 },
    row('Embedded subtitles', fo.select('AllowEmbeddedSubtitles', EMBEDDED_SUBS), 'Which subtitles inside the files to use'),
    avail.SubtitleFetchers?.length ? [
      row('Download languages', fo.pickList('SubtitleDownloadLanguages', subLangs, { placeholder: 'Add a language' })),
      h('h3.set-h', 'Subtitle downloaders'),
      fo.providers({ names: names(avail.SubtitleFetchers), defaults: defaults(avail.SubtitleFetchers), orderKey: 'SubtitleFetcherOrder', disabledKey: 'DisabledSubtitleFetchers' }),
      row('Not if the file has subtitles', t('SkipSubtitlesIfEmbeddedSubtitlesPresent')),
      row('Not if the audio is in that language', t('SkipSubtitlesIfAudioTrackMatches')),
      row('Exact file matches only', t('RequirePerfectSubtitleMatch')),
      row('Save beside the media', t('SaveSubtitlesWithMedia'))] : h('p.dlg-note', 'No subtitle download plugins installed (Open Subtitles, for one).')) : null;

  const music = ct === 'music' ? deck('Lyrics and tags', { color: 'blue', num: 5 },
    avail.LyricFetchers?.length ? [h('h3.set-h', 'Lyrics downloaders'),
      fo.providers({ names: names(avail.LyricFetchers), defaults: defaults(avail.LyricFetchers), orderKey: 'LyricFetcherOrder', disabledKey: 'DisabledLyricFetchers' })] : h('p.dlg-note', 'No lyrics plugins installed.'),
    row('Save lyrics beside the media', t('SaveLyricsWithMedia')),
    row('Prefer the ARTISTS tag', t('PreferNonstandardArtistsTag'), 'When files have both ARTIST and ARTISTS'),
    row('Split tags on custom characters', t('UseCustomTagDelimiters')),
    row('Characters to split on', charsInput(fo, 'CustomTagDelimiters'), 'For example / ; ,'),
    row('Never split these', linesInput(fo, 'DelimiterWhitelist'), 'One per line (AC/DC, for one)')) : null;

  const chapters = CHAPTER_TYPES.includes(ct) ? deck('Chapters and trickplay', { color: 'salmon', num: 6 },
    row('Chapter images', t('EnableChapterImageExtraction'), 'Pictures for the chapter list'),
    row('… during the library scan', t('ExtractChapterImagesDuringLibraryScan'), 'Otherwise the nightly task does it'),
    row('Trickplay images', t('EnableTrickplayImageExtraction'), 'Previews when you scrub'),
    row('… during the library scan', t('ExtractTrickplayImagesDuringLibraryScan')),
    row('Save trickplay beside the media', t('SaveTrickplayWithMedia'))) : null;

  const segments = avail.MediaSegmentProviders?.length ? deck('Media segments', { color: 'peach', num: 7 },
    h('p.dlg-note', 'Intros, credits and recaps, for skipping (Intro Skipper, for one).'),
    fo.providers({ names: names(avail.MediaSegmentProviders), defaults: defaults(avail.MediaSegmentProviders), orderKey: 'MediaSegmentProviderOrder', disabledKey: 'DisabledMediaSegmentProviders' })) : null;

  return h('div.eng-grid', h('div.eng-col', general, subs, music, chapters, segments), h('div.eng-col', meta, images), fo.bar);
}

/** Per type: which images to download, and for backdrops how many and how wide (official imageOptionsEditor). */
function imageOptions(fo, i, ty) {
  const key = `TypeOptions.${i}.ImageOptions`;
  const types = ty.SupportedImageTypes || [];
  const el = h('div.eng-imgopts');
  const get = type => (fo.get(key) || []).find(x => x.Type === type) || { Type: type, Limit: 0, MinWidth: 0 };
  const put = (type, patch) => {
    const list = (fo.get(key) || []).filter(x => x.Type !== type);
    fo.set(key, [...list, { ...get(type), ...patch }]);
  };
  const sync = () => fill(el, types.map(type => {
    const o = get(type);
    if (type === 'Backdrop' || type === 'Screenshot') {
      const lim = h('input.inp.num', { type: 'number', value: o.Limit, attrs: { min: 0, max: 20, title: 'How many' } });
      lim.addEventListener('input', () => put(type, { Limit: Number(lim.value) || 0 }));
      const w = h('input.inp.num', { type: 'number', value: o.MinWidth, attrs: { min: 0, step: 10, title: 'Minimum width (px)' } });
      w.addEventListener('input', () => put(type, { MinWidth: Number(w.value) || 0 }));
      return h('div.eng-imgopt', h('span', `${type}s`), h('label.eng-inline', h('span', 'How many'), numberBox(lim)), h('label.eng-inline', h('span', 'Min width'), numberBox(w)));
    }
    const b = h('button.eng-check', { type: 'button', class: o.Limit > 0 ? 'on' : '' }, type);
    b.addEventListener('click', () => { put(type, { Limit: get(type).Limit > 0 ? 0 : 1 }); sync(); });
    return b;
  }));
  fo.controls.push({ sync });
  sync();
  return h('div', h('p.dlg-note', 'Images to download:'), el);
}

/** A string kept as an array of single characters (CustomTagDelimiters). */
function charsInput(fo, key) {
  const i = h('input.inp', { attrs: { spellcheck: 'false', placeholder: '/;,' } });
  const sync = () => { i.value = (fo.get(key) || []).join(''); };
  i.addEventListener('input', () => fo.set(key, [...new Set(i.value.replace(/\s/g, '').split(''))]));
  fo.controls.push({ sync });
  sync();
  return i;
}
/** Lines kept as an array of strings. */
function linesInput(fo, key) {
  const i = h('textarea.inp.area', { attrs: { spellcheck: 'false' } });
  const sync = () => { i.value = (fo.get(key) || []).join('\n'); };
  i.addEventListener('input', () => fo.set(key, i.value.split('\n').map(x => x.trim()).filter(Boolean)));
  fo.controls.push({ sync });
  sync();
  return i;
}

// ---- library-wide settings ----------------------------------------------------------------------

async function displayPage(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Library display');
  ctx.setParent('#/admin/libraries');
  const fo = editForm({
    app,
    load: async () => ({ sys: await api.get('/System/Configuration'), meta: await api.get('/System/Configuration/metadata') }),
    save: async d => { await api.post('/System/Configuration', d.sys); await api.post('/System/Configuration/metadata', d.meta); },
  });
  await fo.ready;
  return h('div.eng-edit', subTabs('display'), deck('Display', { color: 'orange', num: 1 },
    row('Date added', fo.select('meta.UseFileCreationTimeForDateAdded', [['When the file was found', false], ['The file’s creation date', true]]), 'What "date added" means'),
    row('Folder view', fo.toggle('sys.EnableFolderView'), 'Show plain folders next to the libraries'),
    row('Specials within their seasons', fo.toggle('sys.DisplaySpecialsWithinSeasons'), 'Where they aired, not in season 0'),
    row('Group films into collections', fo.toggle('sys.EnableGroupingMoviesIntoCollections'), 'A collection in place of its films in film lists'),
    row('Group shows into collections', fo.toggle('sys.EnableGroupingShowsIntoCollections')),
    row('Suggest Live TV and channels', fo.toggle('sys.EnableExternalContentInSuggestions'))), fo.bar);
}

async function metadataPage(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Library metadata');
  ctx.setParent('#/admin/libraries');
  const [cultures, countries] = await Promise.all([api.get('/Localization/Cultures', undefined, { signal }).catch(() => []), api.get('/Localization/Countries', undefined, { signal }).catch(() => [])]);
  const fo = editForm({ app, load: () => api.get('/System/Configuration'), save: d => api.post('/System/Configuration', d) });
  await fo.ready;
  return h('div.eng-edit', subTabs('metadata'), deck('Metadata', { color: 'lilac', num: 1 },
    row('Preferred language', fo.select('PreferredMetadataLanguage', cultures.map(c => [c.DisplayName, c.TwoLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0]))), 'For libraries left on Default'),
    row('Country', fo.select('MetadataCountryCode', countries.map(c => [c.DisplayName, c.TwoLetterISORegionName]).sort((a, b) => a[0].localeCompare(b[0])))),
    h('h3.set-h', 'Chapters'),
    row('Chapter length when a file has none (minutes)', fo.num('DummyChapterDuration', { min: 0 }), '0: no made-up chapters'),
    row('Chapter image size', fo.select('ChapterImageResolution', RESOLUTIONS))), fo.bar);
}

async function nfoPage(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('NFO settings');
  ctx.setParent('#/admin/libraries');
  const users = await api.get('/Users', undefined, { signal }).catch(() => []);
  const fo = editForm({ app, load: () => api.get('/System/Configuration/xbmcmetadata'), save: d => api.post('/System/Configuration/xbmcmetadata', d) });
  await fo.ready;
  return h('div.eng-edit', subTabs('nfo'), deck('NFO (Kodi) metadata', { color: 'sky', num: 1 },
    h('p.dlg-note', 'For libraries that save NFO files: what goes into them.'),
    row('Watched and favourites of', fo.select('UserId', [['Nobody', ''], ...users.map(u => [u.Name, u.Id])]), 'Whose watch data is written'),
    row('Release date format', fo.text('ReleaseDateFormat', { placeholder: 'yyyy-MM-dd' })),
    row('Save image paths', fo.toggle('SaveImagePathsInNfo')),
    row('Path substitution', fo.toggle('EnablePathSubstitution'), 'Rewrite paths with the server’s path substitution'),
    row('Copy extra fanart to extrathumbs', fo.toggle('EnableExtraThumbsDuplication'))), fo.bar);
}
