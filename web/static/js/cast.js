// Google Cast: play on a Chromecast, a Google TV or a Cast speaker, as the official client's
// chromecastPlayer plugin does. Chrome's Cast dialog picks the device, which then opens
// Jellyfin's own receiver app (user setting CastReceiverId) and plays from the server itself.
// LCARS sends it commands over a Cast message channel (the receiver has no server socket, so
// the server's session commands don't reach it) and it reports back what it plays.
//
// A cast becomes Play on's target (remote.js), shaped like a server session, so the header,
// the Play on page and everything that plays (app.play, the music queue) work unchanged.
//
// Chrome only lets a secure page (HTTPS, or localhost) use Cast; the official apps' web views,
// the desktop app and TVs don't offer it at all.
import { native, desktopApp } from './shell.js';
import { toast } from './ui.js';

const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=0';
const NS = 'urn:x-cast:com.connectsdk';
const STABLE = 'F007D354'; // Jellyfin's stable receiver, the server's default

// What the receiver does itself; volume and mute are the device's, set from here.
const COMMANDS = ['SetVolume', 'ToggleMute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'SetRepeatMode'];

export class Cast {
  constructor(app) {
    this.app = app;
    /** unsupported | insecure | local | loading | none (no devices) | available | failed */
    this.status = 'unsupported';
    this.session = null;
    this.target = null;  // the pseudo-session handed to Play on
    this.started = false;
  }

  get remote() { return this.app.remote; }
  get active() { return !!this.session && this.remote.target === this.target; }

  /** Once signed in: load Google's sender script and look for devices. */
  async init() {
    if (this.started) return;
    this.started = true;
    if (!window.chrome || native.present || desktopApp() || /Web0S|webOS|SmartTV|Tizen/i.test(navigator.userAgent)) return;
    if (!window.isSecureContext) { this.set('insecure'); return; }
    // The device fetches from the server itself; "localhost" would be the device.
    if (/^(localhost|127\.|\[::1\]$)/.test(new URL(this.serverAddress()).hostname)) { this.set('local'); return; }
    this.set('loading');
    try {
      await new Promise((resolve, reject) => {
        window.__onGCastApiAvailable = ok => (ok ? resolve() : reject(new Error('Cast is not available in this browser')));
        const s = document.createElement('script');
        s.src = SDK;
        s.onerror = () => reject(new Error('Google’s Cast script did not load'));
        document.head.append(s);
      });
      const chrome = window.chrome;
      const appId = this.app.me?.Configuration?.CastReceiverId || STABLE;
      const config = new chrome.cast.ApiConfig(new chrome.cast.SessionRequest(appId),
        s => this.joined(s, false), // a cast already running from this tab (after a reload)
        r => this.set(r === chrome.cast.ReceiverAvailability.AVAILABLE ? 'available' : 'none'));
      await new Promise((resolve, reject) => chrome.cast.initialize(config, resolve, e => reject(new Error(e?.description || e?.code || 'Cast failed'))));
      if (this.status === 'loading') this.set('none');
    } catch (e) {
      console.warn('Cast:', e);
      this.set('failed');
    }
  }

  set(status) {
    if (this.status === status) return;
    this.status = status;
    this.remote.emit();
  }

  /** Chrome's Cast dialog; the device chosen there becomes Play on's target. */
  start() {
    const chrome = window.chrome;
    if (!chrome?.cast?.requestSession) return;
    chrome.cast.requestSession(s => this.joined(s, true), e => {
      if (e?.code !== chrome.cast.ErrorCode.CANCEL) toast('Unable to comply', `Cast: ${e?.description || e?.code || 'no session'}`, 'red');
    });
  }

  joined(session, fresh) {
    if (this.session === session) return;
    this.session = session;
    const r = session.receiver || {};
    this.target = {
      IsCast: true,
      Id: `cast:${session.sessionId}`,
      DeviceId: `cast:${r.label || session.sessionId}`,
      DeviceName: r.friendlyName || 'Google Cast',
      Client: 'Google Cast',
      SupportsMediaControl: true,
      Capabilities: { SupportedCommands: COMMANDS },
      NowPlayingItem: null,
      PlayState: this.volume(),
    };
    session.addMessageListener(NS, (_ns, msg) => this.onMessage(msg));
    session.addUpdateListener(alive => {
      if (this.session !== session) return;
      if (!alive) { this.ended(); return; }
      this.target.PlayState = { ...this.target.PlayState, ...this.volume() };
      this.remote.emit();
    });
    this.remote.connect(this.target, { quiet: !fresh });
    // Ask what it's doing (a cast picked up after a reload may be mid-film).
    this.send('Identify');
  }

  volume() {
    const v = this.session?.receiver?.volume || {};
    return { VolumeLevel: v.level == null ? 100 : Math.round(v.level * 100), IsMuted: !!v.muted };
  }

  /** The cast ended elsewhere: from the phone, Google Home, or the TV's own remote. */
  ended() {
    const was = this.active;
    const name = this.target?.DeviceName;
    this.session = null;
    this.target = null;
    if (was) {
      toast('Cast ended', name || '', 'lilac', 2500);
      this.remote.disconnect();
    }
  }

  /** Play on lets go of the cast: stop it, as Chrome's own Stop casting does. */
  stop() {
    const s = this.session;
    this.session = null;
    this.target = null;
    if (!s) return;
    try {
      this.post(s, 'Stop');
      setTimeout(() => s.stop(() => {}, () => {}), 1000);
    } catch { /* already gone */ }
  }

  // ---- from the receiver --------------------------------------------------------------------

  onMessage(msg) {
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } }
    const t = this.target;
    if (!msg?.type || !t) return;
    if (msg.type === 'playbackerror') { toast('Unable to comply', `${t.DeviceName}: playback error${msg.data ? ` (${msg.data})` : ''}`, 'red', 6000); return; }
    if (msg.type === 'connectionerror') { toast('Link lost', `${t.DeviceName} can’t reach the server at ${this.serverAddress()}`, 'red', 8000); return; }
    if (msg.type === 'error') { console.warn('Cast receiver:', msg.message); return; }
    const d = msg.data;
    if (!d?.ItemId) return;
    // A stop is followed by the next item's start when the queue moves on.
    t.NowPlayingItem = msg.type === 'playbackstop' ? null : images(d.NowPlayingItem || { Id: d.ItemId });
    if (msg.type !== 'playbackstop') clearTimeout(this.watchdog);
    t.PlayState = { ...(d.PlayState || {}), ...this.volume() };
    this.remote.seenAt = Date.now();
    this.remote.emit();
  }

  // ---- to the receiver ----------------------------------------------------------------------

  /** Where the receiver finds the server: this page's own server, as the browser sees it. */
  serverAddress() {
    const api = this.app.api;
    return new URL(api.base || '/', location.href).href.replace(/\/+$/, '');
  }

  send(command, options = {}) {
    if (!this.session) return;
    try { this.post(this.session, command, options); }
    catch (e) { toast('Unable to comply', `${this.target?.DeviceName || 'Cast'}: ${e.message}`, 'red'); }
  }

  post(session, command, options = {}) {
    const api = this.app.api;
    const msg = {
      command, options,
      userId: api.userId, deviceId: api.deviceId, accessToken: api.token,
      serverAddress: this.serverAddress(), serverId: api.session?.serverId,
      receiverName: session.receiver?.friendlyName || null,
    };
    session.sendMessage(NS, JSON.stringify(msg), () => {}, e => {
      console.warn('Cast send failed', command, e);
      toast('Unable to comply', `${session.receiver?.friendlyName || 'Cast'}: ${e?.description || e?.code || 'not sent'}`, 'red');
    });
  }

  /** PlayNow, PlayNext or PlayLast. The receiver fetches the items; it needs to know folders. */
  play(items, { command = 'PlayNow', index = 0, startTicks, mediaSourceId, audioIndex, subIndex } = {}) {
    // Nothing comes back when the device can't reach the server; say so rather than sit silent.
    clearTimeout(this.watchdog);
    if (command === 'PlayNow') {
      const name = this.target?.DeviceName || 'The Cast device';
      this.watchdog = setTimeout(() => {
        if (this.active) toast('No response', `${name} hasn’t started playing. It fetches from ${this.serverAddress()}: can it reach that address?`, 'red', 10000);
      }, 20000);
    }
    this.send(command, {
      items: items.map(i => (typeof i === 'string' ? { Id: i }
        : { Id: i.Id, ServerId: i.ServerId, Name: i.Name, Type: i.Type, MediaType: i.MediaType, IsFolder: i.IsFolder })),
      startIndex: index || undefined, startPositionTicks: startTicks || undefined,
      mediaSourceId, audioStreamIndex: audioIndex, subtitleStreamIndex: subIndex,
    });
  }

  /** Play on's playstate commands; Seek is in seconds. */
  state(cmd, seconds) {
    if (cmd === 'Seek') this.send('Seek', { position: seconds });
    else if (cmd === 'Rewind' || cmd === 'FastForward') this.remote.seekBy(cmd === 'Rewind' ? -10 : 30);
    else this.send(cmd);
  }

  /** Play on's general commands, with string arguments as the server takes them. */
  command(name, args = {}) {
    const s = this.session;
    if (!s) return;
    const fail = e => toast('Unable to comply', `${s.receiver?.friendlyName || 'Cast'}: ${e?.description || e?.code || name}`, 'red');
    if (name === 'SetVolume') s.setReceiverVolumeLevel(Math.max(0, Math.min(100, Number(args.Volume))) / 100, () => {}, fail);
    else if (name === 'ToggleMute') s.setReceiverMuted(!s.receiver?.volume?.muted, () => {}, fail);
    else if (name === 'SetAudioStreamIndex' || name === 'SetSubtitleStreamIndex') this.send(name, { index: Number(args.Index) });
    else if (name === 'SetRepeatMode') this.send(name, { RepeatMode: args.RepeatMode });
  }
}

/** The receiver names its images the way session reports do; LCARS's cards want ImageTags. */
function images(np) {
  const it = { ...np };
  if (it.PrimaryImageTag && !it.ImageTags?.Primary) {
    if (it.PrimaryImageItemId === it.Id || !it.PrimaryImageItemId) it.ImageTags = { ...it.ImageTags, Primary: it.PrimaryImageTag };
    else { it.ParentPrimaryImageItemId = it.PrimaryImageItemId; it.ParentPrimaryImageTag = it.PrimaryImageTag; }
  }
  if (it.BackdropImageTag) {
    if (it.BackdropItemId === it.Id) it.BackdropImageTags = [it.BackdropImageTag];
    else { it.ParentBackdropItemId = it.BackdropItemId; it.ParentBackdropImageTags = [it.BackdropImageTag]; }
  }
  return it;
}
