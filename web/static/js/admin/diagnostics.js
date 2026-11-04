// Diagnostics (admin stage A9): what the official dashboard doesn't show. Library health (checks
// across the libraries, each a list with the fix one click away), the transcodes running now and
// why, and viewing from the activity log. History over time comes from LCARS's own recorder.
import { h, fill } from '../h.js';
import { TICKS } from '../api.js';
import * as f from '../fmt.js';
import { deck, btn, tag, seg, empty, toast, errorBox, loading, epCode, colorAt, image, pickImage } from '../ui.js';
import { confirmDialog } from '../menu.js';
import { REASONS } from './overview.js';
import { row } from './form.js';

export async function diagnostics(ctx) {
  const [tab = 'health'] = ctx.sub;
  ctx.setTitle('Diagnostics');
  const page = { health, transcodes, viewing, history }[tab] || health;
  return h('div.eng-edit', subTabs(tab), await page(ctx));
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['health', 'Library health'], ['transcodes', 'Transcodes'], ['viewing', 'Viewing'], ['history', 'History']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/diagnostics/${k}`, class: k === cur ? 'on' : '' }, l)));

const sel = (opts, value) => h('select.sel', opts.map(([l, v]) => h('option', { value: String(v), attrs: { selected: String(v) === String(value) } }, l)));
const label = it => it.Type === 'Episode' ? [it.SeriesName, epCode(it), it.Name].filter(Boolean).join(' · ')
  : [it.AlbumArtist, it.Name, it.ProductionYear].filter(Boolean).join(' · ');

// ---- library health ---------------------------------------------------------------------------

// Each check: which items, how to find them, and the item tool that fixes them. `query` uses the
// server's own filters where it has one; `keep` filters what came back where it doesn't.
const CHECKS = [
  { id: 'versions', title: 'Several versions', color: 'orange', why: 'Two or more files are grouped as one title. Often an upgrade with the old copy left behind.',
    types: 'Movie,Episode', query: { fields: 'MediaSourceCount,Path' }, keep: it => (it.MediaSourceCount || 1) > 1, info: it => `${it.MediaSourceCount} versions`, tool: null },
  { id: 'dupes', title: 'Duplicate episodes', color: 'salmon', why: 'The same series, season and episode number on more than one item.',
    types: 'Episode', query: { fields: 'Path', isMissing: false }, group: dupes, tool: 'metadata' },
  { id: 'unmatched', title: 'Unmatched', color: 'red', why: 'No TMDb, IMDb or TVDb id: the metadata providers didn’t recognise it.',
    types: 'Movie,Series', query: { hasTmdbId: false, hasImdbId: false, hasTvdbId: false, fields: 'Path' }, tool: 'identify' },
  { id: 'poster', title: 'No poster', color: 'lilac', why: 'No primary image.',
    types: 'Movie,Series,MusicAlbum,BoxSet', query: { enableImageTypes: 'Primary', imageTypeLimit: 1 }, keep: it => !it.ImageTags?.Primary, tool: 'images' },
  { id: 'overview', title: 'No overview', color: 'peach', why: 'No description.',
    types: 'Movie,Series', query: { hasOverview: false }, tool: 'metadata' },
  { id: 'subtitles', title: 'No subtitles', color: 'blue', why: 'No subtitle track, embedded or alongside the file.',
    types: 'Movie,Episode', query: { hasSubtitles: false, isMissing: false }, tool: 'subtitles' },
  { id: 'missing', title: 'Missing episodes', color: 'sky', why: 'Known to the metadata but not on the disk (only when a library shows missing episodes).',
    types: 'Episode', query: { isMissing: true, isUnaired: false }, tool: null },
];
const PAGE = 2000;

async function all(api, query, signal) {
  const out = [];
  for (let start = 0; ; start += PAGE) {
    const r = await api.get('/Items', { recursive: true, startIndex: start, limit: PAGE, ...query }, { signal });
    out.push(...(r.Items || []));
    if (out.length >= (r.TotalRecordCount || 0) || !(r.Items || []).length) return out;
  }
}

/** Episodes sharing a series, season and number: each group as one entry. */
function dupes(items) {
  const by = new Map();
  for (const it of items) {
    if (it.IndexNumber == null || !it.SeriesId) continue;
    const k = `${it.SeriesId}/${it.ParentIndexNumber ?? 0}/${it.IndexNumber}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(it);
  }
  return [...by.values()].filter(g => g.length > 1).flatMap(g => g.map((it, i) => ({ ...it, _info: i ? 'duplicate' : `${g.length} items` })));
}

async function health(ctx) {
  const { api, signal } = ctx;
  const [folders, storage] = await Promise.all([
    api.get('/Library/VirtualFolders', undefined, { signal }).catch(() => []),
    api.get('/System/Info/Storage', undefined, { signal }).catch(() => null),
  ]);
  const libs = folders.filter(l => l.ItemId);
  const lib = sel([['All libraries', ''], ...libs.map(l => [l.Name, l.ItemId])], '');
  const body = h('div.eng-stack');
  let run = 0;

  // Library folders that aren't there any more (the server reports no space for them).
  const broken = (storage?.Libraries || []).flatMap(l => (l.Folders || []).filter(d => d.UsedSpace < 0 && d.FreeSpace < 0).map(d => [l.Name, d.Path]));
  const brokenDeck = broken.length ? deck('Folders not found', { color: 'red', code: `${broken.length}` },
    h('p.dlg-note', 'These library folders can’t be read: a disk not mounted, a share down, or a folder moved. Fix the folder in the library’s settings.'),
    h('div.diag-list', broken.map(([n, p]) => h('div.diag-row', h('a', { href: '#/admin/libraries' }, n), h('span.eng-ro', p))))) : null;

  async function check(c, parentId, n) {
    const list = h('div.diag-list');
    const count = h('span.tag.dim', '…');
    let open = false, items = null;
    const toggle = btn('Show', () => { open = !open; toggle.textContent = open ? 'Hide' : 'Show'; draw(); }, { small: true, color: c.color, ghost: true });
    toggle.disabled = true;
    const LIMIT = 200;
    function draw() {
      if (!open || !items) { fill(list); return; }
      fill(list, items.slice(0, LIMIT).map(it => h('div.diag-row',
        h('a', { href: `#/item/${it.Id}`, title: it.Path || '' }, label(it)),
        h('span.eng-ro', it._info || (c.info ? c.info(it) : it.Path ? it.Path.split('/').slice(-2).join('/') : '')),
        c.tool ? btn(c.tool === 'identify' ? 'Identify' : c.tool === 'images' ? 'Images' : c.tool === 'subtitles' ? 'Subtitles' : 'Edit',
          () => { location.hash = `#/admin/edit/${it.Id}/${c.tool}`; }, { small: true, color: 'lilac', ghost: true }) : null)),
        items.length > LIMIT ? h('p.eng-ro', `…and ${f.num(items.length - LIMIT)} more`) : null);
    }
    const el = h('div.diag-check', { class: `c-${c.color}` },
      h('div.diag-check-h', h('b', c.title), h('span.eng-ro', c.why), count, toggle), list);
    (async () => {
      const mine = run;
      try {
        let got = await all(api, { includeItemTypes: c.types, parentId: parentId || undefined, sortBy: 'SeriesSortName,SortName', ...c.query }, signal);
        if (c.keep) got = got.filter(c.keep);
        if (c.group) got = c.group(got);
        if (mine !== run) return;
        items = got;
        const k = c.group ? got.filter(it => it._info !== 'duplicate').length : got.length;
        count.textContent = k ? f.num(k) : 'none';
        count.className = `tag ${k ? c.color : 'dim'}`;
        toggle.disabled = !k;
        el.classList.toggle('diag-ok', !k);
      } catch (e) { if (!signal.aborted) { count.textContent = 'failed'; count.title = e.message; } }
    })();
    return el;
  }
  async function draw() {
    run++;
    fill(body, brokenDeck, deck('Library health', { color: 'orange', num: 1 }, h('div.diag-checks', await Promise.all(CHECKS.map((c, i) => check(c, lib.value, i + 1))))));
  }
  lib.addEventListener('change', draw);
  draw();
  return [h('div.rc-opts.eng-filters', h('label.rc-sel', h('span', 'Library'), lib),
    h('span.eng-ro', 'Checks run against the server’s database; a library scan refreshes it.')), body];
}

// ---- transcodes (live) ------------------------------------------------------------------------

async function transcodes(ctx) {
  const { api, app, signal } = ctx;
  const body = h('div');
  const stream = (s, type) => (s.NowPlayingItem?.MediaStreams || []).find(m => m.Type === type && (type !== 'Audio' || m.Index === s.PlayState?.AudioStreamIndex))
    || (s.NowPlayingItem?.MediaStreams || []).find(m => m.Type === type);
  const src = v => v ? [v.Codec, v.Height ? `${v.Height}p` : '', v.BitRate ? `${(v.BitRate / 1e6).toFixed(1)} Mbps` : '', v.VideoRangeType && v.VideoRangeType !== 'SDR' ? v.VideoRangeType : ''].filter(Boolean).join(' ') : '';
  const asrc = a => a ? [a.Codec, a.Channels ? `${a.Channels}ch` : '', a.Language || ''].filter(Boolean).join(' ') : '';
  function row(s) {
    const np = s.NowPlayingItem, ti = s.TranscodingInfo || {}, ps = s.PlayState || {};
    const v = stream(s, 'Video'), a = stream(s, 'Audio');
    const reasons = (ti.TranscodeReasons || []).map(r => REASONS[r] || r);
    const hw = ti.HardwareAccelerationType && ti.HardwareAccelerationType !== 'none' ? ti.HardwareAccelerationType : 'software';
    const shape = np.MediaType === 'Audio' ? 'square' : 'poster';
    return h('div.eng-sess',
      h('div.eng-sess-img', image(api, pickImage(np, shape), { shape })),
      h('div.eng-sess-b',
        h('div.eng-sess-who', h('b', s.UserName || 'No user'), h('span', `${s.DeviceName} · ${s.Client}`)),
        h('a.eng-sess-t', { href: `#/item/${np.Id}` }, label(np)),
        h('div.diag-tc',
          h('span.l', 'Video'), h('span', ti.IsVideoDirect ? `${src(v)} · copied` : `${src(v)} → ${[ti.VideoCodec, ti.Height ? `${ti.Height}p` : ''].filter(Boolean).join(' ')}`),
          h('span.l', 'Audio'), h('span', ti.IsAudioDirect ? `${asrc(a)} · copied` : `${asrc(a)} → ${[ti.AudioCodec, ti.AudioChannels ? `${ti.AudioChannels}ch` : ''].filter(Boolean).join(' ')}`),
          h('span.l', 'Container'), h('span', `${np.Container || '?'} → ${ti.Container || '?'}`),
          h('span.l', 'Encoder'), h('span', [hw, ti.Framerate ? `${Math.round(ti.Framerate)} fps` : '', ti.Bitrate ? `${(ti.Bitrate / 1e6).toFixed(1)} Mbps out` : ''].filter(Boolean).join(' · ')),
          ti.CompletionPercentage != null ? [h('span.l', 'Encoded'), h('div.eng-sess-p', seg(ti.CompletionPercentage / 100, { n: 30, tone: 'orange' }), h('span', `${Math.round(ti.CompletionPercentage)}% · watching at ${f.clock((ps.PositionTicks || 0) / TICKS)}`))] : null),
        reasons.length ? h('span.eng-why', `Because: ${reasons.join(', ')}`) : h('span.eng-why', 'No reason given')),
      h('div.eng-sess-a', btn('Stop', async () => {
        if (!(await confirmDialog('Stop playback', `Stop what ${s.UserName || 'someone'} is playing on ${s.DeviceName}?`, 'Stop'))) return;
        try { await api.post(`/Sessions/${s.Id}/Playing/Stop`); toast('Stopped', s.DeviceName, 'red', 2500); } catch (e) { toast('Unable to comply', e.message, 'red'); }
      }, { small: true, color: 'red', ghost: true })));
  }
  function draw(list) {
    const playing = (list || []).filter(s => s.NowPlayingItem);
    const tc = playing.filter(s => s.PlayState?.PlayMethod === 'Transcode');
    const direct = playing.length - tc.length;
    tcDeck.querySelector('.code').textContent = `${tc.length} of ${playing.length}`;
    fill(body, tc.length ? h('div.eng-sessions', tc.map(row)) : empty(playing.length ? `Nothing is transcoding. ${direct} playing directly.` : 'Nothing is playing.'));
  }
  const tcDeck = deck('Transcoding now', { color: 'salmon', num: 1, code: '' }, body);
  draw([]);
  const off = app.subscribe('Sessions', d => draw(Array.isArray(d) ? d : []));
  api.get('/Sessions', undefined, { signal }).then(draw).catch(() => {});
  signal.addEventListener('abort', off);
  return tcDeck;
}

// ---- viewing (from the activity log) --------------------------------------------------------------

const PERIODS = [['7 days', 7], ['30 days', 30], ['90 days', 90], ['A year', 365]];

async function viewing(ctx) {
  const { api, signal } = ctx;
  const [users, sys] = await Promise.all([
    api.get('/Users', undefined, { signal }).catch(() => []),
    api.get('/System/Configuration', undefined, { signal }).catch(() => null),
  ]);
  const period = sel(PERIODS, 30);
  const body = h('div');
  const name = id => users.find(u => u.Id.replace(/-/g, '') === String(id).replace(/-/g, ''))?.Name || 'Someone';
  const keep = sys?.ActivityLogRetentionDays;

  async function load() {
    fill(body, loading('Reading the activity log'));
    const days = +period.value;
    const since = new Date(Date.now() - days * 86400000);
    let entries = [];
    try {
      for (let start = 0; start < 20000; start += 1000) {
        const r = await api.get('/System/ActivityLog/Entries', { startIndex: start, limit: 1000, hasUserId: true, minDate: since.toISOString() }, { signal });
        entries.push(...(r.Items || []));
        if (entries.length >= (r.TotalRecordCount || 0) || !(r.Items || []).length) break;
      }
    } catch (e) { if (!signal.aborted) fill(body, errorBox(e)); return; }
    // A play is a start; its length is the time to the same user's next stop of the same item.
    entries.sort((a, b) => Date.parse(a.Date) - Date.parse(b.Date));
    const plays = [];
    const open = new Map();
    for (const e of entries) {
      const key = `${e.UserId}/${e.ItemId}`;
      if (e.Type === 'VideoPlayback' || e.Type === 'AudioPlayback') {
        const p = { user: e.UserId, item: e.ItemId, audio: e.Type === 'AudioPlayback', at: Date.parse(e.Date), secs: 0, name: e.Name };
        plays.push(p); open.set(key, p);
      } else if (e.Type === 'VideoPlaybackStopped' || e.Type === 'AudioPlaybackStopped') {
        const p = open.get(key);
        if (p) { p.secs = Math.min(6 * 3600, Math.max(0, (Date.parse(e.Date) - p.at) / 1000)); open.delete(key); }
      }
    }
    if (!plays.length) { fill(body, empty(`No plays in the activity log for the last ${days} days.`)); return; }

    // Per user.
    const per = new Map();
    for (const p of plays) {
      const u = per.get(p.user) || { plays: 0, secs: 0, audio: 0, last: 0 };
      u.plays++; u.secs += p.secs; if (p.audio) u.audio++; u.last = Math.max(u.last, p.at);
      per.set(p.user, u);
    }
    const ranked = [...per.entries()].sort((a, b) => b[1].secs - a[1].secs || b[1].plays - a[1].plays);
    const most = ranked[0][1].secs || 1;
    const userDeck = deck('By user', { color: 'sky', num: 1, code: `${per.size}` },
      h('div.diag-users', ranked.map(([id, u], i) => h('div.diag-user',
        h('b', { title: name(id) }, name(id)),
        seg(u.secs / most, { n: 30, tone: colorAt(i) }),
        h('span', `${f.num(u.plays)} plays${u.audio ? ` (${f.num(u.audio)} music)` : ''} · ${f.dur(Math.round(u.secs))} · last ${f.ago(new Date(u.last).toISOString())}`)))));

    // Per day: plays as columns.
    const daysArr = Array.from({ length: Math.min(days, 90) }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (Math.min(days, 90) - 1 - i)); return d; });
    const perDay = daysArr.map(d => plays.filter(p => p.at >= d.getTime() && p.at < d.getTime() + 86400000));
    const peak = Math.max(1, ...perDay.map(p => p.length));
    const dayDeck = deck('By day', { color: 'orange', num: 2, code: `${f.num(plays.length)} plays` },
      h('div.diag-days', daysArr.map((d, i) => h('div.diag-day', { title: `${d.toLocaleDateString()}: ${perDay[i].length} plays` },
        h('i', { style: { height: `${Math.round((perDay[i].length / peak) * 100)}%` } })))),
      h('div.diag-days-l', h('span', daysArr[0].toLocaleDateString()), h('span', 'today')));

    // Hour of day.
    const hours = Array(24).fill(0);
    for (const p of plays) hours[new Date(p.at).getHours()]++;
    const hp = Math.max(1, ...hours);
    const hourDeck = deck('By hour', { color: 'lilac', num: 3, code: '' },
      h('div.diag-days.hours', hours.map((n, i) => h('div.diag-day', { title: `${String(i).padStart(2, '0')}:00: ${n} plays` }, h('i', { style: { height: `${Math.round((n / hp) * 100)}%` } })))),
      h('div.diag-days-l', h('span', '00:00'), h('span', '12:00'), h('span', '23:00')));

    // Most played: episodes under their series, songs under their album.
    const ids = [...new Set(plays.map(p => p.item).filter(Boolean))].slice(0, 1000);
    const items = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const r = await api.get('/Items', { ids: ids.slice(i, i + 100).join(','), fields: 'SeriesName', enableImages: false }, { signal });
        for (const it of r.Items || []) items.set(it.Id.replace(/-/g, ''), it);
      } catch { /* deleted since, or page left */ }
    }
    const top = new Map();
    for (const p of plays) {
      const it = items.get(String(p.item || '').replace(/-/g, ''));
      const key = it ? (it.SeriesId || it.AlbumId || it.Id) : `gone:${p.item}`;
      const e = top.get(key) || { n: 0, secs: 0, id: it ? (it.SeriesId || it.AlbumId || it.Id) : null,
        t: it ? (it.SeriesName || (it.AlbumId ? [it.AlbumArtist, it.Album].filter(Boolean).join(' · ') : '') || it.Name) : 'Removed item' };
      e.n++; e.secs += p.secs; top.set(key, e);
    }
    const topDeck = deck('Most played', { color: 'peach', num: 4, code: '' },
      h('div.diag-list', [...top.values()].sort((a, b) => b.n - a.n || b.secs - a.secs).slice(0, 15).map(e =>
        h('div.diag-row', e.id ? h('a', { href: `#/item/${e.id}` }, e.t) : h('span', e.t), h('span.eng-ro', `${e.n} plays · ${f.dur(Math.round(e.secs))}`)))));

    fill(body, h('div.eng-grid', h('div.eng-col', userDeck, topDeck), h('div.eng-col', dayDeck, hourDeck)));
  }
  period.addEventListener('change', load);
  load();
  return [h('div.rc-opts.eng-filters', h('label.rc-sel', h('span', 'Period'), period),
    h('span.eng-ro', `From the activity log${keep ? `, which keeps ${keep} days` : ''}. Times are from start to stop, so a paused film counts its pause.`)), body];
}

// ---- history (the LCARS plugin's records) -----------------------------------------------------------

const PLUGIN_ID = 'f3cec76b7d21496097cbb4259781b75a'; // Plugin.cs
const HIST_PERIODS = [['7 days', 7], ['30 days', 30], ['90 days', 90], ['A year', 365]];

async function history(ctx) {
  const { api, signal } = ctx;
  let info;
  try { info = await api.get('/Lcars/Info', undefined, { signal }); } catch (e) {
    if (e.status === 404) {
      return deck('History', { color: 'orange', num: 1 },
        h('p.dlg-note', 'Jellyfin keeps no history of transcodes or storage. LCARS’s plugin records them, and it comes with the Jellyfin + LCARS image; this server doesn’t have it.'));
    }
    return errorBox(e);
  }
  const period = sel(HIST_PERIODS, 30);
  const body = h('div');

  async function load() {
    fill(body, loading('Accessing the records'));
    const days = +period.value;
    let tc, st;
    try {
      [tc, st] = await Promise.all([
        api.get('/Lcars/History/Transcodes', { days }, { signal }),
        api.get('/Lcars/History/Storage', { days }, { signal }),
      ]);
    } catch (e) { if (!signal.aborted) fill(body, errorBox(e)); return; }
    fill(body, h('div.eng-grid', h('div.eng-col', transcodeDecks(tc, days)), h('div.eng-col', storageDeck(st, days), recorderDeck(ctx, info))));
  }
  period.addEventListener('change', load);
  load();
  return [h('div.rc-opts.eng-filters', h('label.rc-sel', h('span', 'Period'), period),
    h('span.eng-ro', info.Since ? `Recording since ${new Date(info.Since).toLocaleDateString()} · LCARS plugin v${info.Version}` : `LCARS plugin v${info.Version} · nothing recorded yet`)), body];
}

const secs = r => Math.max(0, (Date.parse(r.End) - Date.parse(r.Start)) / 1000);

function transcodeDecks(list, days) {
  if (!list.length) return deck('Transcodes', { color: 'salmon', num: 1, code: '0' }, empty(`No transcodes in the last ${days} days.`));
  const total = list.reduce((a, r) => a + secs(r), 0);
  const count = (key, arr = list) => { const m = new Map(); for (const r of arr) for (const k of [].concat(key(r)).filter(Boolean)) m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const reasons = count(r => r.Reasons.map(x => REASONS[x] || x));
  const people = count(r => r.UserName);
  const devices = count(r => `${r.Device} · ${r.Client}`);
  const enc = count(r => (r.Hardware && r.Hardware !== 'none' ? r.Hardware : 'software'));
  const bars = (rows, tone) => { const top = rows[0]?.[1] || 1; return h('div.diag-users', rows.slice(0, 8).map(([k, n], i) =>
    h('div.diag-user', h('b', { title: k }, k), seg(n / top, { n: 24, tone: tone || colorAt(i) }), h('span', `${n} ${n === 1 ? 'time' : 'times'}`)))); };
  return [
    deck('Transcodes', { color: 'salmon', num: 1, code: `${list.length}` },
      h('div.eng-tiles',
        h('div.eng-tile', h('b', f.num(list.length)), h('span', 'Transcodes')),
        h('div.eng-tile', h('b', f.dur(Math.round(total)) || '0'), h('span', 'Transcoding')),
        h('div.eng-tile', h('b', f.num(people.length)), h('span', 'People')),
        h('div.eng-tile', h('b', enc.map(([k]) => k).join(', ')), h('span', 'Encoders'))),
      h('h3.set-h', 'Why'), bars(reasons, 'salmon'),
      h('h3.set-h', 'Who'), bars(people),
      h('h3.set-h', 'On what'), bars(devices, 'lilac')),
    deck('Recent transcodes', { color: 'orange', num: 2, code: '' },
      h('div.diag-list', list.slice(0, 100).map(r => h('div.diag-tcr',
        h('span.eng-ro', new Date(r.Start).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })),
        h('div',
          h('a', { href: `#/item/${r.ItemId}` }, r.ItemName),
          h('span.eng-ro', [`${r.UserName} on ${r.Device}`, f.dur(Math.round(secs(r))) || 'under a minute'].join(' · ')),
          h('span.diag-io', [r.VideoOut ? `${r.VideoIn || '?'} → ${r.VideoOut}` : 'video copied', r.AudioOut ? `${r.AudioIn || '?'} → ${r.AudioOut}` : 'audio copied',
            `${r.ContainerIn || '?'} → ${r.ContainerOut || '?'}`].join(' · ')),
          r.Reasons.length ? h('span.eng-why', `Because: ${r.Reasons.map(x => REASONS[x] || x).join(', ')}`) : null))))),
  ];
}

/** A line per disk: used space over the period, with the trend and when it would fill. */
function storageDeck(samples, days) {
  if (!samples.length) return deck('Storage trend', { color: 'peach', num: 3 }, empty('No storage samples yet; one is taken every hour.'));
  const disks = new Map();
  for (const s of samples) {
    const k = s.DeviceId || `${s.Path}`;
    if (!disks.has(k)) disks.set(k, { labels: new Set(), pts: new Map() });
    const d = disks.get(k);
    d.labels.add(s.Group === 'Server' ? s.Label : s.Group);
    d.pts.set(s.T, s); // folders on one disk report the same space at the same time
  }
  const W = 600, H = 120;
  const t0 = Date.now() - days * 86400000, t1 = Date.now();
  return deck('Storage trend', { color: 'peach', num: 3, code: `${disks.size} disks` },
    [...disks.values()].map((d, i) => {
      const pts = [...d.pts.values()].sort((a, b) => Date.parse(a.T) - Date.parse(b.T));
      const last = pts[pts.length - 1], first = pts[0];
      const size = last.Used + last.Free;
      const x = t => ((Date.parse(t) - t0) / (t1 - t0)) * W;
      const y = s => H - (s.Used / (s.Used + s.Free || 1)) * H;
      const line = pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.T).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
      const spanDays = (Date.parse(last.T) - Date.parse(first.T)) / 86400000;
      const grew = last.Used - first.Used;
      const perDay = spanDays >= 1 ? grew / spanDays : 0;
      const full = perDay > 0 ? last.Free / perDay : null;
      return h('div.diag-disk',
        h('div.eng-store-h', h('b', [...d.labels].join(' · ')), h('span', `${f.bytes(last.Used)} of ${f.bytes(size)} · ${f.bytes(last.Free)} free`)),
        h('svg.diag-chart', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Used space on ${[...d.labels].join(', ')}` },
          [0.25, 0.5, 0.75].map(g => h('line.grid', { x1: 0, x2: W, y1: H * g, y2: H * g })),
          h('path.ln', { class: `c${i % 6}`, d: line, 'vector-effect': 'non-scaling-stroke' })),
        h('span.eng-ro', spanDays >= 1
          ? `${grew >= 0 ? '+' : '−'}${f.bytes(Math.abs(grew))} in ${Math.round(spanDays)} days${full != null ? ` · full in about ${full > 3650 ? 'ten years or more' : f.dur(full * 86400)}` : ''}`
          : 'Trend after a day of samples'));
    }));
}

function recorderDeck(ctx, info) {
  const { api } = ctx;
  const opt = (k, opts) => {
    const s = sel(opts, info[k]);
    s.addEventListener('change', async () => {
      try {
        const cfg = await api.get(`/Plugins/${PLUGIN_ID}/Configuration`);
        await api.post(`/Plugins/${PLUGIN_ID}/Configuration`, { ...cfg, [k]: +s.value });
        toast('Saved', '', 'sky', 1500);
      } catch (e) { toast('Unable to comply', e.message, 'red'); }
    });
    return s;
  };
  return deck('Recorder', { color: 'lilac', num: 4 },
    h('div.kv', h('span', 'Kept'), h('span', `${f.num(info.Transcodes)} transcodes · ${f.num(info.StorageSamples)} storage samples`)),
    row('Keep history for', opt('RetentionDays', [['30 days', 30], ['90 days', 90], ['180 days', 180], ['A year', 365], ['Two years', 730]])),
    row('Look at transcodes every', opt('TranscodeSeconds', [['15 seconds', 15], ['30 seconds', 30], ['Minute', 60], ['2 minutes', 120]])),
    row('Record storage every', opt('StorageMinutes', [['15 minutes', 15], ['Hour', 60], ['6 hours', 360], ['Day', 1440]])));
}
