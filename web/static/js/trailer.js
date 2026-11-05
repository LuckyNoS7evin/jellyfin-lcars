// Remote trailers (a film's YouTube trailer from its metadata) in the player's LCARS frame, as
// the official client's YouTube player does, instead of a YouTube tab. YouTube's own player in
// a frame, from its privacy-enhanced address (no cookies until it plays). Other sites open in a
// new tab as before.
import { h } from './h.js';
import { btn } from './ui.js';
import { native } from './shell.js';

/** The YouTube video id in a watch, short, embed or shorts address, or null. */
export function youTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts|v)\/([^/]+)/)?.[1] || null;
    }
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch { return null; }
}

/** The trailer to offer from an item's RemoteTrailers: a YouTube one first. */
export function remoteTrailer(it) {
  const list = (it?.RemoteTrailers || []).filter(t => /^https?:/i.test(t.Url || ''));
  return list.find(t => youTubeId(t.Url)) || list[0] || null;
}

/** Play a remote trailer: YouTube here, anything else in a new tab. Returns a controller or null. */
export function openTrailer(app, item, trailer) {
  const id = youTubeId(trailer.Url);
  if (!id) { native.openExternal(trailer.Url); return null; }
  let closed = false;

  const params = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', modestbranding: '1' });
  const frame = h('iframe.tr-frame', {
    src: `https://www.youtube-nocookie.com/embed/${id}?${params}`,
    title: trailer.Name || `${item.Name} trailer`,
    attrs: {
      allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
      allowfullscreen: '',
      // YouTube refuses to play embeds that don't say which site they're on.
      referrerpolicy: 'strict-origin-when-cross-origin',
    },
  });
  const root = h('div.player.trailer', { attrs: { role: 'dialog', 'aria-label': 'Trailer' } },
    h('div.tr-top',
      h('span.cap'),
      h('div.p-title', h('b', item.Name), h('span', trailer.Name && trailer.Name !== item.Name ? trailer.Name : 'Trailer')),
      btn('Open on YouTube', () => native.openExternal(trailer.Url), { small: true, color: 'blue', title: 'Watch it on YouTube instead' }),
      btn('Exit', close, { small: true, color: 'red' })),
    h('div.tr-stage', frame));

  // Keys reach us while the page has focus; once the trailer's frame has it, Exit closes.
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === 461) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    frame.src = 'about:blank'; // stops the sound at once
    root.remove();
    app.onPlayerClosed?.(item, ctl);
  }

  document.body.append(root);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  const noop = () => {};
  const ctl = {
    kind: 'trailer',
    item: () => item,
    close,
    toggle: noop, pause: noop, play: noop, seekTo: noop, next: noop, prev: noop,
  };
  return ctl;
}
