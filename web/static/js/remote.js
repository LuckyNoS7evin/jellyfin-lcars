// "Play on": control another Jellyfin session (a TV, a phone, another browser) from LCARS, as
// the official client's session player does (plugins/sessionPlayer). While a device is chosen,
// everything you play here is sent to it. The server's WebSocket pushes the session list
// (SessionsStart), so the controls follow what the other device is doing.
import { TICKS } from './api.js';
import { toast } from './ui.js';

// The chosen device id, for this tab only. A device id outlives its session: a TV app that
// restarts, or a reloaded tab, comes back with a new session id but the same device id.
const KEY = 'jfl.remote';
const GRACE = 30000; // how long a chosen device may be away before Play on lets go

export class Remote {
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.target = null;     // the chosen session (the latest copy the server sent)
    this.sessions = [];     // every session this user can control, except this one
    this.seenAt = 0;        // when `target` arrived, to move the position on between updates
    this.listeners = new Set();
    this.watchers = 0;      // pages showing the session list
    this.subscribed = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }

  get active() { return !!this.target; }
  get name() { return this.target ? deviceLabel(this.target) : ''; }
  /** True when the chosen device says it accepts this GeneralCommand. */
  can(cmd) { return supports(this.target, cmd); }

  /** Where the remote is now, in seconds, counting on from its last report while it plays. */
  get position() {
    const ps = this.target?.PlayState;
    if (!ps) return 0;
    const base = (ps.PositionTicks || 0) / TICKS;
    return ps.IsPaused || !this.target.NowPlayingItem ? base : base + (Date.now() - this.seenAt) / 1000;
  }
  get duration() { return (this.target?.NowPlayingItem?.RunTimeTicks || 0) / TICKS; }

  /** Sessions this user can control (the server applies EnableRemoteControlOfOtherUsers). */
  async load() {
    const list = await this.api.get('/Sessions', { controllableByUserId: this.api.userId });
    this.update(list || [], { full: true });
    return this.sessions;
  }

  /**
   * A fresh list from load() (full), or a Sessions message from the socket. The socket sends
   * an admin every session, including ones they may not control, so it only refreshes the
   * devices load() found; new devices show up on the next load().
   */
  update(list, { full = false } = {}) {
    // A steady order (name, then device id), so rows don't swap places between refreshes.
    if (full) {
      this.sessions = list.filter(s => s.DeviceId !== this.api.deviceId && s.SupportsRemoteControl)
        .sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)) || a.DeviceId.localeCompare(b.DeviceId));
    }
    else {
      // Match by device id too: a device that reconnects gets a new session id.
      const byId = new Map(list.map(s => [s.Id, s]));
      const byDevice = new Map(list.map(s => [s.DeviceId, s]));
      this.sessions = this.sessions.map(s => byId.get(s.Id) || byDevice.get(s.DeviceId)).filter(Boolean);
    }
    if (this.target) {
      const s = list.find(x => x.Id === this.target.Id) || list.find(x => x.DeviceId === this.target.DeviceId);
      if (s) {
        this.target = s;
        this.seenAt = Date.now();
        this.missingSince = 0;
      } else if (!this.missingSince) {
        // Gone for now: a reloading tab or restarting TV app is back within seconds.
        this.missingSince = Date.now();
      } else if (Date.now() - this.missingSince > GRACE) {
        toast('Link lost', `${this.name} is no longer connected`, 'red');
        this.disconnect();
        return;
      }
    }
    this.emit();
  }

  /** True while the chosen device has dropped out and may come back. */
  get missing() { return !!this.missingSince; }

  /** Pick up the device chosen earlier in this tab (after a reload). */
  async restore() {
    let id = null;
    try { id = sessionStorage.getItem(KEY); } catch { /* blocked */ }
    if (!id) return;
    // The device may be reconnecting too (both reloaded): look a few times before giving up.
    for (let i = 0; i < 4; i++) {
      try {
        await this.load();
        const s = this.sessions.find(x => x.DeviceId === id);
        if (s) { this.connect(s, { quiet: true }); return; }
      } catch { /* offline */ }
      await new Promise(r => setTimeout(r, 3000));
      if (this.target) return; // chosen by hand meanwhile
    }
    this.forget();
  }

  connect(session, { quiet = false } = {}) {
    // Stop playing here: from now on the other device plays.
    this.app.player?.kind === 'video' && this.app.player.close();
    this.app.queue.active && this.app.queue.pause();
    this.target = session;
    this.seenAt = Date.now();
    this.missingSince = 0;
    try { sessionStorage.setItem(KEY, session.DeviceId); } catch { /* blocked */ }
    this.subscribe();
    if (!quiet) toast('Playing on', this.name, 'lilac', 2500);
    this.emit();
  }

  disconnect() {
    this.target = null;
    this.forget();
    this.subscribe();
    this.emit();
  }

  forget() { try { sessionStorage.removeItem(KEY); } catch { /* blocked */ } }

  /** The session list page calls watch() while it is open, and the returned function when it closes. */
  watch() {
    this.watchers++;
    this.subscribe();
    return () => { this.watchers--; this.subscribe(); };
  }

  /** Ask the server for session updates while something needs them; stop when nothing does. */
  subscribe(force = false) {
    const want = this.active || this.watchers > 0;
    if (want === this.subscribed && !force) return;
    this.subscribed = want;
    const s = this.app.socket;
    if (!s) return;
    // "initial delay,interval" in ms, as the official client sends.
    if (want) s.send('SessionsStart', '0,1500'); else s.send('SessionsStop');
  }

  /** The socket reconnected: the server forgot the subscription. */
  resubscribe() { if (this.subscribed) this.subscribe(true); }

  // ---- commands ---------------------------------------------------------------------------

  /**
   * Play items on the remote. command: PlayNow, PlayNext, PlayLast, PlayShuffle or
   * PlayInstantMix. The other device fetches the items itself, so only ids go.
   */
  async play(items, { command = 'PlayNow', index = 0, startTicks, mediaSourceId, audioIndex, subIndex, shuffle = false } = {}) {
    if (!this.target || !items.length) return;
    let ids = items.map(i => i.Id || i);
    if (shuffle) {
      ids = [...ids];
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      index = 0;
    }
    // The URL has to stay a sensible length; a TV won't take a 1000-track album at once anyway.
    if (ids.length > 200) { const from = Math.max(0, Math.min(index, ids.length - 200)); ids = ids.slice(from, from + 200); index -= from; }
    try {
      await this.api.post(`/Sessions/${this.target.Id}/Playing`, undefined, {
        playCommand: command, itemIds: ids, startIndex: index || undefined, startPositionTicks: startTicks || undefined,
        mediaSourceId, audioStreamIndex: audioIndex, subtitleStreamIndex: subIndex,
      });
      const what = items.length === 1 ? (items[0].Name || '') : `${items.length} items`;
      toast(command === 'PlayNext' ? 'Playing next' : command === 'PlayLast' ? 'Added to queue' : 'Sent', `${what} → ${this.name}`, 'lilac', 2500);
    } catch (e) { this.failed(e); }
  }

  /** Playstate: PlayPause, Pause, Unpause, Stop, NextTrack, PreviousTrack, Seek, Rewind, FastForward. */
  async state(cmd, seconds) {
    if (!this.target) return;
    if (cmd === 'Seek') {
      this.target.PlayState = { ...this.target.PlayState, PositionTicks: Math.round(seconds * TICKS) };
      this.seenAt = Date.now();
      this.emit();
    }
    try {
      await this.api.post(`/Sessions/${this.target.Id}/Playing/${cmd}`, undefined,
        cmd === 'Seek' ? { seekPositionTicks: Math.round(seconds * TICKS) } : undefined);
    } catch (e) { this.failed(e); }
  }

  seekBy(ds) { this.state('Seek', Math.max(0, Math.min(this.duration || Infinity, this.position + ds))); }

  /** A GeneralCommand (SetVolume, SetAudioStreamIndex, ToggleFullscreen...). Arguments are strings. */
  async command(name, args) {
    if (!this.target) return;
    const Arguments = args ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) : undefined;
    try { await this.api.post(`/Sessions/${this.target.Id}/Command`, { Name: name, Arguments }); } catch (e) { this.failed(e); }
  }

  async message(session, header, text, ms = 8000) {
    try {
      await this.api.post(`/Sessions/${session.Id}/Message`, { Header: header, Text: text, TimeoutMs: ms });
      toast('Message sent', deviceLabel(session), 'lilac', 2000);
    } catch (e) { this.failed(e); }
  }

  failed(e) { toast('Unable to comply', `${this.name}: ${e.message}`, 'red'); }
}

/** True when a session accepts this GeneralCommand. */
export function supports(s, cmd) {
  return (s?.Capabilities?.SupportedCommands || s?.SupportedCommands || []).includes(cmd);
}

/** The device's name, falling back to the app's. */
export function deviceLabel(s) {
  return s.DeviceName || s.Client || 'Device';
}
