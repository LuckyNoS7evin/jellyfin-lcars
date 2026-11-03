// Plugins (admin stage A7; official routes/plugins): installed plugins, the catalogue from the
// repositories, the repositories themselves, and each plugin's own settings page, hosted in a
// sandbox (plugin-host.html + js/plugin-shim.js) so the pages written for jellyfin-web run as
// they are, without the plugin's code ever seeing LCARS's storage or the access token.
import { h, fill } from '../h.js';
import { deck, btn, tag, empty, toast, errorBox } from '../ui.js';
import { confirmDialog, dialog } from '../menu.js';
import { row } from './form.js';

const STATUS = { Active: ['Active', 'sky'], Restart: ['Restart to finish', 'peach'], Deleted: ['Removed at restart', 'red'], Superceded: ['Replaced', 'dim'],
  Malfunctioned: ['Failed to load', 'red'], NotSupported: ['Not supported by this server', 'red'], Disabled: ['Disabled', 'lilac'] };
// Package JSON uses lower-case names (with "guid" for the id); be kind to either.
const pk = p => ({ name: p.name ?? p.Name, guid: p.guid ?? p.Id, description: p.description ?? p.Description, overview: p.overview ?? p.Overview,
  owner: p.owner ?? p.Owner, category: p.category ?? p.Category, imageUrl: p.imageUrl ?? p.ImageUrl, versions: (p.versions ?? p.Versions ?? []).map(v => ({
    version: v.version ?? v.Version, changelog: v.changelog ?? v.Changelog, targetAbi: v.targetAbi ?? v.TargetAbi, repositoryName: v.repositoryName ?? v.RepositoryName,
    repositoryUrl: v.repositoryUrl ?? v.RepositoryUrl, timestamp: v.timestamp ?? v.Timestamp })) });
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

export async function plugins(ctx) {
  const [tab = 'installed', name] = ctx.sub;
  ctx.setParent(tab === 'settings' ? '#/admin/plugins' : '#/admin/overview');
  if (tab === 'settings') return settingsPage(ctx, decodeURIComponent(name || ''));
  const page = { installed, catalogue, repositories }[tab] || installed;
  return h('div.eng-edit', subTabs(tab), await page(ctx));
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['installed', 'Installed'], ['catalogue', 'Catalogue'], ['repositories', 'Repositories']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/plugins/${k}`, class: k === cur ? 'on' : '' }, l)));

// ---- installed --------------------------------------------------------------------------------------

async function installed(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Plugins');
  const body = h('div');
  async function load() {
    let list, pages, packages;
    try {
      [list, pages, packages] = await Promise.all([
        api.get('/Plugins', undefined, { signal }),
        api.get('/web/ConfigurationPages', undefined, { signal }).catch(() => []),
        api.get('/Packages', undefined, { signal }).then(r => r.map(pk)).catch(() => []),
      ]);
    } catch (e) { fill(body, errorBox(e)); return; }
    list.sort((a, b) => a.Name.localeCompare(b.Name));
    fill(body, list.length ? h('div.eng-plugins', list.map(p => {
      const page = pages.find(x => x.PluginId === p.Id && !/\.(js|css)$/i.test(x.Name)) || null;
      const pkg = packages.find(x => x.guid === p.Id);
      const latest = pkg?.versions?.[0];
      const update = latest && newer(latest.version, p.Version) ? latest : null;
      const [st, color] = STATUS[p.Status] || [p.Status, 'lilac'];
      return h('div.eng-plugin', { class: p.Status === 'Active' ? '' : 'off' },
        h('div.eng-plugin-img', p.HasImage ? h('img', { src: api.url(`/Plugins/${p.Id}/${p.Version}/Image`), alt: '', attrs: { loading: 'lazy' } }) : h('div.noimg', p.Name[0])),
        h('div.eng-plugin-b',
          h('b', p.Name),
          h('div.eng-sess-m', tag(`v${p.Version}`, 'blue'), tag(st, color), update ? tag(`v${update.version} available`, 'orange') : null),
          p.Description ? h('span.eng-ro', p.Description) : null),
        h('div.eng-plugin-a',
          page && p.Status === 'Active' ? btn('Settings', () => { location.hash = `#/admin/plugins/settings/${encodeURIComponent(page.Name)}`; }, { small: true, color: 'orange' }) : null,
          update && pending.get(p.Id) === update.version ? tag('Updates on restart', 'orange')
            : update ? btn('Update', () => install(api, pkg, update, load), { small: true, color: 'sky' }) : null,
          p.Status === 'Active' ? btn('Disable', () => act(api, `/Plugins/${p.Id}/${p.Version}/Disable`, 'POST', `${p.Name} disabled`, load), { small: true, color: 'lilac', ghost: true })
            : p.Status === 'Disabled' ? btn('Enable', () => act(api, `/Plugins/${p.Id}/${p.Version}/Enable`, 'POST', `${p.Name} enabled`, load), { small: true, color: 'sky', ghost: true }) : null,
          p.CanUninstall ? btn('Uninstall', async () => {
            if (!(await confirmDialog('Uninstall plugin', `Uninstall ${p.Name}? It goes when the server restarts; its settings stay on the disk.`, 'Uninstall'))) return;
            act(api, `/Plugins/${p.Id}/${p.Version}`, 'DELETE', `${p.Name} will be removed at the next restart`, load);
          }, { small: true, color: 'red', ghost: true }) : null));
    })) : empty('No plugins installed.'));
  }
  await load();
  return deck('Installed plugins', { color: 'orange', num: 1 },
    h('p.dlg-note', 'Installing, updating, enabling and removing plugins take effect when the server restarts.'), body);
}

async function act(api, path, method, done, reload) {
  try { await api.req(method, path); toast('Done', done, 'sky', 3000); reload(); } catch (e) { toast('Unable to comply', e.message, 'red'); }
}

// Installs land in /Plugins only after a restart; until then the catalogue shows them from here.
const pending = new Map(); // package guid -> version

async function install(api, p, v, reload) {
  try {
    await api.post(`/Packages/Installed/${encodeURIComponent(p.name)}`, undefined, { assemblyGuid: p.guid, version: v.version, repositoryUrl: v.repositoryUrl });
    pending.set(p.guid, v.version);
    toast('Installing', `${p.name} ${v.version}: restart the server to finish`, 'sky', 5000);
    reload?.();
  } catch (e) { toast('Unable to comply', e.message, 'red'); }
}

// ---- catalogue --------------------------------------------------------------------------------------

async function catalogue(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Plugin catalogue');
  const [pkgs, inst] = await Promise.all([api.get('/Packages', undefined, { signal }).then(r => r.map(pk)), api.get('/Plugins', undefined, { signal }).catch(() => [])]);
  const body = h('div');
  const search = h('input.inp', { attrs: { placeholder: 'Search the catalogue', spellcheck: 'false', type: 'search' } });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = pkgs.filter(p => !q || `${p.name} ${p.description} ${p.overview} ${p.owner}`.toLowerCase().includes(q));
    const cats = [...new Set(shown.map(p => p.category || 'Other'))].sort();
    fill(body, shown.length ? h('div.eng-stack', cats.map((c, i) => deck(c, { color: ['orange', 'sky', 'lilac', 'peach', 'blue', 'salmon'][i % 6], num: i + 1 },
      h('div.eng-plugins', shown.filter(p => (p.category || 'Other') === c).sort((a, b) => a.name.localeCompare(b.name)).map(p => {
        const have = inst.find(x => x.Id === p.guid);
        const latest = p.versions[0];
        const wait = pending.get(p.guid);
        return h('div.eng-plugin',
          h('div.eng-plugin-img', p.imageUrl ? h('img', { src: p.imageUrl, alt: '', attrs: { loading: 'lazy', referrerpolicy: 'no-referrer' } }) : h('div.noimg', p.name[0])),
          h('div.eng-plugin-b',
            h('b', p.name),
            h('div.eng-sess-m', latest ? tag(`v${latest.version}`, 'blue') : null, p.owner ? tag(p.owner, 'lilac') : null, have ? tag(`installed v${have.Version}`, 'sky') : null, wait && wait !== have?.Version ? tag(`v${wait} on restart`, 'orange') : null,
              latest?.repositoryName ? h('span.eng-ro', latest.repositoryName) : null),
            h('span.eng-ro', p.description || p.overview || '')),
          h('div.eng-plugin-a', latest ? btn(have ? 'Versions' : 'Install', () => versions(api, p, have, draw), { small: true, color: have ? 'lilac' : 'orange', ghost: !!have }) : null));
      }))))) : empty('Nothing matches.'));
  };
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 200); });
  draw();
  return [h('div.rc-opts.eng-filters', h('label.rc-sel.grow', h('span', 'Search'), search), h('span.eng-ro', `${pkgs.length} plugins`)), body];
}

function versions(api, p, have, redraw) {
  let d = null;
  d = dialog(p.name, [
    p.overview ? h('p.dlg-text', p.overview) : null,
    h('div.eng-versions', p.versions.slice(0, 12).map(v => h('div.eng-version',
      h('div', h('b', `v${v.version}`), h('span.eng-ro', [v.timestamp ? new Date(v.timestamp).toLocaleDateString() : '', v.targetAbi ? `for Jellyfin ${v.targetAbi}` : ''].filter(Boolean).join(' · ')),
        v.changelog ? h('p.eng-ro', v.changelog.slice(0, 300)) : null),
      have?.Version === v.version ? tag('Installed', 'sky') : pending.get(p.guid) === v.version ? tag('On restart', 'orange') : btn('Install', () => { d.close(); install(api, p, v, redraw); }, { small: true, color: 'orange' })))),
  ], [btn('Close', () => d.close(), { color: 'lilac', ghost: true })], { color: 'orange', wide: true });
}

// ---- repositories -----------------------------------------------------------------------------------

async function repositories(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Plugin repositories');
  let list = await api.get('/Repositories', undefined, { signal });
  const body = h('div');
  const save = async next => {
    try { await api.post('/Repositories', next); list = next; draw(); toast('Repositories saved', '', 'sky', 1800); } catch (e) { toast('Unable to comply', e.message, 'red'); }
  };
  function draw() {
    fill(body, list.length ? h('div.eng-devs', list.map((r, i) => h('div.eng-dev',
      h('div.eng-dev-b', h('b', r.Name || 'Unnamed', r.Enabled === false ? tag('Off', 'lilac') : null), h('span.eng-ro', r.Url)),
      h('div.eng-dev-a',
        btn(r.Enabled === false ? 'Turn on' : 'Turn off', () => save(list.map((x, j) => (j === i ? { ...x, Enabled: x.Enabled === false } : x))), { small: true, color: 'lilac', ghost: true }),
        btn('Remove', async () => {
          if (!(await confirmDialog('Remove repository', `Stop getting plugins from ${r.Name || r.Url}? Installed plugins stay.`, 'Remove'))) return;
          save(list.filter((_, j) => j !== i));
        }, { small: true, color: 'red', ghost: true }))))) : empty('No repositories: the catalogue is empty.'));
  }
  function add() {
    const name = h('input.inp', { attrs: { placeholder: 'Name', spellcheck: 'false' } });
    const url = h('input.inp', { attrs: { placeholder: 'https://…/manifest.json', spellcheck: 'false', type: 'url' } });
    let d = null;
    const go = () => {
      if (!/^https?:\/\//i.test(url.value.trim())) { url.focus(); toast('Address needed', 'The repository’s manifest URL', 'red'); return; }
      d.close();
      save([...list, { Name: name.value.trim() || url.value.trim(), Url: url.value.trim(), Enabled: true }]);
    };
    d = dialog('Add a repository', h('form.dlg-form', { onsubmit: e => { e.preventDefault(); go(); } }, row('Name', name), row('Manifest URL', url),
      h('p.dlg-note', 'Plugins from other repositories aren’t checked by the Jellyfin project. Only add ones you trust.')),
    [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Add', go, { color: 'orange' })], { color: 'blue' });
  }
  draw();
  return deck('Repositories', { color: 'blue', num: 1 }, h('div.actions', btn('Add a repository', add, { color: 'orange' })), body);
}

// ---- a plugin's own settings page --------------------------------------------------------------------

async function settingsPage(ctx, name) {
  const { api, app, signal } = ctx;
  ctx.setTitle(name);
  const pages = await api.get('/web/ConfigurationPages', undefined, { signal });
  const page = pages.find(p => p.Name === name);
  if (!page) return deck(name, { color: 'orange' }, empty('This plugin has no settings page.'));
  const plugin = (await api.get('/Plugins', undefined, { signal }).catch(() => [])).find(p => p.Id === page.PluginId);
  ctx.setTitle(plugin?.Name || page.DisplayName || name);

  // The page, and any configuration pages it pulls in (Intro Skipper keeps its script and styles
  // in their own pages).
  const getPage = n => api.text('/web/ConfigurationPage', { name: n }, { signal });
  let html;
  try { html = await getPage(name); } catch (e) { return deck(name, { color: 'orange' }, errorBox(e)); }
  const files = {};
  for (const m of html.matchAll(/configurationpage\?name=([^"'&\s>]+)/gi)) {
    const n = decodeURIComponent(m[1]);
    if (!(n in files)) files[n] = await getPage(n).catch(() => '');
  }

  const frame = h('iframe.eng-plugin-frame', {
    src: `/static/${app.version}/plugin-host.html`,
    title: `${plugin?.Name || name} settings`,
    attrs: { sandbox: 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals', referrerpolicy: 'no-referrer' },
  });
  const status = h('p.loading', 'Loading the plugin’s page…');

  // Requests from the page: API calls (made here, with the admin's sign-in), toasts, questions,
  // links to other dashboard pages, and its height.
  const route = to => {
    const n = (to.match(/configurationpage\?name=([^&]+)/i) || [])[1];
    if (n) return `#/admin/plugins/settings/${n}`;
    const map = { tasks: '#/admin/ops/tasks', scheduledtasks: '#/admin/ops/tasks', libraries: '#/admin/libraries', library: '#/admin/libraries', users: '#/admin/users',
      plugins: '#/admin/plugins', activity: '#/admin/ops/activity', logs: '#/admin/ops/logs', playback: '#/admin/playback', networking: '#/admin/server/networking', settings: '#/admin/server/general' };
    const key = (to.match(/#\/dashboard\/([a-z]+)/i) || to.match(/#\/([a-z]+)/i) || [])[1]?.toLowerCase();
    return map[key] || null;
  };
  async function onMessage(e) {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    const reply = (id, data) => frame.contentWindow.postMessage({ lcars: 'reply', id, ...data }, '*');
    if (m.lcars === 'ready') {
      status.remove();
      frame.contentWindow.postMessage({ lcars: 'load', html, files }, '*');
    } else if (m.lcars === 'height') {
      frame.style.height = `${Math.min(Math.max(200, m.h + 8), 20000)}px`;
    } else if (m.lcars === 'api') {
      // Only paths on this server's API; the method from a short list.
      const method = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'].includes(m.method) ? m.method : 'GET';
      const path = String(m.path || '/');
      if (!path.startsWith('/') || path.startsWith('//')) { reply(m.id, { status: 400, body: 'Bad path', type: 'text/plain' }); return; }
      try {
        const headers = { Authorization: api.authHeader() };
        if (m.headers?.['content-type']) headers['Content-Type'] = m.headers['content-type'];
        else if (m.body != null) headers['Content-Type'] = 'application/json';
        if (m.headers?.accept) headers.Accept = m.headers.accept;
        const r = await fetch(api.base + path, { method, headers, body: method === 'GET' ? undefined : m.body ?? undefined, signal });
        reply(m.id, { status: r.status, type: r.headers.get('Content-Type') || '', body: await r.text() });
      } catch (err) { if (!signal.aborted) reply(m.id, { status: 0, body: String(err.message || err), type: 'text/plain' }); }
    } else if (m.lcars === 'log') {
      console.warn(`[plugin ${name}]`, String(m.text || '').slice(0, 2000));
    } else if (m.lcars === 'toast') {
      toast(m.title || 'Plugin', m.text || '', m.color || 'blue', 4000);
    } else if (m.lcars === 'confirm') {
      const ok = await confirmDialog(m.title || 'Confirm', m.text || '', 'OK', 'orange');
      reply(m.id, { ok });
    } else if (m.lcars === 'navigate') {
      const to = route(String(m.to || ''));
      if (to) location.hash = to; else toast('Not in LCARS', m.to, 'lilac', 3000);
    }
  }
  window.addEventListener('message', onMessage);
  signal.addEventListener('abort', () => window.removeEventListener('message', onMessage));

  return h('div.eng-edit',
    h('div.eng-edit-head', h('div', h('b.eng-edit-t', plugin?.Name || page.DisplayName || name),
      h('span', [plugin ? `v${plugin.Version}` : '', 'the plugin’s own page'].filter(Boolean).join(' · '))),
    h('div.tabs', btn('All plugins', () => { location.hash = '#/admin/plugins'; }, { small: true, color: 'lilac', ghost: true }))),
    // A plugin with several pages (reports, say) names each; its main page is its settings.
    deck(name === plugin?.Name || !plugin ? 'Settings' : (page.DisplayName && page.DisplayName !== name ? page.DisplayName : name.replace(/_/g, ' ')), { color: 'orange', num: 1 }, status, frame));
}

