// Users (official routes/users and features/users): the list, adding a user, and editing one:
// profile and features, access, parental control, password and picture. Profile, access and
// parental control are one form with one Save bar (the name and the policy); the password and
// picture act straight away, as in the official pages.
import { h, fill } from '../h.js';
import * as f from '../fmt.js';
import { deck, btn, tag, empty, toast, squareJpeg } from '../ui.js';
import { confirmDialog } from '../menu.js';
import { editForm, row } from './form.js';

const SYNCPLAY = [['Create and join groups', 'CreateAndJoinGroups'], ['Join groups', 'JoinGroups'], ['No access', 'None']];
const UNRATED = [['Books', 'Book'], ['Channels', 'ChannelContent'], ['Live TV', 'LiveTvChannel'], ['Films', 'Movie'],
  ['Music', 'Music'], ['Trailers', 'Trailer'], ['Shows', 'Series']];
const DAYS = [['Every day', 'Everyday'], ['Weekdays', 'Weekday'], ['Weekends', 'Weekend'], ['Sunday', 'Sunday'], ['Monday', 'Monday'],
  ['Tuesday', 'Tuesday'], ['Wednesday', 'Wednesday'], ['Thursday', 'Thursday'], ['Friday', 'Friday'], ['Saturday', 'Saturday']];
const HOURS = Array.from({ length: 49 }, (_, i) => [`${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i / 2]);

export async function users(ctx) {
  const [id] = ctx.sub;
  if (!id) return list(ctx);
  if (id === 'new') return add(ctx);
  // Their settings: LCARS's own settings page, for them (official mypreferencesmenu?userId=).
  if (ctx.sub[1] === 'settings') return import('../views/settings.js').then(m => m.settings({ ...ctx, params: { user: id } }));
  return edit(ctx, id);
}

const avatar = (api, u, size = 96) => (u.PrimaryImageTag
  ? h('img', { src: api.url(`/Users/${u.Id}/Images/Primary`, { tag: u.PrimaryImageTag, height: size, quality: 90 }), alt: '' })
  : h('span.eng-user-none', (u.Name || '?')[0]));

// ---- list -------------------------------------------------------------------------------------

async function list(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Users');
  const all = await api.get('/Users', undefined, { signal });
  all.sort((a, b) => (b.Policy?.IsAdministrator - a.Policy?.IsAdministrator) || a.Name.localeCompare(b.Name));
  return deck('Users', { color: 'orange', num: 1, code: `${all.length} on file` },
    h('div.actions', btn('Add user', () => { location.hash = '#/admin/users/new'; }, { color: 'orange' })),
    h('div.eng-users', all.map(u => h('a.eng-user', { href: `#/admin/users/${u.Id}`, class: u.Policy?.IsDisabled ? 'disabled' : '' },
      h('div.eng-user-img', avatar(api, u)),
      h('div.eng-user-b',
        h('b', u.Name),
        h('div.eng-user-tags',
          u.Policy?.IsAdministrator ? tag('Administrator', 'peach') : null,
          u.Policy?.IsDisabled ? tag('Disabled', 'red') : null,
          u.Policy?.IsHidden ? tag('Hidden', 'lilac') : null),
        h('span', u.LastActivityDate ? `Active ${f.ago(u.LastActivityDate)}` : 'Never signed in'))))));
}

// ---- add ----------------------------------------------------------------------------------------

async function add(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('New user');
  ctx.setParent('#/admin/users');
  const [folders, channels] = await Promise.all([
    api.get('/Library/MediaFolders', { isHidden: false }, { signal }).then(r => r.Items || []),
    api.get('/Channels', undefined, { signal }).then(r => r.Items || []).catch(() => []),
  ]);
  const name = h('input.inp', { attrs: { autocomplete: 'off', required: true, spellcheck: 'false' } });
  const pw = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  const pw2 = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  // "All" or a chosen few, for libraries and (when the server has any) channels.
  function picker(items, allLabel) {
    const st = { all: true, chosen: new Set(), el: h('div') };
    const draw = () => fill(st.el, h('div.eng-allor',
      h('div.eng-allor-h', h('button.toggle', { type: 'button', class: st.all ? 'on' : '', onclick: () => { st.all = !st.all; draw(); } }, st.all ? 'On' : 'Off'), h('span', allLabel)),
      h('div.eng-checks', { class: st.all ? 'off' : '' }, items.map(it => h('button.eng-check', {
        type: 'button', class: st.all || st.chosen.has(it.Id) ? 'on' : '', disabled: st.all,
        onclick: () => { if (st.chosen.has(it.Id)) st.chosen.delete(it.Id); else st.chosen.add(it.Id); draw(); },
      }, it.Name)))));
    draw();
    return st;
  }
  const libs = picker(folders, 'All libraries');
  const chans = channels.length ? picker(channels, 'All channels') : null;
  const msg = h('p.msg', { attrs: { role: 'status' } });
  const form = h('form.set-form', {
    onsubmit: async e => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      if (pw.value !== pw2.value) { msg.className = 'msg bad'; msg.textContent = 'The passwords differ'; return; }
      msg.className = 'msg';
      msg.textContent = 'Creating…';
      try {
        const u = await api.post('/Users/New', { Name: n, Password: pw.value || undefined });
        await api.post(`/Users/${u.Id}/Policy`, { ...u.Policy, EnableAllFolders: libs.all, EnabledFolders: libs.all ? [] : [...libs.chosen],
          ...(chans ? { EnableAllChannels: chans.all, EnabledChannels: chans.all ? [] : [...chans.chosen] } : {}) });
        toast('User created', n, 'sky');
        location.hash = `#/admin/users/${u.Id}`;
      } catch (err) {
        msg.className = 'msg bad';
        msg.textContent = `Unable to comply: ${err.message}`;
      }
    },
  },
  row('Name', name), row('Password', pw, 'Optional: a user without one signs in with an empty password'), row('Confirm password', pw2),
  h('h3.set-h', 'Library access'), libs.el,
  chans ? [h('h3.set-h', 'Channel access'), chans.el] : null,
  h('div.actions', btn('Create user', null, { type: 'submit', color: 'orange' }), btn('Cancel', () => { location.hash = '#/admin/users'; }, { color: 'lilac', ghost: true })),
  msg);
  setTimeout(() => name.focus(), 0);
  return deck('New user', { color: 'orange', num: 1 }, form);
}

// ---- edit ---------------------------------------------------------------------------------------

async function edit(ctx, userId) {
  const { api, app, signal } = ctx;
  ctx.setParent('#/admin/users');
  const [user, folders, channels, devices, ratings, authProviders, resetProviders] = await Promise.all([
    api.get(`/Users/${userId}`, undefined, { signal }),
    api.get('/Library/MediaFolders', { isHidden: false }, { signal }).then(r => r.Items || []),
    api.get('/Channels', undefined, { signal }).then(r => r.Items || []).catch(() => []),
    api.get('/Devices', undefined, { signal }).then(r => r.Items || []).catch(() => []),
    api.get('/Localization/ParentalRatings', undefined, { signal }).catch(() => []),
    api.get('/Auth/Providers', undefined, { signal }).catch(() => []),
    api.get('/Auth/PasswordResetProviders', undefined, { signal }).catch(() => []),
  ]);
  ctx.setTitle(user.Name);
  const self = user.Id === api.userId;
  const fo = editForm({
    app,
    // Remote access unset means allowed (official Profile.tsx).
    load: () => ({ Name: user.Name, Policy: { ...user.Policy, EnableRemoteAccess: user.Policy?.EnableRemoteAccess ?? true } }),
    save: async d => {
      const p = { ...d.Policy };
      // As official: with "all" on, the list is stored empty.
      if (p.EnableAllFolders) p.EnabledFolders = [];
      if (p.EnableAllChannels) p.EnabledChannels = [];
      if (p.EnableAllDevices) p.EnabledDevices = [];
      if (p.EnableContentDeletion) p.EnableContentDeletionFromFolders = [];
      if (d.Name !== user.Name) {
        await api.post('/Users', { ...user, Name: d.Name.trim() }, { userId: user.Id });
        user.Name = d.Name.trim();
        ctx.setTitle(user.Name);
      }
      await api.post(`/Users/${user.Id}/Policy`, p);
      if (self) await app.us.load(); // my own permissions changed
    },
  });
  await fo.ready;
  const P = k => `Policy.${k}`;
  const t = k => fo.toggle(P(k));

  // Parental rating: one select over the server's ratings, grouped where they share a score
  // (official loadUser); stores MaxParentalRating and MaxParentalSubRating.
  const groups = [];
  for (const r of ratings) {
    const last = groups[groups.length - 1];
    if (last && last.score === r.RatingScore?.score && last.sub == r.RatingScore?.subScore) { last.name += ` / ${r.Name}`; continue; }
    groups.push({ name: r.Name, score: r.RatingScore?.score ?? r.Value, sub: r.RatingScore?.subScore ?? null });
  }
  const ratingSel = h('select.sel', h('option', { value: '' }, 'No limit'), groups.map((g, i) => h('option', { value: String(i) }, g.name)));
  const syncRating = () => {
    const s = fo.get(P('MaxParentalRating'));
    const sub = fo.get(P('MaxParentalSubRating'));
    let i = groups.findIndex(g => g.score === s && g.sub == sub);
    if (i < 0) i = groups.findIndex(g => g.score === s);
    ratingSel.value = s == null || i < 0 ? '' : String(i);
  };
  ratingSel.addEventListener('change', () => {
    const g = groups[Number(ratingSel.value)];
    fo.set(P('MaxParentalRating'), ratingSel.value === '' ? null : g.score);
    fo.set(P('MaxParentalSubRating'), ratingSel.value === '' ? null : g.sub);
  });
  fo.controls.push({ sync: syncRating });
  syncRating();

  // Access schedules: day, from, to (hours, in halves).
  const schedEl = h('div.eng-scheds');
  const drawScheds = () => {
    const list = fo.get(P('AccessSchedules')) || [];
    const sel = (opts, v, set) => { const s = h('select.sel', opts.map(([l, x]) => h('option', { value: String(x) }, l))); s.value = String(v); s.addEventListener('change', () => set(s.value)); return s; };
    const put = (i, k, v) => { const l = [...(fo.get(P('AccessSchedules')) || [])]; l[i] = { ...l[i], [k]: v }; fo.set(P('AccessSchedules'), l); };
    fill(schedEl,
      list.length ? list.map((s, i) => h('div.eng-sched',
        sel(DAYS, s.DayOfWeek, v => put(i, 'DayOfWeek', v)),
        h('span', 'from'), sel(HOURS, s.StartHour, v => put(i, 'StartHour', Number(v))),
        h('span', 'to'), sel(HOURS, s.EndHour, v => put(i, 'EndHour', Number(v))),
        btn('✕', () => { fo.set(P('AccessSchedules'), list.filter((_, j) => j !== i)); drawScheds(); }, { small: true, ico: true, color: 'red', ghost: true, title: 'Remove' })))
        : h('p.dlg-note', 'No schedule: the user may sign in at any time.'),
      btn('Add a time', () => { fo.set(P('AccessSchedules'), [...list, { DayOfWeek: 'Everyday', StartHour: 0, EndHour: 24 }]); drawScheds(); }, { small: true, color: 'blue' }));
  };
  fo.controls.push({ sync: drawScheds });
  drawScheds();

  const folderItems = folders.map(x => [x.Name, x.Id]);
  const deviceItems = devices.map(d => [`${d.CustomName || d.Name} · ${d.AppName}`, d.Id]);
  const providerRow = (label, key, providers) => (providers.length > 1
    ? row(label, fo.select(P(key), providers.map(p => [p.Name, p.Id]))) : null);

  // ---- profile and features -------------------------------------------------------------------
  const profile = deck('Profile', { color: 'orange', num: 1 },
    user.Policy?.IsDisabled ? h('p.eng-warn', 'This user is disabled and can’t sign in.') : null,
    row('Name', fo.text('Name')),
    row('Administrator', t('IsAdministrator'), self ? 'Your own account: you can’t remove your last administrator' : 'Full control of the server'),
    row('Disabled', t('IsDisabled'), 'Can’t sign in (administrators can’t be disabled)'),
    row('Hidden from the sign-in screen', t('IsHidden'), 'They type their name to sign in'),
    row('Allow remote connections', t('EnableRemoteAccess'), 'From outside the server’s LAN'),
    row('Change their own settings', t('EnableUserPreferenceAccess'), 'Password, home screen and display preferences'),
    row('Their settings', btn('Edit their settings', () => { location.hash = `#/admin/users/${user.Id}/settings`; }, { small: true, color: 'lilac' }), 'Home screen, display, playback and subtitle preferences'),
    providerRow('Authentication provider', 'AuthenticationProviderId', authProviders),
    providerRow('Password reset provider', 'PasswordResetProviderId', resetProviders),
    row('Failed sign-ins before lockout', fo.num(P('LoginAttemptsBeforeLockout'), { min: -1, zero: 0, placeholder: 'Default' }), 'Empty: the default (3, or 5 for administrators); −1: never lock'),
    row('Maximum sessions at once', fo.num(P('MaxActiveSessions'), { min: 0, zero: 0, placeholder: 'No limit' }), 'Empty: no limit'));

  const features = deck('Features', { color: 'peach', num: 2 },
    h('h3.set-h', 'Playback'),
    row('Media playback', t('EnableMediaPlayback')),
    row('Audio transcoding', t('EnableAudioPlaybackTranscoding')),
    row('Video transcoding', t('EnableVideoPlaybackTranscoding'), 'Off: only files their device plays as they are'),
    row('Remuxing', t('EnablePlaybackRemuxing'), 'Changing the container without re-encoding'),
    row('Force transcoding of remote sources', t('ForceRemoteSourceTranscoding')),
    row('Internet streaming bitrate limit (Mbps)', fo.num(P('RemoteClientBitrateLimit'), { min: 0, step: 0.1, scale: 1e6, zero: 0, placeholder: 'No limit' }), 'Empty: no limit for this user'),
    row('SyncPlay', fo.select(P('SyncPlayAccess'), SYNCPLAY)),
    h('h3.set-h', 'Management'),
    row('Delete media', t('EnableContentDeletion'), 'From every library; off to choose below'),
    row(channels.length ? 'Delete from these libraries and channels' : 'Delete from these libraries',
      fo.checklist(P('EnableContentDeletionFromFolders'), [...folderItems, ...channels.map(c => [c.Name, c.Id])], { disabledBy: P('EnableContentDeletion') })),
    row('Download media', t('EnableContentDownloading')),
    row('Manage collections', t('EnableCollectionManagement')),
    row('Manage subtitles', t('EnableSubtitleManagement')),
    row('Manage lyrics', t('EnableLyricManagement')),
    row('Control other users’ sessions', t('EnableRemoteControlOfOtherUsers'), 'Play on, for their devices'),
    row('Control shared devices', t('EnableSharedDeviceControl'), 'Devices nobody is signed in to (DLNA, for one)'),
    h('h3.set-h', 'Live TV'),
    row('Live TV', t('EnableLiveTvAccess')),
    row('Manage Live TV recordings', t('EnableLiveTvManagement')));

  const access = deck('Access', { color: 'sky', num: 3 },
    h('h3.set-h', 'Libraries'), fo.allOr(P('EnableAllFolders'), P('EnabledFolders'), folderItems, 'All libraries'),
    channels.length ? [h('h3.set-h', 'Channels'), fo.allOr(P('EnableAllChannels'), P('EnabledChannels'), channels.map(c => [c.Name, c.Id]), 'All channels')] : null,
    h('h3.set-h', 'Devices'), fo.allOr(P('EnableAllDevices'), P('EnabledDevices'), deviceItems, 'Any device'));

  const parental = deck('Parental control', { color: 'lilac', num: 4 },
    row('Maximum rating', ratingSel, 'Higher-rated items are hidden'),
    row('Block items with no rating', fo.checklist(P('BlockUnratedItems'), UNRATED)),
    row('Only items with these tags', fo.tags(P('AllowedTags')), 'Empty: no restriction'),
    row('Hide items with these tags', fo.tags(P('BlockedTags'))),
    h('h3.set-h', 'Access schedule'), schedEl);

  // ---- password (acts straight away) ------------------------------------------------------------
  const cur = self ? h('input.inp', { type: 'password', attrs: { autocomplete: 'current-password' } }) : null;
  const nw = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  const nw2 = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
  const pwForm = h('form.set-form', {
    onsubmit: async e => {
      e.preventDefault();
      if (nw.value !== nw2.value) { toast('Passwords differ', 'The new password and confirmation must match', 'red'); return; }
      try {
        await api.post('/Users/Password', { CurrentPw: cur ? cur.value : '', NewPw: nw.value }, { userId: user.Id });
        if (cur) cur.value = '';
        nw.value = nw2.value = '';
        toast('Password set', user.Name, 'sky');
      } catch (err) { toast('Unable to comply', err.message, 'red'); }
    },
  },
  cur ? row('Current password', cur) : null, row('New password', nw), row('Confirm', nw2),
  h('div.actions', btn('Set password', null, { type: 'submit', color: 'salmon' }),
    // Jellyfin 12 no longer says whether a user has a password (HasPassword is always true), and
    // it refuses an empty one for administrators.
    !self && !user.Policy?.IsAdministrator ? btn('Remove password', async () => {
      if (!(await confirmDialog('Remove password', `${user.Name} will sign in with an empty password.`, 'Remove'))) return;
      try { await api.post('/Users/Password', { ResetPassword: true }, { userId: user.Id }); toast('Password removed', user.Name, 'red'); } catch (err) { toast('Unable to comply', err.message, 'red'); }
    }, { color: 'red', ghost: true }) : null));

  // ---- picture (acts straight away) -------------------------------------------------------------
  const picEl = h('div.avatar');
  const fileIn = h('input', { type: 'file', attrs: { accept: 'image/*', hidden: true } });
  const drawPic = () => fill(picEl, avatar(api, user, 160),
    h('div.actions', btn(user.PrimaryImageTag ? 'Change picture' : 'Add picture', () => fileIn.click(), { color: 'sky', small: true }),
      user.PrimaryImageTag ? btn('Remove', async () => {
        try { await api.del(`/Users/${user.Id}/Images/Primary`); user.PrimaryImageTag = null; drawPic(); } catch (err) { toast('Unable to comply', err.message, 'red'); }
      }, { color: 'red', small: true, ghost: true }) : null));
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    try {
      await api.req('POST', `/Users/${user.Id}/Images/Primary`, { raw: { data: await squareJpeg(file), type: 'image/jpeg' } });
      Object.assign(user, await api.get(`/Users/${user.Id}`));
      drawPic();
    } catch (err) { toast('Unable to comply', err.message, 'red'); }
  });
  drawPic();

  const account = deck('Password and picture', { color: 'salmon', num: 5 },
    h('div.eng-two', pwForm, h('div', picEl, fileIn)),
    !self ? h('div.actions.eng-danger', btn('Delete user', async () => {
      if (!(await confirmDialog('Delete user', `Delete ${user.Name}? Their watch history and settings go with them. This cannot be undone.`, 'Delete'))) return;
      try { await api.del(`/Users/${user.Id}`); toast('User deleted', user.Name, 'red'); location.hash = '#/admin/users'; } catch (err) { toast('Unable to comply', err.message, 'red'); }
    }, { color: 'red' })) : null);

  return h('div.eng-user-edit',
    h('div.eng-user-head', h('div.eng-user-img', avatar(api, user, 96)), h('div', h('b', user.Name),
      h('span', [user.LastLoginDate ? `Last signed in ${f.ago(user.LastLoginDate)}` : 'Never signed in', user.LastActivityDate ? `active ${f.ago(user.LastActivityDate)}` : ''].filter(Boolean).join(' · ')))),
    h('div.eng-grid', h('div.eng-col', profile, features), h('div.eng-col', access, parental, account)),
    fo.bar);
}
