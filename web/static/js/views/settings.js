// User settings, mirroring the official clients' sections: Profile, Display, Home,
// Playback and Subtitles, plus this client's own extras. Changes save as you make them.
import { h, fill } from '../h.js';
import { CLIENT, VERSION } from '../api.js';
import { deck, btn, toast, canEditPreferences, squareJpeg } from '../ui.js';
import { caps } from '../player/profile.js';
import { subtitleCss } from '../player/engine-web.js';
import { SUBTITLE_DEFAULTS, UserSettings } from '../settings.js';
import { libraryTabs } from './library.js';

const BITRATES = [['Auto (no limit)', 0], ['120 Mbps', 120e6], ['60 Mbps', 60e6], ['40 Mbps', 40e6], ['20 Mbps', 20e6], ['10 Mbps', 10e6], ['8 Mbps', 8e6], ['4 Mbps', 4e6], ['2 Mbps', 2e6], ['1 Mbps', 1e6]];
const SKIPS = [5, 10, 15, 20, 30, 45, 60, 90, 120].map(s => [`${s} seconds`, s * 1000]);
const NEXTUP_DAYS = [['No limit', 0], ['30 days', 30], ['60 days', 60], ['90 days', 90], ['180 days', 180], ['365 days', 365], ['2 years', 730]];
const SEGMENTS = [['Intro', 'Intro'], ['Outro', 'Outro / credits'], ['Recap', 'Recap'], ['Preview', 'Preview'], ['Commercial', 'Commercial']];
const BURN_IN = [['Never (draw them here)', 'auto'], ['Picture subtitles (PGS) only', 'onlyimageformats'], ['Styled and picture subtitles', 'allcomplexformats']];
const SEG_ACTIONS = [['Ask to skip', 'AskToSkip'], ['Skip automatically', 'Skip'], ['Do nothing', 'None']];
const RESOLUTIONS = [['Auto (no limit)', 0], ['4K (2160p)', 3840], ['1440p', 2560], ['1080p', 1920], ['720p', 1280], ['480p', 854]];
const CHANNELS = [['Auto (up to 5.1)', 0], ['Mono', 1], ['Stereo', 2], ['5.1', 6], ['7.1', 8]];
const STILL = [['Never', 'disabled'], ['After 2 episodes or 1 hour idle', 'short'], ['After 3 episodes or 1½ hours idle', 'default'],
  ['After 5 episodes or 2½ hours idle', 'long'], ['After 8 episodes or 4 hours idle', 'veryLong']];
// Subtitle appearance (official subtitlesettings options; the default font is the LCARS one).
const SUB_SIZES = [['Smaller', 'smaller'], ['Small', 'small'], ['Medium', 'medium'], ['Large', 'large'], ['Larger', 'larger'], ['Extra large', 'extralarge']];
const SUB_WEIGHTS = [['Normal', 'normal'], ['Bold', 'bold']];
const SUB_FONT_NAMES = [['LCARS (Antonio)', ''], ['Sans serif', 'sans'], ['Typewriter', 'typewriter'], ['Print', 'print'], ['Console', 'console'], ['Cursive', 'cursive'], ['Casual', 'casual'], ['Small caps', 'smallcaps']];
const SUB_COLOURS = [['White', '#FFFFFF'], ['Yellow', '#FFFF00'], ['LCARS orange', '#FF9966'], ['LCARS sky', '#99CCFF'], ['Light grey', '#CCCCCC'], ['Green', '#66FF66']];
const SUB_BACKS = [['None', 'transparent'], ['Translucent black', 'rgba(0, 0, 0, 0.55)'], ['Black', '#000000'], ['Dark grey', '#333333']];
const SUB_SHADOWS = [['Drop shadow', 'dropshadow'], ['Outline', 'uniform'], ['Raised', 'raised'], ['Depressed', 'depressed'], ['None', 'none']];
const SUB_POSITIONS = [...[1, 2, 3, 4, 5, 6, 8, 10].map(n => [`${n} line${n > 1 ? 's' : ''} from the bottom`, -n]), ...[0, 1, 2].map(n => [n ? `${n} line${n > 1 ? 's' : ''} from the top` : 'Top', n])];
const SUB_MODES =[['Default', 'Default'], ['Smart', 'Smart'], ['Only forced', 'OnlyForced'], ['Always play', 'Always'], ['None', 'None']];
const SECTIONS = [
  ['smalllibrarytiles', 'My media'], ['librarybuttons', 'My media (small)'], ['activerecordings', 'Active recordings'],
  ['resume', 'Continue watching'], ['resumeaudio', 'Continue listening'], ['resumebook', 'Continue reading'],
  ['latestmedia', 'Recently added media'], ['nextup', 'Next up'], ['livetv', 'Live TV'], ['none', 'None'],
];
const DEFAULT_SECTIONS = ['smalllibrarytiles', 'resume', 'resumeaudio', 'resumebook', 'livetv', 'nextup', 'latestmedia', 'none', 'none', 'none'];

export async function settings(ctx) {
  const { api, app, params } = ctx;
  // params.user (from #/admin/users/<id>/settings): an admin editing someone else's settings.
  // Only what's kept on the server; device settings belong to that user's devices.
  const other = params?.user && params.user !== api.userId.replace(/-/g, '') ? params.user : null;
  if (other && !app.me?.Policy?.IsAdministrator) { location.replace('#/settings'); return h('div'); }
  let us = app.us;
  if (other) { us = new UserSettings(api, other); await us.load(); ctx.setParent(`#/admin/users/${other}`); }
  ctx.setTitle(other ? `${us.me.Name}: settings` : 'User settings');
  const [info, cultures, allViews, qcOn] = await Promise.all([
    api.publicInfo(),
    api.get('/Localization/Cultures').catch(() => []),
    // Every library, including ones hidden from My media, for the home settings.
    api.get('/UserViews', { userId: us.userId, includeHidden: true }).then(r => r.Items).catch(() => (other ? [] : app.views)),
    api.quickConnectEnabled().catch(() => false),
  ]);
  const cfg = us.config;

  const saved = (what = 'Saved') => toast(what, '', 'sky', 1800);
  const failed = e => toast('Unable to comply', e.message, 'red');
  const saveCfg = patch => us.saveConfig(patch).then(() => saved()).catch(failed);
  // Password and Jellyfin configuration changes need admin or the "allow user preference
  // changes" permission (server RequestHelpers.AssertCanUpdateUser); without it, hide them.
  const canPrefs = other ? true : canEditPreferences(us.me);
  const cfgRow = (...a) => (canPrefs ? row(...a) : null);
  const managed = canPrefs ? null : h('p.dlg-note', 'Some settings are managed by your administrator.');
  const savePref = (k, v) => us.setPref(k, v).then(() => saved()).catch(failed);

  // ---- controls ---------------------------------------------------------------------------
  const row = (label, control, note) => h('div.set-row', h('div.set-l', h('span', label), note ? h('small', note) : null), h('div.set-c', control));
  const localRow = (...a) => (other ? null : row(...a));
  const toggle = (on, onchange) => {
    const b = h('button.toggle', { type: 'button', class: on ? 'on' : '', attrs: { role: 'switch', 'aria-checked': String(on) } }, on ? 'On' : 'Off');
    b.addEventListener('click', () => {
      on = !on;
      b.classList.toggle('on', on);
      b.textContent = on ? 'On' : 'Off';
      b.setAttribute('aria-checked', String(on));
      onchange(on);
    });
    return b;
  };
  const select = (options, value, onchange) => h('select.sel', { onchange: e => onchange(e.target.value) },
    options.map(([t, v]) => h('option', { value: String(v), attrs: { selected: String(v) === String(value) } }, t)));
  const langs = [['Any language', ''], ...cultures.map(c => [c.DisplayName, c.ThreeLetterISOLanguageName]).filter(([, v]) => v).sort((a, b) => a[0].localeCompare(b[0]))];

  // ---- profile ----------------------------------------------------------------------------
  const cur = h('input.inp', { type: 'password', attrs: { autocomplete: 'current-password' } });
  const nw = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  const nw2 = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  const pwForm = h('form.set-form', {
    onsubmit: async e => {
      e.preventDefault();
      if (nw.value !== nw2.value) { toast('Passwords differ', 'The new password and confirmation must match', 'red'); return; }
      try {
        await us.changePassword(cur.value, nw.value);
        cur.value = nw.value = nw2.value = '';
        saved('Password changed');
      } catch (err) { failed(err); }
    },
  },
  row('Current password', cur), row('New password', nw), row('Confirm new password', nw2),
  h('div.actions', btn('Change password', null, { type: 'submit', color: 'salmon' })));

  // ---- avatar ---------------------------------------------------------------------------------
  // Shrunk to 512×512 JPEG in the browser first: small enough for the proxy's 1 MB limit, and
  // nobody needs an 8 MB phone photo as an avatar. Sent base64, as Jellyfin's /UserImage expects.
  const avatarEl = h('div.avatar');
  const fileIn = h('input', { type: 'file', attrs: { accept: 'image/*', hidden: true } });
  function drawAvatar() {
    const tag = us.me.PrimaryImageTag;
    fill(avatarEl,
      tag ? h('img', { src: api.url(`/Users/${us.userId}/Images/Primary`, { tag, height: 160, quality: 90 }), alt: '' }) : h('span.avatar-none', (us.me.Name || '?')[0]),
      h('div.actions',
        btn(tag ? 'Change picture' : 'Add picture', () => fileIn.click(), { color: 'sky', small: true }),
        tag ? btn('Remove', removeAvatar, { color: 'red', small: true, ghost: true }) : null));
  }
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    try {
      const data = await squareJpeg(file);
      await api.req('POST', '/UserImage', { query: { userId: us.userId }, raw: { data, type: 'image/jpeg' } });
      await us.load();
      drawAvatar();
      saved('Picture updated');
    } catch (e) { failed(e); }
  });
  async function removeAvatar() {
    try {
      await api.del('/UserImage', { userId: us.userId });
      await us.load();
      drawAvatar();
      saved('Picture removed');
    } catch (e) { failed(e); }
  }
  drawAvatar();

  // ---- home ---------------------------------------------------------------------------------
  const sectionsEl = h('div');
  const current = DEFAULT_SECTIONS.map((d, i) => us.pref(`homesection${i}`, d));
  fill(sectionsEl, current.map((v, i) => row(`Section ${i + 1}`, select(SECTIONS.map(([k, t]) => [t, k]), v, val => savePref(`homesection${i}`, val)))));

  const libsEl = h('div.libs');
  let order = [...allViews].sort((a, b) => {
    const o = cfg.OrderedViews || [];
    const ia = o.indexOf(a.Id), ib = o.indexOf(b.Id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  const myExcl = new Set(cfg.MyMediaExcludes || []);
  const latestExcl = new Set(cfg.LatestItemsExcludes || []);
  async function saveLibs() {
    await saveCfg({ OrderedViews: order.map(v => v.Id), MyMediaExcludes: [...myExcl], LatestItemsExcludes: [...latestExcl] });
    if (!other) await app.reloadViews();
  }
  function drawLibs() {
    fill(libsEl, h('div.lib-head', h('span', 'Library'), h('span', 'Order'), h('span', 'In My media'), h('span', 'In Latest'), h('span', 'Opens on')),
      order.map((v, i) => h('div.lib-row',
        h('span.lib-n', v.Name),
        h('span.lib-o',
          btn('▲', () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawLibs(); saveLibs(); }, { small: true, color: 'lilac', disabled: i === 0, title: 'Move up' }),
          btn('▼', () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawLibs(); saveLibs(); }, { small: true, color: 'lilac', disabled: i === order.length - 1, title: 'Move down' })),
        toggle(!myExcl.has(v.Id), on => { if (on) myExcl.delete(v.Id); else myExcl.add(v.Id); saveLibs(); }),
        toggle(!latestExcl.has(v.Id), on => { if (on) latestExcl.delete(v.Id); else latestExcl.add(v.Id); saveLibs(); }),
        // The tab the library opens on (official "Default screen", saved as landing-<id>).
        libraryTabs(v.CollectionType).length > 1
          ? select(libraryTabs(v.CollectionType).map(t => [t.label, t.landing]), us.pref(`landing-${v.Id}`, ''), val => savePref(`landing-${v.Id}`, val || null))
          : h('span'))));
  }
  drawLibs();

  // ---- subtitle appearance --------------------------------------------------------------------
  // Text subtitles only: styled (ASS) and picture (PGS) subtitles keep their own look.
  const preview = h('div.sub-prev', h('span.sub-prev-t', 'The sky\u2019s the limit, Number One.'));
  const drawPreview = () => {
    const t = preview.firstChild;
    for (const [k, v] of Object.entries(subtitleCss(us.subtitleAppearance))) t.style.setProperty(k, v);
    const pos = Number(us.subtitleAppearance.verticalPosition);
    preview.classList.toggle('top', pos >= 0);
  };
  const subSel = (key, options) => select(options, us.subtitleAppearance[key], v => {
    us.setSubtitleAppearance({ [key]: key === 'verticalPosition' ? Number(v) : v });
    drawPreview();
    saved();
  });
  const pickColour = (key, options) => {
    const cur = us.subtitleAppearance[key];
    const known = options.some(([, v]) => v.toLowerCase() === String(cur).toLowerCase());
    return subSel(key, known ? options : [...options, ['Custom', cur]]);
  };
  const appearance = h('div');
  function drawAppearance() {
    drawPreview();
    fill(appearance,
      preview,
      row('Text size', subSel('textSize', SUB_SIZES)),
      row('Weight', subSel('textWeight', SUB_WEIGHTS)),
      row('Font', subSel('font', SUB_FONT_NAMES)),
      row('Colour', pickColour('textColor', SUB_COLOURS)),
      row('Background', pickColour('textBackground', SUB_BACKS)),
      row('Edge', subSel('dropShadow', SUB_SHADOWS)),
      row('Position', subSel('verticalPosition', SUB_POSITIONS)),
      h('div.actions', btn('Reset to defaults', () => {
        us.setLocal('localplayersubtitleappearance3', { ...SUBTITLE_DEFAULTS });
        drawAppearance();
        saved();
      }, { color: 'blue', ghost: true, small: true })));
  }
  drawAppearance();

  // ---- this client ----------------------------------------------------------------------------
  const c = caps();
  const yes = v => (v ? 'Yes' : 'No');

  return h('div.view-settings',
    deck('Profile', { color: 'orange', num: 1 },
      h('div.kv',
        h('span', 'User'), h('span', us.me.Name),
        h('span', 'Administrator'), h('span', yes(us.me.Policy?.IsAdministrator)),
        h('span', 'Server'), h('span', `${info.ServerName} · Jellyfin ${info.Version}`)),
      canPrefs ? [h('h3.set-h', 'Picture'), avatarEl, fileIn] : null,
      other ? h('p.dlg-note', `Settings ${us.me.Name} keeps on the server. Those kept on each device (bitrate, theme music, subtitle look…) are set on that device.`) : null,
      !other && qcOn === true ? row('Quick Connect', btn('Authorise a device', () => { location.hash = '#/quickconnect'; }, { color: 'lilac', small: true }),
        'Sign another device in with the code it shows') : null,
      other ? null : canPrefs ? pwForm : managed),

    deck('Display', { color: 'sky', num: 2 },
      localRow('Theme songs', toggle(us.themeSongs, on => { us.setLocal('themeSongs', on); saved(); }), 'Play theme music on title pages (this device)'),
      localRow('Theme videos', toggle(us.themeVideos, on => { us.setLocal('themeVideos', on); saved(); }), 'Play theme videos behind title pages (this device)'),
      localRow('Backdrops', toggle(us.backdrops, on => { us.setLocal('backdrops', on); app.refreshBackdrops(); saved(); }), 'Show backdrops behind library and title pages (this device)'),
      localRow('Details banner', toggle(us.detailsBanner, on => { us.setLocal('detailsBanner', on); saved(); }), 'Banner art at the top of title pages, when backdrops are off (this device)'),
      row('Episode images in Next up and Continue watching', toggle(us.episodeImages, on => savePref('useEpisodeImagesInNextUpAndResume', on)), 'Off shows the series art instead'),
      localRow('Next up: maximum days', select(NEXTUP_DAYS, us.maxDaysNextUp, v => { us.setLocal('maxDaysForNextUp', Number(v)); saved(); }), 'Hide shows not watched for longer than this (this device)'),
      localRow('Next up: include rewatching', toggle(us.rewatchingNextUp, on => { us.setLocal('enableRewatchingInNextUp', on); saved(); }), 'This device'),
      cfgRow('Show missing episodes in seasons', toggle(cfg.DisplayMissingEpisodes, on => saveCfg({ DisplayMissingEpisodes: on }))),
      cfgRow('Hide watched items in Latest', toggle(cfg.HidePlayedInLatest, on => saveCfg({ HidePlayedInLatest: on })))),

    deck('Home', { color: 'lilac', num: 3 }, sectionsEl, canPrefs ? [h('h3.set-h', 'Libraries'), libsEl] : null),

    deck('Playback', { color: 'peach', num: 4 },
      cfgRow('Preferred audio language', select(langs, cfg.AudioLanguagePreference || '', v => saveCfg({ AudioLanguagePreference: v }))),
      cfgRow('Play default audio track regardless of language', toggle(cfg.PlayDefaultAudioTrack, on => saveCfg({ PlayDefaultAudioTrack: on }))),
      cfgRow('Remember audio selections', toggle(cfg.RememberAudioSelections, on => saveCfg({ RememberAudioSelections: on }))),
      cfgRow('Play next episode automatically', toggle(cfg.EnableNextEpisodeAutoPlay, on => saveCfg({ EnableNextEpisodeAutoPlay: on }))),
      row('Skip back', select(SKIPS, us.num('skipBackLength', 10000), v => savePref('skipBackLength', v))),
      row('Skip forward', select(SKIPS, us.num('skipForwardLength', 30000), v => savePref('skipForwardLength', v))),
      localRow('Maximum streaming bitrate', select(BITRATES, us.maxBitrate, v => { us.setLocal('maxBitrate', Number(v)); saved(); }), 'Above this, Jellyfin transcodes (this device)'),
      localRow('Maximum resolution', select(RESOLUTIONS, us.local('maxVideoWidth', 0), v => { us.setLocal('maxVideoWidth', Number(v)); saved(); }), 'Transcodes are scaled down to this (this device)'),
      localRow('Limit direct play to that resolution', toggle(us.local('limitSupportedVideoResolution', false), on => { us.setLocal('limitSupportedVideoResolution', on); saved(); }),
        'Larger files are transcoded instead of played as they are (this device)'),
      localRow('Audio channels', select(CHANNELS, us.local('allowedAudioChannels', 0), v => { us.setLocal('allowedAudioChannels', Number(v)); saved(); }), 'More than this and the server downmixes (this device)'),
      localRow('Preferred video codec when transcoding', select([['Auto', ''], ['H.264', 'h264'], ...(c.hevc ? [['HEVC', 'hevc']] : []), ...(c.av1 ? [['AV1', 'av1']] : [])],
        us.local('preferredTranscodeVideoCodec', ''), v => { us.setLocal('preferredTranscodeVideoCodec', v); saved(); }), 'This device'),
      localRow('Preferred audio codec when transcoding', select([['Auto', ''], ['AAC', 'aac'], ['MP3', 'mp3'], ...(c.ac3 ? [['AC-3', 'ac3']] : []), ...(c.eac3 ? [['E-AC-3', 'eac3']] : []), ...(c.opus ? [['Opus', 'opus']] : []), ...(c.flac ? [['FLAC', 'flac']] : [])],
        us.local('preferredTranscodeVideoAudioCodec', ''), v => { us.setLocal('preferredTranscodeVideoAudioCodec', v); saved(); }), 'This device'),
      localRow('Cinema mode', toggle(us.local('enableCinemaMode', true), on => { us.setLocal('enableCinemaMode', on); saved(); }),
        'Play the server\u2019s trailers and intros before a film started from the beginning (this device)'),
      localRow('Ask “Are you still watching?”', select(STILL, us.local('stillWatchingPrompt', 'disabled'), v => { us.setLocal('stillWatchingPrompt', v); saved(); }),
        'Before the next episode, after a long run without touching anything (this device)'),
      localRow('Burn in subtitles', select(BURN_IN, us.subtitleBurnIn, v => { us.setLocal('subtitleburnin', v); saved(); }),
        'Styled (ASS) and Blu-ray picture (PGS) subtitles are drawn by the browser; burning them in makes the server transcode (this device)'),
      localRow('Show “Up next” before the end', toggle(us.nextVideoInfo, on => { us.setLocal('enableNextVideoInfoOverlay', on); saved(); }), 'A countdown card for the next episode (this device)'),
      other ? null : h('h3.set-h', 'Media segments'),
      other ? null : h('p.dlg-note', 'What to do when an episode reaches a marked section, such as an intro found by Intro Skipper (this device).'),
      SEGMENTS.map(([type, label]) => localRow(label, select(SEG_ACTIONS, us.segmentAction(type), v => { us.setLocal(`segmentTypeAction__${type}`, v); saved(); })))),

    deck('Subtitles', { color: 'blue', num: 5 },
      cfgRow('Preferred subtitle language', select(langs, cfg.SubtitleLanguagePreference || '', v => saveCfg({ SubtitleLanguagePreference: v }))),
      cfgRow('Subtitle mode', select(SUB_MODES, cfg.SubtitleMode || 'Default', v => saveCfg({ SubtitleMode: v })), 'Which subtitles start automatically'),
      cfgRow('Remember subtitle selections', toggle(cfg.RememberSubtitleSelections, on => saveCfg({ RememberSubtitleSelections: on }))),
      localRow('Always burn in when transcoding', toggle(us.local('alwaysBurnInSubtitleWhenTranscoding', false), on => { us.setLocal('alwaysBurnInSubtitleWhenTranscoding', on); saved(); }),
        'When the server transcodes anyway, have it draw every subtitle into the picture (this device)'),
      other ? null : [h('h3.set-h', 'Appearance'),
        h('p.dlg-note', 'For plain text subtitles (SRT, WebVTT) on this device. Styled and picture subtitles keep their own look.'),
        appearance]),

    other ? null : deck('LCARS client', { color: 'salmon', num: 6 },
      localRow('Audio cues', toggle(app.sound.on, () => app.sound.toggle()), 'Panel chirps when you press controls'),
      h('h3.set-h', 'Decoder capabilities'),
      h('div.kv',
        h('span', 'H.264 / HEVC'), h('span', `${yes(c.h264)} / ${yes(c.hevc)}`),
        h('span', 'AV1 / VP9'), h('span', `${yes(c.av1)} / ${yes(c.vp9)}`),
        h('span', 'Opus / FLAC'), h('span', `${yes(c.opus)} / ${yes(c.flac)}`),
        h('span', 'AC-3 / E-AC-3'), h('span', `${yes(c.ac3)} / ${yes(c.eac3)}`),
        h('span', 'Client'), h('span', `${CLIENT} ${VERSION} · ${app.version}`),
        h('span', 'Device'), h('span', `${api.device} · ${api.deviceId.slice(0, 8)}`)),
      h('div.actions',
        app.hosted ? null : btn('Official Jellyfin web', () => window.open(api.url('/web/'), '_blank', 'noopener'), { color: 'lilac', ghost: true }),
        btn('Log out', () => app.logout(), { color: 'red' }))));
}
