// The jellyfin-web stand-in for plugin settings pages, inside plugin-host.html's sandbox.
//
// A plugin's settings page is HTML with inline scripts written against jellyfin-web's globals:
// ApiClient (getPluginConfiguration, updatePluginConfiguration, getUrl, ajax, fetch, getJSON...),
// Dashboard (showLoadingMsg, processPluginConfigurationUpdateResult, alert, confirm...), events
// on the page element (pageshow), and sometimes plain fetch() with the access token. This page
// has an opaque origin and no network access of its own: every API call goes to the dashboard
// (the parent window) by postMessage, which makes it with the admin's sign-in. The access token
// never comes in here; accessToken() returns a placeholder the parent ignores.
//
// Messages from the parent: {lcars: 'load', html, files: {name: text}}.
// To the parent: {lcars: 'api', id, method, path, headers, body}, {lcars: 'height', h},
// {lcars: 'toast', title, text, color}, {lcars: 'confirm', id, title, text},
// {lcars: 'navigate', to}, {lcars: 'ready'}.
(function () {
  'use strict';
  const BASE = 'http://lcars-plugin-host.invalid'; // what serverAddress() says; never fetched
  const parentWin = window.parent;
  const post = m => parentWin.postMessage({ ...m, lcars: m.lcars }, '*');
  let seq = 0;
  const waiting = new Map();
  const ask = msg => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    post({ ...msg, id });
  });

  // ---- fetch: the server's address goes to the parent; nothing else is allowed out ----------

  const toPath = url => {
    const s = String(url);
    if (s.startsWith(BASE)) return s.slice(BASE.length) || '/';
    if (s.startsWith('/')) return s;
    if (/^[A-Za-z]+\//.test(s) || /^[A-Za-z]+\?/.test(s)) return '/' + s; // "Plugins/…", relative to the server
    return null;
  };
  // Errors in the plugin's own code show up in the dashboard's console, since the sandbox's own
  // console is easy to miss.
  const reportError = (what, err) => post({ lcars: 'log', text: `${what}: ${err?.stack || err?.message || err}` });
  window.addEventListener('error', e => reportError('Error', e.error || e.message));
  window.addEventListener('unhandledrejection', e => reportError('Unhandled rejection', e.reason));
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url;
    const path = toPath(url);
    if (path == null) return realFetch(input, init); // blocked by connect-src anyway
    const headers = {};
    const h = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
    for (const k of ['content-type', 'accept']) if (h.get(k)) headers[k] = h.get(k);
    let body = init.body;
    if (body != null && typeof body !== 'string') {
      if (body instanceof URLSearchParams) { body = body.toString(); headers['content-type'] ||= 'application/x-www-form-urlencoded'; } else body = JSON.stringify(body);
    }
    const r = await ask({ lcars: 'api', method: (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase(), path, headers, body });
    const status = r.status >= 200 && r.status <= 599 ? r.status : 502; // 0 = the parent couldn't reach the server
    return new Response([204, 205, 304].includes(status) ? null : r.body, { status, headers: { 'content-type': r.type || 'text/plain' } });
  };

  // ---- ApiClient ---------------------------------------------------------------------------------

  const qs = params => {
    if (!params) return '';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  };
  async function request(opts, json) {
    const r = await window.fetch(opts.url, { method: opts.type || opts.method || 'GET', body: opts.data, headers: opts.contentType ? { 'content-type': opts.contentType } : opts.headers });
    if (!r.ok) throw r; // like jellyfin-web's ApiClient: pages call error.text() / error.status
    if (json || opts.dataType === 'json') return r.status === 204 ? null : r.json();
    return r;
  }
  let me = null;
  const ApiClient = {
    serverAddress: () => BASE,
    serverId: () => 'lcars',
    deviceId: () => 'lcars-plugin-host',
    accessToken: () => 'lcars-plugin-host', // the parent signs requests itself
    getUrl: (name, params) => `${BASE}/${String(name).replace(/^\/+/, '')}${qs(params)}`,
    ajax: opts => request(opts),
    fetch: opts => request(opts),
    getJSON: url => request({ url, type: 'GET' }, true),
    getPluginConfiguration: id => request({ url: ApiClient.getUrl(`Plugins/${id}/Configuration`) }, true),
    updatePluginConfiguration: (id, config) => request({ url: ApiClient.getUrl(`Plugins/${id}/Configuration`), type: 'POST', data: JSON.stringify(config), contentType: 'application/json' })
      .then(() => ({ IsSuccessful: true })),
    getVirtualFolders: () => request({ url: ApiClient.getUrl('Library/VirtualFolders') }, true),
    getServerConfiguration: () => request({ url: ApiClient.getUrl('System/Configuration') }, true),
    updateServerConfiguration: c => request({ url: ApiClient.getUrl('System/Configuration'), type: 'POST', data: JSON.stringify(c), contentType: 'application/json' }),
    getNamedConfiguration: n => request({ url: ApiClient.getUrl(`System/Configuration/${n}`) }, true),
    updateNamedConfiguration: (n, c) => request({ url: ApiClient.getUrl(`System/Configuration/${n}`), type: 'POST', data: JSON.stringify(c), contentType: 'application/json' }),
    getSystemInfo: () => request({ url: ApiClient.getUrl('System/Info') }, true),
    getPublicSystemInfo: () => request({ url: ApiClient.getUrl('System/Info/Public') }, true),
    getPlugins: () => request({ url: ApiClient.getUrl('Plugins') }, true),
    getScheduledTasks: q => request({ url: ApiClient.getUrl('ScheduledTasks', q) }, true),
    getUsers: q => request({ url: ApiClient.getUrl('Users', q) }, true),
    getUser: id => request({ url: ApiClient.getUrl(`Users/${id}`) }, true),
    getCurrentUser: async () => (me ||= await request({ url: ApiClient.getUrl('Users/Me') }, true)),
    getCurrentUserId: () => me?.Id || null,
    getItems: (userId, q) => request({ url: ApiClient.getUrl('Items', { ...q, userId }) }, true),
    getItem: (userId, id) => request({ url: ApiClient.getUrl(`Items/${id}`, { userId }) }, true),
    getCultures: () => request({ url: ApiClient.getUrl('Localization/Cultures') }, true),
    getCountries: () => request({ url: ApiClient.getUrl('Localization/Countries') }, true),
    getParentalRatings: () => request({ url: ApiClient.getUrl('Localization/ParentalRatings') }, true),
  };
  window.ApiClient = ApiClient;
  window.ServerConnections = { currentApiClient: () => ApiClient, getApiClient: () => ApiClient };

  // ---- Dashboard, loading, toast, require --------------------------------------------------------

  const overlay = () => document.getElementById('lcars-plugin-busy') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'lcars-plugin-busy', className: 'lcars-busy', textContent: 'Working…' }));
  const loading = { show: () => { overlay().hidden = false; }, hide: () => { overlay().hidden = true; } };
  const say = (text, title = '', color = 'blue') => post({ lcars: 'toast', title: title || String(text), text: title ? String(text) : '', color });
  window.Dashboard = {
    showLoadingMsg: loading.show,
    hideLoadingMsg: loading.hide,
    processPluginConfigurationUpdateResult: () => { loading.hide(); say('Settings saved', '', 'sky'); },
    processServerConfigurationUpdateResult: () => { loading.hide(); say('Settings saved', '', 'sky'); },
    alert: a => { loading.hide(); if (typeof a === 'string') say(a); else say(a?.message || '', a?.title || '', 'blue'); return Promise.resolve(); },
    confirm: (text, title, cb) => {
      const p = ask({ lcars: 'confirm', title: title || 'Confirm', text: String(text) }).then(r => !!r.ok);
      if (typeof cb === 'function') p.then(cb);
      return p;
    },
    navigate: to => post({ lcars: 'navigate', to: String(to) }),
    getCurrentUserId: () => ApiClient.getCurrentUserId(),
  };
  window.loading = loading;
  window.toast = t => say(typeof t === 'string' ? t : t?.text || '');
  // A plugin with several pages (Playback Reporting) puts tabs across the top, as jellyfin-web
  // does; the links go through the parent like any other.
  window.LibraryMenu = {
    setTitle: () => {},
    setTabs: (key, index, getTabs) => {
      const tabs = typeof getTabs === 'function' ? getTabs() : [];
      const root = document.getElementById('lcars-plugin');
      if (!root || !Array.isArray(tabs) || !tabs.length) return;
      let bar = document.getElementById('lcars-plugin-tabs');
      if (!bar) { bar = document.createElement('nav'); bar.id = 'lcars-plugin-tabs'; bar.className = 'lcars-tabs'; root.before(bar); }
      bar.replaceChildren(...tabs.map((t, i) => {
        const a = document.createElement('a');
        a.href = t.href || '#';
        a.textContent = t.name || '';
        if (i === index) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
        return a;
      }));
    },
  };
  window.require = (deps, cb) => {
    const mods = (Array.isArray(deps) ? deps : [deps]).map(d => ({ loading, toast: window.toast, confirm: window.Dashboard.confirm, globalize: { translate: k => k } }[String(d).split('/').pop()] || {}));
    if (typeof cb === 'function') setTimeout(() => cb(...mods), 0);
    return Promise.resolve(mods);
  };
  window.Emby = { Page: {} };
  // In jellyfin-web, plugin pages share one window, so one page's helpers leak to the next:
  // Playback Reporting's Breakdown tab uses a Date helper its Playback tab defines. Each page
  // here starts afresh, so supply it.
  if (!Date.prototype.toDateInputValue) {
    Object.defineProperty(Date.prototype, 'toDateInputValue', { configurable: true, writable: true, value() {
      const d = new Date(this); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toJSON().slice(0, 10);
    } });
  }
  window.globalize = { translate: k => k };
  // A plugin may call alert() or confirm() itself: route them to LCARS's dialogs.
  window.alert = m => say(m);

  // ---- links: dashboard routes go to LCARS's own pages -------------------------------------------

  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
    if (href.startsWith('#') || /configurationpage\?name=/i.test(href)) { e.preventDefault(); post({ lcars: 'navigate', to: href }); }
  }, true);

  // ---- modules: a page's controller, and what it import()s from the server --------------------------
  // jellyfin-web loads data-controller="__plugin/x.js" as a module and calls its default export
  // with the page. Modules come from the server through the parent like everything else, then
  // run from blob: URLs; their import() calls of server URLs go the same way.

  async function moduleUrl(path) {
    const r = await window.fetch(BASE + path);
    if (!r.ok) throw new Error(`Couldn't load ${path} (HTTP ${r.status})`);
    const code = (await r.text()).replace(/\bimport\s*\(/g, 'window.__lcarsImport(');
    return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  const pagePath = name => `/web/ConfigurationPage?name=${encodeURIComponent(name)}`;
  window.__lcarsImport = async spec => {
    const s = String(spec);
    const plugin = s.match(/^__plugin\/(.+)$/);
    const path = plugin ? pagePath(plugin[1]) : toPath(s);
    const mod = await import(path == null ? s : await moduleUrl(path));
    chartStyle();
    return mod;
  };
  // Charts (Chart.js, which Playback Reporting brings) in LCARS's type and colours.
  function chartStyle() {
    const C = window.Chart;
    if (!C?.defaults || C.__lcars) return;
    C.__lcars = true;
    const font = '"Antonio", "Arial Narrow", sans-serif', text = '#d9a473', grid = '#2a2838';
    if (C.defaults.global) { // Chart.js 2
      Object.assign(C.defaults.global, { defaultFontFamily: font, defaultFontColor: text, defaultFontSize: 14 });
      if (C.defaults.scale?.gridLines) Object.assign(C.defaults.scale.gridLines, { color: grid, zeroLineColor: '#5a5470' });
    } else { // Chart.js 3+
      C.defaults.color = text;
      C.defaults.borderColor = grid;
      C.defaults.font = { ...C.defaults.font, family: font, size: 14 };
    }
  }
  async function controllers(root) {
    for (const page of root.querySelectorAll('[data-controller]')) {
      try {
        const mod = await window.__lcarsImport(page.getAttribute('data-controller'));
        if (typeof mod.default === 'function') mod.default(page, {});
      } catch (err) { reportError('Controller', err); }
    }
  }

  // ---- loading a page ----------------------------------------------------------------------------

  function runScripts(root, files) {
    for (const old of [...root.querySelectorAll('script')]) {
      const s = document.createElement('script');
      const src = old.getAttribute('src');
      const name = src && (src.match(/configurationpage\?name=([^&]+)/i) || [])[1];
      if (src && !name) { old.remove(); continue; } // outside scripts can't load here anyway
      s.textContent = name ? files[decodeURIComponent(name)] || '' : old.textContent;
      if (old.type && old.type !== 'text/javascript' && old.type !== 'module') s.type = old.type;
      old.replaceWith(s);
    }
  }
  // jellyfin-web's emby-input and emby-select show their label="…" attribute as a label above
  // the box; emby-textarea too. Do the same, linked to the box.
  function labels(root) {
    for (const el of root.querySelectorAll('input[label], select[label], textarea[label]')) {
      if (el.previousElementSibling?.classList.contains('lcars-label')) continue;
      if (!el.id) el.id = `lcars-f${++seq}`;
      const l = document.createElement('label');
      l.className = 'inputLabel lcars-label';
      l.htmlFor = el.id;
      l.textContent = el.getAttribute('label');
      el.before(l);
    }
  }
  // Pages sometimes add boxes later (a list row, a dialog): label those too.
  new MutationObserver(() => { const r = document.getElementById('lcars-plugin'); if (r) labels(r); }).observe(document.documentElement, { childList: true, subtree: true });

  async function load(html, files) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Stylesheets that are other configuration pages come inline.
    for (const l of doc.querySelectorAll('link[rel=stylesheet][href]')) {
      const name = (l.getAttribute('href').match(/configurationpage\?name=([^&]+)/i) || [])[1];
      if (name) { const st = doc.createElement('style'); st.textContent = files[decodeURIComponent(name)] || ''; l.replaceWith(st); } else l.remove();
    }
    for (const st of doc.head.querySelectorAll('style')) document.head.appendChild(st);
    document.getElementById('lcars-plugin-loading')?.remove();
    const holder = document.createElement('div');
    holder.id = 'lcars-plugin';
    holder.innerHTML = doc.body.innerHTML;
    document.body.appendChild(holder);
    labels(holder);
    runScripts(holder, files);
    await controllers(holder);
    // Show the page as jellyfin-web's view manager does.
    for (const page of holder.querySelectorAll('[data-role=page]')) {
      page.classList.remove('hide');
      for (const type of ['viewinit', 'viewbeforeshow', 'pagebeforeshow', 'viewshow', 'pageshow']) {
        page.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { params: {}, isRestored: false } }));
      }
    }
  }

  window.addEventListener('message', e => {
    if (e.source !== parentWin) return;
    const m = e.data || {};
    if (m.lcars === 'load') { ApiClient.getCurrentUser().catch(() => {}); load(m.html, m.files || {}); }
    else if (m.lcars === 'reply') {
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w.resolve(m); }
    }
  });

  // Tell the parent how tall the page is, so the frame fits it.
  let last = 0;
  const report = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - last) > 2) { last = h; post({ lcars: 'height', h }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  window.addEventListener('load', () => { report(); post({ lcars: 'ready' }); });
})();
