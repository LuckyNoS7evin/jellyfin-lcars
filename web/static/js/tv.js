// Driving LCARS with a TV remote (the LG TV app, any TV browser): the arrows move focus to the
// nearest control in that direction, OK presses it, Back goes back (closing what's open first,
// then leaving the app at Home), and the media keys run the player. As jellyfin-web does
// (official focusManager.js, keyboardNavigation.js, inputManager.js), focus is found by where
// things are on screen, within the dialog or menu that's open.
//
// TV mode: the TV app says so (NativeShell layout "tv"), or the browser is a TV's, or ?tv=1 was
// used once on this device (?tv=0 turns it off), which is how to try it on a computer.
import { native } from './shell.js';
import { store } from './api.js';

const TV_UA = /web0s|webos|smart-?tv|netcast|viera|tizen|hbbtv|\btv\b|titanos/i;
const KEY_BACK = new Set([461, 10009]); // webOS, Tizen
const MEDIA = {
  415: 'play', 19: 'pause', 10252: 'playpause', 179: 'playpause', 413: 'stop', 178: 'stop',
  412: 'rewind', 417: 'fastforward', 10232: 'previous', 10233: 'next', 176: 'next', 177: 'previous',
};
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

export function isTv() {
  const flag = new URLSearchParams(location.search).get('tv');
  if (flag === '1' || flag === '0') store.set('jfl.tv', flag === '1' ? '1' : null);
  return store.get('jfl.tv') === '1' || native.layout() === 'tv' || TV_UA.test(navigator.userAgent);
}

/** Visible, on-screen-ish, and not inside something hidden. */
function visible(el) {
  if (el.closest('[hidden], [inert]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
}

/** Where focus may go: the open dialog, the open menu, the player, or the page. */
function scope() {
  const dlgs = [...document.querySelectorAll('dialog[open]')];
  if (dlgs.length) return dlgs[dlgs.length - 1];
  const menu = document.querySelector('.item-menu');
  if (menu) return menu;
  return document.querySelector('.player') || document.body;
}

// A card's caption links where its picture does: one stop per card.
function candidates(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => !el.matches('.card-cap') && visible(el));
}

/**
 * The nearest control in a direction from the focused one: it must lie that way, and closer
 * along the direction beats closer to the side (an overlap on the cross axis counts most).
 */
function nearest(from, dir, list) {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main, cross, overlap;
    if (dir === 'left' || dir === 'right') {
      main = dir === 'right' ? b.left - a.right : a.left - b.right;
      if ((dir === 'right' ? bx <= ax : bx >= ax)) continue;
      cross = Math.abs(by - ay);
      overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
    } else {
      main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if ((dir === 'down' ? by <= ay : by >= ay)) continue;
      cross = Math.abs(bx - ax);
      overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
    }
    const score = Math.max(main, 0) + cross * (overlap ? 0.3 : 2);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function focus(el) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

/** The first thing worth focusing on a new page: the page's own content before the rail. */
export function focusFirst() {
  const root = scope();
  const main = root === document.body ? document.querySelector('main') : null;
  const list = candidates(main || root);
  // A title page's own buttons (Play, Resume, Read) before its genre links and the rest.
  const action = list.find(el => el.matches('.hero .actions button, .hero .actions .btn, .actions > button'));
  return focus(action || list[0] || candidates(root)[0]);
}

export function tvSetup(app, { canGoBack, goBack }) {
  if (!isTv()) return;
  app.tv = true;
  document.documentElement.classList.add('tv');

  function back() {
    const dlgs = [...document.querySelectorAll('dialog[open]')];
    if (dlgs.length) { dlgs[dlgs.length - 1].close(); return; }
    // The player and reader close on Escape, and menus too; give them the key first.
    const hadMenu = !!document.querySelector('.item-menu');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    if (!(document.activeElement || document.body).dispatchEvent(esc)) return;
    if (hadMenu) return;
    // Focus was on a control the player leaves keys to (the volume bar): close it anyway.
    if (app.player || document.querySelector('.player')) { app.player?.close?.(); return; }
    if (canGoBack()) goBack();
    else if (native.canExit()) native.exit();
  }

  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEY_BACK.has(e.keyCode) || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); back(); return; }
    const media = MEDIA[e.keyCode] || { MediaPlay: 'play', MediaPause: 'pause', MediaPlayPause: 'playpause', MediaStop: 'stop',
      MediaRewind: 'rewind', MediaFastForward: 'fastforward', MediaTrackNext: 'next', MediaTrackPrevious: 'previous' }[e.key];
    if (media) { e.preventDefault(); app.mediaKey?.(media); return; }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    if (!dir) return;
    const t = document.activeElement;
    // Typing: left and right move the caret; up and down leave the box.
    if (t?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea') && (dir === 'left' || dir === 'right')) return;
    const root = scope();
    const list = candidates(root);
    e.preventDefault();
    if (!t || t === document.body || t.matches('main') || !root.contains(t) || !visible(t)) { if (!focusFirst()) focus(list[0]); return; }
    focus(nearest(t, dir, list));
  });

  // A new page: put focus on its content once it has drawn (pages load their data first), unless
  // something on the page already took it.
  let pending = 0;
  const settle = () => {
    const my = ++pending;
    let tries = 0;
    const attempt = () => {
      if (my !== pending || document.querySelector('dialog[open], .player')) return;
      const main = document.querySelector('main');
      const t = document.activeElement;
      if (main && main.contains(t) && t !== main) return;
      if (t && t !== document.body && t !== main && !t.closest('header, nav') && visible(t)) return; // chosen already
      if (main && candidates(main).length && !main.querySelector('.loading')) { focusFirst(); return; }
      if (++tries < 30) setTimeout(attempt, 150);
    };
    setTimeout(attempt, 150);
  };
  window.addEventListener('hashchange', settle);
  settle(); // the first page too
  // A page that redraws itself (after playback, to show the new resume point) drops focus.
  // (Removing the focused element doesn't always fire focusout, so changes to the page are
  // watched too.)
  let lostTimer = null;
  const lost = () => {
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      if (document.activeElement === document.body && !document.querySelector('dialog[open], .player')) settle();
    }, 100);
  };
  document.addEventListener('focusout', lost);
  const mainEl = document.querySelector('main');
  if (mainEl) new MutationObserver(lost).observe(mainEl, { childList: true, subtree: true });
  // Opened dialogs get focus on their first control; when the player or reader (or a dialog)
  // goes, focus goes back to what opened it.
  let before = null; // the last thing focused on the page itself
  document.addEventListener('focusin', e => { if (!e.target.closest?.('dialog, .player')) before = e.target; });
  let overlay = false;
  new MutationObserver(() => {
    const d = [...document.querySelectorAll('dialog[open]')].pop();
    const now = !!(d || document.querySelector('.player'));
    if (d && !d.contains(document.activeElement)) focus(candidates(d)[0]);
    if (!now && overlay) { if (before?.isConnected && visible(before)) focus(before); else focusFirst(); }
    overlay = now;
  }).observe(document.body, { childList: true });
}
