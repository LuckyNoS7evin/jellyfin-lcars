// Item tools (admin stage A8): the editors the ⋯ menu used to hand to the official client.
// #/admin/edit/<itemId>/<tool>: metadata, images, identify, subtitles, lyrics. Official sources:
// components/metadataEditor, imageeditor + imageDownloader, itemidentifier, subtitleeditor +
// subtitleuploader, lyricseditor + lyricsuploader.
import { h, fill } from '../h.js';
import { TICKS } from '../api.js';
import * as f from '../fmt.js';
import { deck, btn, arrow, tag, empty, toast, loading, errorBox, epCode, numberBox } from '../ui.js';
import { confirmDialog } from '../menu.js';
import { editForm, row } from './form.js';

// ---- who may use what (official itemHelper) ---------------------------------------------------

const IDENTIFY = new Set(['Movie', 'Trailer', 'Series', 'BoxSet', 'Person', 'Book', 'MusicAlbum', 'MusicArtist', 'MusicVideo']);
const VIDEO = new Set(['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer']);
const isAdmin = me => !!me?.Policy?.IsAdministrator;

/** The tools an item offers this user, in tab order: [id, label]. */
export function toolsFor(item, me) {
  const admin = isAdmin(me);
  const t = [];
  if (admin && item.Type !== 'UserView' && item.Type !== 'CollectionFolder') t.push(['metadata', 'Metadata'], ['images', 'Images']);
  // A library's own picture (official LibraryCard "Edit images").
  if (admin && item.Type === 'CollectionFolder') t.push(['images', 'Images']);
  if (admin && IDENTIFY.has(item.Type) && item.LocationType !== 'Virtual') t.push(['identify', 'Identify']);
  if ((admin || me?.Policy?.EnableSubtitleManagement) && VIDEO.has(item.Type) && item.LocationType === 'FileSystem') t.push(['subtitles', 'Subtitles']);
  if (admin && item.Type === 'Audio') t.push(['lyrics', 'Lyrics']);
  return t;
}

export async function edit(ctx) {
  const { api, app, signal } = ctx;
  const [id, tool = 'metadata'] = ctx.sub;
  if (!/^[0-9a-f]{32}$/i.test(id || '')) { location.replace('#/admin/overview'); return h('div'); }
  const item = await api.get(`/Items/${id}`, { userId: api.userId, fields: 'MediaSources,People,ProviderIds,Taglines,Studios,Genres,Tags,LockedFields,ProductionLocations,ExternalUrls' }, { signal });
  const tools = toolsFor(item, app.me);
  if (!tools.length) { location.replace(`#/item/${id}`); return h('div'); }
  const cur = tools.find(([k]) => k === tool) ? tool : tools[0][0];
  ctx.setTitle(item.Name);
  // A library's page is its library view; the dashboard's library list is where this came from.
  const back = item.Type === 'CollectionFolder' ? '#/admin/libraries' : `#/item/${id}`;
  ctx.setParent(back);
  const sub = item.Type === 'Episode' ? [item.SeriesName, epCode(item)].filter(Boolean).join(' · ') : [item.Type, item.ProductionYear].filter(Boolean).join(' · ');
  const head = h('div.eng-edit-head',
    h('div', h('a.eng-edit-t', { href: back }, item.Name), h('span', item.Type === 'CollectionFolder' ? 'Library' : sub)),
    h('div.tabs', tools.map(([k, label]) => h('a.tab', { href: `#/admin/edit/${id}/${k}`, class: k === cur ? 'on' : '' }, label))));
  const body = await { metadata, images, identify, subtitles, lyrics }[cur](ctx, item);
  return h('div.eng-edit', head, body);
}

// ---- metadata -----------------------------------------------------------------------------------

const PERSON_TYPES = ['Actor', 'GuestStar', 'Director', 'Writer', 'Producer', 'Composer', 'Conductor', 'Lyricist', 'Arranger',
  'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller', 'Inker', 'Colorist',
  'Letterer', 'CoverArtist', 'Editor', 'Translator'];
const STATUS = [['', ''], ['Continuing', 'Continuing'], ['Ended', 'Ended'], ['Unreleased', 'Unreleased']];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FORMAT_3D = [['None', ''], ['Half side by side', 'HalfSideBySide'], ['Full side by side', 'FullSideBySide'], ['Full top and bottom', 'FullTopAndBottom'],
  ['Half top and bottom', 'HalfTopAndBottom'], ['MVC', 'MVC']];
const SERIES_ORDER = [['Aired', ''], ['Absolute', 'absolute'], ['DVD', 'dvd'], ['Digital', 'digital'], ['Story arc', 'storyArc'],
  ['Production', 'production'], ['TV', 'tv'], ['Alternate', 'alternate'], ['Regional', 'regional'], ['Alternate DVD', 'altdvd'], ['Alternate TV', 'alttv']];
const BOXSET_ORDER = [['Date modified', 'Default'], ['Name', 'SortName'], ['Release date', 'PremiereDate']];

async function metadata(ctx, item) {
  const { api, app, signal } = ctx;
  const info = await api.get(`/Items/${item.Id}/MetadataEditor`, undefined, { signal });
  const T = item.Type;
  const video = item.MediaType === 'Video';
  const person = T === 'Person';
  const noRatings = ['Person', 'Genre', 'Studio', 'MusicGenre'].includes(T);
  // The editor works on a copy with lists of names where the item has lists of objects.
  const toDraft = it => ({
    ...it,
    _Studios: (it.Studios || []).map(s => s.Name),
    _Artists: (it.ArtistItems || []).map(a => a.Name),
    _AlbumArtists: (it.AlbumArtists || []).map(a => a.Name),
    _Tagline: it.Taglines?.[0] || '',
    _Place: it.ProductionLocations?.[0] || '',
    _Runtime: T === 'Series' && it.RunTimeTicks ? Math.round(it.RunTimeTicks / 6e8) : null,
    _Enabled: null,
    ProviderIds: { ...(it.ProviderIds || {}) },
    People: (it.People || []).map(p => ({ Name: p.Name, Role: p.Role || '', Type: p.Type, Id: p.Id })),
  });
  let contentType = info.ContentType || '';
  const fo = editForm({
    app,
    load: () => toDraft(item),
    save: async d => {
      const named = (list, old) => list.map(n => old.find(o => o.Name === n) || { Name: n });
      const out = { ...d,
        Studios: named(d._Studios, item.Studios || []),
        ArtistItems: named(d._Artists, item.ArtistItems || []),
        AlbumArtists: named(d._AlbumArtists, item.AlbumArtists || []),
        Taglines: d._Tagline ? [d._Tagline] : [],
        ProductionLocations: person ? (d._Place ? [d._Place] : []) : item.ProductionLocations,
        People: d.People.filter(p => p.Name.trim()).map(p => ({ ...p, Name: p.Name.trim() })),
      };
      if (T === 'Series') out.RunTimeTicks = d._Runtime ? d._Runtime * 6e8 : null;
      for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
      await api.post(`/Items/${item.Id}`, out);
      if (ctypeSel && ctypeSel.value !== contentType) {
        await api.post(`/Items/${item.Id}/ContentType`, undefined, { contentType: ctypeSel.value });
        contentType = ctypeSel.value;
      }
      Object.assign(item, await api.get(`/Items/${item.Id}`, { userId: api.userId, fields: 'People,ProviderIds,Taglines,Studios,Genres,Tags,LockedFields,ProductionLocations' }));
    },
  });
  await fo.ready;

  const ratings = [['None', ''], ...(info.ParentalRatingOptions || []).map(r => [r.Name, r.Name])];
  if (item.OfficialRating && !ratings.some(([, v]) => v === item.OfficialRating)) ratings.push([item.OfficialRating, item.OfficialRating]);
  const langs = [['Default', ''], ...(info.Cultures || []).map(c => [c.DisplayName, c.TwoLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0]))];
  const countries = [['Default', ''], ...(info.Countries || []).map(c => [c.DisplayName, c.TwoLetterISORegionName]).sort((a, b) => a[0].localeCompare(b[0]))];
  const ctypeSel = info.ContentTypeOptions?.length ? h('select.sel', info.ContentTypeOptions.map(o => h('option', { value: o.Value, attrs: { selected: o.Value === contentType } }, o.Name))) : null;
  ctypeSel?.addEventListener('change', () => fo.changed());
  if (ctypeSel) { const d0 = fo.dirty; fo.dirty = () => d0() || ctypeSel.value !== contentType; }

  // Air days (series): ticks for each day, stored as names.
  const airDays = fo.checklist('AirDays', DAYS.map(d => [d.slice(0, 3), d]));

  // People: name, role, kind; reorder, remove, add.
  const peopleEl = h('div.eng-people');
  const drawPeople = () => {
    const list = fo.get('People') || [];
    // Always from the current list: each box edits one field of it.
    const now = () => (fo.get('People') || []).map(p => ({ ...p }));
    const put = (i, k, v) => { const l = now(); l[i][k] = v; fo.set('People', l); };
    const move = (i, j) => { const l = now(); [l[i], l[j]] = [l[j], l[i]]; fo.set('People', l); drawPeople(); };
    fill(peopleEl,
      list.length ? list.map((p, i) => {
        const name = h('input.inp', { value: p.Name, attrs: { placeholder: 'Name', spellcheck: 'false' } });
        name.addEventListener('input', () => put(i, 'Name', name.value));
        const role = h('input.inp', { value: p.Role || '', attrs: { placeholder: 'Role', spellcheck: 'false' } });
        role.addEventListener('input', () => put(i, 'Role', role.value));
        const kind = h('select.sel', PERSON_TYPES.map(t => h('option', { value: t, attrs: { selected: t === p.Type } }, t.replace(/([a-z])([A-Z])/g, '$1 $2'))));
        kind.addEventListener('change', () => put(i, 'Type', kind.value));
        return h('div.eng-person', name, role, kind,
          btn(arrow('u'), () => move(i, i - 1), { small: true, ico: true, color: 'lilac', ghost: true, disabled: i === 0, title: 'Up' }),
          btn(arrow('d'), () => move(i, i + 1), { small: true, ico: true, color: 'lilac', ghost: true, disabled: i === list.length - 1, title: 'Down' }),
          btn('✕', () => { fo.set('People', now().filter((_, j) => j !== i)); drawPeople(); }, { small: true, ico: true, color: 'red', ghost: true, title: 'Remove' }));
      }) : h('p.dlg-note', 'Nobody listed.'),
      btn('Add a person', () => { fo.set('People', [...now(), { Name: '', Role: '', Type: 'Actor' }]); drawPeople(); requestAnimationFrame(() => peopleEl.querySelector('.eng-person:last-of-type input')?.focus()); }, { small: true, color: 'blue' }));
  };
  fo.controls.push({ sync: drawPeople });
  drawPeople();

  // External ids: one box per provider the server knows for this type.
  const ids = (info.ExternalIdInfos || []).map(x => {
    const i = h('input.inp', { attrs: { spellcheck: 'false', placeholder: x.Name } });
    const sync = () => { i.value = fo.get('ProviderIds')?.[x.Key] || ''; };
    i.addEventListener('input', () => fo.set('ProviderIds', { ...fo.get('ProviderIds'), [x.Key]: i.value.trim() || undefined }));
    fo.controls.push({ sync });
    sync();
    return row(`${x.Name}${x.Type ? ` (${x.Type})` : ''}`, i);
  });

  // Fields the server may overwrite on refresh: shown as "enabled", stored as LockedFields.
  const LOCKABLE = [['Name', 'Name'], ['Overview', 'Overview'], ['Genres', 'Genres'], ['Parental rating', 'OfficialRating'], ['People', 'Cast'],
    [person ? 'Birthplace' : 'Production locations', 'ProductionLocations'], ...(T === 'Series' ? [['Runtime', 'Runtime']] : []), ['Studios', 'Studios'], ['Tags', 'Tags']];
  const lockEl = h('div.eng-checks');
  const drawLocks = () => {
    const locked = new Set(fo.get('LockedFields') || []);
    const all = !!fo.get('LockData');
    fill(lockEl, LOCKABLE.map(([label, v]) => {
      const b = h('button.eng-check', { type: 'button', class: !locked.has(v) && !all ? 'on' : '', disabled: all, title: locked.has(v) ? 'Locked: refreshes leave it alone' : 'Refreshes may update it' }, label);
      b.addEventListener('click', () => {
        const s = new Set(fo.get('LockedFields') || []);
        if (s.has(v)) s.delete(v); else s.add(v);
        fo.set('LockedFields', [...s]);
        drawLocks();
      });
      return b;
    }));
  };
  fo.controls.push({ sync: drawLocks });
  drawLocks();
  const lockAll = fo.toggle('LockData');
  lockAll.addEventListener('click', drawLocks);

  const show = (cond, ...r) => (cond ? r : null);
  const general = deck('General', { color: 'orange', num: 1 },
    item.Path ? row('Path', h('span.eng-ro', item.Path)) : null,
    ctypeSel ? row('Content type', ctypeSel, 'What kind of media this folder holds') : null,
    row(person ? 'Name' : 'Title', fo.text('Name')),
    show(['Series', 'Season', 'Episode', 'Movie', 'Trailer', 'Person'].includes(T), row(person ? 'Original name' : 'Original title', fo.text('OriginalTitle'))),
    show(T === 'Series' || item.MediaType === 'Video', row('Original language', fo.select('OriginalLanguage', [['Not set', ''], ...langs.slice(1)]), 'The language it was made in')),
    row('Sort name', fo.text('ForcedSortName', { placeholder: item.SortName || '' }), 'Empty: the server works it out'),
    show(T === 'Episode' || T === 'Season' || T === 'Audio', row(T === 'Audio' ? 'Disc number' : 'Season number', fo.num('ParentIndexNumber', { min: 0, zero: null }))),
    show(T === 'Episode' || T === 'Audio' || T === 'Season', row(T === 'Audio' ? 'Track number' : T === 'Season' ? 'Season number' : 'Episode number', fo.num('IndexNumber', { min: 0, zero: null }))),
    show(T === 'Book', row('Series', fo.text('SeriesName'))),
    show(T === 'Audio' || T === 'MusicVideo', row('Album', fo.text('Album'))),
    show(['Audio', 'MusicAlbum', 'MusicVideo'].includes(T), row('Artists', fo.tags('_Artists', { placeholder: 'Add an artist' })), row('Album artists', fo.tags('_AlbumArtists', { placeholder: 'Add an artist' }))),
    show(video && T !== 'Episode', row('Tagline', fo.text('_Tagline'))),
    row(person ? 'Biography' : 'Overview', fo.text('Overview', { area: true })));

  const dates = deck(person ? 'Life' : 'Dates and ratings', { color: 'peach', num: 2 },
    row(person ? 'Born' : 'Release date', fo.date('PremiereDate')),
    row(person ? 'Birth year' : 'Year', fo.num('ProductionYear', { min: 1000, max: 3000, zero: null })),
    show(T === 'Series' || person, row(person ? 'Died' : 'Ended', fo.date('EndDate'))),
    show(person, row('Birthplace', fo.text('_Place'))),
    show(T !== 'Person', row('Date added', fo.date('DateCreated'))),
    show(T === 'Series', row('Status', fo.select('Status', STATUS)), row('Air days', airDays), row('Air time', fo.text('AirTime', { placeholder: '20:00' })),
      row('Runtime (minutes)', fo.num('_Runtime', { min: 0, zero: null }))),
    show(!noRatings, row('Community rating', fo.num('CommunityRating', { min: 0, max: 10, step: 0.1, int: false, zero: null }), '0 to 10')),
    show(T === 'Movie' || T === 'Trailer', row('Critic rating', fo.num('CriticRating', { min: 0, max: 100, zero: null }), '0 to 100')),
    show(!noRatings, row('Parental rating', fo.select('OfficialRating', ratings)), row('Custom rating', fo.select('CustomRating', ratings), 'Overrides the parental rating for filtering')),
    show(video, row('Aspect ratio', fo.text('AspectRatio', { placeholder: '16:9' })), row('3D format', fo.select('Video3DFormat', FORMAT_3D))),
    show(T === 'Episode' && item.ParentIndexNumber === 0,
      row('Airs before season', fo.num('AirsBeforeSeasonNumber', { min: 0, zero: null })),
      row('Airs after season', fo.num('AirsAfterSeasonNumber', { min: 0, zero: null })),
      row('Airs before episode', fo.num('AirsBeforeEpisodeNumber', { min: 0, zero: null }))),
    show(T === 'Series', row('Episode order', fo.select('DisplayOrder', SERIES_ORDER), 'Which numbering the episodes follow')),
    show(T === 'BoxSet', row('Order', fo.select('DisplayOrder', BOXSET_ORDER))));

  const lists = deck('Genres, studios and tags', { color: 'lilac', num: 3 },
    show(!noRatings, row('Genres', fo.tags('Genres', { placeholder: 'Add a genre' })), row('Studios', fo.tags('_Studios', { placeholder: 'Add a studio' }))),
    row('Tags', fo.tags('Tags')));

  const people = ['Person', 'Genre', 'Studio', 'MusicGenre'].includes(T) ? null : deck('People', { color: 'sky', num: 4 }, peopleEl);

  const ext = deck('External ids and metadata', { color: 'blue', num: 5 },
    ids.length ? ids : h('p.dlg-note', 'No metadata providers for this type.'),
    row('Metadata language', fo.select('PreferredMetadataLanguage', langs)),
    row('Metadata country', fo.select('PreferredMetadataCountryCode', countries)),
    h('h3.set-h', 'Fields a refresh may change'),
    row('Lock everything', lockAll, 'Refreshes leave this item alone'),
    lockEl);

  return h('div.eng-grid', h('div.eng-col', general, dates, lists), h('div.eng-col', people, ext), fo.bar);
}

// ---- images -------------------------------------------------------------------------------------

const IMAGE_TYPES = [['Primary', 'Primary'], ['Backdrop', 'Backdrop'], ['Logo', 'Logo'], ['Thumb', 'Thumb'], ['Banner', 'Banner'],
  ['Art', 'Clear art'], ['Disc', 'Disc'], ['Box', 'Box'], ['BoxRear', 'Box rear'], ['Screenshot', 'Screenshot'], ['Menu', 'Menu']];

async function images(ctx, item) {
  const { api, signal } = ctx;
  const body = h('div');
  const fileIn = h('input', { type: 'file', attrs: { accept: 'image/*', hidden: true } });
  let uploadType = 'Primary';

  async function draw() {
    let infos;
    try { infos = await api.get(`/Items/${item.Id}/Images`, undefined, { signal }); } catch (e) { fill(body, errorBox(e)); return; }
    const byType = t => infos.filter(i => i.ImageType === t).sort((a, b) => (a.ImageIndex || 0) - (b.ImageIndex || 0));
    const have = IMAGE_TYPES.filter(([t]) => byType(t).length);
    const card = (info, list) => {
      const idx = info.ImageIndex ?? 0;
      const src = api.img(item.Id, info.ImageType, { tag: info.ImageTag, index: info.ImageType === 'Backdrop' || info.ImageType === 'Screenshot' ? idx : undefined, h: 240 });
      return h('div.eng-img',
        h('img', { src, alt: '', attrs: { loading: 'lazy' } }),
        h('div.eng-img-m', h('span', info.Width && info.Height ? `${info.Width} × ${info.Height}` : ''), h('span', info.Size ? f.bytes(info.Size) : '')),
        h('div.eng-img-a',
          list.length > 1 && idx > 0 ? btn(arrow('l'), () => reorder(info, idx - 1), { small: true, ico: true, color: 'lilac', ghost: true, title: 'Earlier' }) : null,
          list.length > 1 && idx < list.length - 1 ? btn(arrow('r'), () => reorder(info, idx + 1), { small: true, ico: true, color: 'lilac', ghost: true, title: 'Later' }) : null,
          btn('Delete', () => remove(info), { small: true, color: 'red', ghost: true })));
    };
    fill(body,
      h('div.actions.eng-img-bar',
        btn('Search online', () => searchRemote(), { color: 'sky' }),
        h('span.eng-img-up',
          h('label.eng-inline', h('span', 'Upload as'), h('select.sel', { onchange: e => { uploadType = e.target.value; } }, IMAGE_TYPES.map(([t, l]) => h('option', { value: t, attrs: { selected: t === uploadType } }, l)))),
          btn('Upload', () => fileIn.click(), { color: 'orange' }))),
      // One group per image type, side by side.
      have.length ? h('div.eng-imgtypes', have.map(([t, label]) => h('div.eng-imgtype', h('h3.set-h', label), h('div.eng-imgs', byType(t).map(i => card(i, byType(t))))))) : empty('No images yet.'),
      fileIn);
  }
  async function reorder(info, to) {
    try { await api.post(`/Items/${item.Id}/Images/${info.ImageType}/${info.ImageIndex}/Index`, undefined, { newIndex: to }); draw(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  async function remove(info) {
    if (!(await confirmDialog('Delete image', `Delete this ${info.ImageType.toLowerCase()} image from “${item.Name}”?`, 'Delete'))) return;
    try { await api.del(`/Items/${item.Id}/Images/${info.ImageType}/${info.ImageIndex ?? 0}`); toast('Image deleted', '', 'red', 2000); draw(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      await api.req('POST', `/Items/${item.Id}/Images/${uploadType}`, { raw: { data, type: file.type || 'image/jpeg' } });
      toast('Image uploaded', uploadType, 'sky', 2000);
      draw();
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  });

  // Search the providers (official imageDownloader): by type and provider, all languages or not.
  async function searchRemote() {
    const resBody = h('div');
    let type = 'Primary', provider = '', allLangs = false;
    let providers = [];
    try { providers = await api.get(`/Items/${item.Id}/RemoteImages/Providers`); } catch { /* none */ }
    const types = IMAGE_TYPES.filter(([t]) => providers.some(p => p.SupportedImages?.includes(t)));
    async function run() {
      fill(resBody, loading('Searching'));
      try {
        const r = await api.get(`/Items/${item.Id}/RemoteImages`, { type, providerName: provider || undefined, includeAllLanguages: allLangs, limit: 60 });
        fill(resBody, r.Images?.length ? h('div.eng-imgs.remote', r.Images.map(im => h('div.eng-img',
          h('img', { src: im.ThumbnailUrl || im.Url, alt: '', attrs: { loading: 'lazy', referrerpolicy: 'no-referrer' } }),
          h('div.eng-img-m', h('span', [im.ProviderName, im.Language].filter(Boolean).join(' · ')), h('span', im.Width ? `${im.Width} × ${im.Height}` : '')),
          im.CommunityRating ? h('div.eng-img-m', h('span', `★ ${im.CommunityRating.toFixed(1)}${im.VoteCount ? ` (${im.VoteCount})` : ''}`)) : null,
          h('div.eng-img-a', btn('Use this', async () => {
            try {
              await api.post(`/Items/${item.Id}/RemoteImages/Download`, undefined, { type, imageUrl: im.Url });
              toast('Image saved', type, 'sky', 2000);
              d.close();
              draw();
            } catch (e) { toast('Unable to comply', e.message, 'red'); }
          }, { small: true, color: 'orange' }))))) : empty('Nothing found.'));
      } catch (e) { fill(resBody, errorBox(e)); }
    }
    const { dialog } = await import('../menu.js');
    const d = dialog(`Images for ${item.Name}`, [
      h('div.rc-opts',
        h('label.rc-sel', h('span', 'Type'), h('select.sel', { onchange: e => { type = e.target.value; run(); } }, (types.length ? types : IMAGE_TYPES).map(([t, l]) => h('option', { value: t }, l)))),
        h('label.rc-sel', h('span', 'Provider'), h('select.sel', { onchange: e => { provider = e.target.value; run(); } }, h('option', { value: '' }, 'All'), providers.map(p => h('option', { value: p.Name }, p.Name)))),
        h('label.eng-allor-h', h('button.toggle', { type: 'button', onclick: e => { allLangs = !allLangs; e.currentTarget.classList.toggle('on', allLangs); e.currentTarget.textContent = allLangs ? 'On' : 'Off'; run(); } }, 'Off'), h('span', 'All languages'))),
      resBody,
    ], [btn('Close', () => d.close(), { color: 'lilac', ghost: true })], { color: 'sky', wide: true });
    run();
  }

  draw();
  return deck('Images', { color: 'sky', num: 1 }, body);
}

// ---- identify -----------------------------------------------------------------------------------

async function identify(ctx, item) {
  const { api, signal } = ctx;
  const idInfos = await api.get(`/Items/${item.Id}/ExternalIdInfos`, undefined, { signal }).catch(() => []);
  const name = h('input.inp', { value: item.Name || '', attrs: { spellcheck: 'false' } });
  const year = h('input.inp.num', { type: 'number', value: item.ProductionYear || '', attrs: { min: 1000, max: 3000 } });
  const idIns = idInfos.map(x => [x, h('input.inp', { value: item.ProviderIds?.[x.Key] || '', attrs: { spellcheck: 'false', placeholder: x.Name } })]);
  const results = h('div');
  let replaceImages = true;
  const replaceT = h('button.toggle.on', { type: 'button', onclick: () => { replaceImages = !replaceImages; replaceT.classList.toggle('on', replaceImages); replaceT.textContent = replaceImages ? 'On' : 'Off'; } }, 'On');

  async function search(e) {
    e?.preventDefault();
    fill(results, loading('Searching'));
    const ProviderIds = {};
    for (const [x, i] of idIns) if (i.value.trim()) ProviderIds[x.Key] = i.value.trim();
    try {
      const r = await api.post(`/Items/RemoteSearch/${item.Type}`, {
        SearchInfo: { Name: name.value.trim(), Year: year.value ? Number(year.value) : undefined, ProviderIds },
        ItemId: item.Id, IncludeDisabledProviders: true,
      });
      fill(results, r?.length ? h('div.eng-ident', r.map(res => h('div.eng-ident-r',
        res.ImageUrl ? h('img', { src: res.ImageUrl, alt: '', attrs: { loading: 'lazy', referrerpolicy: 'no-referrer' } }) : h('div.noimg'),
        h('div.eng-ident-b',
          h('b', res.Name), h('span', [res.ProductionYear, res.SearchProviderName].filter(Boolean).join(' · ')),
          res.Overview ? h('p', res.Overview.length > 240 ? `${res.Overview.slice(0, 240)}…` : res.Overview) : null,
          h('div.eng-sess-m', Object.entries(res.ProviderIds || {}).map(([k, v]) => tag(`${k} ${v}`, 'blue')))),
        btn('This one', () => apply(res), { color: 'orange', small: true })))) : empty('No matches. Try fewer words, the original title, or an id.'));
    } catch (err) { fill(results, errorBox(err)); }
  }
  async function apply(res) {
    const ok = await confirmDialog('Identify', `Match “${item.Name}” to “${res.Name}${res.ProductionYear ? ` (${res.ProductionYear})` : ''}”? Its metadata${replaceImages ? ' and images' : ''} are replaced from ${res.SearchProviderName || 'the provider'}.`, 'Match', 'orange');
    if (!ok) return;
    try {
      await api.post(`/Items/RemoteSearch/Apply/${item.Id}`, res, { replaceAllImages: replaceImages });
      toast('Matched', `${res.Name}: the server is refreshing it now`, 'sky', 5000);
      location.hash = `#/item/${item.Id}`;
    } catch (err) { toast('Unable to comply', err.message, 'red'); }
  }
  const form = h('form.set-form', { onsubmit: search },
    row('Name', name), row('Year', numberBox(year)),
    idIns.map(([x, i]) => row(`${x.Name}${x.Type ? ` (${x.Type})` : ''}`, i)),
    row('Replace existing images', replaceT),
    h('div.actions', btn('Search', null, { type: 'submit', color: 'orange' })));
  return h('div.eng-grid', h('div.eng-col', deck('Identify', { color: 'orange', num: 1 },
    h('p.dlg-note', 'Search the metadata providers and pick the right match. Fill in an id (IMDb, TMDb, TVDB...) for an exact hit.'), form)),
  h('div.eng-col', deck('Matches', { color: 'sky', num: 2 }, results)));
}

// ---- subtitles ----------------------------------------------------------------------------------

const SUB_FORMATS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'smi', 'ttml'];

async function subtitles(ctx, item) {
  const { api, app, signal } = ctx;
  const admin = isAdmin(app.me);
  const cultures = await api.get('/Localization/Cultures', undefined, { signal }).catch(() => []);
  const langs = cultures.filter(c => c.ThreeLetterISOLanguageName).map(c => [c.DisplayName, c.ThreeLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0]));
  const pref = app.us?.config?.SubtitleLanguagePreference || 'eng';
  const currentEl = h('div');
  const resultsEl = h('div');

  async function drawCurrent() {
    const it = await api.get(`/Items/${item.Id}`, { userId: api.userId, fields: 'MediaSources' });
    const subs = (it.MediaSources?.[0]?.MediaStreams || []).filter(s => s.Type === 'Subtitle');
    fill(currentEl, subs.length ? h('div.eng-subs', subs.map(s => h('div.eng-sub',
      h('b', s.DisplayTitle || s.Language || `Track ${s.Index}`),
      h('span', [s.Codec, s.IsExternal ? 'file' : 'in the video', s.IsForced ? 'forced' : '', s.IsHearingImpaired ? 'SDH' : ''].filter(Boolean).join(' · ')),
      s.IsExternal && s.Path ? h('span.eng-ro', s.Path) : null,
      s.IsExternal && admin ? btn('Delete', async () => {
        if (!(await confirmDialog('Delete subtitles', `Delete ${s.DisplayTitle || 'this subtitle file'}? The file is removed from the disk.`, 'Delete'))) return;
        try { await api.del(`/Videos/${item.Id}/Subtitles/${s.Index}`); toast('Subtitles deleted', '', 'red', 2000); refreshSoon(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
      }, { small: true, color: 'red', ghost: true }) : null))) : empty('No subtitles yet.'));
  }

  // Jellyfin adds a new or removed file to the item in a background refresh a few seconds
  // later, so look again then.
  const refreshSoon = () => { drawCurrent(); for (const ms of [2500, 6000]) setTimeout(() => { if (currentEl.isConnected) drawCurrent(); }, ms); };

  const langSel = h('select.sel', langs.map(([l, v]) => h('option', { value: v, attrs: { selected: v === pref } }, l)));
  let perfect = false;
  const perfectT = h('button.toggle', { type: 'button', onclick: () => { perfect = !perfect; perfectT.classList.toggle('on', perfect); perfectT.textContent = perfect ? 'On' : 'Off'; } }, 'Off');
  async function search(e) {
    e?.preventDefault();
    fill(resultsEl, loading('Searching'));
    try {
      const r = await api.get(`/Items/${item.Id}/RemoteSearch/Subtitles/${langSel.value}`, { isPerfectMatch: perfect });
      fill(resultsEl, r?.length ? h('div.eng-subs', r.map(s => h('div.eng-sub',
        h('b', s.Name),
        h('span', [s.ProviderName, s.Format, s.IsHashMatch ? 'exact file match' : '', s.HearingImpaired ? 'SDH' : '', s.Forced ? 'forced' : '',
          s.DownloadCount ? `${f.num(s.DownloadCount)} downloads` : '', s.CommunityRating ? `★ ${s.CommunityRating}` : ''].filter(Boolean).join(' · ')),
        s.Comment ? h('span.eng-ro', s.Comment) : null,
        btn('Download', async () => {
          try { await api.post(`/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(s.Id)}`); toast('Subtitles downloaded', s.Name, 'sky', 2500); refreshSoon(); } catch (err) { toast('Unable to comply', err.message, 'red'); }
        }, { small: true, color: 'orange' })))) : empty('Nothing found. Is a subtitle provider plugin installed (Open Subtitles, for one)?'));
    } catch (err) { fill(resultsEl, errorBox(err)); }
  }

  // Upload a file (official subtitleuploader): language, forced, SDH, base64 data.
  const fileIn = h('input', { type: 'file', attrs: { accept: SUB_FORMATS.map(x => `.${x}`).join(','), hidden: true } });
  const upLang = h('select.sel', langs.map(([l, v]) => h('option', { value: v, attrs: { selected: v === pref } }, l)));
  let forced = false, sdh = false;
  const tgl = (label, get, set) => { const b = h('button.toggle', { type: 'button' }, 'Off'); b.addEventListener('click', () => { set(!get()); b.classList.toggle('on', get()); b.textContent = get() ? 'On' : 'Off'; }); return row(label, b); };
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    const fmt = (file.name.split('.').pop() || '').toLowerCase();
    if (!SUB_FORMATS.includes(fmt)) { toast('Not a subtitle file', `Allowed: ${SUB_FORMATS.join(', ')}`, 'red'); return; }
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      await api.post(`/Videos/${item.Id}/Subtitles`, { Language: upLang.value, Format: fmt, IsForced: forced, IsHearingImpaired: sdh, Data: data });
      toast('Subtitles uploaded', file.name, 'sky', 2500);
      refreshSoon();
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  });

  drawCurrent();
  return h('div.eng-grid',
    h('div.eng-col',
      deck('Subtitles', { color: 'sky', num: 1 }, currentEl),
      deck('Upload', { color: 'orange', num: 2 },
        row('Language', upLang), tgl('Forced', () => forced, v => { forced = v; }), tgl('For the hard of hearing', () => sdh, v => { sdh = v; }),
        h('div.actions', btn('Choose a file', () => fileIn.click(), { color: 'orange' })), fileIn)),
    h('div.eng-col', deck('Search', { color: 'lilac', num: 3 },
      h('form.set-form', { onsubmit: search }, row('Language', langSel), row('Exact file matches only', perfectT),
        h('div.actions', btn('Search', null, { type: 'submit', color: 'lilac' }))),
      resultsEl)));
}

// ---- lyrics -------------------------------------------------------------------------------------

/** Lyrics as LRC text: [mm:ss.xx] before each timed line. */
function toLrc(r) {
  const meta = r?.Metadata || {};
  const head = [['ar', meta.Artist], ['al', meta.Album], ['ti', meta.Title], ['by', meta.Author]].filter(([, v]) => v).map(([k, v]) => `[${k}:${v}]`);
  const lines = (r?.Lyrics || []).map(l => {
    if (l.Start == null) return l.Text || '';
    const s = l.Start / TICKS;
    return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]${l.Text || ''}`;
  });
  return [...head, ...lines].join('\n');
}

async function lyrics(ctx, item) {
  const { api, app } = ctx;
  let current = null;
  try { current = await api.get(`/Audio/${item.Id}/Lyrics`); } catch { /* none (404) */ }
  const text = h('textarea.inp.area.eng-lrc', { attrs: { spellcheck: 'false', placeholder: '[00:12.00]First line\n[00:15.50]Second line\n\nor plain text without times' } });
  const fo = editForm({ app, load: () => ({ text: toLrc(current) }), save: async d => {
    await api.req('POST', `/Audio/${item.Id}/Lyrics`, { query: { fileName: `${item.Name || 'lyrics'}.lrc` }, raw: { data: d.text, type: 'text/plain' } });
  } });
  await fo.ready;
  text.value = fo.get('text');
  text.addEventListener('input', () => fo.set('text', text.value));
  fo.controls.push({ sync: () => { text.value = fo.get('text'); } });

  const resultsEl = h('div');
  async function search() {
    fill(resultsEl, loading('Searching'));
    try {
      const r = await api.get(`/Audio/${item.Id}/RemoteSearch/Lyrics`);
      fill(resultsEl, r?.length ? h('div.eng-subs', r.map(x => h('div.eng-sub',
        h('b', [x.Lyrics?.Metadata?.Artist, x.Lyrics?.Metadata?.Title].filter(Boolean).join(' · ') || 'Lyrics'),
        h('span', [x.ProviderName, x.Lyrics?.Lyrics?.some(l => l.Start != null) ? 'synced' : 'plain'].filter(Boolean).join(' · ')),
        h('span.eng-ro', (x.Lyrics?.Lyrics || []).slice(0, 3).map(l => l.Text).join(' / ')),
        btn('Use these', async () => {
          try { await api.post(`/Audio/${item.Id}/RemoteSearch/Lyrics/${encodeURIComponent(x.Id)}`); toast('Lyrics saved', '', 'sky', 2000); app.refresh(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
        }, { small: true, color: 'orange' })))) : empty('Nothing found. Is a lyrics provider plugin installed?'));
    } catch (e) { fill(resultsEl, errorBox(e)); }
  }
  return h('div.eng-grid',
    h('div.eng-col', deck('Lyrics', { color: 'sky', num: 1 },
      h('p.dlg-note', 'LRC: a [minutes:seconds] time before each line makes them follow the song in the audio queue. Saving writes a .lrc file next to the track.'),
      text,
      current ? h('div.actions', btn('Delete lyrics', async () => {
        if (!(await confirmDialog('Delete lyrics', 'Delete the lyrics file for this track?', 'Delete'))) return;
        try { await api.del(`/Audio/${item.Id}/Lyrics`); toast('Lyrics deleted', '', 'red', 2000); app.leaveGuard?.clear(); app.refresh(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
      }, { color: 'red', ghost: true })) : null,
      fo.bar)),
    h('div.eng-col', deck('Search', { color: 'lilac', num: 2 }, h('div.actions', btn('Search the providers', search, { color: 'lilac' })), resultsEl)));
}

// ---- versions -----------------------------------------------------------------------------------

/** Undo a manual "group versions" (official itemDetails: only for a Grouping media source). */
export async function splitVersions(ctx, item) {
  if (!(await confirmDialog('Split versions', `Split “${item.Name}” back into separate items? Versions grouped by file name (in one folder) can't be split.`, 'Split', 'orange'))) return false;
  try { await ctx.api.del(`/Videos/${item.Id}/AlternateSources`); toast('Versions split', item.Name, 'sky'); return true; } catch (e) { toast('Unable to comply', e.message, 'red'); return false; }
}

/** Group selected films (or videos) as versions of one item. */
export async function groupVersions(ctx, items) {
  if (!(await confirmDialog('Group versions', `Make ${items.map(i => `“${i.Name}”`).join(', ')} versions of one item? You pick the version when you play it.`, 'Group', 'orange'))) return false;
  try { await ctx.api.post('/Videos/MergeVersions', undefined, { ids: items.map(i => i.Id) }); toast('Versions grouped', `${items.length} items`, 'sky'); return true; } catch (e) { toast('Unable to comply', e.message, 'red'); return false; }
}

