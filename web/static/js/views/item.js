// Details for any item: films and episodes (play, tracks, cast), series and seasons
// (episodes), albums and artists (tracks), collections, playlists and people.
import { native } from '../shell.js';
import { h, fill } from '../h.js';
import { Api, TICKS } from '../api.js';
import * as f from '../fmt.js';
import {
  deck, card, empty, errorBox, loading, btn, tag, ro, missingState, missingTag, itemHref, runtime, epCode, years, pickImage, image, code, toast,
  canMarkPlayed, canRate, onUserData, swapKeepingFocus,
} from '../ui.js';
import { themeFor } from '../player/theme.js';
import { menuButton, canManageCollections, download } from '../menu.js';
import { addSelectAction } from '../select.js';

/** Where Back goes when there's no history: one level up. */
function parentOf(it) {
  if (it.Type === 'Episode') return `#/item/${it.SeasonId || it.SeriesId}`;
  if (it.Type === 'Season') return `#/item/${it.SeriesId}`;
  if (it.Type === 'Audio' && it.AlbumId) return `#/item/${it.AlbumId}`;
  if (it.Type === 'MusicAlbum' && it.AlbumArtists?.[0]) return `#/item/${it.AlbumArtists[0].Id}`;
  if (it.Type === 'Person') return '#/home';
  return it.ParentId ? `#/item/${it.ParentId}` : '#/home';
}

const VIDEO_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer']);
// Title pages that play theme songs/videos (their own or inherited from the series).
const THEMED = new Set(['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video']);

export async function item(ctx) {
  const { api, params } = ctx;
  const it = await api.item(params.id);
  if (it.Type === 'CollectionFolder' || it.Type === 'UserView') { location.replace(`#/lib/${it.Id}`); return h('div'); }
  ctx.setTitle(it.Type === 'Episode' ? it.SeriesName : it.Name);
  ctx.setParent(parentOf(it));
  if (VIDEO_TYPES.has(it.Type)) return videoItem(ctx, it);
  switch (it.Type) {
    case 'Series': return series(ctx, it);
    case 'Season': return season(ctx, it);
    case 'MusicAlbum': return album(ctx, it);
    case 'MusicArtist': return artist(ctx, it);
    case 'Audio': return audioItem(ctx, it);
    case 'Person': return person(ctx, it);
    case 'Playlist': return playlist(ctx, it);
    default: return folder(ctx, it);
  }
}

// ---- shared pieces ----------------------------------------------------------------------

/** Async deck: shows "accessing" until load() resolves. */
function lazyDeck(title, opts, load) {
  const body = h('div', loading());
  const el = deck(title, opts, body);
  load().then(n => fill(body, n)).catch(e => fill(body, errorBox(e)));
  return el;
}

function backdrop(api, it) {
  if (it.BackdropImageTags?.length) return api.img(it.Id, 'Backdrop', { tag: it.BackdropImageTags[0], index: 0, w: 1920 });
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags?.length) {
    return api.img(it.ParentBackdropItemId, 'Backdrop', { tag: it.ParentBackdropImageTags[0], index: 0, w: 1920 });
  }
  return null;
}

/** Every backdrop of the item (or its series/parent), for the page background. */
function backdropUrls(api, it) {
  if (it.BackdropImageTags?.length) return it.BackdropImageTags.map((tag, i) => api.img(it.Id, 'Backdrop', { tag, index: i, w: 1920 }));
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags?.length) {
    return it.ParentBackdropImageTags.map((tag, i) => api.img(it.ParentBackdropItemId, 'Backdrop', { tag, index: i, w: 1920 }));
  }
  return [];
}

function facts(it) {
  const out = [];
  const y = years(it);
  if (y) out.push(y);
  if (it.OfficialRating) out.push(it.OfficialRating);
  if (it.CommunityRating) out.push(`★ ${it.CommunityRating.toFixed(1)}`);
  if (it.CriticRating) out.push(`${it.CriticRating}% critics`);
  const rt = runtime(it);
  if (rt && it.Type !== 'Series') out.push(rt);
  if (it.RunTimeTicks && VIDEO_TYPES.has(it.Type)) {
    const left = (it.RunTimeTicks - (it.UserData?.PlaybackPositionTicks || 0)) / TICKS;
    out.push(`Ends ${new Date(Date.now() + left * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
  }
  return out.join('  ·  ');
}

function hero(ctx, it, { kicker, actions = [], extra = [], shape } = {}) {
  const { api, app } = ctx;
  // With full-page backdrops on, the banner would draw the same art twice (ghosting).
  const bg = app.us.detailsBanner && !app.us.backdrops ? backdrop(api, it) : null;
  app.backdrops(backdropUrls(api, it));
  const media = h('div.hero-media', bg ? h('img.hero-bg', { src: bg, alt: '', attrs: { decoding: 'async' } }) : null);
  if (THEMED.has(it.Type)) themeFor(ctx, it, media);
  const im = pickImage(it, shape === 'wide' ? 'wide' : 'poster');
  const poster = im ? h('img.hero-poster', { src: api.img(im.id, im.type, { tag: im.tag, h: 640 }), alt: '' }) : null;
  const overview = it.Overview ? h('p.overview.clamp', { title: 'Show all', onclick: e => e.currentTarget.classList.toggle('clamp') }, it.Overview) : null;
  // The logo (the item's, or its series'), the original title when it differs, and the
  // tagline, as on the official details page.
  const logo = it.ImageTags?.Logo ? api.img(it.Id, 'Logo', { tag: it.ImageTags.Logo, h: 160 })
    : it.ParentLogoItemId && it.ParentLogoImageTag ? api.img(it.ParentLogoItemId, 'Logo', { tag: it.ParentLogoImageTag, h: 160 }) : null;
  const original = it.OriginalTitle && it.OriginalTitle !== it.Name ? h('div.hero-orig', it.OriginalTitle) : null;
  const tagline = it.Taglines?.[0] ? h('p.tagline', it.Taglines[0]) : null;
  return h('div.hero',
    media,
    logo ? h('img.hero-logo', { src: logo, alt: '', attrs: { decoding: 'async' } }) : null,
    h('div.hero-in', { class: [poster ? '' : 'noposter', shape === 'square' || shape === 'wide' ? shape : ''].join(' ') },
      poster,
      h('div.hero-text',
        kicker ? h('div.hero-kicker', kicker) : null,
        h('h1.hero-title', it.Name),
        original,
        h('div.hero-sub', facts(it)),
        airs(it),
        tagline,
        overview,
        detailsList(it),
        actions.length ? h('div.actions', actions) : null,
        extra)));
}

/** Played / favourite toggles that update in place. */
/** Genres, director, writers, studios and external links (IMDb, TheTVDB, TMDB...). */
function detailsList(it) {
  const people = type => (it.People || []).filter(p => p.Type === type);
  const join = (list, render) => list.flatMap((x, i) => (i ? [', ', render(x)] : [render(x)]));
  const personLinks = list => join(list, p => h('a', { href: `#/item/${p.Id}` }, p.Name));
  const rows = [];
  const add = (label, value) => { if (value?.length) rows.push(h('span', label), h('span', value)); };
  const types = listTypes(it);
  const listLink = (kind, value, name) => h('a', { href: `#/list?${new URLSearchParams({ [kind]: value, name, type: types })}` }, name);
  add('Genres', it.GenreItems?.length ? join(it.GenreItems, g => listLink('genre', g.Id, g.Name)) : it.Genres?.join(', '));
  const directors = people('Director');
  add(directors.length > 1 ? 'Directors' : 'Director', personLinks(directors));
  const writers = people('Writer');
  add(writers.length > 1 ? 'Writers' : 'Writer', personLinks(writers));
  add('Studios', join((it.Studios || []).filter(x => x.Id), x => listLink('studio', x.Id, x.Name)));
  if (it.Type === 'Person') {
    const date = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    if (it.PremiereDate) add('Born', date(it.PremiereDate) + (it.EndDate ? '' : ` (age ${age(it.PremiereDate)})`));
    if (it.EndDate) add('Died', `${date(it.EndDate)}${it.PremiereDate ? ` (aged ${age(it.PremiereDate, it.EndDate)})` : ''}`);
    add('Birthplace', it.ProductionLocations?.[0]);
  }
  const links = [
    ...(it.HomePageUrl && /^https?:/i.test(it.HomePageUrl) ? [{ Name: 'Website', Url: it.HomePageUrl }] : []),
    ...(it.ExternalUrls || []),
  ];
  add('Links', join(links, e => h('a.ext', { href: e.Url, target: '_blank', rel: 'noopener noreferrer' }, e.Name)));
  add('Tags', join(it.Tags || [], t => listLink('tag', t, t)));
  return rows.length ? h('div.kv.details', rows) : null;
}

/** What a genre/studio/tag link lists, by the kind of item it was clicked on. */
function listTypes(it) {
  if (['MusicAlbum', 'MusicArtist', 'Audio'].includes(it.Type)) return 'MusicAlbum';
  if (it.Type === 'Book') return 'Book';
  if (['Series', 'Season', 'Episode'].includes(it.Type)) return 'Series,Movie';
  return 'Movie,Series';
}

const age = (from, to = Date.now()) => {
  const a = new Date(from), b = new Date(to);
  return b.getFullYear() - a.getFullYear() - (b < new Date(b.getFullYear(), a.getMonth(), a.getDate()) ? 1 : 0);
};

/** "Airs Thursdays at 03:00" for series (official renderSeriesAirTime). */
function airs(it) {
  if (it.Type !== 'Series' || !(it.AirDays?.length || it.AirTime)) return null;
  const days = it.AirDays?.length === 7 ? 'daily' : (it.AirDays || []).map(d => `${d}s`).join(', ');
  return h('div.hero-airs', `${it.Status === 'Ended' ? 'Aired' : 'Airs'} ${days}${it.AirTime ? ` at ${it.AirTime}` : ''}`.replace(/\s+/g, ' '));
}

/** Trailer button: a local trailer plays here, otherwise the first remote one opens. */
function trailerButton(ctx, it) {
  const { api, app } = ctx;
  if (it.LocalTrailerCount > 0) {
    return btn('Trailer', async () => {
      try {
        const r = await api.get(`/Items/${it.Id}/LocalTrailers`, { userId: api.userId });
        if (r[0]) app.playList(r, 0); else toast('No trailer', '', 'salmon');
      } catch (e) { toast('Unable to comply', e.message, 'red'); }
    }, { color: 'blue' });
  }
  const remote = (it.RemoteTrailers || []).filter(t => /^https?:/i.test(t.Url));
  if (!remote.length) return null;
  return btn('Trailer ↗', () => native.openExternal(remote[0].Url), { color: 'blue', title: remote[0].Name || 'Trailer' });
}

/** After a menu action on a title page: leave if it was deleted, else redraw. */
const afterMenu = ctx => (it, { deleted } = {}) => {
  if (!deleted) { ctx.app.refresh(); return; }
  const parent = it.SeasonId || it.SeriesId || it.ParentId;
  location.hash = parent ? `#/item/${parent}` : '#/home';
};

function toggles(ctx, it, { small = false } = {}) {
  const { api } = ctx;
  const ud = it.UserData || (it.UserData = {});
  const played = btn(ud.Played ? 'Watched ✓' : 'Mark watched', async () => {
    try {
      const r = await api.setPlayed(it.Id, !ud.Played);
      ud.Played = r?.Played ?? !ud.Played;
      played.textContent = ud.Played ? 'Watched ✓' : 'Mark watched';
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }, { color: 'lilac', ghost: true, small });
  const fav = btn(ud.IsFavorite ? 'Favourite ★' : 'Favourite ☆', async () => {
    try {
      const r = await api.setFavorite(it.Id, !ud.IsFavorite);
      ud.IsFavorite = r?.IsFavorite ?? !ud.IsFavorite;
      fav.textContent = ud.IsFavorite ? 'Favourite ★' : 'Favourite ☆';
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }, { color: 'salmon', ghost: true, small });
  onUserData(it, played, () => { played.textContent = ud.Played ? 'Watched ✓' : 'Mark watched'; });
  onUserData(it, fav, () => { fav.textContent = ud.IsFavorite ? 'Favourite ★' : 'Favourite ☆'; });
  return [canMarkPlayed(it) ? played : null, canRate(it) ? fav : null].filter(Boolean);
}

// Like the official details page: everyone except artists, one card per person for the
// writer/director/producer roles they share, and guest stars in a deck of their own.
const MERGEABLE = new Set(['Writer', 'Director', 'Producer']);
const ROLE_LABEL = { GuestStar: 'Guest star', AlbumArtist: 'Album artist' };

function splitPeople(list = []) {
  const cast = [];
  const guests = [];
  const crewAt = new Map();
  for (const p of list) {
    if (p.Type === 'GuestStar') { guests.push(p); continue; }
    if (p.Type === 'Artist' || p.Type === 'AlbumArtist') continue;
    const merge = p.Id && MERGEABLE.has(p.Type);
    if (merge && crewAt.has(p.Id)) { cast[crewAt.get(p.Id)].RoleList.push(p); continue; }
    if (merge) crewAt.set(p.Id, cast.length);
    cast.push(merge ? { ...p, RoleList: [p] } : p);
  }
  return { cast, guests };
}

const roleText = p => (p.RoleList?.length > 1
  ? p.RoleList.map(r => r.Role || ROLE_LABEL[r.Type] || r.Type).join(' / ')
  : p.Role || ROLE_LABEL[p.Type] || p.Type);

function peopleDeck(ctx, title, list, color) {
  if (!list.length) return null;
  return deck(title, { color },
    h('div.people', list.map(p => h('a.person', { href: `#/item/${p.Id}`, title: p.Name },
      p.PrimaryImageTag ? h('img', { src: ctx.api.img(p.Id, 'Primary', { tag: p.PrimaryImageTag, h: 240 }), alt: '', attrs: { loading: 'lazy' } }) : h('div.noimg', '—'),
      h('span.card-t', p.Name),
      h('span.card-s', roleText(p))))));
}

function people(ctx, it) {
  const { cast, guests } = splitPeople(it.People);
  const music = ['MusicAlbum', 'Audio', 'MusicVideo', 'Book', 'Photo'].includes(it.Type);
  return [peopleDeck(ctx, music ? 'People' : 'Cast & crew', cast, 'lilac'), peopleDeck(ctx, 'Guest stars', guests, 'blue')];
}

function similar(ctx, it) {
  const { api, signal } = ctx;
  return lazyDeck('Related records', { color: 'blue' }, async () => {
    const r = await api.get(`/Items/${it.Id}/Similar`, { userId: api.userId, limit: 16, fields: Api.FIELDS }, { signal });
    return r.Items.length ? h('div.shelf', r.Items.map(i => card(api, i))) : empty('No related records');
  });
}

/** Special features (extras, behind the scenes...): official renderSpecials. */
function specials(ctx, it) {
  const { api, signal } = ctx;
  if (!it.SpecialFeatureCount) return null;
  return lazyDeck('Special features', { color: 'peach' }, async () => {
    const r = await api.get(`/Items/${it.Id}/SpecialFeatures`, { userId: api.userId }, { signal });
    return r.length ? h('div.shelf.wide', r.map(i => card(api, i, { shape: 'wide' }))) : empty('No special features');
  });
}

/** The collections this film or series belongs to. */
function inCollections(ctx, it) {
  const { api, signal } = ctx;
  const body = h('div');
  const el = deck('In collections', { color: 'peach' }, body);
  el.hidden = true;
  api.get(`/Items/${it.Id}/Collections`, { userId: api.userId, fields: Api.FIELDS }, { signal })
    .then(r => { if (r.Items?.length) { fill(body, h('div.shelf', r.Items.map(i => card(api, i)))); el.hidden = false; } })
    .catch(() => {});
  return el;
}

/** "More from Season 1": the rest of the season, scrolled to this episode. */
function moreFromSeason(ctx, it) {
  const { api, signal } = ctx;
  if (it.Type !== 'Episode' || !it.SeasonId || !it.SeriesId) return null;
  const body = h('div');
  const el = deck(`More from ${it.SeasonName || 'this season'}`, { color: 'sky' }, body);
  el.hidden = true;
  api.get(`/Shows/${it.SeriesId}/Episodes`, { userId: api.userId, seasonId: it.SeasonId, fields: Api.FIELDS }, { signal }).then(r => {
    if ((r.Items || []).length < 2) return;
    const shelf = h('div.shelf.wide', r.Items.map(e => card(api, e, { shape: 'wide' })));
    fill(body, shelf);
    el.hidden = false;
    const i = r.Items.findIndex(e => e.Id === it.Id);
    const target = shelf.children[Math.max(0, i - 1)];
    if (target) requestAnimationFrame(() => { shelf.scrollLeft = target.offsetLeft - shelf.offsetLeft; });
    shelf.children[i]?.classList.add('current');
  }).catch(() => {});
  return el;
}

/** Scenes: chapter cards that play from that point (official: only with chapter images). */
function scenes(ctx, it, play) {
  const { api } = ctx;
  const ch = it.Chapters || [];
  if (!ch.length || !ch[0].ImageTag) return null;
  return deck('Scenes', { color: 'lilac' }, h('div.shelf.wide', ch.map((c, i) => h('div.card.wide',
    h('div.card-pic', h('a.card-link', { href: '#', title: `Play from ${f.clock(c.StartPositionTicks / TICKS)}`, onclick: e => { e.preventDefault(); play(c.StartPositionTicks); } },
      h('img', { src: api.img(it.Id, 'Chapter', { tag: c.ImageTag, index: i, w: 480 }), alt: '', attrs: { loading: 'lazy' } }))),
    h('div.card-cap', h('span.card-t', c.Name || `Chapter ${i + 1}`), h('span.card-s', f.clock(c.StartPositionTicks / TICKS)))))));
}

/** Files split into parts (cd1/cd2): official renderAdditionalParts. */
function additionalParts(ctx, it) {
  const { api, signal } = ctx;
  if (!(it.PartCount > 1)) return null;
  return lazyDeck('Additional parts', { color: 'peach' }, async () => {
    const r = await api.get(`/Videos/${it.Id}/AdditionalParts`, { userId: api.userId }, { signal });
    return r.Items?.length ? h('div.shelf.wide', r.Items.map(i => card(api, i, { shape: 'wide' }))) : empty('No other parts');
  });
}

const streamLabel = s => s.DisplayTitle || [s.Language, s.Codec].filter(Boolean).join(' · ') || `Track ${s.Index}`;
// As official: the stream's title, or its resolution and codec.
const videoLabel = s => [s.Title, s.Width && s.Height ? `${s.Width}×${s.Height}` : '', (s.Codec || '').toUpperCase()].filter(Boolean).join(' · ') || `Track ${s.Index}`;

// ---- films and episodes -------------------------------------------------------------------

function videoItem(ctx, it) {
  const { api, app } = ctx;
  const sources = it.MediaSources || [];
  let src = sources[0];
  const pos = it.UserData?.PlaybackPositionTicks || 0;
  const sel = { audio: src?.DefaultAudioStreamIndex, sub: src?.DefaultSubtitleStreamIndex ?? -1, video: undefined };

  const picks = h('div.picks');
  const info = h('div.media-info');
  function drawPicks() {
    const streams = src?.MediaStreams || [];
    const vids = streams.filter(s => s.Type === 'Video');
    const auds = streams.filter(s => s.Type === 'Audio');
    const subs = streams.filter(s => s.Type === 'Subtitle');
    const select = (label, opts, value, onchange) => h('label.pick', h('span', label),
      h('select.sel', { onchange: e => onchange(e.target.value) },
        opts.map(([v, t]) => h('option', { value: String(v), attrs: { selected: String(v) === String(value) } }, t))));
    fill(picks, 
      sources.length > 1 ? select('Version', sources.map(s => [s.Id, s.Name || s.Container]), src.Id, v => {
        src = sources.find(s => s.Id === v);
        sel.audio = src.DefaultAudioStreamIndex;
        sel.sub = src.DefaultSubtitleStreamIndex ?? -1;
        sel.video = undefined;
        drawPicks();
      }) : null,
      // Several video streams (angles, a second cut): official lists them; here they can be played.
      vids.length > 1 ? select('Video', vids.map(s => [s.Index, videoLabel(s)]), sel.video ?? vids[0].Index, v => { sel.video = Number(v) === vids[0].Index ? undefined : Number(v); drawPicks(); }) : null,
      auds.length ? select('Audio', auds.map(s => [s.Index, streamLabel(s)]), sel.audio, v => { sel.audio = Number(v); }) : null,
      subs.length ? select('Subtitles', [[-1, 'Off'], ...subs.map(s => [s.Index, streamLabel(s)])], sel.sub, v => { sel.sub = Number(v); }) : null);
    const vs = vids.find(s => s.Index === sel.video) || vids[0];
    const as = streams.find(s => s.Index === sel.audio) || auds[0];
    fill(info, 
      vs ? ro('Video', `${(vs.Codec || '').toUpperCase()} ${vs.Width && vs.Height ? `${vs.Width}×${vs.Height}` : ''} ${vs.VideoRangeType && vs.VideoRangeType !== 'SDR' ? vs.VideoRangeType : ''}`.trim(), 'sky') : null,
      as ? ro('Audio', `${(as.Codec || '').toUpperCase()} ${as.ChannelLayout || (as.Channels ? as.Channels + 'ch' : '')}`.trim(), 'sky') : null,
      src?.Container ? ro('Container', src.Container.toUpperCase(), 'peach') : null,
      src?.Size ? ro('Size', f.bytes(src.Size), 'peach') : null,
      src?.Bitrate ? ro('Bitrate', `${(src.Bitrate / 1e6).toFixed(1)} Mbps`, 'peach') : null);
  }
  drawPicks();

  const play = startTicks => app.play(it, { startTicks, mediaSourceId: src?.Id, audioIndex: sel.audio, subIndex: sel.sub, videoIndex: sel.video });
  const miss = missingState(it);
  const actions = [
    miss ? missingTag(it) : null,
    !miss && pos > 0 ? btn(`Resume ${f.clock(pos / TICKS)}`, () => play(pos), { color: 'orange' }) : null,
    miss ? null : btn(pos > 0 ? 'From start' : 'Engage', () => play(0), { color: pos > 0 ? 'peach' : 'orange' }),
    trailerButton(ctx, it),
    ...toggles(ctx, it),
    menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) }),
  ].filter(Boolean);

  const kicker = it.Type === 'Episode'
    ? h('span', h('a', { href: `#/item/${it.SeriesId}` }, it.SeriesName), it.SeasonId ? [' · ', h('a', { href: `#/item/${it.SeasonId}` }, it.SeasonName || 'Season')] : null, ` · ${epCode(it)}`)
    : it.Type === 'Movie' ? 'Film' : it.Type;

  return h('div.view-item',
    deck(it.Type === 'Episode' ? 'Episode record' : 'Film record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, { kicker, actions, extra: [picks, info], shape: it.Type === 'Episode' ? 'wide' : 'poster' })),
    additionalParts(ctx, it),
    moreFromSeason(ctx, it),
    scenes(ctx, it, play),
    specials(ctx, it),
    people(ctx, it),
    it.Type === 'Episode' ? null : inCollections(ctx, it),
    it.Type === 'Episode' ? null : similar(ctx, it));
}

// ---- series + seasons ---------------------------------------------------------------------

function series(ctx, it) {
  const { api, app, signal } = ctx;
  const nextBtn = btn('Engage', async () => {
    try {
      const r = await api.get('/Shows/NextUp', { userId: api.userId, seriesId: it.Id, limit: 1, fields: Api.FIELDS, enableResumable: true }, { signal });
      let ep = r.Items[0];
      if (!ep) {
        const e = await api.get(`/Shows/${it.Id}/Episodes`, { userId: api.userId, limit: 1, isMissing: false, fields: Api.FIELDS });
        ep = e.Items[0];
      }
      if (ep) app.play(ep, { resume: true }); else toast('No episodes', '', 'salmon');
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }, { color: 'orange' });

  return h('div.view-item',
    deck('Series record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, { kicker: [it.Status === 'Continuing' ? 'Continuing' : it.Status || 'Series', it.Studios?.[0]?.Name].filter(Boolean).join(' · '), actions: [nextBtn, trailerButton(ctx, it), ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })].filter(Boolean) })),
    lazyDeck('Next up', { color: 'sky' }, async () => {
      const r = await api.get('/Shows/NextUp', { userId: api.userId, seriesId: it.Id, limit: 1, fields: Api.FIELDS, enableResumable: true }, { signal });
      return r.Items.length ? episodes(ctx, r.Items) : empty('Series complete');
    }),
    lazyDeck('Seasons', { color: 'lilac' }, async () => {
      const r = await api.get(`/Shows/${it.Id}/Seasons`, { userId: api.userId, fields: Api.FIELDS }, { signal });
      return r.Items.length ? h('div.shelf', r.Items.map(s => card(api, s))) : empty('No seasons');
    }),
    specials(ctx, it),
    people(ctx, it),
    inCollections(ctx, it),
    similar(ctx, it));
}

function season(ctx, it) {
  const { api, app, signal } = ctx;
  let eps = [];
  const playFirst = btn('Engage', () => {
    const have = eps.filter(e => e.LocationType !== 'Virtual');
    const ep = have.find(e => !e.UserData?.Played) || have[0];
    if (ep) app.play(ep, { resume: true }); else toast('Nothing to play', 'No episodes of this season are on the server', 'salmon');
  }, { color: 'orange' });
  return h('div.view-item',
    deck('Season record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, { kicker: h('a', { href: `#/item/${it.SeriesId}` }, it.SeriesName), actions: [playFirst, ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })] })),
    lazyDeck('Episodes', { color: 'sky' }, async () => {
      const r = await api.get(`/Shows/${it.SeriesId}/Episodes`, { userId: api.userId, seasonId: it.Id, fields: Api.FIELDS + ',MediaSources' }, { signal });
      eps = r.Items;
      return eps.length ? episodes(ctx, eps) : empty('No episodes');
    }));
}

function episodes(ctx, list) {
  return h('div.eps', list.map(ep => epRow(ctx, ep)));
}

function epRow(ctx, ep) {
  const { api, app } = ctx;
  const ud = ep.UserData || {};
  const pct = !ud.Played && ud.PlayedPercentage > 0 ? ud.PlayedPercentage : 0;
  const im = pickImage(ep, 'wide');
  // Missing and unaired episodes (shown when "Show missing episodes" is on) can't play.
  const miss = missingState(ep);
  const row = h('div.ep', { class: [ud.Played ? 'played' : '', miss ? 'virtual' : ''].join(' '), key: ep.Id },
    h('div.ep-img', miss ? {} : { onclick: () => app.play(ep, { resume: true }), title: 'Play' },
      image(api, im, { shape: 'wide', label: epCode(ep) }),
      pct ? h('div.prog', h('i', { style: { width: `${pct.toFixed(1)}%` } })) : null),
    h('div.ep-body',
      h('div.ep-t', h('span.n', epCode(ep) || (ep.IndexNumber ?? '')), h('a', { href: itemHref(ep) }, ep.Name)),
      h('div.ep-m',
        missingTag(ep),
        ep.PremiereDate ? h('span', new Date(ep.PremiereDate).toLocaleDateString()) : null,
        runtime(ep) ? h('span', runtime(ep)) : null,
        ep.CommunityRating ? h('span', `★ ${ep.CommunityRating.toFixed(1)}`) : null,
        ud.Played ? tag('Watched', 'sky') : pct ? tag(`${Math.round(pct)}%`, 'peach') : null),
      ep.Overview ? h('p.overview.clamp', { onclick: e => e.currentTarget.classList.toggle('clamp') }, ep.Overview) : null),
    h('div.ep-side',
      miss ? null : btn(ud.PlaybackPositionTicks > 0 ? 'Resume' : 'Play', () => app.play(ep, { resume: true }), { small: true, color: 'orange' }),
      toggles(ctx, ep, { small: true }),
      menuButton(ctx, ep, { onChange: () => ctx.app.refresh() })));
  onUserData(ep, row, () => swapKeepingFocus(row, epRow(ctx, ep)));
  return row;
}

// ---- music --------------------------------------------------------------------------------

/** A track list wired to the queue; highlights the playing track. */
function tracks(ctx, list, { showArtist = true, showDisc = false } = {}) {
  const { app, signal } = ctx;
  const rows = [];
  let lastDisc = null;
  const multiDisc = showDisc && new Set(list.map(t => t.ParentIndexNumber)).size > 1;
  list.forEach((t, i) => {
    if (multiDisc && t.ParentIndexNumber !== lastDisc) {
      lastDisc = t.ParentIndexNumber;
      rows.push(h('div.disc', `Disc ${lastDisc ?? '?'}`));
    }
    rows.push(h('div.trk', {
      key: t.Id, attrs: { tabindex: 0, 'data-id': t.Id, role: 'button' },
      onclick: () => app.queue.play(list, i),
      onkeydown: e => { if (e.key === 'Enter') app.queue.play(list, i); },
    },
    h('span.trk-n', t.IndexNumber ?? i + 1),
    h('span.trk-t', t.Name),
    h('span.trk-a', showArtist ? (t.Artists || []).join(', ') || t.AlbumArtist || '' : t.Album || ''),
    h('span.trk-d', runtime(t) ? f.clock(t.RunTimeTicks / TICKS) : '')));
  });
  const el = h('div.tracks', rows);
  const mark = () => {
    const id = app.queue.current?.Id;
    el.querySelectorAll('.trk').forEach(r => r.classList.toggle('now', r.dataset.id === id));
  };
  mark();
  const off = app.queue.on(w => { if (w === 'state') mark(); });
  signal.addEventListener('abort', off);
  return el;
}

function queueButtons(ctx, getList) {
  const { app } = ctx;
  return [
    btn('Play', () => app.queue.play(getList()), { color: 'orange' }),
    btn('Shuffle', () => app.queue.play(getList(), 0, { shuffle: true }), { color: 'peach' }),
    btn('Add to queue', () => { app.queue.add(getList()); toast('Queued', `${getList().length} tracks`, 'sky'); }, { color: 'sky', ghost: true }),
  ];
}

async function album(ctx, it) {
  const { api, signal } = ctx;
  const r = await api.items({ parentId: it.Id, sortBy: 'ParentIndexNumber,IndexNumber,SortName', recursive: true, includeItemTypes: 'Audio' }, { signal });
  const list = r.Items;
  const artistLinks = (it.AlbumArtists || []).map((a, i) => [i ? ', ' : '', h('a', { href: `#/item/${a.Id}` }, a.Name)]);
  const total = list.reduce((s, t) => s + (t.RunTimeTicks || 0), 0) / TICKS;
  it.RunTimeTicks = 0; // facts() shows the total below instead
  return h('div.view-item',
    deck('Album record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, {
        kicker: artistLinks.length ? h('span', artistLinks) : 'Album', shape: 'square',
        actions: [...queueButtons(ctx, () => list), ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })],
        extra: h('div.media-info', ro('Tracks', String(list.length), 'sky'), ro('Duration', f.dur(total), 'sky')),
      })),
    deck('Tracks', { color: 'sky' }, list.length ? tracks(ctx, list, { showDisc: true }) : empty('No tracks')),
    moreFromArtist(ctx, it),
    similar(ctx, it));
}

/** Other albums by the album artist (official renderMoreFromArtist). */
function moreFromArtist(ctx, it) {
  const { api, signal } = ctx;
  const a = it.AlbumArtists?.[0];
  if (!a) return null;
  const body = h('div');
  const el = deck(`More from ${a.Name}`, { color: 'lilac' }, body);
  el.hidden = true;
  api.items({ albumArtistIds: a.Id, includeItemTypes: 'MusicAlbum', recursive: true, excludeItemIds: it.Id, sortBy: 'ProductionYear,SortName', sortOrder: 'Descending', limit: 24 }, { signal })
    .then(r => { if (r.Items.length) { fill(body, h('div.shelf.square', r.Items.map(i => card(api, i)))); el.hidden = false; } })
    .catch(() => {});
  return el;
}

async function artist(ctx, it) {
  const { api, signal } = ctx;
  let songs = null;
  const getSongs = async () => songs || (songs = (await api.items({
    artistIds: it.Id, includeItemTypes: 'Audio', recursive: true, sortBy: 'PremiereDate,Album,ParentIndexNumber,IndexNumber', limit: 1000,
  }, { signal })).Items);
  const qb = (label, opts, color) => btn(label, async () => {
    const s = await getSongs();
    if (opts.add) ctx.app.queue.add(s); else ctx.app.queue.play(s, 0, opts);
  }, { color });
  return h('div.view-item',
    deck('Artist record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, { kicker: 'Artist', shape: 'square', actions: [qb('Play all', {}, 'orange'), qb('Shuffle', { shuffle: true }, 'peach'), ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })] })),
    lazyDeck('Albums', { color: 'sky' }, async () => {
      const r = await api.items({ albumArtistIds: it.Id, includeItemTypes: 'MusicAlbum', recursive: true, sortBy: 'ProductionYear,SortName', sortOrder: 'Descending' }, { signal });
      return r.Items.length ? h('div.grid', r.Items.map(a => card(api, a))) : empty('No albums');
    }),
    lazyDeck('Appears on', { color: 'lilac' }, async () => {
      const r = await api.items({ contributingArtistIds: it.Id, excludeItemIds: it.Id, includeItemTypes: 'MusicAlbum', recursive: true, sortBy: 'ProductionYear,SortName', sortOrder: 'Descending', limit: 40 }, { signal });
      return r.Items.length ? h('div.shelf.square', r.Items.map(a => card(api, a))) : empty('No other albums');
    }),
    similar(ctx, it));
}

function audioItem(ctx, it) {
  const { app } = ctx;
  return h('div.view-item',
    deck('Track record', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, {
        kicker: it.AlbumId ? h('a', { href: `#/item/${it.AlbumId}` }, it.Album) : 'Track', shape: 'square',
        actions: [btn('Play', () => app.queue.play([it]), { color: 'orange' }), btn('Add to queue', () => app.queue.add([it]), { color: 'sky', ghost: true }), ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })],
      })),
    it.HasLyrics ? lazyDeck('Lyrics', { color: 'sky' }, async () => {
      const r = await ctx.api.get(`/Audio/${it.Id}/Lyrics`, undefined, { signal: ctx.signal });
      const lines = r.Lyrics || [];
      return lines.length ? h('div.lyrics', lines.map(l => h('p', l.Text || '\u00a0'))) : empty('No lyrics');
    }) : null);
}

// ---- other containers -------------------------------------------------------------------

/**
 * Edit a playlist in place (official playlisteditor): rename, public or not, and the entries:
 * drag or ▲▼ (Alt+↑/↓) to move, ✕ (Delete) to remove. Each change is saved as it's made.
 */
function playlistEditor(ctx, it, list) {
  const { api, signal } = ctx;
  const entries = [...list];
  const nameIn = h('input.inp', { value: it.Name, attrs: { 'aria-label': 'Playlist name', maxlength: 200 } });
  const pubBox = h('input', { type: 'checkbox', attrs: { 'aria-label': 'Public' },
    onchange: () => save({ IsPublic: pubBox.checked }).catch(() => { pubBox.checked = !pubBox.checked; }) });
  api.get(`/Playlists/${it.Id}`, undefined, { signal }).then(p => { pubBox.checked = !!p?.OpenAccess; }).catch(() => {});
  const save = async patch => {
    try { await api.post(`/Playlists/${it.Id}`, patch); toast('Saved', it.Name, 'sky', 1800); }
    catch (e) { toast('Not saved', e.message, 'red'); throw e; }
  };
  const rowsEl = h('div.tracks');
  let dragFrom = -1;

  async function move(from, to) {
    if (to < 0 || to >= entries.length || from === to) return;
    const [e] = entries.splice(from, 1);
    entries.splice(to, 0, e);
    draw(to);
    try { await api.post(`/Playlists/${it.Id}/Items/${e.PlaylistItemId}/Move/${to}`); }
    catch (err) { toast('Not moved', err.message, 'red'); }
  }
  async function remove(i) {
    const [e] = entries.splice(i, 1);
    draw(Math.min(i, entries.length - 1));
    try { await api.del(`/Playlists/${it.Id}/Items`, { entryIds: e.PlaylistItemId }); }
    catch (err) { toast('Not removed', err.message, 'red'); entries.splice(i, 0, e); draw(i); }
  }
  function draw(focus = -1) {
    fill(rowsEl, entries.length ? entries.map((t, i) => {
      const el = h('div.trk.qtrk', {
        key: t.PlaylistItemId, attrs: { tabindex: 0, draggable: 'true', 'aria-label': `${t.Name}, ${i + 1} of ${entries.length}` },
        onkeydown: e => {
          if (e.target !== el) return;
          if (e.key === 'Delete') { remove(i); e.preventDefault(); }
          else if (e.altKey && e.key === 'ArrowUp') { move(i, i - 1); e.preventDefault(); }
          else if (e.altKey && e.key === 'ArrowDown') { move(i, i + 1); e.preventDefault(); }
        },
        ondragstart: e => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
        ondragend: () => { dragFrom = -1; el.classList.remove('dragging'); rowsEl.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); },
        ondragover: e => { if (dragFrom < 0) return; e.preventDefault(); rowsEl.querySelectorAll('.drop').forEach(x => x !== el && x.classList.remove('drop')); el.classList.add('drop'); },
        ondragleave: () => el.classList.remove('drop'),
        ondrop: e => { e.preventDefault(); if (dragFrom >= 0) move(dragFrom, i); },
      },
      h('span.trk-n', i + 1),
      h('span.trk-t', t.Type === 'Episode' ? `${t.SeriesName || ''} ${epCode(t)} · ${t.Name}` : t.Name),
      h('span.trk-a', t.AlbumArtist || t.Album || (t.ProductionYear ? String(t.ProductionYear) : '')),
      h('span.trk-d', runtime(t) ? f.clock(t.RunTimeTicks / TICKS) : ''),
      h('span.trk-x',
        h('button.qb', { type: 'button', title: 'Move up (Alt+↑)', disabled: i === 0, onclick: () => move(i, i - 1) }, '▲'),
        h('button.qb', { type: 'button', title: 'Move down (Alt+↓)', disabled: i === entries.length - 1, onclick: () => move(i, i + 1) }, '▼'),
        h('button.qb.x', { type: 'button', title: 'Remove (Delete)', onclick: () => remove(i) }, '✕')));
      return el;
    }) : empty('Empty playlist'));
    if (focus >= 0) requestAnimationFrame(() => rowsEl.querySelectorAll('.qtrk')[focus]?.focus());
  }
  draw();

  return deck('Edit playlist', { color: 'sky' },
    h('div.pl-edit',
      h('label.pick', h('span', 'Name'), nameIn),
      btn('Rename', async () => {
        const name = nameIn.value.trim();
        if (!name || name === it.Name) return;
        await save({ Name: name });
        it.Name = name;
      }, { color: 'sky', small: true }),
      h('label.dlg-check', pubBox, h('span', 'Public: everyone on the server can see it')),
    ),
    rowsEl);
}

async function playlist(ctx, it) {
  const { api, app, signal, query } = ctx;
  const [r, perm] = await Promise.all([
    api.get(`/Playlists/${it.Id}/Items`, { userId: api.userId, fields: Api.FIELDS, enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1 }, { signal }),
    // The owner, and people it's shared with as editors, may change it.
    api.get(`/Playlists/${it.Id}/Users/${api.userId}`, undefined, { signal }).catch(() => null),
  ]);
  const list = r.Items || [];
  const canEdit = !!perm?.CanEdit;
  const editing = canEdit && query.get('edit') === '1';
  const audio = list.length && list.every(i => i.MediaType === 'Audio');
  if (query.get('edit') === '1' && !canEdit) toast('Read only', 'Only the owner, or someone it is shared with for editing, can change this playlist', 'salmon');
  return h('div.view-item',
    deck('Playlist', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, {
        kicker: `${list.length} entries`, shape: 'square',
        actions: [...(audio ? queueButtons(ctx, () => list) : list.length ? [btn('Play all', () => app.playList(list, 0, { resume: true }), { color: 'orange' }), btn('Shuffle', () => app.shuffle(it), { color: 'peach' })] : []),
          canEdit ? h('a.btn', { class: editing ? 'c-sky' : 'c-lilac', href: editing ? `#/item/${it.Id}` : `#/item/${it.Id}?edit=1` }, editing ? 'Done' : 'Edit') : null,
          menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })].filter(Boolean),
      })),
    editing ? playlistEditor(ctx, it, list) : deck('Entries', { color: 'sky' },
      !list.length ? empty('Empty playlist')
        : audio ? tracks(ctx, list)
          : list.every(i => i.Type === 'Episode') ? episodes(ctx, list)
            : h('div.grid', list.map(i => card(api, i)))));
}

async function person(ctx, it) {
  const { api, signal } = ctx;
  return h('div.view-item',
    deck('Personnel file', { color: 'orange', code: code(it.Id) },
      hero(ctx, it, { kicker: 'Person', actions: toggles(ctx, it).slice(-1) })),
    // Everything they're credited on, a shelf per type (official itemsByName.js): films and
    // series first, then guest spots in episodes, music, books.
    lazyDeck('Filmography', { color: 'sky' }, async () => {
      const r = await api.items({ personIds: it.Id, recursive: true, includeItemTypes: PERSON_TYPES.map(t => t[0]).join(','),
        sortBy: 'ProductionYear,PremiereDate,SortName', sortOrder: 'Descending', excludeLocationTypes: 'Virtual', limit: 500 }, { signal });
      if (!r.Items.length) return empty('No records');
      const byType = Map.groupBy(r.Items, i => i.Type);
      return PERSON_TYPES.filter(([t]) => byType.has(t)).map(([t, shape]) => [
        h('h3.set-h', `${GROUP_LABELS[t] || t} · ${byType.get(t).length}`),
        // Episodes (guest spots, often hundreds) scroll sideways instead of filling the page.
        t === 'Episode'
          ? h('div.shelf.wide', byType.get(t).map(i => card(api, i, { shape: 'wide' })))
          : h('div.grid', { class: shape || '' }, byType.get(t).map(i => card(api, i, shape === 'wide' ? { shape: 'wide' } : {})))]);
    }));
}

/** Read / Continue · page 42 / From the start. Comics store a page, EPUBs a fraction. */
function bookButtons(ctx, it) {
  const ud = it.UserData || {};
  const pos = ud.Played ? 0 : ud.PlaybackPositionTicks || 0;
  // Audiobooks play in the music player, from where they were.
  if (it.Type === 'AudioBook') {
    return [
      btn(pos > 0 ? `Continue · ${f.clock(pos / 1e7)}` : 'Listen', () => ctx.app.play(it, { resume: true }), { color: 'orange' }),
      pos > 0 ? btn('From the start', () => ctx.app.play(it, { startTicks: 0 }), { color: 'peach' }) : null,
    ].filter(Boolean);
  }
  const where = it.RunTimeTicks === 10000000 ? `${Math.round(pos / 100000)}%` : `page ${Math.round(pos / 10000) + 1}`;
  return [
    btn(pos > 0 ? `Continue · ${where}` : 'Read', () => ctx.app.read(it), { color: 'orange' }),
    pos > 0 ? btn('From the start', () => ctx.app.read(it, { fromStart: true }), { color: 'peach' }) : null,
  ].filter(Boolean);
}

/** On a folder of books (a manga series): open the one in progress, or the first unread. */
async function seriesReadButton(ctx, it) {
  const { api, signal } = ctx;
  try {
    const r = await api.items({ parentId: it.Id, includeItemTypes: 'Book', sortBy: 'SortName', fields: 'UserData', limit: 2000 }, { signal });
    if (!r.Items.length) return null;
    const next = r.Items.find(b => !b.UserData?.Played && b.UserData?.PlaybackPositionTicks > 0)
      || r.Items.find(b => !b.UserData?.Played);
    if (!next) return btn('Read again', () => ctx.app.read(r.Items[0], { fromStart: true }), { color: 'orange' });
    const started = r.Items.some(b => b.UserData?.Played || b.UserData?.PlaybackPositionTicks > 0);
    return btn(started ? `Continue · ${next.Name}` : 'Start reading', () => ctx.app.read(next), { color: 'orange', title: next.Name });
  } catch { return null; }
}

// Person pages: the types listed, in this order, with their card shape.
const PERSON_TYPES = [['Movie'], ['Series'], ['Episode', 'wide'], ['Video', 'wide'], ['MusicVideo', 'wide'], ['MusicAlbum'], ['Audio'], ['Book'], ['AudioBook']];

const GROUP_LABELS = { Movie: 'Films', Series: 'Series', Season: 'Seasons', Episode: 'Episodes', MusicAlbum: 'Albums', MusicArtist: 'Artists', Audio: 'Songs', Book: 'Books', AudioBook: 'Audiobooks', Video: 'Videos', MusicVideo: 'Music videos', Photo: 'Photos' };

async function folder(ctx, it) {
  const { api, signal } = ctx;
  const isBook = it.Type === 'Book' || it.Type === 'AudioBook';
  // On a collection page, multi-select can take things out of it.
  if (it.Type === 'BoxSet' && canManageCollections(ctx.app.me)) {
    const off = addSelectAction({
      id: 'uncollect', label: 'Remove from collection', color: 'red',
      run: async items => {
        await api.del(`/Collections/${it.Id}/Items`, { ids: items.map(i => i.Id).join(',') });
        toast('Removed from collection', `${items.length} from ${it.Name}`, 'sky');
        ctx.app.refresh();
      },
    });
    signal.addEventListener('abort', off);
  }
  const children = isBook ? null : lazyDeck(it.Type === 'BoxSet' ? 'Collection contents' : 'Contents', { color: 'sky' }, async () => {
    const r = await api.items({ parentId: it.Id, sortBy: it.Type === 'BoxSet' ? 'ProductionYear,SortName' : 'SortName', recursive: false }, { signal });
    if (!r.Items.length) return empty('No records');
    // Collections with mixed contents are grouped by type, as the official page does.
    const byType = Map.groupBy(r.Items, i => i.Type);
    if (it.Type !== 'BoxSet' || byType.size < 2) return h('div.grid', r.Items.map(i => card(api, i)));
    return [...byType].map(([type, items]) => [h('h3.set-h', GROUP_LABELS[type] || type), h('div.grid', items.map(i => card(api, i)))]);
  });
  const actions = h('span.contents');
  if (isBook) actions.append(...bookButtons(ctx, it));
  else if (it.Type === 'Folder') seriesReadButton(ctx, it).then(b => b && actions.append(b));
  return h('div.view-item',
    deck(`${it.Type === 'BoxSet' ? 'Collection' : it.Type} record`, { color: 'orange', code: code(it.Id) },
    hero(ctx, it, { kicker: it.Type === 'BoxSet' ? 'Collection' : it.Type, actions: [
      actions,
      // Collections play in release order, like the official client.
      it.Type === 'BoxSet' ? btn('Play all', async () => ctx.app.playList(await ctx.app.playableItems(it), 0, { resume: true }), { color: 'orange' }) : null,
      // Books, as official: a Download button beside Read when the user may download.
      isBook && it.CanDownload ? btn('Download', () => download(ctx.api, [it]), { color: 'lilac', ghost: true }) : null,
      ...toggles(ctx, it), menuButton(ctx, it, { small: false, onChange: afterMenu(ctx) })].filter(Boolean) })),
    children);
}
