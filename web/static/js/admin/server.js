// Server settings (admin stage A6; official routes/settings, networking, branding, devices, keys,
// backups). General and Networking change settings that some only apply after a restart (the
// form says so); Devices, API keys and Backups act straight away.
import { h, fill } from '../h.js';
import * as f from '../fmt.js';
import { deck, btn, tag, empty, toast, errorBox } from '../ui.js';
import { confirmDialog, dialog } from '../menu.js';
import { editForm, row } from './form.js';

export async function server(ctx) {
  const [tab = 'general'] = ctx.sub;
  ctx.setParent('#/admin/overview');
  const page = { general, networking, branding, devices, keys, backups }[tab] || general;
  return h('div.eng-edit', subTabs(tab), await page(ctx));
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['general', 'General'], ['networking', 'Networking'], ['branding', 'Branding'],
  ['devices', 'Devices'], ['keys', 'API keys'], ['backups', 'Backups']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/server/${k}`, class: k === cur ? 'on' : '' }, l)));

// ---- general ----------------------------------------------------------------------------------------

async function general(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Server settings');
  const [cultures, pub] = await Promise.all([api.get('/Localization/Options', undefined, { signal }).catch(() => []), api.publicInfo().catch(() => ({}))]);
  const fo = editForm({
    app,
    load: () => api.get('/System/Configuration'),
    save: d => api.post('/System/Configuration', d),
    restartKeys: ['CachePath', 'MetadataPath'],
  });
  await fo.ready;
  const t = k => fo.toggle(k);
  return [h('div.eng-grid',
    h('div.eng-col',
      deck('Server', { color: 'orange', num: 1 },
        row('Name', fo.text('ServerName', { placeholder: pub.ServerName || '' }), 'Shown to apps; empty: the machine’s name'),
        row('Display language', fo.select('UICulture', cultures.map(c => [c.Name, c.Value])), 'For the server’s own messages'),
        row('Quick Connect', t('QuickConnectAvailable'), 'Sign in on a new device with a code')),
      deck('Folders', { color: 'peach', num: 2 },
        row('Cache', fo.path('CachePath', api), 'Empty: the default. Applies after a restart'),
        row('Metadata', fo.path('MetadataPath', api), 'Images and metadata the server downloads. Applies after a restart'))),
    h('div.eng-col',
      deck('Performance', { color: 'lilac', num: 3 },
        row('Parallel library scan tasks', fo.num('LibraryScanFanoutConcurrency', { min: 0, zero: 0, placeholder: 'Auto' }), 'Empty: half the processor cores'),
        row('Parallel metadata refreshes', fo.num('LibraryMetadataRefreshConcurrency', { min: 0, zero: 0, placeholder: 'Auto' })),
        row('Parallel image encodes', fo.num('ParallelImageEncodingLimit', { min: 0, zero: 0, placeholder: 'Auto' }), 'Empty: one per processor core'),
        row('Warn about slow responses', t('EnableSlowResponseWarning'), 'In the log'),
        row('… slower than (milliseconds)', fo.num('SlowResponseThresholdMs', { min: 0 }))),
      deck('Logs', { color: 'blue', num: 4 },
        row('Keep activity for (days)', fo.num('ActivityLogRetentionDays', { min: 0, zero: null, placeholder: 'For ever' }), 'Empty: never delete'),
        row('Let apps upload their logs', t('AllowClientLogUpload'), 'For bug reports from the TV and phone apps')))), fo.bar];
}

// ---- networking -------------------------------------------------------------------------------------

/** PublishedServerUriBySubnet as the official page shows it: one address, or internal and external. */
function pubFrom(list = []) {
  if (list.length === 1 && !list[0].includes('=')) return { same: true, all: list[0], internal: '', external: '' };
  const o = { same: true, all: '', internal: '', external: '' };
  for (const part of list) { const [k, ...v] = part.split('='); if (['all', 'internal', 'external'].includes(k)) o[k] = v.join('='); }
  if (!o.all && (o.internal || o.external)) o.same = false;
  return o;
}
function pubTo(p) {
  if (p.same) return p.all ? [`all=${p.all}`] : [];
  return [p.internal && `internal=${p.internal}`, p.external && `external=${p.external}`].filter(Boolean);
}

async function networking(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Networking');
  const fo = editForm({
    app,
    load: async () => { const c = await api.get('/System/Configuration/network'); return { ...c, _pub: pubFrom(c.PublishedServerUriBySubnet) }; },
    save: async d => {
      const c = { ...d, PublishedServerUriBySubnet: pubTo(d._pub) };
      delete c._pub;
      await api.post('/System/Configuration/network', c);
    },
    restartKeys: ['InternalHttpPort', 'InternalHttpsPort', 'BaseUrl', 'EnableHttps', 'RequireHttps', 'CertificatePath', 'CertificatePassword',
      'LocalNetworkAddresses', 'EnableIPv4', 'EnableIPv6', 'KnownProxies', 'LocalNetworkSubnets'],
  });
  await fo.ready;
  const t = k => fo.toggle(k);
  const body = h('div');
  function draw() {
    fo.controls.length = 0;
    const same = fo.get('_pub.same');
    const sameT = t('_pub.same');
    sameT.addEventListener('click', draw);
    const httpsT = t('EnableHttps');
    httpsT.addEventListener('click', draw);
    const https = fo.get('EnableHttps');
    fill(body, h('div.eng-grid',
      h('div.eng-col',
        deck('Ports and address', { color: 'orange', num: 1 },
          h('p.dlg-note', 'Changes here apply after a restart; the restart banner offers one.'),
          row('HTTP port', fo.num('InternalHttpPort', { min: 1, max: 65535 })),
          row('Base URL', fo.text('BaseUrl', { placeholder: '/jellyfin' }), 'A path prefix, if a proxy serves the server under one'),
          row('Bind to addresses', fo.tags('LocalNetworkAddresses', { placeholder: 'Add an address' }), 'Empty: all of them'),
          row('IPv4', t('EnableIPv4')),
          row('IPv6', t('EnableIPv6'))),
        deck('HTTPS', { color: 'peach', num: 2 },
          row('HTTPS', httpsT, 'Most set-ups leave this to the reverse proxy'),
          https ? [
            row('HTTPS port', fo.num('InternalHttpsPort', { min: 1, max: 65535 })),
            row('Require HTTPS', t('RequireHttps'), 'Redirect plain HTTP (not for the LAN)'),
            row('Certificate (.pfx)', fo.path('CertificatePath', api)),
            row('Certificate password', fo.text('CertificatePassword'))] : null),
        deck('Published addresses', { color: 'lilac', num: 3 },
          h('p.dlg-note', 'The address apps are told to use (in discovery replies and links), when the one the server sees isn’t right, as behind a proxy.'),
          row('One address for everyone', sameT),
          same ? row('Address', fo.text('_pub.all', { placeholder: 'https://jellyfin.example.org' }))
            : [row('On the LAN', fo.text('_pub.internal', { placeholder: 'http://192.168.0.10:8096' })),
              row('From outside', fo.text('_pub.external', { placeholder: 'https://jellyfin.example.org' }))])),
      h('div.eng-col',
        deck('Local network', { color: 'sky', num: 4 },
          row('LAN subnets', fo.tags('LocalNetworkSubnets', { placeholder: 'Add a subnet (192.168.1.0/24)' }), 'Who counts as local. Empty: the server’s own subnets'),
          row('Known proxies', fo.tags('KnownProxies', { placeholder: 'Add an address, subnet or host' }), 'Proxies whose X-Forwarded-For the server believes'),
          row('Auto-discovery', t('AutoDiscovery'), 'Answer apps looking for servers on the LAN (UDP 7359)')),
        deck('Remote access', { color: 'blue', num: 5 },
          row('Allow remote connections', t('EnableRemoteAccess'), 'Off: only the LAN may connect'),
          row('IP filter', fo.tags('RemoteIPFilter', { placeholder: 'Add an address or subnet' }), 'For remote connections'),
          row('The filter is a block list', t('IsRemoteIPFilterBlacklist'), 'Off: only these may connect remotely')))));
  }
  draw();
  return [body, fo.bar];
}

// ---- branding ---------------------------------------------------------------------------------------

async function branding(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Branding');
  const fo = editForm({ app, load: () => api.get('/System/Configuration/branding'), save: d => api.post('/System/Configuration/branding', d) });
  await fo.ready;
  const splash = h('div.eng-splash');
  const fileIn = h('input', { type: 'file', attrs: { accept: 'image/*', hidden: true } });
  const pub = await api.publicInfo().catch(() => ({}));
  const upload = async (data, type, what) => {
    try {
      await api.req('POST', '/Branding/Splashscreen', { raw: { data, type } });
      // The apps only show it while it's on.
      if (!fo.get('SplashscreenEnabled')) { fo.set('SplashscreenEnabled', true); fo.refresh(); await fo.save(); }
      toast('Splash screen set', what, 'sky', 2500);
      drawSplash();
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  };
  async function drawSplash() {
    // Jellyfin has no splash of its own: with none uploaded, its address is a 404.
    let have = false;
    // (Jellyfin doesn't answer HEAD here, so ask for a tiny copy.)
    try { have = (await fetch(api.url('/Branding/Splashscreen', { t: Date.now(), width: 8 }))).ok; } catch { /* offline */ }
    const { lcarsSplash, lcarsSplashData } = await import('./splash.js');
    const preview = have ? h('img', { src: api.url('/Branding/Splashscreen', { t: Date.now(), width: 640 }), alt: 'Splash screen' }) : (await lcarsSplash(pub.ServerName)).toDataURL('image/jpeg', 0.8);
    fill(splash,
      have ? preview : [h('p.dlg-note', 'None set: the apps start without one. The LCARS splash looks like this:'), h('img', { src: preview, alt: 'The LCARS splash screen' })],
      h('div.actions',
        btn('Use the LCARS splash', async () => upload(await lcarsSplashData(pub.ServerName), 'image/jpeg', 'LCARS'), { color: 'orange', small: true }),
        btn('Upload an image', () => fileIn.click(), { color: 'sky', small: true }),
        have ? btn('Remove', async () => {
          try { await api.del('/Branding/Splashscreen'); toast('Splash screen removed', '', 'sky', 2000); drawSplash(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
        }, { color: 'red', small: true, ghost: true }) : null));
  }
  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
    upload(data, file.type || 'image/jpeg', file.name);
  });
  drawSplash();
  return [h('div.eng-grid',
    h('div.eng-col', deck('Sign-in page', { color: 'orange', num: 1 },
      h('p.dlg-note', 'For the official apps’ sign-in screens. LCARS doesn’t show these yet.'),
      row('Disclaimer', fo.text('LoginDisclaimer', { area: true }), 'Shown under the sign-in form'),
      row('Custom CSS', fo.text('CustomCss', { area: true }), 'Added to the official web client'))),
    h('div.eng-col', deck('Splash screen', { color: 'sky', num: 2 },
      row('Show the splash screen', fo.toggle('SplashscreenEnabled'), 'While the TV and phone apps start'),
      splash, fileIn))), fo.bar];
}

// ---- devices ----------------------------------------------------------------------------------------

async function devices(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Devices');
  const body = h('div');
  async function load() {
    let list;
    try { list = (await api.get('/Devices', undefined, { signal })).Items || []; } catch (e) { fill(body, errorBox(e)); return; }
    list.sort((a, b) => Date.parse(b.DateLastActivity) - Date.parse(a.DateLastActivity));
    fill(body, list.length ? h('div.eng-devs', list.map(d => {
      const mine = d.Id === api.deviceId;
      return h('div.eng-dev',
        h('div.eng-dev-b',
          h('b', d.CustomName || d.Name, mine ? tag('This browser', 'sky') : null),
          h('span', [d.AppName, d.AppVersion].filter(Boolean).join(' ')),
          h('span.eng-ro', `${d.LastUserName || 'nobody'} · ${f.ago(d.DateLastActivity)}${d.CustomName ? ` · really “${d.Name}”` : ''}`)),
        h('div.eng-dev-a',
          btn('Rename', () => rename(d), { small: true, color: 'lilac', ghost: true }),
          mine ? null : btn('Delete', () => remove(d), { small: true, color: 'red', ghost: true })));
    })) : empty('No devices.'));
  }
  function rename(d) {
    const input = h('input.inp', { value: d.CustomName || '', attrs: { placeholder: d.Name, spellcheck: 'false' } });
    let dd = null;
    const go = async () => {
      try { await api.post('/Devices/Options', { CustomName: input.value.trim() }, { id: d.Id }); dd.close(); toast('Renamed', input.value.trim() || d.Name, 'sky', 2000); load(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
    };
    dd = dialog(`Rename ${d.CustomName || d.Name}`, h('form.dlg-form', { onsubmit: e => { e.preventDefault(); go(); } }, h('label.field', h('span', 'Name'), input), h('p.dlg-note', 'Empty: the name the app gives itself.')),
      [btn('Cancel', () => dd.close(), { color: 'lilac', ghost: true }), btn('Rename', go, { color: 'orange' })]);
    setTimeout(() => input.select(), 0);
  }
  async function remove(d) {
    if (!(await confirmDialog('Delete device', `Delete “${d.CustomName || d.Name}”? Its sign-in ends; ${d.LastUserName || 'its user'} signs in again on it next time.`, 'Delete'))) return;
    try { await api.del('/Devices', { id: d.Id }); toast('Device deleted', d.CustomName || d.Name, 'red', 2000); load(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  await load();
  return deck('Devices', { color: 'sky', num: 1 }, body);
}

// ---- API keys ---------------------------------------------------------------------------------------

async function keys(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('API keys');
  const body = h('div');
  async function load() {
    let list;
    try { list = (await api.get('/Auth/Keys', undefined, { signal })).Items || []; } catch (e) { fill(body, errorBox(e)); return; }
    fill(body, list.length ? h('div.eng-devs', list.map(k => {
      const shown = h('code.eng-key', '•'.repeat(12) + k.AccessToken.slice(-4));
      let open = false;
      return h('div.eng-dev',
        h('div.eng-dev-b', h('b', k.AppName || 'Unnamed'), shown, h('span.eng-ro', `Created ${new Date(k.DateCreated).toLocaleDateString()}${k.DateLastActivity ? ` · used ${f.ago(k.DateLastActivity)}` : ''}`)),
        h('div.eng-dev-a',
          btn('Show', e => { open = !open; shown.textContent = open ? k.AccessToken : '•'.repeat(12) + k.AccessToken.slice(-4); e.currentTarget.textContent = open ? 'Hide' : 'Show'; }, { small: true, color: 'lilac', ghost: true }),
          btn('Copy', async () => { try { await navigator.clipboard.writeText(k.AccessToken); toast('Key copied', k.AppName, 'sky', 2000); } catch { toast('Unable to copy', 'The browser blocked the clipboard', 'red'); } }, { small: true, color: 'sky', ghost: true }),
          btn('Revoke', async () => {
            if (!(await confirmDialog('Revoke key', `Revoke the key for “${k.AppName}”? Anything using it stops working straight away.`, 'Revoke'))) return;
            try { await api.del(`/Auth/Keys/${encodeURIComponent(k.AccessToken)}`); toast('Key revoked', k.AppName, 'red', 2000); load(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
          }, { small: true, color: 'red', ghost: true })));
    })) : empty('No API keys.'));
  }
  function create() {
    const input = h('input.inp', { attrs: { placeholder: 'What will use it (Sonarr, Home Assistant…)', spellcheck: 'false', required: true } });
    let d = null;
    const go = async () => {
      const app = input.value.trim();
      if (!app) { input.focus(); return; }
      try { await api.post('/Auth/Keys', undefined, { app }); d.close(); toast('Key created', app, 'sky', 2000); load(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
    };
    d = dialog('New API key', h('form.dlg-form', { onsubmit: e => { e.preventDefault(); go(); } }, h('label.field', h('span', 'Name'), input),
      h('p.dlg-note', 'A key gets full administrator access to the server. Give one to each thing that needs it, so you can revoke it on its own.')),
    [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Create', go, { color: 'orange' })]);
    setTimeout(() => input.focus(), 0);
  }
  await load();
  return deck('API keys', { color: 'peach', num: 1 }, h('div.actions', btn('New API key', create, { color: 'orange' })), body);
}

// ---- backups ----------------------------------------------------------------------------------------

async function backups(ctx) {
  const { api } = ctx;
  ctx.setTitle('Backups');
  const body = h('div');
  const opts = { Metadata: true, Trickplay: false, Subtitles: true };
  const tog = (label, key, note) => {
    const b = h('button.toggle', { type: 'button', class: opts[key] ? 'on' : '' }, opts[key] ? 'On' : 'Off');
    b.addEventListener('click', () => { opts[key] = !opts[key]; b.classList.toggle('on', opts[key]); b.textContent = opts[key] ? 'On' : 'Off'; });
    return row(label, b, note);
  };
  async function load() {
    let list;
    try { list = await api.get('/Backup'); } catch (e) { fill(body, errorBox(e)); return; }
    list.sort((a, b) => Date.parse(b.DateCreated) - Date.parse(a.DateCreated));
    fill(body, list.length ? h('div.eng-devs', list.map(b => h('div.eng-dev',
      h('div.eng-dev-b',
        h('b', new Date(b.DateCreated).toLocaleString()),
        h('span', `Jellyfin ${b.ServerVersion} · ${['Database', b.Options?.Metadata && 'metadata', b.Options?.Subtitles && 'subtitles', b.Options?.Trickplay && 'trickplay'].filter(Boolean).join(', ')}`),
        h('span.eng-ro', b.Path)),
      h('div.eng-dev-a', btn('Restore', () => restore(b), { small: true, color: 'red', ghost: true }))))) : empty('No backups yet.'));
  }
  async function create(button) {
    button.disabled = true;
    toast('Backing up', 'This can take a while on a big server', 'sky', 4000);
    try { await api.post('/Backup/Create', { ...opts, Database: true }); toast('Backup made', '', 'sky'); load(); } catch (e) { toast('Unable to comply', e.message, 'red'); } finally { button.disabled = false; }
  }
  async function restore(b) {
    const ok = await confirmDialog('Restore backup', `Restore the backup from ${new Date(b.DateCreated).toLocaleString()}? The server restarts and everything since then is lost: watch history, settings, users and library changes.`, 'Restore and restart');
    if (!ok) return;
    try { await api.post('/Backup/Restore', { ArchiveFileName: b.Path }); toast('Restoring', 'The server restarts; LCARS reconnects when it’s back', 'red', 10000); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  await load();
  const makeBtn = btn('Back up now', e => create(e.currentTarget), { color: 'orange' });
  return h('div.eng-grid',
    h('div.eng-col', deck('New backup', { color: 'orange', num: 1 },
      h('p.dlg-note', 'The database (users, watch history, settings) always goes in. Media files never do.'),
      tog('Metadata and images', 'Metadata'), tog('Subtitles', 'Subtitles', 'Downloaded ones in the metadata folder'), tog('Trickplay images', 'Trickplay', 'Can be big'),
      h('div.actions', makeBtn))),
    h('div.eng-col', deck('Backups', { color: 'salmon', num: 2 }, body)));
}
