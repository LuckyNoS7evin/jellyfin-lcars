// First-run setup (official apps/wizard): a new server has no administrator yet, and its own
// wizard is part of jellyfin-web, which LCARS replaces when Jellyfin hosts it. The /Startup
// endpoints (and adding libraries) work without signing in until setup is finished.
// Steps as official: language and name, the administrator, libraries, metadata, remote access.
import { h, fill } from '../h.js';
import { deck, btn, toast, empty } from '../ui.js';

const TYPES = [['Films', 'movies'], ['Shows', 'tvshows'], ['Music', 'music'], ['Music videos', 'musicvideos'], ['Books', 'books'],
  ['Home videos and photos', 'homevideos'], ['Mixed films and shows', '']];
const STEPS = ['Server', 'Administrator', 'Libraries', 'Metadata', 'Remote access'];

export function wizard(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('First contact');
  const body = h('div');
  const state = { step: 0, cfg: null, user: '' };
  // The folder picker and its styles come from the admin dashboard.
  if (!document.querySelector('link[data-admin-css]')) document.head.append(h('link', { rel: 'stylesheet', href: `${app.assets}css/admin.css`, attrs: { 'data-admin-css': '' } }));

  const row = (label, control, note) => h('div.set-row', h('div.set-l', h('span', label), note ? h('small', note) : null), h('div.set-c', control));
  const sel = (opts, value) => h('select.sel', opts.map(([l, v]) => h('option', { value: String(v), attrs: { selected: String(v) === String(value ?? '') } }, l)));
  const failed = e => toast('Unable to comply', e.message, 'red');
  const steps = () => h('div.tabs.wiz-steps', STEPS.map((s, i) => h('span.tab', { class: i === state.step ? 'on' : i < state.step ? 'done' : '' }, `${i + 1} ${s}`)));
  const nav = (next, { back = true, label = 'Continue' } = {}) => h('div.actions',
    back && state.step > 0 ? btn('Back', () => { state.step--; draw(); }, { color: 'lilac', ghost: true }) : null,
    btn(label, next, { color: 'orange' }));

  async function draw() {
    fill(body, steps(), await [server, admin, libraries, metadata, remote][state.step]());
  }

  // 1. The server's name and display language.
  async function server() {
    const [cfg, langs, pub] = await Promise.all([api.get('/Startup/Configuration'), api.get('/Localization/Options').catch(() => []), api.publicInfo().catch(() => ({}))]);
    state.cfg = cfg;
    // Empty, the server goes by its host name (in Docker, the container's id).
    const name = h('input.inp', { value: cfg.ServerName || '', attrs: { spellcheck: 'false', placeholder: pub.ServerName || '' } });
    const ui = sel(langs.map(l => [l.Name, l.Value]), cfg.UICulture || 'en-US');
    return deck('Welcome', { color: 'orange', num: 1 },
      h('p.dlg-text', 'This Jellyfin server is new. A few settings, then it’s ready; everything here can be changed later in Engineering.'),
      row('Server name', name, 'How apps show this server'),
      row('Display language', ui, 'For the server’s own messages'),
      nav(async () => {
        try {
          state.cfg = { ...state.cfg, ServerName: name.value.trim(), UICulture: ui.value };
          await api.post('/Startup/Configuration', state.cfg);
          state.step++; draw();
        } catch (e) { failed(e); }
      }));
  }

  // 2. The first user, who is the administrator.
  async function admin() {
    const first = await api.get('/Startup/User').catch(() => ({}));
    const name = h('input.inp', { value: state.user || first.Name || '', attrs: { autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off' } });
    const pw = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
    const pw2 = h('input.inp', { type: 'password', attrs: { autocomplete: 'new-password' } });
    const msg = h('p.msg', { attrs: { role: 'status' } });
    return deck('Administrator', { color: 'sky', num: 2 },
      h('p.dlg-text', 'The first account, with full control of the server. More people can be added later.'),
      row('Username', name), row('Password', pw), row('Confirm password', pw2), msg,
      nav(async () => {
        if (!name.value.trim()) { name.focus(); return; }
        if (!pw.value) { msg.className = 'msg bad'; msg.textContent = 'A password is needed'; pw.focus(); return; }
        if (pw.value !== pw2.value) { msg.className = 'msg bad'; msg.textContent = 'The passwords differ'; return; }
        try {
          await api.post('/Startup/User', { Name: name.value.trim(), Password: pw.value });
          state.user = name.value.trim();
          state.step++; draw();
        } catch (e) { failed(e); }
      }));
  }

  // 3. Libraries: a name, a type and folders each. Optional now; Engineering has the full editor.
  async function libraries() {
    const { pickFolder } = await import('../admin/form.js');
    const list = h('div');
    async function drawList() {
      const libs = await api.get('/Library/VirtualFolders').catch(() => []);
      fill(list, libs.length ? libs.map(l => h('div.eng-folder', h('span', `${l.Name} · ${TYPES.find(([, v]) => v === (l.CollectionType || ''))?.[0] || l.CollectionType} · ${(l.Locations || []).join(', ')}`),
        btn('✕', async () => {
          try { await api.del('/Library/VirtualFolders', { name: l.Name, refreshLibrary: false }); drawList(); } catch (e) { failed(e); }
        }, { small: true, ico: true, color: 'red', ghost: true, title: `Remove ${l.Name}` }))) : empty('No libraries yet.'));
    }
    const name = h('input.inp', { attrs: { placeholder: 'Films', spellcheck: 'false' } });
    const type = sel(TYPES, 'movies');
    const paths = [];
    const pathsEl = h('div.eng-folders');
    const drawPaths = () => fill(pathsEl, paths.map(p => h('div.eng-folder', h('span', p),
      btn('✕', () => { paths.splice(paths.indexOf(p), 1); drawPaths(); }, { small: true, ico: true, color: 'red', ghost: true, title: `Remove ${p}` }))),
    btn('Add a folder', async () => { const p = await pickFolder(api, ''); if (p && !paths.includes(p)) { paths.push(p); drawPaths(); } }, { small: true, color: 'blue' }));
    drawPaths();
    drawList();
    return deck('Libraries', { color: 'lilac', num: 3 },
      h('p.dlg-text', 'Where your media is. You can add libraries now or later, in Engineering → Libraries.'),
      list,
      h('h3.set-h', 'Add a library'),
      row('Name', name), row('Content', type), row('Folders', pathsEl),
      h('div.actions', btn('Add library', async () => {
        const n = name.value.trim();
        if (!n) { name.focus(); return; }
        if (!paths.length) { toast('No folders', 'Add at least one folder', 'red'); return; }
        try {
          await api.post('/Library/VirtualFolders', { LibraryOptions: { PathInfos: paths.map(Path => ({ Path })) } },
            { name: n, collectionType: type.value || undefined, refreshLibrary: false, paths });
          name.value = ''; paths.length = 0; drawPaths(); drawList();
          toast('Library added', n, 'sky', 2000);
        } catch (e) { failed(e); }
      }, { small: true, color: 'sky' })),
      nav(() => { state.step++; draw(); }));
  }

  // 4. The language and country for metadata.
  async function metadata() {
    const [cultures, countries] = await Promise.all([api.get('/Localization/Cultures').catch(() => []), api.get('/Localization/Countries').catch(() => [])]);
    const lang = sel(cultures.map(c => [c.DisplayName, c.TwoLetterISOLanguageName]).sort((a, b) => a[0].localeCompare(b[0])), state.cfg?.PreferredMetadataLanguage || 'en');
    const country = sel(countries.map(c => [c.DisplayName, c.TwoLetterISORegionName]).sort((a, b) => a[0].localeCompare(b[0])), state.cfg?.MetadataCountryCode || 'US');
    return deck('Metadata', { color: 'peach', num: 4 },
      h('p.dlg-text', 'The language titles and descriptions are fetched in, and the country for ratings and release dates.'),
      row('Language', lang), row('Country', country),
      nav(async () => {
        try {
          state.cfg = { ...state.cfg, PreferredMetadataLanguage: lang.value, MetadataCountryCode: country.value };
          await api.post('/Startup/Configuration', state.cfg);
          state.step++; draw();
        } catch (e) { failed(e); }
      }));
  }

  // 5. Remote access, then finish and sign in.
  async function remote() {
    let on = true;
    const t = h('button.toggle.on', { type: 'button', attrs: { role: 'switch', 'aria-checked': 'true' } }, 'On');
    t.addEventListener('click', () => { on = !on; t.classList.toggle('on', on); t.textContent = on ? 'On' : 'Off'; t.setAttribute('aria-checked', String(on)); });
    return deck('Remote access', { color: 'blue', num: 5 },
      row('Allow connections from outside this network', t, 'Off: only devices on the LAN can connect'),
      nav(async () => {
        try {
          await api.post('/Startup/RemoteAccess', { EnableRemoteAccess: on });
          await api.post('/Startup/Complete');
          toast('Setup complete', 'Sign in with the administrator account', 'sky', 4000);
          app.afterSetup(state.user);
        } catch (e) { failed(e); }
      }, { label: 'Finish' }));
  }

  draw().catch(failed);
  return h('div.view-wizard', body);
}
