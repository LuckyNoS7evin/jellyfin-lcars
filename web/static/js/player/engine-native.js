// The iPhone app's own video player as an engine (see engine.js): when the Jellyfin app's
// "native video player" setting is on, it plays full screen over LCARS with its own controls,
// and tells LCARS where it is and whether it's paused (jellyfin-expo NativeVideoPlayer). LCARS
// still chooses the stream (PlaybackInfo with the app's device profile) and reports playback to
// Jellyfin, as jellyfin-web's playbackManager does for it.
import { h } from '../h.js';
import { events } from '../shell.js';

export function nativeEngine(app, pb, plugin) {
  const el = h('div.p-native', h('p', 'Playing in the app’s player'));
  const subs = new Map();
  const emit = (ev, data) => { for (const fn of subs.get(ev) || []) fn(data); };
  let duration = 0;
  let open = false;
  // The app's player starts playing by itself; until it has said so, there's nothing to toggle
  // (playPause is a toggle, so a "play" sent early would pause it).
  let started = false;
  // The app's player reports through the events hub; the core hears the usual engine events.
  const relay = [
    ['timeupdate', () => emit('timeupdate')],
    ['playing', () => { started = true; emit('playing'); }],
    ['unpause', () => emit('playing')],
    ['pause', () => { started = true; emit('pause'); }],
    // Finished, or closed in the app (it then calls playbackManager.stop first, see shell.js).
    ['stopped', () => { if (open) { open = false; emit('ended'); } }],
  ];
  for (const [ev, fn] of relay) events.on(plugin, ev, fn);

  return {
    kind: 'native',
    el,
    on(ev, fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); },
    // The app's own profile: what its player plays directly, and how it wants subtitles.
    profile({ maxBitrate } = {}) {
      const p = JSON.parse(JSON.stringify(window.ExpoVideoProfile || {}));
      if (maxBitrate) p.MaxStreamingBitrate = maxBitrate;
      return p;
    },
    async load({ url, startAt = 0, ms }) {
      duration = (ms?.RunTimeTicks || 0) / 1e7;
      open = true;
      started = false;
      await plugin.play({ url, item: ms, mediaSource: ms, mediaType: 'Video', playerStartPositionTicks: Math.round(startAt * 1e7), fullscreen: true });
      emit('durationchange');
      emit('canplaythrough');
    },
    setSubtitle() {}, setSecondarySubtitle: undefined,
    subtitleDelay: 0,
    subtitleStyle() {},
    aspect: 'auto',
    frameStep() {},
    stats: () => ({ width: null, height: null, dropped: null, frames: null, buffered: null, player: 'The app’s player', bandwidth: null, levelBitrate: null }),
    play() { if (started && plugin.paused?.()) plugin.playPause?.(); return Promise.resolve(); },
    pause() { if (started && !plugin.paused?.()) plugin.playPause?.(); },
    // Seeking happens in the app's own controls.
    seek() {},
    get paused() { return started ? !!plugin.paused?.() : false; },
    get position() { return (Number(plugin.currentTime?.()) || 0) / 1000; },
    get duration() { return duration; },
    get rate() { return 1; }, set rate(v) {},
    get volume() { return 1; }, set volume(v) {},
    get muted() { return false; }, set muted(v) {},
    bufferedTo: p => p,
    stop() { if (open) { open = false; plugin.stop?.(false); } },
    destroy() {
      open = false;
      try { plugin.stop?.(true); } catch { /* gone */ }
      for (const [ev, fn] of relay) events.off(plugin, ev, fn);
      subs.clear();
    },
  };
}
