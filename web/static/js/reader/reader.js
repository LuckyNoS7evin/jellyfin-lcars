// The book reader overlay: comics (cbz), PDFs and EPUBs, in the player's LCARS frame. Turn pages
// with the arrow keys, a click or tap on either side, a swipe, or the wheel; the middle of the
// page shows and hides the controls. Progress goes to Jellyfin on every page turn.
import { h, fill } from '../h.js';
import { TICKS, randomId } from '../api.js';
import { btn, arrow, tag, toast } from '../ui.js';
import { Reporter } from '../player/report.js';
import { RemoteZip } from './zip.js';
import { comicEngine } from './comic.js';
import { epubEngine } from './epub.js';
import { bookSeries, nextVolume } from '../books.js';

// zip: the book is a zip read with Range requests (whole: fetched in one go below that size).
// PDFs bring pdf.js, which does its own ranges, only when one is opened.
const FORMATS = {
  cbz: { zip: true, make: comicEngine },
  zip: { zip: true, make: comicEngine },
  epub: { zip: true, whole: 64 << 20, make: epubEngine },
  pdf: { make: ctx => import('./pdf.js').then(m => m.pdfEngine(ctx)) },
};

export function openReader(app, item, opts = {}) {
  const { api } = app;
  const ac = new AbortController();
  const stage = h('div.r-stage');
  const statusEl = h('div.p-status.blink', 'Accessing archive');
  const titleEl = h('div.p-title');
  const infoEl = h('div.p-info');
  const timeEl = h('div.p-time');
  const posEl = h('div.pos');
  const scrub = h('div.scrub', { attrs: { role: 'slider', 'aria-label': 'Position', tabindex: 0 } }, posEl);
  const btnsEl = h('div.p-btns');
  const endEl = h('div.r-end', { hidden: true });
  let menuEl = null;
  const root = h('div.player.reader', { attrs: { role: 'dialog', 'aria-label': 'Reader' } },
    stage, statusEl,
    h('div.p-ui',
      h('div.p-top', h('span.cap'), titleEl, infoEl),
      h('div.p-bot', timeEl, scrub, btnsEl)),
    endEl);

  let cur = item;
  let engine = null;
  let reporter = null;
  let closed = false;
  let nextBook;      // undefined: not looked up yet; null: none
  let dragFrac = null;

  // ---- drawing ----------------------------------------------------------------------------
  function drawTitle() {
    fill(titleEl, h('b', cur.Name), cur.SeriesName || cur.Album ? h('span', cur.SeriesName || cur.Album) : '');
  }
  function drawInfo() {
    fill(infoEl, ...(engine ? engine.info().map((t, i) => tag(t, ['blue', 'lilac', 'sky'][i % 3])) : []),
      btn('Exit', close, { small: true, color: 'red' }));
  }
  function drawPos() {
    if (!engine) return;
    const f = dragFrac ?? engine.fraction();
    const [left, right] = engine.readout();
    fill(timeEl, h('span', left), h('span', right));
    scrub.classList.toggle('rtl', !!engine.rtl);
    posEl.style.width = `${f * 100}%`;
    scrub.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }
  function drawButtons() {
    fill(btnsEl,
      btn(arrow('l'), () => side('left'), { color: 'orange', title: engine?.rtl ? 'Next page' : 'Previous page' }),
      btn(arrow('r'), () => side('right'), { color: 'orange', title: engine?.rtl ? 'Previous page' : 'Next page' }),
      ...(engine ? engine.buttons() : []),
      h('span.grow'),
      btn(document.fullscreenElement ? 'Window' : 'Full screen', fullscreen, { color: 'salmon' }),
      h('span.grow.r'));
  }
  function setStatus(text, blink = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('blink', blink);
  }

  // ---- progress ---------------------------------------------------------------------------
  // Reported on each page turn (bundled when pages flip quickly), not on a timer.
  let reportTimer = null;
  function changed() {
    drawPos();
    drawButtons();
    if (!engine) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => reporter?.progress('TimeUpdate'), 500);
    if (engine.atEnd() && !cur.UserData?.Played) {
      cur.UserData = { ...cur.UserData, Played: true };
      api.setPlayed(cur.Id, true).catch(() => {});
    }
  }

  async function start() {
    try {
      cur = await api.item(item.Id);
      drawTitle();
      const ext = (cur.Path || '').split('.').pop().toLowerCase();
      const fmt = FORMATS[ext];
      if (!fmt) throw new Error(`${ext ? ext.toUpperCase() : 'This'} books can't be opened here yet`);
      const url = api.url(`/Items/${cur.Id}/File`, {}, { auth: true });
      const zip = fmt.zip ? await new RemoteZip(url, { signal: ac.signal, wholeBelow: fmt.whole || 0 }).open() : null;
      if (closed) return;
      const ud = cur.UserData || {};
      const startTicks = opts.startTicks ?? (opts.fromStart || ud.Played ? 0 : ud.PlaybackPositionTicks || 0);
      setStatus('');
      engine = await fmt.make({ app, zip, url, signal: ac.signal, stage, item: cur, startTicks, onChange: changed, menu });
      if (closed) { engine.destroy(); return; }
      reporter = new Reporter(api, { itemId: cur.Id, mediaSourceId: cur.Id, playSessionId: randomId(), playMethod: 'DirectPlay' },
        () => ({ position: engine.ticks() / TICKS, paused: false }));
      reporter.start(0);
      drawInfo();
      changed();
      poke();
    } catch (e) {
      if (closed || e.name === 'AbortError') return;
      setStatus('Unable to comply');
      toast('Unable to open book', e.message, 'red', 8000);
    }
  }

  // ---- turning pages ------------------------------------------------------------------------
  let busy = false;
  async function turn(dir) {
    if (!engine || busy) return;
    if (!endEl.hidden) { if (dir === 'prev') hideEnd(); return; }
    busy = true;
    try {
      const r = await (dir === 'next' ? engine.next() : engine.prev());
      if (r === 'end') showEnd();
      else if (r === 'start') toast('First page', '', 'sky', 1500);
    } catch (e) {
      toast('Page failure', e.message, 'red');
    } finally { busy = false; }
  }
  /** Left and right on screen: which way that is depends on the reading direction. */
  const side = s => turn((s === 'right') !== !!engine?.rtl ? 'next' : 'prev');

  async function findNext() {
    if (nextBook !== undefined) return nextBook;
    nextBook = null;
    try {
      nextBook = nextVolume(await bookSeries(api, cur), cur);
    } catch { /* none */ }
    return nextBook;
  }

  async function showEnd() {
    const nb = await findNext();
    fill(endEl,
      h('span.cap'),
      h('div.r-end-body',
        h('small', 'End of record'),
        h('b', cur.Name),
        nb ? h('span', `Next: ${nb.Name}`) : h('span', cur.SeriesName ? `Last book in ${cur.SeriesName}` : ''),
        h('div.actions',
          nb ? btn(`Read next`, () => openNext(nb), { color: 'orange' }) : null,
          btn('Back', hideEnd, { color: 'sky' }),
          btn('Close', close, { color: 'red' }))));
    endEl.hidden = false;
    root.classList.remove('idle');
    endEl.querySelector('button')?.focus();
  }
  function hideEnd() { endEl.hidden = true; }
  async function openNext(nb) {
    await close();
    app.read(nb, { fromStart: !nb.UserData?.PlaybackPositionTicks });
  }

  // ---- menus (contents) ---------------------------------------------------------------------
  function closeMenu() { menuEl?.remove(); menuEl = null; }
  function menu(title, rows, color = 'sky') {
    if (menuEl) { closeMenu(); return; }
    menuEl = h('div.p-menu.r-menu', { class: `c-${color}` }, h('h3', title),
      rows.map(([label, on, fn]) => h('button', { type: 'button', class: on ? 'on' : '', onclick: () => { closeMenu(); fn(); } }, label)));
    root.append(menuEl);
    (menuEl.querySelector('button.on') || menuEl.querySelector('button'))?.focus();
    menuEl.querySelector('button.on')?.scrollIntoView({ block: 'center' });
  }

  // ---- input ----------------------------------------------------------------------------------
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  }

  // Click/tap: outer thirds turn the page, the middle shows or hides the controls.
  let swiped = false;
  let down = null;
  stage.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; swiped = false; });
  stage.addEventListener('pointerup', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (e.pointerType !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; side(dx < 0 ? 'right' : 'left'); }
    down = null;
  });
  stage.addEventListener('click', e => {
    if (swiped || menuEl) { closeMenu(); return; }
    if (getSelection()?.toString()) return;
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.3) side('left');
    else if (x > 0.7) side('right');
    else root.classList.toggle('idle');
  });
  // The wheel turns pages, unless the page itself scrolls (fit width) and isn't at its end.
  let wheelAt = 0;
  stage.addEventListener('wheel', e => {
    if (engine?.scrolls()) {
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const atTop = stage.scrollTop <= 0;
      if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;
    }
    e.preventDefault();
    if (Date.now() - wheelAt < 350 || Math.abs(e.deltaY) < 4) return;
    wheelAt = Date.now();
    turn(e.deltaY > 0 ? 'next' : 'prev');
  }, { passive: false });

  // Scrub bar: drag to preview the position, let go to jump there.
  const fracAt = e => {
    const r = scrub.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return engine?.rtl ? 1 - f : f;
  };
  scrub.addEventListener('pointerdown', e => { if (!engine) return; scrub.setPointerCapture(e.pointerId); dragFrac = fracAt(e); drawPos(); });
  scrub.addEventListener('pointermove', e => { if (dragFrac != null && scrub.hasPointerCapture(e.pointerId)) { dragFrac = fracAt(e); drawPos(); } });
  scrub.addEventListener('pointerup', async () => {
    if (dragFrac == null) return;
    const f = dragFrac;
    dragFrac = null;
    hideEnd();
    await engine.goFraction(f);
  });

  function onKey(e) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const inMenu = !!e.target.closest?.('.p-menu, .r-end, .p-btns');
    const scrollKeys = engine?.scrolls();
    const handled = {
      ArrowRight: () => side('right'), ArrowLeft: () => side('left'),
      ArrowDown: () => (scrollKeys || inMenu ? false : turn('next')),
      ArrowUp: () => (scrollKeys || inMenu ? false : turn('prev')),
      ' ': () => (inMenu ? false : turn(e.shiftKey ? 'prev' : 'next')),
      PageDown: () => turn('next'), PageUp: () => turn('prev'),
      Home: () => engine?.goFraction(0), End: () => engine?.goFraction(1),
      f: fullscreen, F: fullscreen,
      Escape: () => { if (menuEl) closeMenu(); else if (!endEl.hidden) hideEnd(); else if (!document.fullscreenElement) close(); },
      ...(engine?.keys || {}),
    }[k];
    if (!handled) return;
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && menuEl) return;
    if (handled() === false) return;
    e.preventDefault();
    e.stopPropagation();
    poke();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('fullscreenchange', drawButtons);

  // Controls fade after a few seconds; moving the mouse brings them back.
  let idleTimer = null;
  function poke() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!menuEl && endEl.hidden) root.classList.add('idle'); }, 2500);
  }
  root.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') poke(); });

  async function close() {
    if (closed) return;
    closed = true;
    ac.abort();
    clearTimeout(reportTimer);
    clearTimeout(idleTimer);
    closeMenu();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', drawButtons);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (reporter) await reporter.stop();
    engine?.destroy();
    root.remove();
    app.onPlayerClosed?.(cur, ctl);
  }

  document.body.append(root);
  drawTitle();
  drawInfo();
  drawButtons();
  start();

  const noop = () => {};
  const ctl = {
    kind: 'book',
    item: () => cur,
    close,
    toggle: noop, pause: noop, play: noop, seekTo: noop,
    next: () => turn('next'), prev: () => turn('prev'),
  };
  return ctl;
}
