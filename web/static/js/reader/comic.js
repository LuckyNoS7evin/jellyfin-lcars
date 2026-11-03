// Comic reader (cbz): one or two pages at a time, left-to-right or right-to-left (manga).
// Pages are read straight out of the archive as they're needed, a few ahead.
import { h } from '../h.js';
import { btn } from '../ui.js';
import { IMAGE_RE } from './zip.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Progress is the page index, as the official comics player reports it (ms × 10 000 ticks).
const PAGE_TICKS = 10000;

export async function comicEngine({ app, zip, stage, item, startTicks, onChange }) {
  const pages = zip.entries
    .filter(e => IMAGE_RE.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  if (!pages.length) throw new Error('No pages in this archive');
  const n = pages.length;

  // ComicInfo.xml says whether it's right-to-left manga.
  let manga = null;
  const info = zip.entries.find(e => /(^|\/)comicinfo\.xml$/i.test(e.name));
  if (info) {
    try {
      const x = new DOMParser().parseFromString(await zip.text(info), 'application/xml');
      manga = x.getElementsByTagName('Manga')[0]?.textContent?.trim() || null;
    } catch { /* no hint */ }
  }

  // Settings: this series first, then what the book says, then whatever was used last.
  const seriesKey = `reader.comic.${item.ParentId || item.SeriesName || 'all'}`;
  const saved = app.us.local(seriesKey, null) || {};
  const last = app.us.local('reader.comic', {}) || {};
  const s = {
    rtl: saved.rtl ?? (manga ? manga === 'YesAndRightToLeft' : last.rtl ?? false),
    spread: saved.spread ?? last.spread ?? (innerWidth > innerHeight * 1.2),
    fit: saved.fit ?? last.fit ?? 'page',
  };
  const save = () => { app.us.setLocal(seriesKey, s); app.us.setLocal('reader.comic', s); };

  // ---- pages ------------------------------------------------------------------------------

  const cache = new Map(); // index -> Promise<{url, w, h}>
  function load(i) {
    if (i < 0 || i >= n) return Promise.resolve(null);
    let p = cache.get(i);
    if (!p) {
      p = zip.blob(pages[i]).then(async b => {
        const url = URL.createObjectURL(b);
        const img = new Image();
        img.src = url;
        try { await img.decode(); } catch { /* shown anyway */ }
        return { url, w: img.naturalWidth, h: img.naturalHeight };
      });
      p.catch(() => cache.delete(i));
      cache.set(i, p);
    }
    return p;
  }
  function trim() {
    for (const [i, p] of cache) {
      if (i >= at - 4 && i <= at + 10) continue;
      cache.delete(i);
      p.then(r => r && URL.revokeObjectURL(r.url)).catch(() => {});
    }
  }
  const portrait = r => r && r.w < r.h;

  // Two-page spreads: the cover is alone, then pages pair up from the second page (odd
  // indexes), unless either page of the pair is a landscape double-page scan.
  async function layout(i) {
    if (!s.spread || i === 0 || i % 2 === 0 || i + 1 >= n) return [i];
    const [a, b] = await Promise.all([load(i), load(i + 1)]);
    return portrait(a) && portrait(b) ? [i, i + 1] : [i];
  }
  async function align(i) {
    i = Math.max(0, Math.min(n - 1, i));
    if (s.spread && i > 1 && i % 2 === 0 && (await layout(i - 1)).length === 2) return i - 1;
    return i;
  }

  let at = 0;
  let shown = [0];
  let seq = 0;
  async function show(i) {
    const my = ++seq;
    const sh = await layout(i);
    const imgs = await Promise.all(sh.map(load));
    if (my !== seq) return;
    at = i;
    shown = sh;
    stage.classList.toggle('two', sh.length === 2);
    stage.classList.toggle('rtl', s.rtl);
    stage.classList.toggle('fit-width', s.fit === 'width');
    stage.replaceChildren(...imgs.filter(Boolean).map(r => h('img', { src: r.url, alt: '', draggable: 'false' })));
    stage.scrollTop = 0;
    trim();
    // Read ahead (and one back) so turning a page is instant.
    const end = at + shown.length;
    for (let k = 0; k < 4; k++) load(end + k);
    load(at - 1);
    onChange();
  }

  async function redraw() { save(); await show(await align(at)); }

  await show(await align(Math.round((startTicks || 0) / PAGE_TICKS)));

  const toggleDir = () => { s.rtl = !s.rtl; redraw(); };
  const toggleSpread = () => { s.spread = !s.spread; redraw(); };
  const toggleFit = () => { s.fit = s.fit === 'width' ? 'page' : 'width'; redraw(); };

  return {
    kind: 'Comic',
    info: () => ['CBZ', `${n} pages`, manga === 'YesAndRightToLeft' ? 'Manga' : null].filter(Boolean),
    get rtl() { return s.rtl; },
    readout: () => [shown.length === 2 ? `Pages ${at + 1}–${at + 2} of ${n}` : `Page ${at + 1} of ${n}`, `${Math.round(((at + shown.length) / n) * 100)}%`],
    fraction: () => (n > 1 ? (at + shown.length - 1) / (n - 1) : 1),
    ticks: () => at * PAGE_TICKS,
    atEnd: () => at + shown.length >= n,
    async next() { if (at + shown.length >= n) return 'end'; await show(at + shown.length); return null; },
    async prev() {
      if (at === 0) return 'start';
      let p = at - 1;
      if (s.spread && p > 1 && p % 2 === 0 && (await layout(p - 1)).length === 2) p--;
      await show(p);
      return null;
    },
    async goFraction(f) { await show(await align(Math.round(f * (n - 1)))); },
    scrolls: () => s.fit === 'width',
    buttons: () => [
      btn(s.rtl ? 'Right to left' : 'Left to right', toggleDir, { color: 'sky', title: 'Reading direction (D)' }),
      btn(s.spread ? 'Two pages' : 'One page', toggleSpread, { color: 'sky', title: 'Pages per view (2)' }),
      btn(s.fit === 'width' ? 'Fit width' : 'Fit page', toggleFit, { color: 'lilac', title: 'Page fit (W)' }),
    ],
    keys: { d: toggleDir, D: toggleDir, 2: toggleSpread, w: toggleFit, W: toggleFit },
    destroy() {
      seq++;
      for (const p of cache.values()) p.then(r => r && URL.revokeObjectURL(r.url)).catch(() => {});
      cache.clear();
    },
  };
}
