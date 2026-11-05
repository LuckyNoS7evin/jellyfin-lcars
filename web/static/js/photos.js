// The photo viewer (official slideshow.js, without the slideshow): one photo at a time in the
// player's LCARS frame, stepping through the photos it was opened among (an album, a library
// page, search results). Images come from the server's image endpoint, so formats a browser
// can't show (camera raw) arrive as JPEG or WebP. Arrow keys, a click on either side, a swipe or
// the wheel step; the middle shows and hides the controls; Zoom shows actual pixels.
import { h, fill } from './h.js';
import { btn, arrow, tag } from './ui.js';
import { download } from './menu.js';

const fmtDate = iso => {
  const d = iso && new Date(iso);
  return d && !isNaN(d) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
};

// Jellyfin keeps the EXIF aperture value (APEX), not the f-number: f = 2^(value/2).
const fNumber = av => (av > 0 ? `f/${(2 ** (av / 2)).toFixed(1).replace(/\.0$/, '')}` : '');
const ext = p => (p.Path || '').match(/\.(\w+)$/)?.[1]?.toUpperCase() || '';

/** openPhotos(app, items, index) -> controller. items: Photo items, in order. */
export function openPhotos(app, items, index = 0) {
  const { api } = app;
  const list = items.filter(i => i.Type === 'Photo');
  let i = Math.max(0, list.findIndex(p => p.Id === items[index]?.Id));
  let closed = false;
  let zoom = false;
  let infoOn = false;
  const full = new Map(); // id -> the full item (camera details), fetched when Info is open

  const img = h('img', { alt: '', attrs: { draggable: 'false' } });
  const stage = h('div.ph-stage', img);
  const statusEl = h('div.p-status');
  const titleEl = h('div.p-title');
  const infoEl = h('div.p-info');
  const countEl = h('div.p-time');
  const btnsEl = h('div.p-btns');
  const panel = h('div.ph-info', { hidden: true });
  const root = h('div.player.photos', { attrs: { role: 'dialog', 'aria-label': 'Photo viewer' } },
    stage, statusEl, panel,
    h('div.p-ui',
      h('div.p-top', h('span.cap'), titleEl, infoEl),
      h('div.p-bot', countEl, btnsEl)));

  // Sized for the screen (device pixels), or the whole picture when zoomed.
  const src = (p, big = false) => {
    if (!p?.ImageTags?.Primary && !p?.PrimaryImageTag) return null;
    const tag = p.ImageTags?.Primary || p.PrimaryImageTag;
    if (big) return api.url(`/Items/${p.Id}/Images/Primary`, { tag, quality: 92 });
    const dpr = Math.min(devicePixelRatio || 1, 2);
    return api.url(`/Items/${p.Id}/Images/Primary`, {
      tag, quality: 90, maxWidth: Math.round(innerWidth * dpr), maxHeight: Math.round(innerHeight * dpr),
    });
  };
  const preload = p => { const u = src(p); if (u) { const x = new Image(); x.src = u; } };

  function show() {
    const p = list[i];
    if (!p) return;
    zoom = false;
    stage.classList.remove('zoom');
    stage.scrollTo(0, 0);
    statusEl.textContent = 'Accessing image';
    statusEl.classList.add('blink');
    statusEl.hidden = false;
    const u = src(p);
    if (!u) { statusEl.textContent = 'No image'; statusEl.classList.remove('blink'); img.removeAttribute('src'); }
    else img.src = u;
    preload(list[i + 1]);
    preload(list[i - 1]);
    draw();
    // The full record: the file type for the top line (001.CR2 beside 001.JPG), and Info.
    if (!full.has(p.Id)) {
      api.item(p.Id).then(d => { full.set(p.Id, d); if (list[i] === p && !closed) draw(); }).catch(() => {});
    }
  }
  img.addEventListener('load', () => { statusEl.hidden = true; });
  img.addEventListener('error', () => { statusEl.textContent = 'Unable to display this image'; statusEl.classList.remove('blink'); statusEl.hidden = false; });

  function draw() {
    const p = full.get(list[i].Id) || list[i];
    fill(titleEl, h('b', p.Name), p.Album || p.ParentName ? h('span', p.Album || '') : '');
    fill(infoEl,
      p.Width && p.Height ? tag(`${p.Width}×${p.Height}`, 'lilac') : null,
      ext(p) ? tag(ext(p), 'blue') : null,
      btn('Exit', close, { small: true, color: 'red' }));
    fill(countEl, h('span', `${i + 1} / ${list.length}`), h('span', fmtDate(p.PremiereDate || p.DateCreated)));
    fill(btnsEl,
      btn(arrow('l'), () => step(-1), { color: 'orange', title: 'Previous photo', disabled: i === 0 }),
      btn(arrow('r'), () => step(1), { color: 'orange', title: 'Next photo', disabled: i >= list.length - 1 }),
      btn(zoom ? 'Fit' : 'Zoom', toggleZoom, { color: 'sky', title: zoom ? 'Fit to the screen (Z)' : 'Actual size (Z)' }),
      btn('Info', toggleInfo, { color: 'sky', ghost: !infoOn, title: 'Date, camera and place (I)' }),
      p.CanDownload ? btn('Download', () => download(api, [p]), { color: 'lilac', title: 'The original file' }) : null,
      h('span.grow'),
      btn(document.fullscreenElement ? 'Window' : 'Full screen', fullscreen, { color: 'salmon' }),
      h('span.grow.r'));
    if (infoOn) drawPanel();
  }

  async function drawPanel() {
    const p = list[i];
    panel.hidden = false;
    let d = full.get(p.Id);
    if (!d) {
      fill(panel, h('p', 'Accessing'));
      try { d = await api.item(p.Id); full.set(p.Id, d); } catch { d = p; }
      if (list[i] !== p || !infoOn) return;
    }
    const exp = d.ExposureTime ? (d.ExposureTime < 1 ? `1/${Math.round(1 / d.ExposureTime)} s` : `${d.ExposureTime} s`) : '';
    // Models often start with the make already ("Canon EOS 550D").
    const camera = d.CameraModel && d.CameraMake && d.CameraModel.toLowerCase().startsWith(d.CameraMake.toLowerCase())
      ? d.CameraModel : [d.CameraMake, d.CameraModel].filter(Boolean).join(' ');
    const where = d.Latitude != null && d.Longitude != null && (d.Latitude || d.Longitude)
      ? `${d.Latitude.toFixed(5)}, ${d.Longitude.toFixed(5)}` : '';
    const rows = [
      ['Taken', fmtDate(d.PremiereDate)],
      ['Added', fmtDate(d.DateCreated)],
      ['Size', d.Width && d.Height ? `${d.Width} × ${d.Height}` : ''],
      ['Camera', camera],
      ['Settings', [fNumber(d.Aperture), exp, d.IsoSpeedRating && `ISO ${d.IsoSpeedRating}`, d.FocalLength && `${d.FocalLength} mm`].filter(Boolean).join(' · ')],
      ['Place', where],
      ['File', (d.Path || '').split('/').pop()],
    ].filter(([, v]) => v);
    fill(panel, h('h3', 'Photo record'), h('dl', rows.map(([k, v]) => [h('dt', k), h('dd', k === 'Place'
      ? h('a', { href: `https://www.openstreetmap.org/?mlat=${d.Latitude}&mlon=${d.Longitude}#map=15/${d.Latitude}/${d.Longitude}`, target: '_blank', rel: 'noopener' }, v)
      : v)])));
  }

  function toggleInfo() {
    infoOn = !infoOn;
    panel.hidden = !infoOn;
    draw();
  }

  function toggleZoom() {
    const p = list[i];
    zoom = !zoom;
    stage.classList.toggle('zoom', zoom);
    if (zoom) {
      const u = src(p, true);
      if (u) img.src = u;
    } else {
      img.src = src(p);
      stage.scrollTo(0, 0);
    }
    draw();
  }

  function step(n) {
    const to = i + n;
    if (to < 0 || to >= list.length) return;
    i = to;
    show();
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  }

  // Click/tap: outer thirds step, the middle shows or hides the controls. Zoomed, clicks pan.
  let down = null;
  let swiped = false;
  stage.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; swiped = false; });
  stage.addEventListener('pointerup', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!zoom && e.pointerType !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; step(dx < 0 ? 1 : -1); }
    down = null;
  });
  stage.addEventListener('click', e => {
    if (swiped || zoom) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.3) step(-1);
    else if (x > 0.7) step(1);
    else root.classList.toggle('idle');
  });
  stage.addEventListener('dblclick', toggleZoom);
  let wheelAt = 0;
  stage.addEventListener('wheel', e => {
    if (zoom) return;
    e.preventDefault();
    if (Date.now() - wheelAt < 300 || Math.abs(e.deltaY) < 4) return;
    wheelAt = Date.now();
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  function onKey(e) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const handled = {
      ArrowRight: () => (zoom ? false : step(1)), ArrowLeft: () => (zoom ? false : step(-1)),
      PageDown: () => step(1), PageUp: () => step(-1),
      Home: () => step(-i), End: () => step(list.length - 1 - i),
      z: toggleZoom, Z: toggleZoom, i: toggleInfo, I: toggleInfo,
      f: fullscreen, F: fullscreen,
      Escape: () => { if (zoom) toggleZoom(); else if (!document.fullscreenElement) close(); else return false; },
      Backspace: () => close(),
    }[k] || (e.keyCode === 461 ? () => close() : null); // a TV remote's Back
    if (!handled) return;
    if (handled() === false) return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('fullscreenchange', draw);

  // Controls fade after a few seconds; moving the mouse brings them back.
  let idleTimer = null;
  function poke() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('idle'), 3000);
  }
  root.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') poke(); });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', draw);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    root.remove();
    app.onPlayerClosed?.(list[i], ctl);
  }

  document.body.append(root);
  // Keys are the viewer's now, not the box it was opened from (search).
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  show();
  poke();

  const noop = () => {};
  const ctl = {
    kind: 'photos',
    item: () => list[i],
    close,
    toggle: noop, pause: noop, play: noop, seekTo: noop,
    next: () => step(1), prev: () => step(-1),
  };
  return ctl;
}
