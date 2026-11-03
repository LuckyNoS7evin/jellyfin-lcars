// Theme songs and theme videos on title pages (the official clients' "Theme songs" /
// "Theme videos" settings). A theme keeps playing while you move between pages that share
// it (series -> season -> episode) and fades out when you leave or start playback.

let cur = null;      // {key, el}
let claimed = false; // did the page being shown ask for a theme?

const FADE_MS = 1200;
const VOLUME = 0.45;

function fade(el, to, ms, done) {
  const from = el.volume;
  const t0 = performance.now();
  const step = now => {
    // rAF time can be a little before t0, which made k (and the volume) negative.
    const k = Math.max(0, Math.min(1, (now - t0) / ms));
    el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k < 1) requestAnimationFrame(step); else done?.();
  };
  requestAnimationFrame(step);
}

export function stopTheme() {
  if (!cur) return;
  const { el } = cur;
  cur = null;
  fade(el, 0, FADE_MS / 2, () => { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); });
}

/** Router hooks: a page that doesn't claim the theme stops it. */
export function beginRoute() { claimed = false; }
export function endRoute() { if (!claimed) stopTheme(); }

/**
 * Starts the item's theme (inherited from its series/season) if the settings allow.
 * heroBg: element to put a theme video in, behind the title.
 */
export async function themeFor(ctx, item, heroBg) {
  const { api, app, signal } = ctx;
  const us = app.us;
  if (!us.themeSongs && !us.themeVideos) return;
  claimed = true;
  // Don't talk over music or a video.
  if ((app.queue.active && !app.queue.paused) || app.player) { stopTheme(); return; }
  let r;
  try {
    r = await api.get(`/Items/${item.Id}/ThemeMedia`, { userId: api.userId, inheritFromParent: true }, { signal });
  } catch { return; }
  if (signal.aborted) return;
  const video = us.themeVideos ? r.ThemeVideosResult?.Items?.[0] : null;
  const song = us.themeSongs ? r.ThemeSongsResult?.Items?.[0] : null;

  if (video && heroBg) {
    stopTheme();
    const el = document.createElement('video');
    el.className = 'hero-video';
    el.loop = true;
    el.playsInline = true;
    el.volume = 0;
    el.src = api.url(`/Videos/${video.Id}/stream`, { static: true, mediaSourceId: video.Id }, { auth: true });
    heroBg.prepend(el);
    cur = { key: video.Id, el };
    el.play().then(() => fade(el, VOLUME, FADE_MS)).catch(() => { el.muted = true; el.play().catch(() => {}); });
    return;
  }
  if (!song) { stopTheme(); return; }
  if (cur?.key === song.Id) return; // already playing (e.g. series -> season)
  stopTheme();
  const el = new Audio();
  el.loop = true;
  el.volume = 0;
  el.src = api.url(`/Audio/${song.Id}/universal`, {
    UserId: api.userId, DeviceId: api.deviceId, MaxStreamingBitrate: 320000,
    Container: 'mp3,aac,m4a|aac,flac,webma,webm|webma,wav,ogg,opus', TranscodingContainer: 'mp3', TranscodingProtocol: 'http', AudioCodec: 'mp3',
  }, { auth: true });
  cur = { key: song.Id, el };
  el.play().then(() => fade(el, VOLUME, FADE_MS)).catch(() => { if (cur?.el === el) cur = null; });
}
