// Jellyfin API client. The web build talks to /jf (the Go server proxies it to Jellyfin); the
// desktop build sets a full server URL. Each browser logs in as its own user and keeps its
// own access token.

export const CLIENT = 'LCARS';
export const VERSION = '0.1.0';
export const TICKS = 1e7; // Jellyfin ticks per second

const SESSION_KEY = 'jfl.session';
const DEVICE_KEY = 'jfl.device';

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* blocked */ } },
  json(k) { try { return JSON.parse(this.get(k)); } catch { return null; } },
};

/**
 * A random 32-hex-digit id (device and play-session ids). crypto.randomUUID only exists on
 * HTTPS pages and localhost; getRandomValues works on plain http://<lan-ip> too.
 */
export function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function deviceId() {
  let id = store.get(DEVICE_KEY);
  if (!id) {
    id = randomId();
    store.set(DEVICE_KEY, id);
  }
  return id;
}

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return window.__TAURI__ ? `LCARS Desktop ${os}`.trim() : `${browser} ${os}`.trim();
}

export class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const q = query => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
};

export class Api {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.deviceId = deviceId();
    this.device = deviceName();
    this.session = store.json(SESSION_KEY); // {token, userId, userName, serverId, serverName}
    this.onUnauthorized = () => {};
  }

  get authed() { return !!this.session?.token; }
  get userId() { return this.session?.userId; }
  get token() { return this.session?.token; }

  authHeader() {
    const esc = s => encodeURIComponent(s);
    let v = `MediaBrowser Client="${CLIENT}", Device="${esc(this.device)}", DeviceId="${this.deviceId}", Version="${VERSION}"`;
    if (this.token) v += `, Token="${this.token}"`;
    return v;
  }

  /** raw: {data, type} sends data as is with that Content-Type (an image upload) instead of JSON. */
  async req(method, path, { query, body, signal, keepalive, raw } = {}) {
    const headers = { Authorization: this.authHeader(), Accept: 'application/json' };
    if (raw) headers['Content-Type'] = raw.type;
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.base + path + q(query), {
        method, headers, signal, keepalive,
        body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError(0, 'Server unreachable');
    }
    if (res.status === 401 && this.authed) {
      this.clear();
      this.onUnauthorized();
    }
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      try {
        let t = await res.text();
        // Jellyfin often sends the reason as a JSON string ("..." with the quotes), and ASP.NET
        // validation failures as a problem document: show "Field: what's wrong" instead.
        if (/^".*"$/s.test(t)) { try { t = JSON.parse(t); } catch { /* keep it as is */ } }
        else if (/^\{.*"title"/s.test(t)) {
          try {
            const p = JSON.parse(t);
            const errs = Object.entries(p.errors || {}).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`);
            t = errs.length ? errs.join('; ') : p.detail || p.title || t;
          } catch { /* keep it as is */ }
        }
        if (t && t.length < 300) msg = t;
      } catch { /* ignore */ }
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return null;
    const type = res.headers.get('Content-Type') || '';
    return type.includes('json') ? res.json() : null;
  }

  get(path, query, opts) { return this.req('GET', path, { ...opts, query }); }
  /** A plain-text response (log files). */
  async text(path, query, { signal } = {}) {
    let res;
    try { res = await fetch(this.base + path + q(query), { headers: { Authorization: this.authHeader() }, signal }); } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError(0, 'Server unreachable');
    }
    if (!res.ok) throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`);
    return res.text();
  }
  post(path, body, query, opts) { return this.req('POST', path, { ...opts, body, query }); }
  del(path, query, opts) { return this.req('DELETE', path, { ...opts, query }); }

  /** An absolute URL; auth adds the token as ApiKey (Jellyfin 12 dropped api_key) for <video>/<audio>/<track> sources. */
  url(path, query = {}, { auth = false } = {}) {
    const full = this.base + path + q(auth ? { ...query, ApiKey: this.token } : query);
    return new URL(full, location.href).href;
  }

  /** Image URL. Item images don't need auth. */
  img(id, type = 'Primary', { tag, h, w, index, quality = 90 } = {}) {
    if (!id) return null;
    const idx = index != null ? `/${index}` : '';
    return this.url(`/Items/${id}/Images/${type}${idx}`, { fillHeight: h, fillWidth: w, quality, tag });
  }

  // ---- session --------------------------------------------------------------------------

  login(username, password) {
    return this.post('/Users/AuthenticateByName', { Username: username, Pw: password }).then(r => this.signedIn(r));
  }

  // Quick Connect (official login controller): this device asks for a code, someone signed in
  // elsewhere authorises it, and the secret then buys a token.
  quickConnectEnabled() { return this.get('/QuickConnect/Enabled'); }
  quickConnectStart() { return this.post('/QuickConnect/Initiate'); }
  quickConnectState(secret, signal) { return this.get('/QuickConnect/Connect', { secret }, { signal }); }
  quickConnectLogin(secret) {
    return this.post('/Users/AuthenticateWithQuickConnect', { Secret: secret }).then(r => this.signedIn(r));
  }
  /** Authorise another device's code for this user (an admin may pick any user). */
  quickConnectAuthorize(code, userId) { return this.post('/QuickConnect/Authorize', undefined, { code, userId }); }

  /** Keep the session from an AuthenticationResult. */
  async signedIn(r) {
    let serverName = '';
    try { serverName = (await this.publicInfo()).ServerName; } catch { /* optional */ }
    this.session = { token: r.AccessToken, userId: r.User.Id, userName: r.User.Name, serverId: r.ServerId, serverName };
    store.set(SESSION_KEY, JSON.stringify(this.session));
    return r;
  }

  async logout() {
    try { await this.post('/Sessions/Logout'); } catch { /* token may already be gone */ }
    this.clear();
  }

  clear() {
    this.session = null;
    store.set(SESSION_KEY, null);
  }

  publicInfo() { return this.get('/System/Info/Public'); }
  publicUsers() { return this.get('/Users/Public'); }

  // ---- common queries ---------------------------------------------------------------------

  /** Fields most views need on list items. */
  static FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview,ChildCount,RecursiveItemCount,UserData,CanDelete,CanDownload,MediaSourceCount';

  me() { return this.get('/Users/Me'); }
  views() { return this.get('/UserViews', { userId: this.userId }); }
  item(id) { return this.get(`/Items/${id}`, { userId: this.userId }); }
  items(query, opts) {
    return this.get('/Items', { userId: this.userId, fields: Api.FIELDS, enableImageTypes: 'Primary,Backdrop,Thumb', imageTypeLimit: 1, ...query }, opts);
  }

  setPlayed(id, played) {
    return played ? this.post(`/UserPlayedItems/${id}`, undefined, { userId: this.userId })
      : this.del(`/UserPlayedItems/${id}`, { userId: this.userId });
  }
  setFavorite(id, fav) {
    return fav ? this.post(`/UserFavoriteItems/${id}`, undefined, { userId: this.userId })
      : this.del(`/UserFavoriteItems/${id}`, { userId: this.userId });
  }
}

/**
 * The server's WebSocket: library/userdata events and remote control. Reconnects with
 * backoff, answers ForceKeepAlive and sends KeepAlive at half the server's interval.
 */
export function connectSocket(api, onMessage, onState = () => {}) {
  let ws = null;
  let wait = 1000;
  let keep = null;
  let stopped = false;
  let timer = null;

  const send = (type, data) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ MessageType: type, Data: data }));
  };

  function open() {
    if (stopped || !api.authed) return;
    const u = new URL(api.url('/socket', { ApiKey: api.token, deviceId: api.deviceId }));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(u.href);
    onState('connecting');
    ws.onopen = () => { wait = 1000; onState('live'); };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.MessageType === 'ForceKeepAlive') {
        send('KeepAlive');
        clearInterval(keep);
        keep = setInterval(() => send('KeepAlive'), Math.max(5, (m.Data || 60) / 2) * 1000);
        return;
      }
      if (m.MessageType === 'KeepAlive') return;
      onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(keep);
      ws = null;
      if (stopped) return;
      onState('offline');
      timer = setTimeout(open, wait);
      wait = Math.min(wait * 2, 30000);
    };
    ws.onerror = () => ws?.close();
  }

  const kick = () => { if (!ws && !stopped) { clearTimeout(timer); wait = 1000; open(); } };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  open();

  return {
    send,
    close() { stopped = true; clearTimeout(timer); clearInterval(keep); ws?.close(); },
  };
}
