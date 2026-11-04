// The LCARS video player core: controls, keys, scrub bar, chapters, skip intro, Up next, the
// video queue, track menus, speed, subtitle delay and look, aspect ratio, the playback info
// overlay, "Are you still watching?", cinema mode intros, multi-part films and playback
// reports. How the stream actually plays is up to an engine (engine.js): the browser's <video>
// on the web, mpv in the desktop app. Nothing in here touches a media element directly.
import { h, fill } from '../h.js';
import { Api, TICKS } from '../api.js';
import * as f from '../fmt.js';
import { btn, arrow, tag, toast, epCode, image, pickImage, seg, volumeBar } from '../ui.js';
import { Reporter, playbackInfo } from './report.js';
import { autoBitrate, lastMeasured } from './bitrate.js';
import { createEngine } from './engine.js';
import { native } from '../shell.js';

const QUALITIES = [
  ['Auto', 0], ['60 Mbps', 60e6], ['40 Mbps', 40e6], ['20 Mbps', 20e6], ['10 Mbps', 10e6],
  ['8 Mbps', 8e6], ['4 Mbps', 4e6], ['2 Mbps', 2e6], ['1 Mbps', 1e6],
];

const REPEATS = [['Off', 'RepeatNone'], ['All', 'RepeatAll'], ['One', 'RepeatOne']];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ASPECTS = [['Auto', 'auto'], ['Fill the screen (crop)', 'cover'], ['Stretch', 'fill']];
// Official plugins/stillWatching/constants.ts: items played, and hours without input.
const STILL_WATCHING = { short: [2, 1], default: [3, 1.5], long: [5, 2.5], veryLong: [8, 4] };
const KEYS = [
  ['Space · K', 'Play / pause'], ['← →', 'Skip back / forward'], ['J · L', 'Back / forward 10 seconds'],
  ['0 – 9', 'Jump to 0 – 90%'], ['Home · End', 'Start / end'], [', .', 'Frame back / forward (paused)'],
  ['< >', 'Slower / faster'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['G · H', 'Subtitles earlier / later'],
  ['A', 'Aspect ratio'], ['I', 'Playback info'], ['F', 'Full screen'], ['Page up · Page down', 'Chapters'],
  ['N · P', 'Next / previous'], ['Enter', 'Skip intro / start next'], ['?', 'This list'], ['Esc', 'Close'],
];

const streamLabel = s => s.DisplayTitle || [s.Language, s.Codec, s.Title].filter(Boolean).join(' · ') || `Track ${s.Index}`;

/**
 * playVideo(app, item, {resume, startTicks, audioIndex, subIndex, list, index}) -> controller.
 * list/index: a video queue (play all, shuffle); without one, episodes go on to the next
 * episode of the series.
 * app: {api, us (UserSettings), onPlayerClosed(item)}.
 */
export function playVideo(app, item, opts = {}) {
  const { api } = app;
  // Playback settings as they were when the player opened (settings.js `playback`).
  const pb = app.us.playback;
  const eng = createEngine(app, pb);
  const statusEl = h('div.p-status');
  const titleEl = h('div.p-title');
  const infoEl = h('div.p-info');
  const timeEl = h('div.p-time');
  const bufEl = h('div.buf');
  const posEl = h('div.pos');
  const marksEl = h('div.marks');
  const scrub = h('div.scrub', { attrs: { role: 'slider', 'aria-label': 'Position', tabindex: 0 } }, bufEl, posEl, marksEl);
  const tipEl = h('div.scrub-tip', { hidden: true });
  const skipEl = h('button.btn.skip-seg', { type: 'button', class: 'c-orange', hidden: true, onclick: () => skipSegment(askSeg) });
  const upNextEl = h('div.upnext.c-blue', { hidden: true });
  const btnsEl = h('div.p-btns');
  const osdEl = h('div.p-osd', { hidden: true, attrs: { 'aria-live': 'polite' } });
  const statsEl = h('div.p-stats', { hidden: true });
  const askEl = h('div.p-ask', { hidden: true, attrs: { role: 'alertdialog', 'aria-label': 'Are you still watching?' } });
  let menuEl = null;
  // The engine's element sits in its own box so subtitle canvases stay under the controls.
  const root = h('div.player', { attrs: { role: 'dialog', 'aria-label': 'Video player' } },
    h('div.p-vid', eng.el),
    statusEl,
    h('div.p-ui',
      h('div.p-top', h('span.cap'), titleEl, infoEl),
      h('div.p-bot', timeEl, h('div.scrub-wrap', scrub, tipEl), btnsEl)),
    statsEl,
    skipEl,
    upNextEl,
    osdEl,
    askEl);

  let cur = item;           // the episode/movie being played (changes on "next")
  let full = null;          // cur with chapters and trickplay info
  let list = opts.list?.length ? [...opts.list] : null;
  let listIndex = list ? Math.max(0, opts.index || 0) : 0;
  // Official repeat modes: RepeatAll starts the list again (after any intros), RepeatOne this item.
  let repeat = 'RepeatNone';
  const introIds = new Set();
  let ms = null;            // media source
  let wantSource = opts.mediaSourceId; // version chosen on the title page (first item only)
  let playSessionId = null;
  let method = 'DirectPlay';
  let reporter = null;
  let audioIndex = opts.audioIndex;
  // Watch together (syncplay.js): the controls ask the group instead of acting, and the group's
  // commands drive the player through ctl.local.
  let sync = opts.sync || null;
  let syncLoaded = false;   // this item has loaded and paused at its start for the group
  let onSeeked = null;      // resolves ctl.local.whenReady() after a group seek
  let subIndex = opts.subIndex;
  let maxBitrate = pb.maxBitrate || 0;
  const skipBack = pb.skipBack;
  const skipFwd = pb.skipForward;
  let forceTranscode = false;
  let burnAll = false;      // drawing a subtitle failed: let the server burn subtitles in
  let nextEp = null;        // what "next" plays: the next in the list, or the next episode
  let segments = [];        // media segments (intro, outro...) in seconds
  const segDone = new Set(); // segments already skipped or offered
  let askSeg = null;        // the segment the Skip button is offering
  let askSince = 0;
  let upNext = null;        // null, 'shown' or 'hidden' for this item
  let closed = false;
  let duration = (item.RunTimeTicks || 0) / TICKS;
  let started = false;
  let loadToken = 0;
  let showRemaining = app.us.local('timeRemaining', true); // right-hand time: remaining or total
  let secIndex = null;      // secondary subtitle (browser only)
  let statsTimer = null;
  let session = null;       // this device's server session, for the info overlay
  // "Are you still watching?" (official stillWatching plugin): since the player opened or the
  // last answer, the items started and the time of the last key press or mouse move.
  let watchStart = Date.now();
  const watched = new Set([item.Id]);
  let lastInput = Date.now();
  eng.aspect = app.us.local('aspectRatio', 'auto');

  const position = () => eng.position;
  const state = () => ({ position: position(), paused: eng.paused, muted: eng.muted, volume: eng.volume, repeat });

  function setStatus(text, blink = false) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('blink', blink);
  }

  function drawTitle() {
    const kicker = cur.Type === 'Episode' ? [cur.SeriesName, epCode(cur)].filter(Boolean).join(' · ') : cur.ProductionYear || '';
    fill(titleEl, h('b', cur.Name), kicker ? h('span', String(kicker)) : '');
  }

  function drawInfo() {
    const vs = ms?.MediaStreams?.find(s => s.Type === 'Video');
    fill(infoEl,
      sync ? tag('Together', 'peach') : null,
      tag(method === 'DirectPlay' ? 'Direct' : 'Transcode', method === 'DirectPlay' ? 'sky' : 'salmon'),
      vs ? tag(`${vs.Codec || ''} ${vs.Height ? vs.Height + 'p' : ''}`.trim(), 'lilac') : null,
      ms?.Container ? tag(ms.Container, 'blue') : null,
      btn('Exit', close, { small: true, color: 'red' }));
  }

  function drawTime() {
    const p = position();
    const d = dur();
    const ends = d ? new Date(Date.now() + (d - p) * 1000 / eng.rate) : null;
    const rate = eng.rate;
    fill(timeEl,
      h('span', f.clock(p)),
      h('span', [ends ? `Ends ${ends.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '', rate !== 1 ? ` · ${rate}×` : ''].join('')),
      // Click to switch between time remaining and the total.
      h('span.t-end', { attrs: { role: 'button', tabindex: 0, title: showRemaining ? 'Time remaining (click for total)' : 'Total time (click for remaining)' } },
        d ? (showRemaining ? `-${f.clock(Math.max(0, d - p))}` : f.clock(d)) : ''));
    posEl.style.width = d ? `${Math.min(100, (p / d) * 100)}%` : '0';
    const buf = eng.bufferedTo(p);
    bufEl.style.width = d ? `${Math.min(100, (buf / d) * 100)}%` : '0';
  }

  // ---- volume, speed and the on-screen readout ------------------------------------------------

  function setVolume(v) {
    eng.volume = Math.max(0, Math.min(1, v));
    if (eng.volume > 0) eng.muted = false;
  }
  function toggleMute() { eng.muted = !eng.muted; }
  const volBar = volumeBar({ volume: () => eng.volume, muted: () => eng.muted, set: setVolume, toggleMute });
  volBar.classList.add('p-vol');

  let osdTimer = null;
  /** A short readout at the top of the picture: "Volume" with a meter, "Speed 1.5×"... */
  function osd(label, value, frac) {
    fill(osdEl, h('span.cap'), h('b', label), value != null ? h('span', String(value)) : null, frac != null ? seg(frac, { n: 20, tone: 'sky' }) : null);
    osdEl.hidden = false;
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { osdEl.hidden = true; }, 1300);
  }
  const showVolume = () => osd(eng.muted ? 'Muted' : 'Volume', eng.muted ? null : `${Math.round(eng.volume * 100)}%`, eng.muted ? 0 : eng.volume);

  function setSpeed(r) {
    eng.rate = r;
    osd('Speed', `${r}×`);
    drawTime();
  }
  function stepSpeed(dir) {
    const i = SPEEDS.indexOf(eng.rate);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
    setSpeed(next);
  }

  function setAspect(a) {
    eng.aspect = a;
    app.us.setLocal('aspectRatio', a);
    osd('Aspect ratio', ASPECTS.find(x => x[1] === a)?.[0]);
  }
  function cycleAspect() {
    const i = ASPECTS.findIndex(x => x[1] === eng.aspect);
    setAspect(ASPECTS[(i + 1) % ASPECTS.length][1]);
  }

  const delayText = d => `${d > 0 ? '+' : ''}${d.toFixed(1)} s`;
  function setDelay(d) {
    eng.subtitleDelay = d;
    osd('Subtitle delay', delayText(eng.subtitleDelay));
    if (menuEl?.dataset.kind === 'options') menu('options', true);
  }

  function drawButtons() {
    const subs = ms?.MediaStreams?.filter(s => s.Type === 'Subtitle') || [];
    const auds = ms?.MediaStreams?.filter(s => s.Type === 'Audio') || [];
    fill(btnsEl, 
      btn(eng.paused ? 'Play' : 'Pause', toggle, { color: 'orange' }),
      btn(`−${skipBack}`, () => seekBy(-skipBack), { color: 'peach', title: `Back ${skipBack} seconds` }),
      btn(`+${skipFwd}`, () => seekBy(skipFwd), { color: 'peach', title: `Forward ${skipFwd} seconds` }),
      auds.length > 1 ? btn('Audio', () => menu('audio'), { color: 'sky' }) : null,
      subs.length ? btn('Subtitles', () => menu('subs'), { color: 'sky' }) : null,
      // Only users allowed to transcode get a choice (official playersettingsmenu.js).
      btn('Options', () => menu('options'), { color: 'lilac', title: 'Quality, speed, aspect ratio, subtitle delay, info' }),
      chapters().length > 1 ? btn([arrow('l'), h('span', 'Chapter')], prevChapter, { color: 'blue', title: 'Previous chapter (Page Up)' }) : null,
      chapters().length > 1 ? btn([h('span', 'Chapter'), arrow('r')], nextChapter, { color: 'blue', title: 'Next chapter (Page Down)' }) : null,
      list && listIndex > 0 ? btn('Previous', playPrev, { color: 'blue', title: list[listIndex - 1].Name }) : null,
      nextEp ? btn('Next', playNext, { color: 'blue', title: nextEp.Name }) : null,
      introIds.has(cur.Id) ? null : btn(isFav() ? '★' : '☆', toggleFav, { color: 'salmon', ghost: !isFav(), title: isFav() ? 'Remove from favourites' : 'Add to favourites' }),
      // The volume meter sits inside the lilac bar.
      h('span.grow', volBar),
      btn(isFullscreen() ? 'Window' : 'Full screen', fullscreen, { color: 'salmon' }),
      h('span.grow.r'));
  }

  // ---- favourite ----------------------------------------------------------------------------

  const userData = () => (full?.Id === cur.Id ? full.UserData : null) || cur.UserData || (cur.UserData = {});
  const isFav = () => !!userData().IsFavorite;
  async function toggleFav() {
    const it = cur, ud = userData(), on = !ud.IsFavorite;
    try {
      const r = await api.setFavorite(it.Id, on);
      Object.assign(ud, r || { IsFavorite: on });
      if (it.UserData && it.UserData !== ud) it.UserData.IsFavorite = ud.IsFavorite;
    } catch (e) { toast('Unable to comply', e.message, 'red'); return; }
    if (closed || cur !== it) return;
    osd(on ? 'Added to favourites' : 'Removed from favourites', it.Name);
    drawButtons();
  }

  function setRepeat(mode) {
    if (!REPEATS.some(r => r[1] === mode)) return;
    repeat = mode;
    osd('Repeat', REPEATS.find(r => r[1] === mode)[0]);
    reporter?.progress('RepeatModeChange');
    if (menuEl?.dataset.kind === 'options') menu('options', true);
  }

  // ---- menus ------------------------------------------------------------------------------

  function closeMenu() { menuEl?.remove(); menuEl = null; }

  const textSubs = () => (ms?.MediaStreams || []).filter(x => x.Type === 'Subtitle' && x.DeliveryMethod === 'External' && x.DeliveryUrl && !['ass', 'ssa', 'pgssub', 'pgs'].includes((x.Codec || '').toLowerCase()));
  const canTranscode = () => app.me?.Policy?.EnableVideoPlaybackTranscoding !== false;

  /**
   * The track and options menus. Rows are [label, on, fn, value?] or elements; fn returning
   * 'stay' keeps the menu open (it redraws). keep: redraw in place rather than toggling.
   */
  function menu(kind, keep = false) {
    if (!keep && menuEl?.dataset.kind === kind) { closeMenu(); return; }
    closeMenu();
    let title, rows, color = 'c-sky';
    const back = ['‹ Options', false, () => { menu('options'); return 'stay'; }];
    if (kind === 'audio') {
      title = 'Audio';
      rows = ms.MediaStreams.filter(s => s.Type === 'Audio').map(s => [streamLabel(s), s.Index === audioIndex, () => switchAudio(s.Index)]);
    } else if (kind === 'subs') {
      title = 'Subtitles';
      rows = [['Off', subIndex == null || subIndex < 0, () => switchSubs(-1)],
        ...ms.MediaStreams.filter(s => s.Type === 'Subtitle').map(s => [
          `${streamLabel(s)}${s.DeliveryMethod === 'Encode' ? ' · burn-in' : ''}`, s.Index === subIndex, () => switchSubs(s.Index)])];
    } else if (kind === 'subs2') {
      title = 'Secondary subtitles';
      rows = [back, ['Off', secIndex == null, () => setSecondary(null)],
        ...textSubs().filter(s => s.Index !== subIndex).map(s => [streamLabel(s), s.Index === secIndex, () => setSecondary(s.Index)])];
    } else if (kind === 'quality') {
      title = 'Quality';
      color = 'c-lilac';
      rows = [back, ...QUALITIES.map(([label, bps]) => [label, bps === maxBitrate, () => switchQuality(bps)])];
    } else if (kind === 'repeat') {
      title = 'Repeat';
      color = 'c-lilac';
      rows = [back, ...REPEATS.map(([label, m]) => [label, repeat === m, () => setRepeat(m)])];
    } else if (kind === 'speed') {
      title = 'Playback speed';
      color = 'c-lilac';
      rows = [back, ...SPEEDS.map(r => [r === 1 ? 'Normal' : `${r}×`, eng.rate === r, () => setSpeed(r)])];
    } else if (kind === 'aspect') {
      title = 'Aspect ratio';
      color = 'c-lilac';
      rows = [back, ...ASPECTS.map(([label, a]) => [label, eng.aspect === a, () => setAspect(a)])];
    } else if (kind === 'keys') {
      title = 'Keyboard';
      color = 'c-lilac';
      rows = [h('dl.p-keys', KEYS.map(([k, what]) => [h('dt', k), h('dd', what)]))];
    } else {
      title = 'Options';
      color = 'c-lilac';
      const sub = k => () => { menu(k); return 'stay'; };
      const hasSubs = (ms?.MediaStreams || []).some(x => x.Type === 'Subtitle') && subIndex != null && subIndex >= 0;
      rows = [
        canTranscode() ? ['Quality', false, sub('quality'), QUALITIES.find(q => q[1] === maxBitrate)?.[0] || 'Auto'] : null,
        ['Playback speed', false, sub('speed'), eng.rate === 1 ? 'Normal' : `${eng.rate}×`],
        sync ? null : ['Repeat', false, sub('repeat'), REPEATS.find(r => r[1] === repeat)[0]],
        ['Aspect ratio', false, sub('aspect'), ASPECTS.find(x => x[1] === eng.aspect)?.[0]],
        hasSubs ? h('div.p-mrow',
          h('span', 'Subtitle delay'),
          h('span.p-delay',
            btn('−', () => setDelay(eng.subtitleDelay - 0.1), { small: true, color: 'sky', title: 'Earlier (G)' }),
            h('b', delayText(eng.subtitleDelay)),
            btn('+', () => setDelay(eng.subtitleDelay + 0.1), { small: true, color: 'sky', title: 'Later (H)' }),
            eng.subtitleDelay ? btn('Reset', () => setDelay(0), { small: true, color: 'sky', ghost: true }) : null)) : null,
        eng.setSecondarySubtitle && textSubs().length > (textSubs().some(s => s.Index === subIndex) ? 1 : 0)
          ? ['Secondary subtitles', false, sub('subs2'), secIndex == null ? 'Off' : streamLabel(ms.MediaStreams.find(s => s.Index === secIndex) || {})] : null,
        ['Playback info', !statsEl.hidden, () => { toggleStats(); return 'stay'; }, statsEl.hidden ? 'Off' : 'On'],
        eng.canPip ? ['Picture in picture', eng.pip, () => { eng.togglePip().catch(e => toast('Unable to comply', e.message, 'red')); }] : null,
        ['Keyboard shortcuts', false, sub('keys'), '?'],
      ].filter(Boolean);
    }
    menuEl = h('div.p-menu', { class: color, attrs: { 'data-kind': kind } },
      h('h3', title),
      rows.map(r => (r instanceof Node ? r : h('button', {
        type: 'button', class: r[1] ? 'on' : '',
        onclick: () => {
          const res = r[2]();
          if (res === 'stay') { if (menuEl?.dataset.kind === kind) menu(kind, true); } else closeMenu();
        },
      }, h('span', r[0]), r[3] != null ? h('small', String(r[3])) : null))));
    root.querySelector('.p-ui').append(menuEl);
  }

  // ---- loading ----------------------------------------------------------------------------

  async function load(startAt) {
    const token = ++loadToken;
    setStatus('Accessing', true);
    lastT = -1;
    if (reporter) { await reporter.stop(); reporter = null; }
    eng.stop();
    let info;
    const fullP = full?.Id === cur.Id ? Promise.resolve(full) : api.item(cur.Id).catch(() => cur);
    // Auto: the limit the connection test found (none at home).
    const cap = maxBitrate || await autoBitrate(api).catch(() => 0) || undefined;
    if (token !== loadToken || closed) return;
    try {
      [info, full] = await Promise.all([playbackInfo(api, cur.Id, {
        profile: eng.profile({ maxBitrate: cap, burnIn: burnAll }),
        maxBitrate: cap,
        // The version picked on the title page (for that item, not its intros), then the same one on reloads.
        mediaSourceId: ms?.Id || (cur.Id === item.Id ? wantSource : undefined),
        audioIndex, subIndex,
        directPlay: !forceTranscode,
        alwaysBurnIn: pb.alwaysBurnInWhenTranscoding,
      }), fullP]);
    } catch (e) {
      if (token === loadToken) setStatus(`Unable to comply: ${e.message}`);
      return;
    }
    if (token !== loadToken || closed) return;
    ms = info.ms;
    playSessionId = info.playSessionId;
    if (ms.RunTimeTicks) duration = ms.RunTimeTicks / TICKS;
    if (audioIndex == null) audioIndex = ms.DefaultAudioStreamIndex;
    if (subIndex == null) subIndex = ms.DefaultSubtitleStreamIndex ?? -1;

    const direct = ms.SupportsDirectPlay && !forceTranscode && !ms.TranscodingUrl;
    method = direct ? 'DirectPlay' : 'Transcode';

    // Subtitles delivered as files (not burned in), for the engine to show.
    const subs = ms.MediaStreams
      .filter(x => x.Type === 'Subtitle' && x.DeliveryMethod === 'External' && x.DeliveryUrl)
      .map(x => ({ ...x, url: api.url(x.DeliveryUrl.replace(/^\/+/, '/')) }));
    let url;
    if (direct) {
      url = api.url(`/Videos/${cur.Id}/stream.${ms.Container}`, {
        static: true, mediaSourceId: ms.Id, deviceId: api.deviceId, playSessionId, Tag: ms.ETag,
      }, { auth: true });
    } else {
      url = api.url(ms.TranscodingUrl.replace(/^\/+/, '/'));
      if (!/[?&](api_key|ApiKey)=/i.test(url)) url += `&ApiKey=${encodeURIComponent(api.token)}`;
    }
    await eng.load({ url, hls: !direct, direct, startAt, ms, subs, item: cur, audioIndex });
    if (token !== loadToken || closed) return;
    applySubs();
    drawInfo();
    drawButtons();
    drawMarks();
    loadSegments(token);

    syncLoaded = false;
    reporter = new Reporter(api, { itemId: cur.Id, mediaSourceId: ms.Id, playSessionId, playMethod: method, audioIndex, subIndex }, state);
    started = false;
    // Tell the server what's loaded even if it hasn't started: a remote Play into a background
    // tab waits until the tab is shown, and the remote should see the film arrive (paused).
    const early = setTimeout(() => { if (!started && token === loadToken && !closed) { started = true; reporter?.start(); } }, 2000);
    try { await eng.play(); } catch (e) {
      // Without a click on the page first, browsers only let video start muted.
      if (e?.name === 'NotAllowedError' && !eng.muted && token === loadToken && !closed) {
        eng.muted = true;
        try {
          await eng.play();
          autoMuted = true;
          osd('Muted', 'Click or press a key for sound');
          return;
        } catch { eng.muted = false; }
      }
      setStatus('Press play');
      drawButtons();
      if (sync && !syncLoaded) { syncLoaded = true; sync.loaded(); }
      clearTimeout(early);
      if (!started && token === loadToken && !closed) { started = true; reporter?.start(); }
    }
  }
  // Muted by the browser's autoplay rule: the first click or key brings the sound back.
  let autoMuted = false;
  const unmuteOnInput = () => { if (autoMuted) { autoMuted = false; eng.muted = false; showVolume(); } };

  const withUrl = s => ({ ...s, url: api.url(s.DeliveryUrl.replace(/^\/+/, '/')) });

  /** Show the chosen subtitles if they're delivered as files (burned-in ones need nothing). */
  function applySubs() {
    const s = ms?.MediaStreams?.find(x => x.Type === 'Subtitle' && x.Index === subIndex);
    // mpv also shows the file's own (embedded) subtitles; other engines get them burned in.
    eng.setSubtitle(s && s.DeliveryMethod === 'External' && s.DeliveryUrl ? withUrl(s)
      : s && eng.embeddedSubs && s.DeliveryMethod === 'Embed' ? s : null);
    if (eng.setSecondarySubtitle) {
      const s2 = secIndex != null && secIndex !== subIndex && textSubs().find(x => x.Index === secIndex);
      if (!s2) secIndex = null;
      eng.setSecondarySubtitle(s2 ? withUrl(s2) : null);
    }
  }

  function setSecondary(idx) {
    secIndex = idx;
    applySubs();
  }

  function switchAudio(idx) {
    if (idx === audioIndex) return;
    audioIndex = idx;
    load(position());
  }

  function switchSubs(idx) {
    const s = ms.MediaStreams.find(x => x.Index === idx);
    const old = ms.MediaStreams.find(x => x.Index === subIndex);
    const burnedNow = old?.DeliveryMethod === 'Encode';
    subIndex = idx;
    if (reporter) reporter.info.subIndex = idx;
    const engineShows = s && eng.embeddedSubs && s.DeliveryMethod === 'Embed';
    if ((s && s.DeliveryMethod === 'Encode') || burnedNow || (s && !s.DeliveryUrl && s.DeliveryMethod !== 'External' && !engineShows)) {
      load(position()); // the server has to (stop) burning them in
    } else {
      applySubs();
      reporter?.progress('SubtitleTrackChange');
    }
  }

  function switchQuality(bps) {
    maxBitrate = bps;
    forceTranscode = bps > 0;
    load(position());
  }

  // ---- chapters, segments, scrub preview, up next -------------------------------------------

  const chapters = () => (full?.Id === cur.Id ? full.Chapters : cur.Chapters) || [];
  const dur = () => duration || eng.duration || 0;

  function drawMarks() {
    const d = dur();
    fill(marksEl, d ? chapters().filter(c => c.StartPositionTicks > 0).map(c => {
      const m = h('i');
      m.style.left = `${Math.min(100, (c.StartPositionTicks / TICKS / d) * 100)}%`;
      return m;
    }) : null);
  }

  // Official playbackmanager.js: next goes to the first chapter after now (or the next
  // item); previous steps back 10 seconds first, so a double press goes back a chapter.
  function nextChapter() {
    const p = position();
    const c = chapters().find(x => x.StartPositionTicks / TICKS > p + 0.5);
    if (c) seekTo(c.StartPositionTicks / TICKS); else if (nextEp) playNext();
  }
  function prevChapter() {
    const t = Math.max(0, position() - 10);
    const c = chapters().filter(x => x.StartPositionTicks / TICKS <= t).pop();
    seekTo(c ? c.StartPositionTicks / TICKS : 0);
  }

  async function loadSegments(token) {
    segments = [];
    if (ms?.HasSegments === false) return;
    try {
      const r = await api.get(`/MediaSegments/${cur.Id}`);
      if (token !== loadToken) return;
      segments = (r.Items || []).map(s => ({ id: s.Id, type: s.Type, start: (s.StartTicks || 0) / TICKS, end: s.EndTicks ? s.EndTicks / TICKS : 0 }))
        .filter(s => pb.segmentAction(s.type) !== 'None');
    } catch { /* no segments */ }
  }

  const SEG_NAMES = { Intro: 'intro', Outro: 'credits', Recap: 'recap', Preview: 'preview', Commercial: 'commercial' };
  // A segment that runs to the end of the video skips straight to the next item.
  const toEnd = s => !s.end || s.end >= dur() - 1;

  function skipSegment(s) {
    if (!s) return;
    hideSkip();
    if (toEnd(s) && nextEp) playNext();
    else if (s.end) seekTo(s.end);
  }

  function hideSkip() { askSeg = null; skipEl.hidden = true; }

  // Official mediaSegmentManager.ts: each segment acts once when playback enters it;
  // auto-skip ignores ones under a second, the prompt ones under three seconds.
  function checkSegments() {
    const p = position();
    const s = segments.find(x => p >= x.start && p < (x.end || Infinity));
    if (askSeg && askSeg !== s) hideSkip();
    if (s && !segDone.has(s.id)) {
      segDone.add(s.id);
      const len = (s.end || dur()) - s.start;
      const action = pb.segmentAction(s.type);
      if (action === 'Skip' && len >= 1) { skipSegment(s); toast(`Skipped ${SEG_NAMES[s.type] || s.type.toLowerCase()}`, '', 'orange', 1800); return; }
      if (action === 'AskToSkip' && len >= 3) {
        // Credits running to the end: the Up next card is the prompt (official video/index.js).
        if (toEnd(s) && nextEp && pb.nextVideoInfo) { showUpNext(); return; }
        askSeg = s;
        askSince = Date.now();
        skipEl.textContent = toEnd(s) && nextEp ? 'Next episode' : `Skip ${SEG_NAMES[s.type] || s.type.toLowerCase()}`;
      }
    }
    // The prompt shows for 8 seconds, and again whenever the controls are up.
    if (askSeg) skipEl.hidden = Date.now() - askSince > 8000 && root.classList.contains('idle');
  }

  function showUpNext() {
    if (upNext || !nextEp) return;
    upNext = 'shown';
    const n = nextEp;
    const kicker = n.Type === 'Episode' ? [n.SeriesName, epCode(n)].filter(Boolean).join(' · ') : n.ProductionYear || '';
    fill(upNextEl,
      h('div.un-pic', image(api, pickImage(n, 'wide'), { shape: 'wide', label: n.Name })),
      h('div.un-txt',
        h('small', 'Up next'),
        h('b', n.Name),
        kicker ? h('span', String(kicker)) : null,
        h('span.un-count'),
        h('div.actions',
          btn('Start now', playNext, { color: 'blue', small: true }),
          btn('Hide', () => { upNext = 'hidden'; upNextEl.hidden = true; }, { color: 'lilac', small: true, ghost: true }))));
    upNextEl.hidden = false;
    drawUpNext();
  }

  // Official video/index.js: 30-40 seconds before the end of episodes of 10+ minutes.
  function checkUpNext() {
    const d = dur(), p = position();
    if (!nextEp || !pb.nextVideoInfo || d < 600) return;
    const at = d >= 3000 ? 40 : d >= 2400 ? 35 : 30;
    if (!upNext && p >= d - at && d - p >= 20 && (cur.Type === 'Episode' || list)) showUpNext();
    // Seeking back well before the card's time takes it away, so it can come back.
    if (upNext === 'shown' && p < d - at - 10 && !segments.some(s => toEnd(s) && p >= s.start)) { upNext = null; upNextEl.hidden = true; }
    drawUpNext();
  }

  function drawUpNext() {
    if (upNext !== 'shown') return;
    const left = Math.max(0, Math.ceil(dur() - position()));
    const auto = list || pb.autoplayNext;
    const c = upNextEl.querySelector('.un-count');
    if (c) c.textContent = auto ? `Starts in ${left} s` : `${left} s remaining`;
  }

  function resetForItem() {
    full = null;
    segments = [];
    segDone.clear();
    hideSkip();
    upNext = null;
    upNextEl.hidden = true;
    fill(marksEl);
  }

  // Hover preview over the scrub bar: time, chapter name and the trickplay thumbnail.
  function trickplay() {
    const t = full?.Trickplay?.[ms?.Id];
    if (!t) return null;
    const widths = Object.keys(t).map(Number).sort((a, b) => a - b);
    const w = widths.find(x => x >= 320) || widths[widths.length - 1];
    return w ? t[w] : null;
  }

  function showTip(e) {
    const r = scrub.getBoundingClientRect();
    const d = dur();
    if (!d) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const at = frac * d;
    const ch = chapters().filter(c => c.StartPositionTicks / TICKS <= at).pop();
    const tp = trickplay();
    let pic = null;
    if (tp) {
      const scale = Math.min(1, 280 / tp.Width);
      const tile = Math.floor((at * 1000) / tp.Interval);
      const per = tp.TileWidth * tp.TileHeight;
      const off = tile % per;
      pic = h('div.tip-pic');
      pic.style.width = `${tp.Width * scale}px`;
      pic.style.height = `${tp.Height * scale}px`;
      pic.style.backgroundImage = `url("${api.url(`/Videos/${cur.Id}/Trickplay/${tp.Width}/${Math.floor(tile / per)}.jpg`, { MediaSourceId: ms.Id }, { auth: true })}")`;
      pic.style.backgroundSize = `${tp.TileWidth * tp.Width * scale}px auto`;
      pic.style.backgroundPosition = `${-(off % tp.TileWidth) * tp.Width * scale}px ${-Math.floor(off / tp.TileWidth) * tp.Height * scale}px`;
    }
    fill(tipEl, pic, ch?.Name ? h('small', ch.Name) : null, h('b', f.clock(at)));
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth;
    tipEl.style.left = `${Math.max(tw / 2, Math.min(r.width - tw / 2, frac * r.width))}px`;
  }

  // ---- playback info overlay -----------------------------------------------------------------
  // What's playing and how (official playerstats): the source, what the server is doing to it
  // (from this device's session), and what the engine sees.

  const mbps = b => (b ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mbps` : null);
  const autoNote = () => {
    const m = lastMeasured();
    if (!m) return 'Auto';
    return m.home ? 'Auto · none on the home network' : m.bps ? `Auto · ${mbps(m.bps)} (connection test)` : 'Auto · none (test failed)';
  };
  const fps = n => (n ? `${Math.round(n * 100) / 100} fps` : null);

  function toggleStats() {
    statsEl.hidden = !statsEl.hidden;
    clearInterval(statsTimer);
    statsTimer = null;
    if (statsEl.hidden) return;
    let n = 0;
    const refresh = () => {
      if (n++ % 3 === 0) loadSession();
      drawStats();
    };
    refresh();
    statsTimer = setInterval(refresh, 1000);
  }

  async function loadSession() {
    try {
      const r = await api.get('/Sessions', { deviceId: api.deviceId });
      session = (r || []).find(x => x.NowPlayingItem?.Id === cur.Id) || (r || [])[0] || null;
    } catch { session = null; }
  }

  function drawStats() {
    if (statsEl.hidden) return;
    const vs = ms?.MediaStreams?.find(x => x.Type === 'Video');
    const as = ms?.MediaStreams?.find(x => x.Index === audioIndex);
    const ss = ms?.MediaStreams?.find(x => x.Index === subIndex);
    const ti = session?.TranscodingInfo;
    const st = eng.stats();
    const reasons = ti?.TranscodeReasons?.length ? ti.TranscodeReasons
      : (new URLSearchParams((ms?.TranscodingUrl || '').split('?')[1] || '').get('TranscodeReasons') || '').split(',').filter(Boolean);
    const section = (name, pairs) => {
      const ok = pairs.filter(([, v]) => v != null && v !== '');
      return ok.length ? [h('h4', name), h('dl', ok.map(([k, v]) => [h('dt', k), h('dd', String(v))]))] : null;
    };
    fill(statsEl,
      section('Playback', [
        ['Player', `${eng.name === 'web' ? 'Web' : eng.name} · ${st.player || ''}`],
        ['Method', session?.PlayState?.PlayMethod || method],
        ['Speed', eng.rate !== 1 ? `${eng.rate}×` : null],
        ['Picture', st.width ? `${st.width}×${st.height}` : null],
        ['Dropped frames', st.frames ? `${st.dropped} of ${st.frames}` : null],
        ['Buffered', st.buffered != null ? `${st.buffered.toFixed(1)} s` : null],
        ['Bandwidth', mbps(st.bandwidth)],
        ['Bitrate limit', maxBitrate ? mbps(maxBitrate) : autoNote()],
      ]),
      ti ? section('Transcoding', [
        ['Video', ti.IsVideoDirect ? 'Copied' : [ti.VideoCodec, ti.Width && `${ti.Width}×${ti.Height}`].filter(Boolean).join(' · ')],
        ['Audio', ti.IsAudioDirect ? 'Copied' : [ti.AudioCodec, ti.AudioChannels && `${ti.AudioChannels} ch`].filter(Boolean).join(' · ')],
        ['Container', ti.Container],
        ['Bitrate', mbps(ti.Bitrate)],
        ['Encoding at', fps(ti.Framerate)],
        ['Progress', ti.CompletionPercentage ? `${ti.CompletionPercentage.toFixed(1)}%` : null],
        ['Hardware', ti.HardwareAccelerationType || 'None'],
        ['Reasons', reasons.map(r => r.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ') || null],
      ]) : section('Transcoding', [['Reasons', reasons.join(', ') || null]]),
      section('Source', [
        ['Container', ms?.Container],
        ['Size', ms?.Size ? `${(ms.Size / 1e9).toFixed(2)} GB` : null],
        ['Bitrate', mbps(ms?.Bitrate)],
        ['Video', vs ? [vs.Codec, vs.Profile, vs.Width && `${vs.Width}×${vs.Height}`, fps(vs.RealFrameRate), vs.BitDepth && `${vs.BitDepth}-bit`, vs.VideoRangeType && vs.VideoRangeType !== 'SDR' ? vs.VideoRangeType : null].filter(Boolean).join(' · ') : null],
        ['Audio', as ? [as.Codec, as.ChannelLayout || (as.Channels && `${as.Channels} ch`), as.Language, mbps(as.BitRate)].filter(Boolean).join(' · ') : null],
        ['Subtitles', ss ? `${streamLabel(ss)} · ${ss.DeliveryMethod === 'Encode' ? 'burned in' : ss.DeliveryMethod === 'External' ? 'drawn here' : ss.DeliveryMethod || ''}` : null],
        ['Subtitle delay', eng.subtitleDelay ? delayText(eng.subtitleDelay) : null],
      ]),
      btn('Close', toggleStats, { small: true, color: 'lilac', ghost: true }));
  }

  // ---- are you still watching? -------------------------------------------------------------

  /** Resolves true to carry on, false to stop (official stillWatching plugin, episodes only). */
  function stillWatching(next) {
    const rule = STILL_WATCHING[pb.stillWatching];
    if (!rule || next.Type !== 'Episode') { watched.add(next.Id); return Promise.resolve(true); }
    const [count, hours] = rule;
    const span = hours * 3600e3;
    const since = Date.now() - watchStart;
    if (!(since >= span && (Date.now() - lastInput >= span || watched.size >= count))) { watched.add(next.Id); return Promise.resolve(true); }
    return new Promise(resolve => {
      const answer = yes => {
        askEl.hidden = true;
        if (yes) { watchStart = Date.now(); watched.clear(); watched.add(next.Id); }
        resolve(yes);
      };
      fill(askEl, h('div.p-ask-box',
        h('span.cap'),
        h('div',
          h('b', 'Are you still watching?'),
          h('span', `Up next: ${[next.SeriesName, epCode(next), next.Name].filter(Boolean).join(' · ')}`),
          h('div.actions',
            btn('Continue watching', () => answer(true), { color: 'orange' }),
            btn('Stop', () => answer(false), { color: 'red', ghost: true })))));
      askEl.hidden = false;
      askEl.querySelector('button')?.focus();
    });
  }

  // ---- cinema mode and multi-part films ------------------------------------------------------

  /**
   * Before the first item: the server's intros (trailers, pre-rolls) when cinema mode is on and
   * a film starts from the beginning, and the other parts of a film split across files.
   * Both just become entries in the video queue.
   */
  async function expandFirst(startTicks) {
    // In a group everyone plays the group's queue as it is.
    if (sync) return;
    const [intros, parts] = await Promise.all([
      pb.cinemaMode && !startTicks && item.Type === 'Movie'
        ? api.get(`/Items/${item.Id}/Intros`, { userId: api.userId }).then(r => r.Items || []).catch(() => []) : [],
      item.PartCount > 1
        ? api.get(`/Videos/${item.Id}/AdditionalParts`, { userId: api.userId, fields: Api.FIELDS }).then(r => r.Items || []).catch(() => []) : [],
    ]);
    if (!intros.length && !parts.length) return;
    intros.forEach(i => introIds.add(i.Id));
    const entries = [...intros, item, ...parts];
    if (list) list.splice(listIndex, 1, ...entries); else { list = entries; listIndex = 0; }
    cur = list[listIndex];
    duration = (cur.RunTimeTicks || 0) / TICKS;
  }

  // ---- controls ---------------------------------------------------------------------------

  function toggle() {
    if (sync) { if (eng.paused) sync.requestUnpause(); else sync.requestPause(); return; }
    if (eng.paused) eng.play().catch(() => {}); else eng.pause();
  }
  const clampTime = s => { const d = dur(); return Math.max(0, d ? Math.min(d - 1, s) : s); };
  function rawSeek(s) { eng.seek(clampTime(s)); drawTime(); }
  function seekTo(s) {
    if (sync) { sync.requestSeek(clampTime(s)); return; }
    rawSeek(s);
  }
  function seekBy(ds) { seekTo(position() + ds); }
  // The desktop app's mpv fills the app's window, so fullscreen is the window's (engine-mpv.js).
  const isFullscreen = () => (eng.toggleFullscreen ? eng.isFullscreen : !!document.fullscreenElement);
  function fullscreen() {
    if (eng.toggleFullscreen) { eng.toggleFullscreen(); setTimeout(drawButtons, 300); return; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  }

  async function findNext() {
    nextEp = null;
    if (list) { nextEp = list[listIndex + 1] || null; drawButtons(); return; }
    if (cur.Type !== 'Episode' || !cur.SeriesId) return;
    try {
      // Episodes with a file only, as official (playbackmanager.js getEpisodes): with "show
      // missing episodes" on, the server lists the missing and unaired ones too.
      const r = await api.get(`/Shows/${cur.SeriesId}/Episodes`, { userId: api.userId, startItemId: cur.Id, isMissing: false, limit: 2, fields: 'Overview' });
      nextEp = r.Items?.[1] || null;
    } catch { /* no next */ }
    drawButtons();
  }

  async function playNext() {
    if (sync) { sync.requestNext(); return; }
    if (!nextEp) return;
    if (list) listIndex++;
    go(nextEp);
  }

  function playPrev() {
    if (sync) { sync.requestPrevious(); return; }
    if (!list || listIndex === 0) { seekTo(0); return; }
    listIndex--;
    go(list[listIndex]);
  }

  async function go(next) {
    if (!askEl.hidden) return; // already asking "Are you still watching?"
    if (reporter) { await reporter.stop(); reporter = null; }
    if (!sync && !(await stillWatching(next))) { close(); return; }
    if (closed) return;
    cur = next;
    burnAll = false;
    secIndex = null;
    eng.subtitleDelay = 0;
    resetForItem();
    ms = null;
    audioIndex = undefined;
    subIndex = undefined;
    duration = (cur.RunTimeTicks || 0) / TICKS;
    drawTitle();
    mediaSession();
    findNext();
    load(0);
  }

  // replaced: another player takes over, or the group itself finished or stopped; otherwise
  // closing in a group stops following it, so the others don't wait for this device.
  async function close({ replaced = false } = {}) {
    if (closed) return;
    closed = true;
    if (sync && !replaced) sync.halt();
    loadToken++;
    closeMenu();
    clearInterval(statsTimer);
    clearTimeout(osdTimer);
    if (reporter) await reporter.stop();
    eng.destroy();
    if (eng.kind !== 'native') native.disableFullscreen();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', drawButtons);
    clearTimeout(idleTimer);
    clearInterval(tick);
    app.onPlayerClosed?.(cur, ctl);
  }

  // scrub bar: click or drag
  const scrubTo = e => {
    const r = scrub.getBoundingClientRect();
    const d = dur();
    if (d) seekTo(((e.clientX - r.left) / r.width) * d);
  };
  scrub.addEventListener('pointerdown', e => { scrub.setPointerCapture(e.pointerId); scrubTo(e); });
  scrub.addEventListener('pointermove', e => { if (scrub.hasPointerCapture(e.pointerId)) scrubTo(e); showTip(e); });
  scrub.addEventListener('pointerleave', () => { tipEl.hidden = true; });
  scrub.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') tipEl.hidden = true; });
  scrub.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { seekBy(-10); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowRight') { seekBy(10); e.preventDefault(); e.stopPropagation(); }
  });

  eng.on('click', () => { if (menuEl) closeMenu(); else toggle(); });
  eng.on('dblclick', fullscreen);
  eng.on('playing', () => {
    if (sync) {
      // In a group the item starts paused at its place, and the group starts it together.
      if (!syncLoaded) { syncLoaded = true; eng.pause(); sync.loaded(); } else sync.playing();
    }
    setStatus('');
    if (!started) { started = true; reporter?.start(); } else reporter?.progress('Unpause');
    drawButtons();
    poke();
  });
  eng.on('pause', () => { reporter?.progress('Pause'); drawButtons(); poke(); });
  eng.on('waiting', () => { setStatus('Buffering', true); sync?.waiting(); });
  eng.on('seeked', () => { reporter?.progress('TimeUpdate'); const f = onSeeked; onSeeked = null; f?.(); });
  eng.on('volumechange', () => { volBar.draw(); reporter?.progress('VolumeChange'); });
  eng.on('ratechange', drawTime);
  eng.on('pipchange', () => { if (menuEl?.dataset.kind === 'options') menu('options', true); });
  function ended() {
    // The end of the group's queue: done together, still in the group.
    if (sync) { if (nextEp) sync.requestNext(); else close({ replaced: true }); return; }
    if (repeat === 'RepeatOne') { go(cur); return; }
    if (nextEp && (list || pb.autoplayNext)) { playNext(); return; }
    if (repeat === 'RepeatAll') {
      if (!list) { go(cur); return; }
      listIndex = Math.max(0, list.findIndex(x => !introIds.has(x.Id)));
      go(list[listIndex]);
      return;
    }
    close();
  }
  eng.on('ended', ended);
  // Some files end early on one track: the video and one audio track stop a minute before
  // the file's runtime because another audio track (a dub) runs longer. The browser or hls.js
  // then waits at "Buffering" for data that never comes, and 'ended' never fires. So near the
  // end, if playback hasn't moved and nothing new has buffered for 10 seconds, treat it as ended.
  let stall = { p: -1, b: -1, since: 0 };
  function checkStall() {
    if (eng.kind === 'native' || eng.kind === 'mpv' || !started || eng.paused || !askEl.hidden) { stall.since = 0; return; }
    const p = position(), d = dur(), b = eng.bufferedTo(p);
    if (!d || d - p > 120 || b - p > 1 || p !== stall.p || b !== stall.b) { stall = { p, b, since: Date.now() }; return; }
    if (!stall.since) { stall.since = Date.now(); return; }
    if (Date.now() - stall.since >= 10000) { stall = { p: -1, b: -1, since: 0 }; ended(); }
  }
  // 'playing' doesn't always follow a stall (hls.js, seeks), so clear the buffering note
  // once the picture is moving again.
  let lastT = -1;
  eng.on('timeupdate', () => {
    const t = eng.position;
    if (statusEl.classList.contains('blink') && !eng.paused && t !== lastT && lastT >= 0) setStatus('');
    lastT = t;
    checkSegments();
    checkUpNext();
  });
  eng.on('canplaythrough', () => { if (!eng.paused && statusEl.classList.contains('blink')) setStatus(''); });
  eng.on('durationchange', drawMarks);
  eng.on('error', e => {
    if (closed) return;
    if (e.direct && !forceTranscode) {
      toast('Direct play failed', 'Switching to a server transcode', 'salmon');
      forceTranscode = true;
      load(position() || (opts.resume ? (item.UserData?.PlaybackPositionTicks || 0) / TICKS : 0));
    } else {
      setStatus(`Playback failure${e.message ? `: ${e.message}` : ''}`);
    }
  });
  // A subtitle the engine draws itself failed: have the server burn it in instead.
  eng.on('subtitlefailed', () => {
    if (closed) return;
    toast('Subtitle renderer failure', 'Asking the server to burn them in instead', 'salmon');
    burnAll = true;
    load(position());
  });
  document.addEventListener('fullscreenchange', drawButtons);

  // auto-hide the controls while playing
  let idleTimer = null;
  function poke() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!eng.paused && !menuEl) root.classList.add('idle'); }, 3000);
  }
  const input = () => { lastInput = Date.now(); };
  root.addEventListener('pointermove', () => { input(); poke(); });
  root.addEventListener('pointerdown', () => { input(); poke(); unmuteOnInput(); });
  // The wheel over the picture changes the volume.
  root.querySelector('.p-vid').addEventListener('wheel', e => {
    e.preventDefault();
    setVolume(eng.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    showVolume();
  }, { passive: false });
  timeEl.addEventListener('click', e => {
    if (!e.target.closest('.t-end')) return;
    showRemaining = !showRemaining;
    app.us.setLocal('timeRemaining', showRemaining);
    drawTime();
  });

  const jump = (ds, label) => { seekBy(ds); osd(label); };
  function onKey(e) {
    if (e.target.closest?.('input, select, textarea, .scrub.vol')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    input();
    unmuteOnInput();
    const k = e.key;
    // A TV remote: up and down move between the controls (the TV has its own volume), and
    // left and right do too once a control has focus; OK on the picture plays or pauses.
    if (app.tv) {
      const onCtl = !!e.target.closest?.('.p-ui button, .p-ui [tabindex], .p-menu button');
      if (k === 'ArrowUp' || k === 'ArrowDown') { poke(); if (!onCtl) { (root.querySelector('.p-btns button') || root.querySelector('.p-ui button'))?.focus(); e.preventDefault(); e.stopPropagation(); } return; }
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && onCtl) { poke(); return; }
      if (k === 'Enter' && !onCtl && askEl.hidden && !(askSeg && !skipEl.hidden) && upNext !== 'shown') { toggle(); e.preventDefault(); e.stopPropagation(); poke(); return; }
    }
    // While asking "Are you still watching?", only its buttons (and Esc for Stop) work.
    if (!askEl.hidden) {
      if (k === 'Escape') { askEl.querySelector('.c-red')?.click(); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    const d = dur();
    const handled = {
      ' ': toggle, k: toggle, K: toggle,
      ArrowLeft: () => jump(-skipBack, `−${skipBack} s`), ArrowRight: () => jump(skipFwd, `+${skipFwd} s`),
      j: () => jump(-10, '−10 s'), J: () => jump(-10, '−10 s'), l: () => jump(10, '+10 s'), L: () => jump(10, '+10 s'),
      Home: () => seekTo(0), End: () => seekTo(d),
      ',': () => (eng.paused ? eng.frameStep(-1) : false), '.': () => (eng.paused ? eng.frameStep(1) : false),
      '<': () => stepSpeed(-1), '>': () => stepSpeed(1),
      ArrowUp: () => { setVolume(eng.volume + 0.05); showVolume(); },
      ArrowDown: () => { setVolume(eng.volume - 0.05); showVolume(); },
      f: fullscreen, F: fullscreen, m: () => { toggleMute(); showVolume(); }, M: () => { toggleMute(); showVolume(); },
      g: () => setDelay(eng.subtitleDelay - 0.1), G: () => setDelay(eng.subtitleDelay - 0.1),
      h: () => setDelay(eng.subtitleDelay + 0.1), H: () => setDelay(eng.subtitleDelay + 0.1),
      a: cycleAspect, A: cycleAspect, i: toggleStats, I: toggleStats, '?': () => menu('keys'),
      n: playNext, N: playNext, p: () => (list ? playPrev() : false), P: () => (list ? playPrev() : false),
      PageDown: nextChapter, PageUp: prevChapter,
      Enter: () => { if (askSeg && !skipEl.hidden) skipSegment(askSeg); else if (upNext === 'shown') playNext(); else return false; },
      Escape: () => { if (menuEl) closeMenu(); else if (!isFullscreen()) close(); else if (eng.toggleFullscreen) fullscreen(); },
    }[k] || (/^[0-9]$/.test(k) && d ? () => { seekTo((d * Number(k)) / 10); osd(`${k}0%`); } : null);
    if (!handled || (k === 'Enter' && e.target.closest?.('button'))) return;
    if (handled() === false) return;
    e.preventDefault(); e.stopPropagation(); poke();
  }
  document.addEventListener('keydown', onKey, true);

  function mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const art = cur.Type === 'Episode' && cur.SeriesId ? api.img(cur.SeriesId, 'Primary', { h: 512 }) : api.img(cur.Id, 'Primary', { h: 512 });
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.Name, artist: cur.SeriesName || '', artwork: art ? [{ src: art, sizes: '341x512' }] : [] });
  }

  const tick = setInterval(() => { if (!closed) { drawTime(); checkStall(); } }, 500);

  document.body.append(root);
  // In the iPhone app this hides its tab bar and turns the phone to landscape (its own player,
  // when that's in use, does this itself).
  if (eng.kind !== 'native') native.enableFullscreen();
  drawTitle();
  drawInfo();
  drawButtons();
  drawTime();
  poke();
  const startTicks = opts.startTicks ?? (opts.resume ? item.UserData?.PlaybackPositionTicks || 0 : 0);
  expandFirst(startTicks).finally(() => {
    if (closed) return;
    drawTitle();
    mediaSession();
    findNext();
    // Intros start from the beginning; the film keeps its resume point.
    load(cur.Id === item.Id ? startTicks / TICKS : 0);
  });

  // controller for remote control (WebSocket Playstate and GeneralCommand messages)
  const hasStream = (type, idx) => !!ms?.MediaStreams?.some(s => s.Type === type && s.Index === idx);
  const ctl = {
    kind: 'video',
    item: () => cur,
    toggle, close, seekTo, seekBy, next: playNext, prev: playPrev,
    pause: () => eng.pause(), play: () => eng.play().catch(() => {}),
    state,
    setAudio: idx => { if (hasStream('Audio', idx)) { switchAudio(idx); osd('Audio', streamLabel(ms.MediaStreams.find(s => s.Index === idx))); } },
    setSubs: idx => {
      if (idx >= 0 && !hasStream('Subtitle', idx)) return;
      if (ms) switchSubs(idx);
      osd('Subtitles', idx < 0 ? 'Off' : streamLabel(ms.MediaStreams.find(s => s.Index === idx)));
      if (menuEl) menu(menuEl.dataset.kind, true);
    },
    get volume() { return eng.volume; },
    setVolume: v => { setVolume(v); showVolume(); },
    setMuted: m => { eng.muted = m; showVolume(); },
    toggleMute: () => { toggleMute(); showVolume(); },
    fullscreen,
    setRepeat,
    // Watch together: the group's commands act here directly (syncplay.js).
    local: {
      // As at load: if the browser won't start it with sound (no click on the page yet), start
      // it muted rather than leave this device behind the group.
      play: () => eng.play().catch(e => {
        if (e?.name !== 'NotAllowedError' || eng.muted || closed) return;
        eng.muted = true;
        eng.play().then(() => { autoMuted = true; osd('Muted', 'Click or press a key for sound'); }).catch(() => { eng.muted = false; });
      }),
      pause: () => eng.pause(),
      seek: s => rawSeek(s),
      position: () => position(),
      paused: () => eng.paused,
      stop: () => close({ replaced: true }),
      whenReady: () => new Promise(res => { const t = setTimeout(res, 5000); onSeeked = () => { clearTimeout(t); res(); }; }),
    },
    /** The group moved to items[index] (next, previous, or a pick from its queue). */
    syncGoTo(items, index) { list = items; listIndex = index; go(list[listIndex]); },
    /** The group's queue changed around the item playing. */
    syncQueue(items) {
      const i = items.findIndex(x => x.PlaylistItemId === cur.PlaylistItemId);
      list = items; if (i >= 0) listIndex = i;
      findNext();
    },
    syncOff() { sync = null; drawInfo(); drawButtons(); },
  };
  return ctl;
}
