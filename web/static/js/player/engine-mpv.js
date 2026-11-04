// The desktop app's mpv as an engine (see engine.js). Jellyfin Desktop (formerly Jellyfin Media
// Player) offers mpv to the page through a Qt bridge, `window.api.player`, which its own
// mpvVideoPlayer plugin for jellyfin-web is built on. LCARS drives the bridge directly: the
// player core keeps its controls, menus and reporting, and mpv only plays.
//
// mpv draws in a layer behind the web page, so while it plays the page is see-through: the
// player's own background, the page's and everything behind the player.
//
// Bridge, as the app's mpvVideoPlayer uses it: load(url, {startMilliseconds, autoplay},
// streamdata, audio, subtitle, done), play(), pause(), stop(), seekTo(ms), setVolume(0..100),
// setMuted(b), setPlaybackRate(rate * 1000), setAudioStream(n), setSubtitleStream(n | '#,url'),
// setSubtitleDelay(ms), setVideoRectangle(x, y, w, h) (0,0,0,0 fills the window, -1 hides);
// signals playing, paused, positionUpdate(ms), updateDuration(ms), finished, error(message),
// buffering(percent). Audio and subtitle tracks are mpv's: counted from 1 among the file's own
// streams of that type; a transcode carries only the chosen audio, so it's always track 1.
import { h } from '../h.js';

/** mpv in the desktop app, when the app offers it and its "use mpv" setting is on. */
export function mpvAvailable() {
  const s = window.NativeShell;
  if (!window.api?.player || typeof window._mpvVideoPlayer !== 'function') return false;
  try { return (s?.getPlugins?.() || []).includes('mpvVideoPlayer'); } catch { return false; }
}

// mpv's track number for a Jellyfin stream index: 1-based among the file's streams of that type.
function mpvTrack(streams, index, type) {
  let n = 0;
  for (const s of streams || []) {
    if (s.Type !== type || s.IsExternal) continue;
    n++;
    if (s.Index === index) return n;
  }
  return null;
}

const ASPECT = { auto: 'normal', cover: 'zoom', fill: 'stretch' };

export function mpvEngine(app, pb) {
  const player = window.api.player;
  const el = h('div.p-mpv');
  const subs = new Map();
  const emit = (ev, data) => { for (const fn of subs.get(ev) || []) fn(data); };
  el.addEventListener('click', e => emit('click', e));
  el.addEventListener('dblclick', e => emit('dblclick', e));

  let pos = 0;              // seconds
  let duration = 0;         // seconds
  let paused = false;
  let open = false;         // a source is loaded (so 'finished' means this one ended)
  let direct = false;
  let ms = null;
  let rate = 1;
  let volume = 1;
  let muted = false;
  let delay = 0;
  let aspect = 'auto';
  let sub = null;           // the subtitle stream showing

  const on = {
    playing: () => { paused = false; player.setVideoRectangle(0, 0, 0, 0); emit('playing'); emit('canplaythrough'); },
    paused: () => { paused = true; emit('pause'); },
    positionUpdate: t => { pos = (Number(t) || 0) / 1000; emit('timeupdate'); },
    updateDuration: t => { duration = (Number(t) || 0) / 1000; emit('durationchange'); },
    finished: () => { if (open) { open = false; emit('ended'); } },
    error: m => { if (open) emit('error', { message: String(m || 'mpv error'), direct }); },
    buffering: p => { if (Number(p) < 100) emit('waiting'); else emit('canplaythrough'); },
  };
  for (const [sig, fn] of Object.entries(on)) player[sig]?.connect?.(fn);
  // See-through from the player down to the window, so mpv's picture shows.
  document.documentElement.classList.add('mpv-playing');

  // The subtitle argument mpv takes: a file's URL ('#,' + url), a track of the file, or -1.
  function subArg(s) {
    if (!s) return -1;
    if (s.DeliveryMethod === 'External' && s.url) return `#,${s.url}`;
    if (s.DeliveryMethod === 'Embed' || s.DeliveryMethod == null) return mpvTrack(ms?.MediaStreams, s.Index, 'Subtitle') ?? -1;
    return -1; // burned in by the server
  }

  return {
    kind: 'mpv',
    el,
    // mpv shows embedded subtitles itself, so switching them needs no reload.
    embeddedSubs: true,
    on(ev, fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); },
    // The app's own profile (its settings decide what's forced to transcode), with LCARS's
    // bitrate limit; burnIn leaves out the subtitle formats so the server burns them in.
    profile({ maxBitrate, burnIn = false } = {}) {
      const p = JSON.parse(JSON.stringify(window.NativeShell?.AppHost?.getDeviceProfile?.() || {}));
      if (maxBitrate) { p.MaxStreamingBitrate = maxBitrate; p.MaxStaticBitrate = Math.min(p.MaxStaticBitrate || maxBitrate, maxBitrate); }
      if (burnIn) p.SubtitleProfiles = [];
      return p;
    },
    load({ url, direct: d, startAt = 0, ms: source, item, audioIndex, subtitle }) {
      direct = !!d;
      ms = source;
      sub = subtitle || null;
      pos = startAt;
      duration = (ms?.RunTimeTicks || 0) / 1e7;
      paused = false;
      open = true;
      const audio = !direct ? 1 : (audioIndex != null && audioIndex >= 0 ? mpvTrack(ms?.MediaStreams, audioIndex, 'Audio') ?? 1 : 1);
      const video = ms?.MediaStreams?.find(s => s.Type === 'Video');
      const data = { type: 'video', headers: { 'User-Agent': window.jmpInfo?.userAgent || navigator.userAgent }, metadata: item || {}, media: {} };
      const fps = video?.RealFrameRate || video?.AverageFrameRate;
      if (fps) data.frameRate = fps;
      return new Promise(resolve => {
        player.load(url, { startMilliseconds: Math.round(startAt * 1000), autoplay: true }, data, audio, subArg(sub), () => {
          player.setSubtitleDelay(Math.round(delay * 1000));
          player.setPlaybackRate(Math.round(rate * 1000));
          player.setVolume(Math.round(volume * 100));
          player.setMuted(muted);
          emit('durationchange');
          resolve();
        });
      });
    },
    setSubtitle(s) { sub = s || null; player.setSubtitleStream(subArg(sub)); },
    get subtitleDelay() { return delay; },
    set subtitleDelay(v) { delay = Number(v) || 0; player.setSubtitleDelay(Math.round(delay * 1000)); },
    // The app's subtitle settings style them (mpv's own options).
    subtitleStyle() {},
    get aspect() { return aspect; },
    set aspect(v) {
      aspect = ASPECT[v] ? v : 'auto';
      // The app's own Aspect Ratio setting (normal, zoom, stretch...), which mpv follows.
      const v2 = window.jmpInfo?.settings?.video;
      // LCARS's Auto leaves the app's own choices (Default, Force 16:9...) alone; only Cover and
      // Fill, or coming back from them, change it.
      const want = ASPECT[aspect];
      const ours = v2 && (v2.aspect === 'zoom' || v2.aspect === 'stretch');
      try { if (v2 && v2.aspect !== want && (aspect !== 'auto' || ours)) v2.aspect = want; } catch { /* not writable */ }
    },
    frameStep() {},
    stats: () => ({ width: null, height: null, dropped: null, frames: null, buffered: null, player: 'mpv (the app’s player)', bandwidth: null, levelBitrate: null }),
    play() { player.play(); return Promise.resolve(); },
    pause() { player.pause(); },
    seek(s) { pos = Math.max(0, s); player.seekTo(Math.round(pos * 1000)); emit('timeupdate'); emit('seeked'); },
    get paused() { return paused; },
    get position() { return pos; },
    get duration() { return duration; },
    get rate() { return rate; },
    set rate(r) { rate = Number(r) || 1; player.setPlaybackRate(Math.round(rate * 1000)); emit('ratechange'); },
    get volume() { return volume; },
    set volume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); player.setVolume(Math.round(volume * 100)); emit('volumechange'); },
    get muted() { return muted; },
    set muted(m) { muted = !!m; player.setMuted(muted); emit('volumechange'); },
    // mpv buffers on its own; the core only uses this for the scrub bar and its stall check.
    bufferedTo: p => p,
    // Fullscreen is the app window's, not the page's.
    toggleFullscreen() { window.api?.input?.executeActions?.(['host:fullscreen']); },
    get isFullscreen() { return window.jmpInfo?.settings?.main?.fullscreen === true; },
    stop() { if (open) { open = false; player.stop(); } },
    destroy() {
      open = false;
      try { player.stop(); player.setVideoRectangle(-1, 0, 0, 0); } catch { /* gone */ }
      for (const [sig, fn] of Object.entries(on)) { try { player[sig]?.disconnect?.(fn); } catch { /* gone */ } }
      document.documentElement.classList.remove('mpv-playing');
      subs.clear();
    },
  };
}
