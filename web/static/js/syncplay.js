// SyncPlay, "watch together" (official plugins/syncPlay): people in a group play the same thing
// at the same time. The server owns the group's queue and state. Playing something, pausing,
// seeking, next and previous are requests to it; it answers everyone with the new queue
// (SyncPlayGroupUpdate PlayQueue) or a playback command (SyncPlayCommand) saying what to do and
// when, in server time. Each client tells it when it's buffering and when it's ready again, and
// the group only starts once everyone is.
//
// The video player (player/video.js) takes `sync: app.sync` while a group is on: its controls then
// call request*() here instead of acting, it reports loaded() / buffering() / ready(), and this
// drives it through its `local` controls. Video only; music isn't shared yet.
import { Api, TICKS } from './api.js';
import { toast } from './ui.js';

const TICKS_PER_MS = 10000;
const PINGS_KEPT = 8;
const GREEDY_PINGS = 3;           // the first pings come a second apart, then once a minute
const BUFFERING_AFTER = 3000;     // ms of 'waiting' before telling the group we're buffering

const GROUP_MESSAGES = {
  GroupDoesNotExist: 'That group no longer exists',
  CreateGroupDenied: 'You may not create groups',
  JoinGroupDenied: 'You may not join groups',
  LibraryAccessDenied: 'Someone in the group can’t see this',
  SyncPlayIsDisabled: 'Watch together is off for your account',
};

export class SyncPlay {
  constructor(app) {
    this.app = app;
    this.group = null;            // GroupInfoDto while in a group
    this.enabledAt = null;        // server time the group was joined; older commands are ignored
    this.timeReady = false;       // the clock offset has been measured
    this.queued = null;           // a command that came before the clock was ready
    this.following = true;        // false after closing the player in a group (SetIgnoreWait)
    this.state = null;            // group state: Idle, Waiting, Paused, Playing
    this.lastCommand = null;      // the group's last playback command
    this.queue = null;            // the last PlayQueue update (Playlist, PlayingItemIndex...)
    this.measures = [];
    this.offset = 0;              // server clock minus ours, ms
    this.ping = 0;
    this.pings = 0;
    this.pollTimer = null;
    this.timer = null;            // a scheduled command
    this.bufTimer = null;
    this.subs = new Set();
    app.listen('SyncPlayGroupUpdate', d => this.onGroupUpdate(d));
    app.listen('SyncPlayCommand', d => this.onCommand(d));
  }

  get active() { return !!this.group; }
  get api() { return this.app.api; }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  changed() { for (const fn of [...this.subs]) { try { fn(); } catch (e) { console.warn(e); } } }
  /** The signed-in user's SyncPlay permission: CreateAndJoinGroups, JoinGroups or None. */
  get access() { return this.app.me?.Policy?.SyncPlayAccess || 'CreateAndJoinGroups'; }

  // ---- groups ---------------------------------------------------------------------------------

  list() { return this.api.get('/SyncPlay/List'); }
  create(name) { return this.api.post('/SyncPlay/New', { GroupName: name }); }
  join(id) { return this.api.post('/SyncPlay/Join', { GroupId: id }); }
  leave() { return this.api.post('/SyncPlay/Leave'); }

  onGroupUpdate(m) {
    const d = m?.Data;
    switch (m?.Type) {
      case 'GroupJoined': this.enable(d); break;
      case 'GroupUpdate': this.group = d; this.changed(); break;
      case 'UserJoined':
        if (this.group) this.group.Participants = [...(this.group.Participants || []), d];
        toast('Joined the group', d, 'sky', 2500); this.changed(); break;
      case 'UserLeft':
        if (this.group) this.group.Participants = (this.group.Participants || []).filter(u => u !== d);
        toast('Left the group', d, 'lilac', 2500); this.changed(); break;
      case 'NotInGroup':
      case 'GroupLeft': this.disable(); break;
      case 'StateUpdate': this.state = d?.State || null; this.changed(); break;
      case 'PlayQueue': this.onQueue(d).catch(e => console.warn('SyncPlay queue', e)); break;
      default:
        if (GROUP_MESSAGES[m?.Type]) toast('Watch together', GROUP_MESSAGES[m.Type], 'salmon');
    }
  }

  enable(group) {
    if (this.group && this.group.GroupId !== group.GroupId) this.disable(false);
    this.group = group;
    this.enabledAt = new Date(group.LastUpdatedAt);
    this.state = group.State || null;
    this.following = true;
    this.timeReady = false;
    this.lastCommand = null;
    this.queue = null;
    this.startClock();
    toast('Watching together', group.GroupName, 'sky', 2500);
    this.changed();
  }

  disable(say = true) {
    if (!this.group) return;
    const was = this.group.GroupName;
    this.group = null;
    this.enabledAt = null;
    this.timeReady = false;
    this.queued = null;
    this.lastCommand = null;
    this.queue = null;
    this.state = null;
    this.clearScheduled();
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.app.player?.syncOff?.();
    if (say) toast('Left the group', was, 'lilac', 2500);
    this.changed();
  }

  // ---- the clock (official TimeSync): NTP-style, the measurement with the least delay -------------

  startClock() {
    clearTimeout(this.pollTimer);
    this.measures = [];
    this.pings = 0;
    const poll = async () => {
      if (!this.group) return;
      try {
        const sent = Date.now();
        const r = await this.api.get('/GetUtcTime');
        const got = Date.now();
        const rx = Date.parse(r.RequestReceptionTime), tx = Date.parse(r.ResponseTransmissionTime);
        const m = { offset: ((rx - sent) + (tx - got)) / 2, delay: (got - sent) - (tx - rx) };
        this.measures.push(m);
        if (this.measures.length > PINGS_KEPT) this.measures.shift();
        const best = [...this.measures].sort((a, b) => a.delay - b.delay)[0];
        this.offset = best.offset;
        this.ping = Math.round(best.delay / 2);
        this.pings++;
        this.api.post('/SyncPlay/Ping', { Ping: this.ping }).catch(() => {});
        if (!this.timeReady) {
          this.timeReady = true;
          const q = this.queued;
          this.queued = null;
          if (q) this.onCommand(q);
        }
      } catch (e) { console.warn('SyncPlay clock', e); }
      if (this.group) this.pollTimer = setTimeout(poll, this.pings < GREEDY_PINGS ? 1000 : 60000);
    };
    poll();
  }
  /** Server time now, ms. */
  serverNow() { return Date.now() + this.offset; }
  /** A server time as ours, ms. */
  toLocal(serverMs) { return serverMs - this.offset; }
  /** Where the group is now, given it was at `ticks` at server time `when` and kept playing. */
  estimate(ticks, when) { return ticks + (this.serverNow() - when) * TICKS_PER_MS; }

  // ---- the queue ----------------------------------------------------------------------------------

  currentPlaylistItemId() {
    const q = this.queue;
    return q && q.PlayingItemIndex >= 0 ? q.Playlist[q.PlayingItemIndex]?.PlaylistItemId || null : null;
  }

  async onQueue(d) {
    d.LastUpdate = Date.parse(d.LastUpdate);
    if (this.queue && d.LastUpdate <= this.queue.LastUpdate) return;
    const before = this.queue;
    this.queue = d;
    this.changed();
    if (!d.Playlist?.length) return;
    const p = this.app.player;
    switch (d.Reason) {
      case 'NewPlaylist':
        if (!this.following) await this.follow();
        await this.startPlayback();
        break;
      case 'SetCurrentItem': case 'NextItem': case 'PreviousItem':
        this.playCurrent();
        break;
      case 'RemoveItems': {
        const old = before && before.PlayingItemIndex >= 0 ? before.Playlist[before.PlayingItemIndex]?.PlaylistItemId : null;
        if (old !== this.currentPlaylistItemId()) this.playCurrent();
        else p?.syncQueue?.(await this.items());
        break;
      }
      default: // Queue, QueueNext, MoveItem, RepeatMode, ShuffleMode: the list changed, not the item
        p?.syncQueue?.(await this.items());
    }
  }

  /** The queue's items, with their PlaylistItemIds. */
  async items() {
    const pl = this.queue?.Playlist || [];
    if (!pl.length) return [];
    const ids = [...new Set(pl.map(x => x.ItemId))];
    const r = await this.api.items({ ids: ids.join(','), fields: Api.FIELDS });
    const byId = new Map((r.Items || []).map(i => [i.Id.replace(/-/g, ''), i]));
    return pl.map(x => byId.get(String(x.ItemId).replace(/-/g, '')) && { ...byId.get(String(x.ItemId).replace(/-/g, '')), PlaylistItemId: x.PlaylistItemId }).filter(Boolean);
  }

  async startPlayback() {
    if (!this.following || !this.queue?.Playlist?.length) return;
    const items = await this.items();
    const index = Math.max(0, this.queue.PlayingItemIndex);
    const it = items[index];
    if (!it) return;
    if (it.MediaType === 'Audio') { toast('Watch together', 'Music isn’t shared yet; play a video', 'salmon'); return; }
    const c = this.lastCommand;
    const startTicks = c && Date.parse(c.EmittedAt) >= this.queue.LastUpdate && c.PositionTicks != null
      ? (c.Command === 'Unpause' ? this.estimate(c.PositionTicks, Date.parse(c.When)) : c.PositionTicks)
      : this.queue.StartPositionTicks || 0;
    this.app.play(it, { list: items, index, startTicks: Math.max(0, Math.round(startTicks)), fromSync: true });
  }

  /** The group moved to another item of the same queue. */
  async playCurrent() {
    if (!this.following) return;
    const items = await this.items();
    const index = Math.max(0, this.queue.PlayingItemIndex);
    const p = this.app.player;
    if (p?.syncGoTo && p.kind === 'video') p.syncGoTo(items, index);
    else await this.startPlayback();
  }

  // ---- requests (what the controls do while in a group) ---------------------------------------------

  /** Play these items in the group (official Controller.play). Episodes queue the rest of the series. */
  async requestPlay(it, opts = {}) {
    let list = opts.list?.length ? opts.list : null;
    let index = list ? opts.index || 0 : 0;
    if (!list && it.Type === 'Episode' && it.SeriesId) {
      try {
        const r = await this.api.get(`/Shows/${it.SeriesId}/Episodes`, { userId: this.api.userId, startItemId: it.Id, isMissing: false, limit: 100 });
        if (r.Items?.length) { list = r.Items; index = Math.max(0, list.findIndex(x => x.Id === it.Id)); }
      } catch { /* just this one */ }
    }
    list = list || [it];
    const startTicks = opts.startTicks ?? (opts.resume ? it.UserData?.PlaybackPositionTicks || 0 : 0);
    if (!this.following) await this.follow();
    await this.api.post('/SyncPlay/SetNewQueue', { PlayingQueue: list.map(x => x.Id), PlayingItemPosition: index, StartPositionTicks: startTicks });
  }
  requestPause() { this.api.post('/SyncPlay/Pause').catch(() => {}); this.app.player?.local?.pause(); }
  requestUnpause() { this.api.post('/SyncPlay/Unpause').catch(() => {}); }
  requestSeek(seconds) { this.api.post('/SyncPlay/Seek', { PositionTicks: Math.max(0, Math.round(seconds * TICKS)) }).catch(() => {}); }
  requestNext() { this.api.post('/SyncPlay/NextItem', { PlaylistItemId: this.currentPlaylistItemId() }).catch(() => {}); }
  requestPrevious() { this.api.post('/SyncPlay/PreviousItem', { PlaylistItemId: this.currentPlaylistItemId() }).catch(() => {}); }
  get playing() { return this.lastCommand?.Command === 'Unpause'; }

  /** Stop following the group without leaving it (closing the player), so it doesn't wait for us. */
  halt() {
    if (!this.group || !this.following) return;
    this.following = false;
    this.clearScheduled();
    this.api.post('/SyncPlay/SetIgnoreWait', { IgnoreWait: true }).catch(() => {});
    this.changed();
  }
  async follow() {
    this.following = true;
    await this.api.post('/SyncPlay/SetIgnoreWait', { IgnoreWait: false }).catch(() => {});
    this.changed();
  }
  /** Back to what the group is playing. */
  async resume() { await this.follow(); await this.startPlayback(); }

  // ---- reports from the player ------------------------------------------------------------------

  report(path, isPlaying) {
    const p = this.app.player?.local;
    if (!this.group || !p) return;
    this.api.post(path, {
      When: new Date(this.serverNow()).toISOString(),
      PositionTicks: Math.round(p.position() * TICKS),
      IsPlaying: isPlaying ?? !p.paused(),
      PlaylistItemId: this.currentPlaylistItemId(),
    }).catch(() => {});
  }
  /** The player has loaded the item and paused at the start: ready for the group. */
  loaded() { this.report('/SyncPlay/Ready', false); }
  waiting() {
    clearTimeout(this.bufTimer);
    this.bufTimer = setTimeout(() => { this.buffering = true; this.report('/SyncPlay/Buffering'); }, BUFFERING_AFTER);
  }
  playing() {
    clearTimeout(this.bufTimer);
    this.buffering = false;
    this.report('/SyncPlay/Ready');
  }

  // ---- commands (official PlaybackCore) -----------------------------------------------------------

  onCommand(c) {
    if (!this.group || !c) return;
    const cmd = { ...c, when: Date.parse(c.When), emitted: Date.parse(c.EmittedAt), ticks: c.PositionTicks != null ? Number(c.PositionTicks) : null };
    if (cmd.emitted < this.enabledAt.getTime()) return; // from before we joined
    if (!this.timeReady) { this.queued = c; return; }
    const last = this.lastCommand;
    this.lastCommand = c;
    this.changed();
    const p = this.app.player?.local;
    if (!p || !this.following) return;
    if (c.Command !== 'Stop' && c.PlaylistItemId !== this.currentPlaylistItemId()) return;
    // The same command again (the server repeats it to latecomers): only redo what didn't happen.
    if (last && last.When === c.When && last.Command === c.Command && last.PositionTicks === c.PositionTicks && last.PlaylistItemId === c.PlaylistItemId
      && this.toLocal(cmd.when) <= Date.now()) {
      if (c.Command === 'Unpause' && !p.paused()) return;
      if (c.Command === 'Pause' && p.paused() && Math.abs(p.position() * TICKS - cmd.ticks) < TICKS) return;
      if (c.Command === 'Seek' && p.paused() && Math.abs(p.position() * TICKS - cmd.ticks) < TICKS) { this.report('/SyncPlay/Ready', false); return; }
    }
    this.apply(cmd);
  }

  clearScheduled() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  apply(cmd) {
    this.clearScheduled();
    const p = () => this.app.player?.local;
    const at = Math.max(0, this.toLocal(cmd.when) - Date.now());
    const later = fn => { if (at > 0) this.timer = setTimeout(fn, at); else fn(); };
    const sec = t => t / TICKS;
    switch (cmd.Command) {
      case 'Unpause':
        if (at > 0) {
          // Waiting for the start time: be at the right place, then start on time.
          if (cmd.ticks != null && Math.abs(p()?.position() * TICKS - cmd.ticks) > 400 * TICKS_PER_MS) p()?.seek(sec(cmd.ticks));
          this.timer = setTimeout(() => p()?.play(), at);
        } else {
          // Late: start where the group is by now.
          const t = cmd.ticks != null ? this.estimate(cmd.ticks, cmd.when) : null;
          if (t != null) p()?.seek(sec(t));
          p()?.play();
        }
        break;
      case 'Pause':
        later(() => { p()?.pause(); if (cmd.ticks != null) p()?.seek(sec(cmd.ticks)); });
        break;
      case 'Seek':
        later(() => {
          const lp = p();
          if (!lp) return;
          lp.pause();
          lp.seek(sec(cmd.ticks || 0));
          // Ready once the picture is there at the new place.
          lp.whenReady().then(() => this.report('/SyncPlay/Ready', false));
        });
        break;
      case 'Stop':
        later(() => this.app.player?.local?.stop());
        break;
      default:
    }
  }
}
