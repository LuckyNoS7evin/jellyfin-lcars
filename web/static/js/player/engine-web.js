// The browser playback engine (see engine.js for the interface): a <video> element; hls.js for
// the server's HLS transcodes where the browser has no native HLS; <track>s for text subtitles,
// and canvas renderers for ASS/SSA and PGS (subs.js). Picture-in-picture and secondary
// subtitles are browser-only extras the core uses when they're there.
import { h } from '../h.js';
import { deviceProfile, caps } from './profile.js';
import { drawSubtitles, canvasKind, externalFormats } from './subs.js';

let Hls = null;
async function loadHls() {
  if (!Hls) Hls = (await import('../../vendor/hls.min.mjs')).default;
  return Hls;
}

const EVENTS = ['playing', 'pause', 'waiting', 'seeked', 'volumechange', 'ended', 'timeupdate', 'canplaythrough', 'durationchange', 'ratechange', 'click', 'dblclick'];

// Subtitle looks (official subtitleappearancehelper.js), for ::cue.
const SIZES = { smaller: '.8em', small: '1em', medium: '1.36em', large: '1.72em', larger: '2em', extralarge: '2.2em' };
const SHADOWS = {
  dropshadow: '#000 0 0 7px',
  raised: '-0.04em -0.04em #fff, 0 -0.04em #fff, -0.04em 0 #fff, 0.04em 0.04em #000, 0 0.04em #000, 0.04em 0 #000',
  depressed: '0.04em 0.04em #fff, 0 0.04em #fff, 0.04em 0 #fff, -0.04em -0.04em #000, 0 -0.04em #000, -0.04em 0 #000',
  uniform: '#000 0 0.03em, #000 0 -0.03em, #000 0 0.05em, #000 0 -0.05em, #000 0.03em 0, #000 -0.03em 0, #000 0.03em 0.03em, #000 -0.03em 0.03em, #000 0.03em -0.03em, #000 -0.03em -0.03em, #000 0.05em 0, #000 -0.05em 0',
  none: 'none',
};
export const SUB_FONTS = {
  '': '"Antonio", sans-serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  typewriter: '"Courier New", monospace',
  print: 'Georgia, "Times New Roman", serif',
  console: 'Consolas, "Lucida Console", Menlo, Monaco, monospace',
  cursive: '"Lucida Handwriting", "Brush Script MT", "Segoe Script", cursive',
  casual: 'Gabriola, "Segoe Print", "Comic Sans MS", Chalkboard, sans-serif',
  smallcaps: 'Copperplate, "Copperplate Gothic", system-ui, sans-serif',
};

/** CSS declarations for a subtitle appearance (settings.js subtitleAppearance). */
export function subtitleCss(a) {
  return {
    'font-size': SIZES[a.textSize] || SIZES.medium,
    'font-weight': a.textWeight === 'bold' ? 'bold' : 'normal',
    'font-family': SUB_FONTS[a.font] ?? SUB_FONTS[''],
    'font-variant': a.font === 'smallcaps' ? 'small-caps' : 'normal',
    'text-shadow': SHADOWS[a.dropShadow] || SHADOWS.dropshadow,
    'background-color': a.textBackground || 'transparent',
    color: a.textColor || '#fff',
  };
}

// One sheet for the cue look, shared by every player (adopted, so the CSP allows it).
let cueSheet = null;
function setCueStyle(a) {
  if (!cueSheet) {
    cueSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, cueSheet];
  }
  const css = Object.entries(subtitleCss(a)).map(([k, v]) => `${k}: ${v};`).join(' ');
  cueSheet.replaceSync(`.player .p-vid video::cue { ${css} text-transform: none; letter-spacing: normal; }`);
}

export function webEngine(app, pb) {
  const { api } = app;
  const video = h('video', { attrs: { playsinline: true, preload: 'auto', crossorigin: 'anonymous' } });
  const listeners = new Map();
  const emit = (type, detail) => { for (const fn of listeners.get(type) || []) fn(detail); };
  for (const t of EVENTS) video.addEventListener(t, e => emit(t, e));

  let hls = null;
  let token = 0;            // bumps on every load/stop so late callbacks are ignored
  let direct = false;
  let ms = null;
  let subR = null;          // canvas subtitle renderer (ASS/PGS), if one is drawing
  let subToken = 0;
  let subIdx = null;        // stream indexes of the <track>s showing
  let sub2Idx = null;
  let delay = 0;            // subtitle delay, seconds
  let line = Number(pb.subtitles?.verticalPosition ?? -3);
  const orig = new WeakMap(); // cue -> its own [start, end], so delays don't add up
  setCueStyle(pb.subtitles || {});

  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return; // stop() empties the source; that isn't an error
    emit('error', { message: video.error?.message || 'Media error', direct });
  });

  function stopCanvasSubs() {
    subToken++;
    subR?.destroy();
    subR = null;
  }

  function stop() {
    token++;
    stopCanvasSubs();
    subIdx = sub2Idx = null;
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.querySelectorAll('track').forEach(t => t.remove());
    video.load();
  }

  async function load({ url, hls: isHls, direct: d, startAt, ms: source, subs = [] }) {
    stop();
    const my = token;
    direct = !!d;
    ms = source;
    // Text subtitles become <track>s and switch instantly; ASS and PGS are drawn on a canvas.
    for (const s of subs.filter(x => !canvasKind(x))) {
      const t = h('track', { kind: 'subtitles', label: s.DisplayTitle || s.Language || `Track ${s.Index}`, srclang: s.Language || 'und', src: s.url });
      t.dataset.index = s.Index;
      t.addEventListener('load', () => fixCues(t));
      video.append(t);
    }
    const seekOnLoad = () => video.addEventListener('loadedmetadata', () => { if (startAt) video.currentTime = startAt; }, { once: true });
    if (!isHls || (caps().nativeHls && !window.MediaSource)) {
      video.src = url;
      seekOnLoad();
      return;
    }
    const H = await loadHls();
    if (my !== token) return;
    hls = new H({ startPosition: startAt || 0, maxBufferLength: 30, maxMaxBufferLength: 120, backBufferLength: 60, manifestLoadingTimeOut: 30000, levelLoadingTimeOut: 30000, fragLoadingTimeOut: 60000 });
    let recovered = false;
    hls.on(H.Events.ERROR, (_, e) => {
      if (!e.fatal) return;
      if (e.type === H.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
      if (e.type === H.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
      emit('error', { message: e.details, direct: false });
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  const trackEls = () => [...video.querySelectorAll('track')];

  // Delay and position every cue of a loaded track: the main one sits `line` lines from the
  // bottom (official verticalPosition), the secondary one at the top.
  function fixCues(el) {
    const cues = el.track?.cues;
    if (!cues) return;
    const idx = Number(el.dataset.index);
    for (const c of cues) {
      if (!orig.has(c)) orig.set(c, [c.startTime, c.endTime]);
      const [a, b] = orig.get(c);
      c.startTime = Math.max(0, a + delay);
      c.endTime = Math.max(0, b + delay);
      c.snapToLines = true;
      c.line = idx === sub2Idx && idx !== subIdx ? 0 : line;
    }
  }

  function showTracks() {
    // A <track> only loads once its mode is set; give the element a tick to register.
    requestAnimationFrame(() => {
      trackEls().forEach((el, i) => {
        const n = Number(el.dataset.index);
        const t = video.textTracks[i];
        if (!t) return;
        t.mode = n === subIdx || n === sub2Idx ? 'showing' : 'disabled';
        fixCues(el);
      });
    });
  }

  function setSubtitle(s) {
    stopCanvasSubs();
    subIdx = null;
    if (s && canvasKind(s)) {
      showTracks();
      const my = subToken;
      const fail = e => { if (my === subToken) { console.warn('[subs]', e); emit('subtitlefailed', e); } };
      drawSubtitles(api, video, s, ms, { onError: fail, delay })
        .then(r => { if (my === subToken) subR = r; else r?.destroy(); })
        .catch(fail);
      return;
    }
    if (s) subIdx = s.Index;
    showTracks();
  }

  /** Browser only: a second text subtitle at the top of the picture (null for none). */
  function setSecondarySubtitle(s) {
    sub2Idx = s && !canvasKind(s) ? s.Index : null;
    showTracks();
  }

  function setDelay(d) {
    delay = Math.round(d * 10) / 10;
    subR?.setDelay?.(delay);
    trackEls().forEach(fixCues);
  }

  const vstream = () => ms?.MediaStreams?.find(x => x.Type === 'Video');

  video.addEventListener('enterpictureinpicture', () => emit('pipchange', true));
  video.addEventListener('leavepictureinpicture', () => emit('pipchange', false));

  return {
    name: 'web',
    el: video,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    profile: ({ maxBitrate, burnIn = false } = {}) => deviceProfile({
      maxBitrate,
      external: burnIn ? [] : externalFormats(pb.subtitleBurnIn),
      maxWidth: pb.maxVideoWidth, limitWidth: pb.limitVideoWidth, audioChannels: pb.allowedAudioChannels,
      videoCodec: pb.preferredVideoCodec, audioCodec: pb.preferredAudioCodec,
    }),
    load,
    setSubtitle,
    setSecondarySubtitle,
    get subtitleDelay() { return delay; },
    set subtitleDelay(d) { setDelay(d); },
    subtitleStyle(a) { line = Number(a.verticalPosition ?? -3); setCueStyle(a); trackEls().forEach(fixCues); },
    // auto (letterbox), cover (fill the screen, cropping) or fill (stretch).
    get aspect() { return video.dataset.aspect || 'auto'; },
    set aspect(a) { video.dataset.aspect = a; },
    /** One frame on (dir 1) or back (-1), paused. */
    frameStep(dir) {
      const v = vstream();
      const fps = v?.RealFrameRate || v?.AverageFrameRate || 24;
      video.pause();
      video.currentTime = Math.max(0, video.currentTime + dir / fps);
    },
    /** Numbers for the playback info overlay. */
    stats() {
      const q = video.getVideoPlaybackQuality?.();
      const lvl = hls?.levels?.[hls.currentLevel];
      return {
        width: video.videoWidth, height: video.videoHeight,
        dropped: q?.droppedVideoFrames ?? null, frames: q?.totalVideoFrames ?? null,
        buffered: Math.max(0, this.bufferedTo(video.currentTime) - video.currentTime),
        player: hls ? 'hls.js' : (direct ? 'Browser (direct)' : 'Browser (native HLS)'),
        bandwidth: hls?.bandwidthEstimate || null,
        levelBitrate: lvl?.bitrate || null,
      };
    },
    // Picture-in-picture (browser only).
    get canPip() { return !!document.pictureInPictureEnabled && !video.disablePictureInPicture; },
    get pip() { return document.pictureInPictureElement === video; },
    togglePip() {
      if (document.pictureInPictureElement === video) return document.exitPictureInPicture();
      return video.requestPictureInPicture();
    },
    play: () => video.play(),
    pause: () => video.pause(),
    seek: s => { video.currentTime = s; },
    get paused() { return video.paused; },
    get position() { return video.currentTime || 0; },
    get duration() { return Number.isFinite(video.duration) ? video.duration : 0; },
    get rate() { return video.playbackRate || 1; },
    // defaultPlaybackRate too, so the speed survives loading the next item.
    set rate(r) { video.defaultPlaybackRate = video.playbackRate = r; },
    get volume() { return video.volume; },
    set volume(v) { video.volume = Math.max(0, Math.min(1, v)); },
    get muted() { return video.muted; },
    set muted(m) { video.muted = !!m; },
    bufferedTo(p) {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= p + 1) end = Math.max(end, video.buffered.end(i));
      return end;
    },
    stop,
    destroy() {
      if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
      stop();
    },
  };
}
