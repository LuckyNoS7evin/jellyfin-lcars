// Play on: the devices you can control, and the remote control for the one you chose (the
// official client's player selection menu and remotecontrol page in one place).
import { h, fill } from '../h.js';
import { Api, TICKS } from '../api.js';
import * as f from '../fmt.js';
import { deck, btn, arrow, empty, tag, image, pickImage, epCode, volumeBar } from '../ui.js';
import { dialog } from '../menu.js';
import { deviceLabel, supports } from '../remote.js';
import { REPEAT_LABEL } from './queue.js';

const REPEATS = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
const streamLabel = s => s.DisplayTitle || [s.Language, s.Codec, s.Title].filter(Boolean).join(' · ') || `Track ${s.Index}`;

export async function remote(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Play on');
  const r = app.remote;
  await r.load();

  const ctlBody = h('div');
  const listBody = h('div');
  const ctlDeck = deck('Remote control', { color: 'lilac', code: 'R-01' }, ctlBody);
  let posEl = null, timeEl = null, volEl = null;
  let ctlKey = '';
  let queueFor = '';
  let queueItems = [];

  // ---- the device list --------------------------------------------------------------------

  function deviceRow(s) {
    const on = r.target?.Id === s.Id;
    const np = s.NowPlayingItem;
    const control = s.SupportsMediaControl;
    return h('div.dev', { class: on ? 'on' : '', key: s.Id },
      h('div.dev-n', h('b', deviceLabel(s)), h('span', [s.Client, s.ApplicationVersion].filter(Boolean).join(' ')),
        // Two devices with the same name: the start of the device id (as Settings shows it) tells them apart.
        r.sessions.filter(x => deviceLabel(x) === deviceLabel(s)).length > 1 ? h('span', `#${s.DeviceId.slice(0, 8)}`) : null,
        s.UserName && s.UserId !== api.userId ? tag(s.UserName, 'peach') : null),
      h('div.dev-s', np ? [s.PlayState?.IsPaused ? 'Paused: ' : 'Playing: ', h('b', [np.SeriesName, np.Name].filter(Boolean).join(' · '))]
        : s.LastActivityDate ? `Active ${f.ago(s.LastActivityDate)}` : ''),
      h('div.dev-b',
        control ? (on ? btn('Disconnect', () => r.disconnect(), { color: 'red', small: true, ghost: true })
          : btn('Play on this', () => r.connect(s), { color: 'lilac', small: true })) : h('span.dev-x', 'Messages only'),
        supports(s, 'DisplayMessage') ? btn('Message', () => askMessage(s), { color: 'sky', small: true, ghost: true }) : null));
  }

  // Google Cast (cast.js): Chrome's own dialog picks the device, so one row stands for them all.
  function castRow() {
    const c = app.cast;
    if (c.status === 'unsupported') return null;
    if (c.active) {
      return h('div.dev.on', { key: 'cast' },
        h('div.dev-n', h('b', r.name), h('span', 'Google Cast')),
        h('div.dev-s', r.target.NowPlayingItem ? [r.target.PlayState?.IsPaused ? 'Paused: ' : 'Playing: ', h('b', r.target.NowPlayingItem.Name)] : 'Casting'),
        h('div.dev-b', btn('Stop casting', () => r.disconnect(), { color: 'red', small: true, ghost: true })));
    }
    const note = {
      insecure: 'Needs LCARS on HTTPS',
      local: 'Not from localhost: open LCARS at the server’s own address',
      loading: 'Looking for devices…',
      none: 'No Cast devices found on this network',
      failed: 'Cast didn’t start in this browser',
      available: 'Chromecast, Google TV, Cast speakers',
    }[c.status];
    return h('div.dev', { key: 'cast' },
      h('div.dev-n', h('b', 'Google Cast'), h('span', 'Jellyfin receiver')),
      h('div.dev-s', note || ''),
      h('div.dev-b', c.status === 'available' ? btn('Cast…', () => c.start(), { color: 'lilac', small: true }) : null));
  }

  function drawList() {
    const here = h('div.dev', { class: r.active ? '' : 'on', key: 'here' },
      h('div.dev-n', h('b', 'This device'), h('span', api.device)),
      h('div.dev-s', r.active ? '' : 'Playing here'),
      h('div.dev-b', r.active ? btn('Play here', () => r.disconnect(), { color: 'orange', small: true }) : null));
    fill(listBody,
      h('div.devs', here, castRow(), r.sessions.map(deviceRow)),
      r.sessions.length || app.cast.active || app.cast.status === 'available' ? null : empty('No other devices are signed in. Open a Jellyfin app on the TV or phone and it appears here.'),
      h('p.dlg-note', 'Devices signed in as you, or anyone if your account may control other users’ sessions.'));
  }

  function askMessage(s) {
    const head = h('input.inp', { attrs: { maxlength: 60, placeholder: 'Message' } });
    const text = h('input.inp', { attrs: { maxlength: 300, placeholder: 'Text', required: true } });
    let d = null;
    const send = () => { if (!text.value.trim()) { text.focus(); return; } r.message(s, head.value.trim() || 'Message', text.value.trim()); d.close(); };
    d = dialog(`Message ${deviceLabel(s)}`, h('form.dlg-form', { onsubmit: e => { e.preventDefault(); send(); } },
      h('label.field', h('span', 'Header'), head), h('label.field', h('span', 'Text'), text)),
    [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Send', send, { color: 'sky' })], { color: 'sky' });
    setTimeout(() => text.focus(), 0);
  }

  // ---- the remote control -------------------------------------------------------------------

  function drawControl() {
    const s = r.target;
    ctlDeck.hidden = !s;
    if (!s) { ctlKey = ''; return; }
    const np = s.NowPlayingItem;
    const ps = s.PlayState || {};
    // Redraw when something you see changes; the time moves on in tick().
    const key = JSON.stringify([s.Id, r.missing, np?.Id, ps.IsPaused, ps.IsMuted, ps.VolumeLevel, ps.AudioStreamIndex, ps.SubtitleStreamIndex,
      ps.RepeatMode, ps.PlaybackOrder, s.PlaylistItemId, (s.NowPlayingQueue || []).map(q => q.PlaylistItemId).join(), queueItems.length]);
    if (key === ctlKey) return;
    ctlKey = key;
    ctlDeck.querySelector('h2').textContent = `Playing on ${deviceLabel(s)}`;
    if (r.missing) {
      posEl = timeEl = volEl = null;
      fill(ctlBody, h('p.msg.blink', `Lost contact with ${deviceLabel(s)}. Waiting for it to reconnect…`),
        h('div.actions', btn('Disconnect', () => r.disconnect(), { color: 'red', ghost: true })));
      return;
    }
    if (!np) {
      posEl = timeEl = volEl = null;
      fill(ctlBody,
        h('p.empty', `Standing by. Anything you play now goes to ${deviceLabel(s)}.`),
        h('div.actions', btn('Disconnect', () => r.disconnect(), { color: 'red', ghost: true })));
      return;
    }
    const audio = np.MediaType === 'Audio';
    const streams = np.MediaStreams || [];
    const auds = streams.filter(x => x.Type === 'Audio');
    const subs = streams.filter(x => x.Type === 'Subtitle');
    posEl = h('div.pos');
    timeEl = h('div.np-time');
    const scrub = h('div.scrub', { attrs: { role: 'slider', 'aria-label': 'Position', tabindex: 0 } }, posEl);
    scrub.addEventListener('pointerdown', e => {
      const b = scrub.getBoundingClientRect();
      if (r.duration) r.state('Seek', ((e.clientX - b.left) / b.width) * r.duration);
    });
    scrub.addEventListener('keydown', e => {
      const d = { ArrowLeft: -10, ArrowRight: 30 }[e.key];
      if (d) { r.seekBy(d); e.preventDefault(); }
    });
    const sub = np.Type === 'Episode' ? [np.SeriesName, epCode(np)].filter(Boolean).join(' · ')
      : audio ? [np.AlbumArtist || (np.Artists || []).join(', '), np.Album].filter(Boolean).join(' · ') : np.ProductionYear || '';
    volEl = r.can('SetVolume') ? volumeBar({
      volume: () => (r.target?.PlayState?.VolumeLevel ?? 100) / 100,
      muted: () => !!r.target?.PlayState?.IsMuted,
      set: v => { setLocal({ VolumeLevel: Math.round(v * 100), IsMuted: false }); r.command('SetVolume', { Volume: Math.round(v * 100) }); },
      toggleMute: () => { setLocal({ IsMuted: !r.target?.PlayState?.IsMuted }); r.command('ToggleMute'); },
    }) : null;
    const select = (label, list, value, onchange) => h('label.rc-sel', h('span', label),
      h('select.sel', { onchange: e => onchange(Number(e.target.value)) },
        list.map(([t, v]) => h('option', { value: String(v), attrs: { selected: v === value } }, t))));
    const repeat = ps.RepeatMode || 'RepeatNone';
    const shuffled = ps.PlaybackOrder === 'Shuffle';
    fill(ctlBody,
      h('div.np',
        h('div.np-img', image(api, pickImage(np, audio ? 'square' : 'poster'), { shape: audio ? 'square' : 'poster' })),
        h('div.np-body',
          h('a.np-title', { href: `#/item/${np.Id}` }, np.Name),
          sub ? h('div.np-sub', String(sub)) : null,
          h('div.np-meta', [ps.IsPaused ? 'Paused' : 'Playing', ps.PlayMethod === 'Transcode' ? 'transcoding' : ps.PlayMethod ? 'direct' : '', s.Client].filter(Boolean).join(' · ')),
          scrub, timeEl)),
      h('div.actions.rc-btns',
        btn(arrow('l', 2), () => r.state('PreviousTrack'), { color: 'peach', title: 'Previous' }),
        btn('−10', () => r.seekBy(-10), { color: 'peach', title: 'Back 10 seconds' }),
        btn(ps.IsPaused ? 'Play' : 'Pause', () => { setLocal({ IsPaused: !ps.IsPaused }); r.state('PlayPause'); }, { color: 'orange' }),
        btn('+30', () => r.seekBy(30), { color: 'peach', title: 'Forward 30 seconds' }),
        btn(arrow('r', 2), () => r.state('NextTrack'), { color: 'peach', title: 'Next' }),
        btn('Stop', () => r.state('Stop'), { color: 'red' }),
        volEl ? h('span.rc-vol', volEl) : null,
        !audio && r.can('ToggleFullscreen') ? btn('Full screen', () => r.command('ToggleFullscreen'), { color: 'salmon', ghost: true }) : null),
      h('div.rc-opts',
        auds.length > 1 && r.can('SetAudioStreamIndex')
          ? select('Audio', auds.map(x => [streamLabel(x), x.Index]), ps.AudioStreamIndex, i => r.command('SetAudioStreamIndex', { Index: i })) : null,
        subs.length && r.can('SetSubtitleStreamIndex')
          ? select('Subtitles', [['Off', -1], ...subs.map(x => [streamLabel(x), x.Index])], ps.SubtitleStreamIndex ?? -1, i => r.command('SetSubtitleStreamIndex', { Index: i })) : null,
        audio && r.can('SetRepeatMode')
          ? btn(REPEAT_LABEL[repeat], () => r.command('SetRepeatMode', { RepeatMode: REPEATS[(REPEATS.indexOf(repeat) + 1) % 3] }), { color: repeat === 'RepeatNone' ? 'lilac' : 'peach', small: true }) : null,
        audio && r.can('SetShuffleQueue')
          ? btn(shuffled ? 'Shuffle on' : 'Shuffle off', () => r.command('SetShuffleQueue', { ShuffleMode: shuffled ? 'Sorted' : 'Shuffle' }), { color: shuffled ? 'peach' : 'lilac', small: true }) : null,
        btn('Disconnect', () => r.disconnect(), { color: 'red', small: true, ghost: true })),
      drawQueue(s));
    tick();
  }

  /** Show the change straight away; the device's next report confirms (or corrects) it. */
  function setLocal(patch) {
    if (!r.target) return;
    r.target.PlayState = { ...r.target.PlayState, ...patch };
    if ('IsPaused' in patch) r.seenAt = Date.now();
    drawControl();
  }

  // The remote's queue: names come from the session if it sends them, otherwise one lookup.
  function drawQueue(s) {
    const q = s.NowPlayingQueue || [];
    if (q.length < 2) return null;
    const ids = q.map(x => x.Id);
    const k = ids.join();
    if (k !== queueFor) {
      queueFor = k;
      const full = s.NowPlayingQueueFullItems;
      if (full?.length === q.length) queueItems = full;
      else {
        queueItems = [];
        api.items({ ids: [...new Set(ids)].join(','), fields: Api.FIELDS }, { signal }).then(res => {
          if (queueFor !== k) return;
          const byId = new Map(res.Items.map(i => [i.Id, i]));
          queueItems = ids.map(id => byId.get(id)).filter(Boolean);
          ctlKey = '';
          drawControl();
        }).catch(() => {});
      }
    }
    if (!queueItems.length) return null;
    const curIdx = q.findIndex(x => x.PlaylistItemId === s.PlaylistItemId);
    return [h('h3.set-h', `Queue · ${q.length} items`),
      h('div.tracks', queueItems.map((t, i) => h('div.trk.qtrk', {
        class: i === curIdx ? 'now' : '', attrs: { tabindex: 0, role: 'button' },
        onclick: () => r.play(queueItems, { index: i }),
        onkeydown: e => { if (e.key === 'Enter') r.play(queueItems, { index: i }); },
      },
      h('span.trk-n', i + 1),
      h('span.trk-t', t.Type === 'Episode' ? `${epCode(t)} ${t.Name}` : t.Name),
      h('span.trk-a', t.AlbumArtist || t.SeriesName || ''),
      h('span.trk-d', t.RunTimeTicks ? f.clock(t.RunTimeTicks / TICKS) : ''))))];
  }

  function tick() {
    if (!posEl || !r.target) return;
    const d = r.duration;
    const p = Math.min(r.position, d || Infinity);
    posEl.style.width = d ? `${Math.min(100, (p / d) * 100)}%` : '0';
    fill(timeEl, h('span', f.clock(p)), h('span', d ? f.clock(d) : ''));
  }

  function draw() {
    drawList();
    drawControl();
    volEl?.draw();
  }

  // Space plays/pauses the remote, ← → seek, while this page is open and you're not typing.
  const onKey = e => {
    if (!r.active || e.ctrlKey || e.metaKey || e.altKey || app.player) return;
    if (e.target.closest?.('input, select, textarea, dialog, .scrub, button')) return;
    const act = { ' ': () => r.state('PlayPause'), ArrowLeft: () => r.seekBy(-10), ArrowRight: () => r.seekBy(30) }[e.key];
    if (act) { act(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  draw();
  const unwatch = r.watch();
  const off = r.on(draw);
  const timer = setInterval(tick, 500);
  // New devices only come from /Sessions (see Remote.update).
  const poll = setInterval(() => { if (document.visibilityState === 'visible') r.load().catch(() => {}); }, 10000);
  signal.addEventListener('abort', () => { off(); unwatch(); clearInterval(timer); clearInterval(poll); document.removeEventListener('keydown', onKey); });
  return [ctlDeck, deck('Devices', { color: 'orange', code: 'R-02' }, listBody)];
}
