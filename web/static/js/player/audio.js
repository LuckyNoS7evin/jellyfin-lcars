// Music queue. One <audio> element for the whole app, so playback carries on while you
// browse. Streams through /Audio/{id}/universal, which direct-plays what the browser
// supports and transcodes the rest to MP3.
import { TICKS, randomId } from '../api.js';
import { caps } from './profile.js';
import { Reporter } from './report.js';
import { autoBitrate } from './bitrate.js';

const rid = randomId;
const isAudio = i => i.Type === 'Audio' || i.MediaType === 'Audio';
// Each queue entry is its own object (the same song can be queued twice) with a queue id.
const entry = i => ({ ...i, _qid: rid() });
const REPEAT = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const DEVICE = 'jfl.music';
function loadDevice() { try { return JSON.parse(localStorage.getItem(DEVICE)) || {}; } catch { return {}; } }

export class AudioQueue {
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.items = [];
    this.index = -1;
    this.reporter = null;
    this.listeners = new Set();
    this.started = false;
    // Repeat, shuffle and volume are remembered on this device.
    const dev = loadDevice();
    this.repeat = REPEAT.includes(dev.repeat) ? dev.repeat : 'RepeatNone';
    this.shuffle = false;
    this.sorted = null; // the queue in its own order while shuffled
    this.el.volume = Number.isFinite(dev.volume) ? Math.max(0, Math.min(1, dev.volume)) : 1;
    this.el.muted = !!dev.muted;

    const el = this.el;
    el.addEventListener('playing', () => {
      if (!this.started) { this.started = true; this.reporter?.start(); } else this.reporter?.progress('Unpause');
      this.emit();
    });
    el.addEventListener('pause', () => { this.reporter?.progress('Pause'); this.emit(); });
    el.addEventListener('ended', () => {
      if (this.repeat === 'RepeatOne') this.playAt(this.index);
      else this.next(true);
    });
    el.addEventListener('volumechange', () => { this.saveDevice(); this.reporter?.progress('VolumeChange'); this.emit('volume'); });
    el.addEventListener('error', () => { if (el.getAttribute('src')) this.next(true); });
    el.addEventListener('timeupdate', () => this.emit('time'));
    el.addEventListener('seeked', () => this.reporter?.progress('TimeUpdate'));

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.el.play());
      ms.setActionHandler('pause', () => this.el.pause());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('nexttrack', () => this.next());
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'state') { for (const fn of this.listeners) fn(what); }

  get current() { return this.items[this.index] || null; }
  get active() { return !!this.current; }
  get paused() { return this.el.paused; }
  get position() { return this.el.currentTime || 0; }
  get duration() { return this.el.duration || (this.current?.RunTimeTicks || 0) / TICKS; }

  saveDevice() {
    try { localStorage.setItem(DEVICE, JSON.stringify({ repeat: this.repeat, volume: this.el.volume, muted: this.el.muted })); } catch { /* private mode */ }
  }

  /**
   * Replace the queue. A new queue plays in order unless it comes from a Shuffle button
   * (shuffle: true); the shuffle toggle then works on that queue.
   */
  play(items, index = 0, { shuffle = false, startTicks = 0 } = {}) {
    if (!this.app.mayPlay?.(items[index])) return;
    // Playing on another device (remote.js): it gets the tracks instead.
    if (this.app.remote?.active) { this.app.remote.play(items.filter(isAudio), { index, shuffle, startTicks }); return; }
    const list = items.filter(isAudio).map(entry);
    if (!list.length) return;
    index = Math.max(0, Math.min(index, list.length - 1));
    this.shuffle = !!shuffle;
    if (this.shuffle) {
      this.sorted = list;
      this.items = shuffled(list);
      index = 0;
    } else {
      this.sorted = null;
      this.items = list;
    }
    // Where the first track starts (an audiobook resuming); later tracks start at the beginning.
    this.startAt = startTicks > 0 ? startTicks / 1e7 : 0;
    this.playAt(index);
  }

  add(items) {
    if (!this.app.mayPlay?.()) return;
    if (this.app.remote?.active) { this.app.remote.play(items.filter(isAudio), { command: 'PlayLast' }); return; }
    const list = items.filter(isAudio).map(entry);
    if (!this.active) { this.play(list); return; }
    this.items.push(...list);
    this.sorted?.push(...list);
    this.changed('PlaylistItemAdd');
  }

  /** Insert after the current track ("Play next"). */
  playNext(items) {
    if (!this.app.mayPlay?.()) return;
    if (this.app.remote?.active) { this.app.remote.play(items.filter(isAudio), { command: 'PlayNext' }); return; }
    const list = items.filter(isAudio).map(entry);
    if (!this.active) { this.play(list); return; }
    this.items.splice(this.index + 1, 0, ...list);
    if (this.sorted) this.sorted.splice(this.sorted.indexOf(this.current) + 1, 0, ...list);
    this.changed('PlaylistItemAdd');
  }

  /** The queue changed without the track changing: redraw and tell the server. */
  changed(event) {
    if (this.reporter) this.reporter.info.playlistIndex = this.index;
    if (this.reporter) this.reporter.info.playlistLength = this.items.length;
    this.reporter?.progress(event);
    this.emit();
  }

  // ---- repeat, shuffle, order -----------------------------------------------------------------

  /** Off → all → one → off, or a given mode (remote SetRepeatMode). */
  cycleRepeat(mode) {
    this.repeat = REPEAT.includes(mode) ? mode : REPEAT[(REPEAT.indexOf(this.repeat) + 1) % REPEAT.length];
    this.saveDevice();
    this.changed('RepeatModeChange');
  }

  /** Shuffle what's left around the current track, or put the queue back in order. */
  setShuffle(on = !this.shuffle) {
    on = !!on;
    if (on === this.shuffle) return;
    this.shuffle = on;
    const cur = this.current;
    if (cur) {
      if (on) {
        this.sorted = [...this.items];
        this.items = [cur, ...shuffled(this.items.filter(t => t !== cur))];
        this.index = 0;
      } else if (this.sorted) {
        this.items = this.sorted;
        this.sorted = null;
        this.index = Math.max(0, this.items.indexOf(cur));
      }
    }
    this.changed('ShuffleChange');
  }

  /** Move a track within the queue (drag and drop, or the up/down buttons). */
  move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
    const cur = this.current;
    const [t] = this.items.splice(from, 1);
    this.items.splice(to, 0, t);
    this.index = this.items.indexOf(cur);
    this.changed('PlaylistItemMove');
  }

  setVolume(v) { this.el.volume = Math.max(0, Math.min(1, v)); if (this.el.volume > 0) this.el.muted = false; }
  toggleMute() { this.el.muted = !this.el.muted; }

  /** Report shape: entries for the server's NowPlayingQueue. */
  queueInfo() { return this.items.map(t => ({ Id: t.Id, PlaylistItemId: t._qid })); }

  async playAt(i) {
    if (this.reporter) { this.reporter.stop(); this.reporter = null; }
    this.index = i;
    const it = this.current;
    if (!it) { this.stop(); return; }
    const c = caps();
    const containers = ['mp3', 'aac,m4a|aac', 'm4b|aac', c.flac && 'flac', c.opus && 'opus,webm|opus,ogg|opus', c.vorbis && 'ogg|vorbis,webm|vorbis', 'wav'].filter(Boolean);
    const playSessionId = rid();
    // A music quality limit makes the server send mp3 at that bitrate when a file is above it.
    const limit = this.app.us?.maxMusicBitrate || 0;
    // Otherwise, away from home, under what the connection test found (as official; none at home).
    const auto = limit ? 0 : await autoBitrate(this.api).catch(() => 0);
    if (this.current !== it) return; // stopped or moved on meanwhile
    this.el.src = this.api.url(`/Audio/${it.Id}/universal`, {
      UserId: this.api.userId, DeviceId: this.api.deviceId, PlaySessionId: playSessionId,
      MaxStreamingBitrate: limit || auto || 140_000_000, AudioBitRate: limit || undefined, Container: containers.join(','),
      TranscodingContainer: 'mp3', TranscodingProtocol: 'http', AudioCodec: 'mp3', EnableRedirection: true, EnableRemoteMedia: false,
    }, { auth: true });
    this.started = false;
    const from = this.startAt || 0;
    this.startAt = 0;
    if (from > 0) this.el.addEventListener('loadedmetadata', () => { try { this.el.currentTime = from; } catch { /* not seekable */ } }, { once: true });
    this.reporter = new Reporter(this.api, {
      itemId: it.Id, mediaSourceId: it.Id, playSessionId, playMethod: 'DirectPlay',
      playlistIndex: i, playlistLength: this.items.length, playlistItemId: it._qid,
    }, () => ({
      position: this.position, paused: this.el.paused, muted: this.el.muted, volume: this.el.volume,
      repeat: this.repeat, order: this.shuffle ? 'Shuffle' : 'Default', queue: this.queueInfo(),
    }));
    this.metadata();
    this.emit();
    try { await this.el.play(); } catch { this.emit(); }
  }

  next(auto = false) {
    if (this.index + 1 < this.items.length) this.playAt(this.index + 1);
    else if (this.repeat === 'RepeatAll' && this.items.length) this.playAt(0);
    else if (auto) this.stop();
  }

  prev() {
    if (this.position > 3) { this.el.currentTime = 0; return; }
    if (this.index > 0) this.playAt(this.index - 1);
    else if (this.repeat === 'RepeatAll' && this.items.length > 1) this.playAt(this.items.length - 1);
    else this.el.currentTime = 0;
  }

  toggle() { if (!this.active) return; if (this.el.paused) this.el.play().catch(() => {}); else this.el.pause(); }
  pause() { this.el.pause(); }
  resume() { this.el.play().catch(() => {}); }
  seekTo(s) { if (Number.isFinite(s)) this.el.currentTime = Math.max(0, s); }

  stop() {
    if (this.reporter) { this.reporter.stop(); this.reporter = null; }
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.items = [];
    this.sorted = null;
    this.index = -1;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.emit();
  }

  remove(i) {
    const t = this.items[i];
    if (!t) return;
    if (this.sorted) this.sorted.splice(this.sorted.indexOf(t), 1);
    if (i === this.index) {
      this.items.splice(i, 1);
      if (!this.items.length) { this.stop(); return; }
      this.playAt(Math.min(i, this.items.length - 1));
      return;
    }
    this.items.splice(i, 1);
    if (i < this.index) this.index--;
    this.changed('PlaylistItemRemove');
  }

  metadata() {
    if (!('mediaSession' in navigator)) return;
    const it = this.current;
    const art = it.AlbumId ? this.api.img(it.AlbumId, 'Primary', { h: 512, tag: it.AlbumPrimaryImageTag }) : this.api.img(it.Id, 'Primary', { h: 512 });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.Name, artist: it.AlbumArtist || (it.Artists || []).join(', '), album: it.Album || '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  }
}
