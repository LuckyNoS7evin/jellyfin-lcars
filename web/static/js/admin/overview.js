// Admin overview (official dashboard home, routes/index.tsx and components/widgets): the server,
// its storage, what's in the libraries, who's watching what, running tasks, and the activity log.
// Sessions, tasks and activity are live over the socket.
import { h, fill } from '../h.js';
import { TICKS } from '../api.js';
import * as f from '../fmt.js';
import { deck, btn, tag, seg, empty, toast, image, pickImage, epCode } from '../ui.js';
import { confirmDialog, dialog } from '../menu.js';
import { restartServer } from './admin.js';
import { supports } from '../remote.js';

const REASONS = {
  ContainerNotSupported: 'container', VideoCodecNotSupported: 'video codec', AudioCodecNotSupported: 'audio codec',
  SubtitleCodecNotSupported: 'subtitle format', AudioIsExternal: 'external audio', SecondaryAudioNotSupported: 'secondary audio',
  VideoProfileNotSupported: 'video profile', VideoLevelNotSupported: 'video level', VideoResolutionNotSupported: 'resolution',
  VideoBitDepthNotSupported: 'bit depth', VideoFramerateNotSupported: 'frame rate', RefFramesNotSupported: 'ref frames',
  AnamorphicVideoNotSupported: 'anamorphic', InterlacedVideoNotSupported: 'interlaced', AudioChannelsNotSupported: 'audio channels',
  AudioProfileNotSupported: 'audio profile', AudioSampleRateNotSupported: 'sample rate', AudioBitDepthNotSupported: 'audio bit depth',
  ContainerBitrateExceedsLimit: 'bitrate limit', VideoBitrateNotSupported: 'video bitrate', AudioBitrateNotSupported: 'audio bitrate',
  UnknownVideoStreamInfo: 'unknown video', UnknownAudioStreamInfo: 'unknown audio', DirectPlayError: 'direct play failed',
  VideoRangeTypeNotSupported: 'HDR type', VideoCodecTagNotSupported: 'codec tag', StreamCountExceedsLimit: 'stream count',
};
const COUNTS = [['MovieCount', 'Films'], ['SeriesCount', 'Series'], ['EpisodeCount', 'Episodes'], ['BoxSetCount', 'Collections'],
  ['AlbumCount', 'Albums'], ['SongCount', 'Songs'], ['ArtistCount', 'Artists'], ['BookCount', 'Books'], ['MusicVideoCount', 'Music videos']];
const PATHS = [['ProgramDataFolder', 'Program data'], ['CacheFolder', 'Cache'], ['ImageCacheFolder', 'Image cache'],
  ['InternalMetadataFolder', 'Metadata'], ['TranscodingTempFolder', 'Transcodes'], ['LogFolder', 'Logs'], ['WebFolder', 'Web client']];

export async function overview(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Engineering');
  const [info, pub, storage, counts] = await Promise.all([
    api.get('/System/Info', undefined, { signal }),
    api.publicInfo(),
    api.get('/System/Info/Storage', undefined, { signal }).catch(() => null),
    api.get('/Items/Counts', undefined, { signal }).catch(() => null),
  ]);

  // ---- server -----------------------------------------------------------------------------
  const serverDeck = deck('Server', { color: 'orange', num: 1, code: pub.Version },
    h('div.kv',
      h('span', 'Name'), h('span', pub.ServerName),
      h('span', 'Version'), h('span', [`Jellyfin ${pub.Version}`, info.HasUpdateAvailable ? ' · update available' : ''].join('')),
      h('span', 'System'), h('span', [info.OperatingSystemDisplayName, info.SystemArchitecture].filter(Boolean).join(' · ')),
      info.PackageName ? [h('span', 'Package'), h('span', info.PackageName)] : null,
      h('span', 'Local address'), h('span', pub.LocalAddress || '')),
    h('div.actions',
      btn('Scan all libraries', async () => {
        await api.post('/Library/Refresh');
        toast('Library scan started', 'Progress shows under Running tasks', 'sky');
      }, { color: 'sky' }),
      info.CanSelfRestart ? btn('Restart', () => restartServer(ctx), { color: 'red', ghost: true }) : null,
      btn('Shut down', async () => {
        if (!(await confirmDialog('Shut down server', 'Shut Jellyfin down? It stays off until it is started again (by Docker, if its restart policy says so).', 'Shut down'))) return;
        await api.post('/System/Shutdown');
        toast('Shutting down', '', 'red', 8000);
      }, { color: 'red', ghost: true })));

  // ---- storage: one segmented bar per disk, with the paths on it ------------------------------
  // Paths on the same disk report the same space, so they share a bar.
  function disks(entries) {
    const by = new Map();
    for (const [label, d] of entries) {
      if (!d) continue;
      const key = d.DeviceId || `${d.UsedSpace}/${d.FreeSpace}`;
      if (!by.has(key)) by.set(key, { d, items: [] });
      by.get(key).items.push([label, d.Path]);
    }
    return [...by.values()];
  }
  const bar = ({ d, items }) => {
    // A folder that doesn't exist yet (a fresh server's image cache) reports -1.
    const known = d.UsedSpace >= 0 && d.FreeSpace >= 0;
    const total = known ? d.UsedSpace + d.FreeSpace : 0;
    const frac = total ? d.UsedSpace / total : 0;
    return h('div.eng-store',
      h('div.eng-store-h', h('b', items.map(([l]) => l).join(' · ')),
        h('span', total ? `${f.bytes(d.UsedSpace)} of ${f.bytes(total)} · ${f.bytes(d.FreeSpace)} free` : known ? 'empty' : 'not created yet')),
      seg(frac, { n: 40, tone: frac > 0.9 ? 'alert' : frac > 0.75 ? 'peach' : 'sky' }),
      h('div.eng-store-p', { title: items.map(([, p]) => p).join('\n') }, items.map(([, p]) => p).join(' · ')));
  };
  const storageDeck = storage ? deck('Storage', { color: 'peach', num: 2 },
    h('h3.set-h', 'Server'),
    h('div.eng-stores', disks(PATHS.map(([k, label]) => [label, storage[k]])).map(bar)),
    storage.Libraries?.length ? [h('h3.set-h', 'Libraries'),
      h('div.eng-stores', disks(storage.Libraries.flatMap(l => (l.Folders || []).map(d => [l.Name, d]))).map(bar))] : null) : null;

  // ---- counters ---------------------------------------------------------------------------
  const countDeck = counts ? deck('Library computer', { color: 'lilac', num: 3 },
    h('div.eng-tiles', COUNTS.filter(([k]) => counts[k]).map(([k, label]) => h('div.eng-tile', h('b', f.num(counts[k])), h('span', label))))) : null;

  // ---- sessions (live) ----------------------------------------------------------------------
  const sessBody = h('div');
  function sessionRow(s) {
    const np = s.NowPlayingItem;
    const ps = s.PlayState || {};
    const ti = s.TranscodingInfo;
    const pos = (ps.PositionTicks || 0) / TICKS;
    const dur = (np?.RunTimeTicks || 0) / TICKS;
    const method = ps.PlayMethod === 'Transcode' ? (ti?.IsVideoDirect ? 'Remux / audio transcode' : 'Transcode') : ps.PlayMethod === 'DirectStream' ? 'Direct stream' : 'Direct play';
    const reasons = (ti?.TranscodeReasons || []).map(r => REASONS[r] || r);
    return h('div.eng-sess', { key: s.Id },
      np ? h('div.eng-sess-img', image(api, pickImage(np, np.MediaType === 'Audio' ? 'square' : 'poster'), { shape: np.MediaType === 'Audio' ? 'square' : 'poster' })) : h('div.eng-sess-img.none'),
      h('div.eng-sess-b',
        h('div.eng-sess-who', h('b', s.UserName || 'No user'), h('span', `${s.DeviceName} · ${s.Client} ${s.ApplicationVersion || ''}`.trim())),
        np ? [
          h('a.eng-sess-t', { href: `#/item/${np.Id}` }, [np.SeriesName, np.Type === 'Episode' ? epCode(np) : '', np.Name].filter(Boolean).join(' · ')),
          dur ? h('div.eng-sess-p', seg(pos / dur, { n: 30, tone: ps.IsPaused ? 'lilac' : 'orange' }), h('span', `${ps.IsPaused ? 'Paused ' : ''}${f.clock(pos)} / ${f.clock(dur)}`)) : null,
          h('div.eng-sess-m',
            tag(method, ps.PlayMethod === 'Transcode' ? 'salmon' : 'sky'),
            ti ? [
              ti.VideoCodec ? tag(`${ti.VideoCodec}${ti.Height ? ` ${ti.Height}p` : ''}`, 'lilac') : null,
              ti.AudioCodec ? tag(`${ti.AudioCodec}${ti.AudioChannels ? ` ${ti.AudioChannels}ch` : ''}`, 'lilac') : null,
              ti.Bitrate ? tag(`${(ti.Bitrate / 1e6).toFixed(1)} Mbps`, 'blue') : null,
              ti.HardwareAccelerationType && ti.HardwareAccelerationType !== 'none' ? tag(ti.HardwareAccelerationType, 'peach') : null,
              ti.Framerate ? tag(`${Math.round(ti.Framerate)} fps`, 'blue') : null,
            ] : null,
            reasons.length ? h('span.eng-why', `Because: ${reasons.join(', ')}`) : null),
        ] : h('div.eng-sess-idle', `Idle · last active ${f.ago(s.LastActivityDate)}`)),
      h('div.eng-sess-a',
        supports(s, 'DisplayMessage') ? btn('Message', () => askMessage(s), { small: true, color: 'sky', ghost: true }) : null,
        np && s.SupportsMediaControl ? btn('Stop', () => stopSession(s), { small: true, color: 'red', ghost: true }) : null));
  }
  function askMessage(s) {
    const text = h('input.inp', { attrs: { maxlength: 300, placeholder: 'Text', 'aria-label': 'Message' } });
    let d = null;
    const send = () => { if (!text.value.trim()) { text.focus(); return; } app.remote.message(s, 'Message from the server', text.value.trim()); d.close(); };
    d = dialog(`Message ${s.UserName || ''} on ${s.DeviceName}`.replace('  ', ' '), h('form.dlg-form', { onsubmit: e => { e.preventDefault(); send(); } }, text),
      [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Send', send, { color: 'sky' })], { color: 'sky' });
    setTimeout(() => text.focus(), 0);
  }
  async function stopSession(s) {
    const who = `${s.UserName || 'someone'} on ${s.DeviceName}`;
    if (!(await confirmDialog('Stop playback', `Stop what ${who} is playing?`, 'Stop'))) return;
    try { await api.post(`/Sessions/${s.Id}/Playing/Stop`); toast('Stopped', who, 'red', 2500); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  const ACTIVE_MS = 10 * 60 * 1000;
  function drawSessions(list) {
    const now = Date.now();
    const shown = list.filter(s => s.DeviceId !== api.deviceId && (s.NowPlayingItem || now - Date.parse(s.LastActivityDate) < ACTIVE_MS))
      .sort((a, b) => (!!b.NowPlayingItem - !!a.NowPlayingItem) || Date.parse(b.LastActivityDate) - Date.parse(a.LastActivityDate));
    const playing = shown.filter(s => s.NowPlayingItem).length;
    sessDeck.querySelector('.code').textContent = `${playing} active`;
    fill(sessBody, shown.length ? h('div.eng-sessions', shown.map(sessionRow)) : empty('No one is connected right now.'));
  }
  const sessDeck = deck('Active sessions', { color: 'sky', num: 4, code: '' }, sessBody);

  // ---- running tasks (live) -----------------------------------------------------------------
  const taskBody = h('div');
  function drawTasks(tasks) {
    const running = (tasks || []).filter(t => t.State !== 'Idle');
    fill(taskBody, running.length ? running.map(t => h('div.eng-task',
      h('div.eng-task-h', h('b', t.Name), h('span', t.State === 'Cancelling' ? 'Stopping…' : `${Math.round(t.CurrentProgressPercentage || 0)}%`)),
      seg((t.CurrentProgressPercentage || 0) / 100, { n: 40, tone: 'orange' }))) : empty('No tasks running.'));
  }
  const taskDeck = deck('Running tasks', { color: 'blue', num: 5 }, taskBody);

  // ---- activity and alerts -------------------------------------------------------------------
  const actBody = h('div');
  const alertBody = h('div');
  const entry = e => h('div.eng-act', { class: `sev-${(e.Severity || 'Information').toLowerCase()}` },
    h('span.eng-act-t', { title: new Date(e.Date).toLocaleString() }, f.ago(e.Date)),
    h('span.eng-act-n', e.Name),
    e.ShortOverview ? h('span.eng-act-o', e.ShortOverview) : null);
  let actTimer = null;
  async function loadActivity() {
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    try {
      const [act, alerts] = await Promise.all([
        api.get('/System/ActivityLog/Entries', { startIndex: 0, limit: 8, hasUserId: true, minDate: week }, { signal }),
        api.get('/System/ActivityLog/Entries', { startIndex: 0, limit: 6, hasUserId: false, minDate: week }, { signal }),
      ]);
      fill(actBody, act.Items?.length ? act.Items.map(entry) : empty('Nothing this week.'));
      fill(alertBody, alerts.Items?.length ? alerts.Items.map(entry) : empty('No alerts this week.'));
    } catch { /* page left */ }
  }
  const actDeck = deck('Activity', { color: 'salmon', num: 6 }, actBody);
  const alertDeck = deck('Alerts', { color: 'red', num: 7 }, alertBody);

  // ---- live data ----------------------------------------------------------------------------
  drawSessions([]);
  drawTasks([]);
  loadActivity();
  const offs = [
    app.subscribe('Sessions', d => drawSessions(Array.isArray(d) ? d : [])),
    app.subscribe('ScheduledTasksInfo', d => drawTasks(d), '0,1000'),
    // The server sends the new entries; one re-read keeps both lists right (and filtered).
    app.subscribe('ActivityLogEntry', () => { clearTimeout(actTimer); actTimer = setTimeout(loadActivity, 300); }, '0,1000'),
  ];
  // The first Sessions push can take a moment; show the list straight away.
  api.get('/Sessions', undefined, { signal }).then(drawSessions).catch(() => {});
  api.get('/ScheduledTasks', { isHidden: false }, { signal }).then(drawTasks).catch(() => {});
  signal.addEventListener('abort', () => { for (const off of offs) off(); clearTimeout(actTimer); });

  return h('div.eng-grid',
    h('div.eng-col', serverDeck, countDeck, sessDeck, taskDeck),
    h('div.eng-col', storageDeck, actDeck, alertDeck));
}
