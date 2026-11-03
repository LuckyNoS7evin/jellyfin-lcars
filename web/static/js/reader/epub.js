// EPUB reader: each chapter is laid out in columns inside a shadow root and turned a page
// (one or two columns) at a time. The book's own CSS applies, scoped to the shadow root, with
// the reader's font, size and colours on top. Scripts, forms and remote resources are dropped.
import { h } from '../h.js';
import { btn } from '../ui.js';
import { IMAGE_RE } from './zip.js';

// Progress is a fraction of the book (official bookPlayer: 1000 ms "duration" → ticks).
const BOOK_TICKS = 10000000;
const GAP = 64;
const THEMES = {
  night: { label: 'Night', bg: '#000', fg: '#e6dfd2', link: '#99ccff' },
  lcars: { label: 'LCARS', bg: '#000', fg: '#ffcc99', link: '#99ccff' },
  paper: { label: 'Paper', bg: '#f3ead7', fg: '#2a241c', link: '#8a4b00' },
};
const FONTS = { book: 'Book font', serif: 'Serif', sans: 'Sans' };
const DROP = 'script, iframe, frame, object, embed, link, meta, style, base, form, input, button, select, textarea, audio, video';

const BASE_CSS = `
:host { all: initial; display: block; position: absolute; inset: 0; overflow: hidden; contain: strict; text-align: start; }
.view { position: absolute; top: 44px; bottom: 52px; left: 50%; overflow: hidden; }
.flow { height: 100%; column-fill: auto; }
.x-html, .x-body { height: auto; }`;

const OVERRIDE_CSS = `
.x-html, .x-body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important;
  margin: 0 !important; padding: 0 !important; columns: auto !important; writing-mode: horizontal-tb !important; }
.x-html { font-size: var(--fs) !important; line-height: 1.6; }
.x-body { color: var(--fg) !important; background: none !important; }
.x-body * { color: inherit !important; background-color: transparent !important; }
.x-body a, .x-body a * { color: var(--link) !important; }
.font-serif, .font-serif * { font-family: Georgia, "Noto Serif", "DejaVu Serif", serif !important; }
.font-sans, .font-sans * { font-family: system-ui, "Noto Sans", "DejaVu Sans", sans-serif !important; }
img, svg { max-width: 100% !important; max-height: var(--colh) !important; object-fit: contain; break-inside: avoid; }
img { height: auto !important; }
p { orphans: 2; widows: 2; }
.solo .x-body, .solo .x-body * { text-align: center !important; text-indent: 0 !important; }
::selection { background: rgb(153 204 255 / .35); }`;

let baseSheet, overrideSheet;
function sheet(text) {
  const s = new CSSStyleSheet();
  try { s.replaceSync(text); } catch { return null; }
  return s;
}

// html/body/:root selectors in the book's CSS point at the wrapper divs instead.
const SEL_RE = /(^|[\s,>+~(])(html|body|:root)(?![\w-])/gi;
function scope(rules) {
  for (const r of rules) {
    if (r.selectorText != null) {
      try { r.selectorText = r.selectorText.replace(SEL_RE, (m, p, t) => p + (t.toLowerCase() === 'body' ? '.x-body' : '.x-html')); } catch { /* keep */ }
    }
    if (r.cssRules) scope(r.cssRules);
  }
}

const IMPORT_RE = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;
const URL_RE = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;

function dir(path) { return path.split('/').slice(0, -1).join('/'); }
function resolve(base, href) {
  const [p, frag] = href.split('#');
  let path;
  try { path = decodeURIComponent(p); } catch { path = p; }
  const out = [];
  for (const x of `${base ? `${base}/` : ''}${path}`.split('/')) {
    if (x === '..') out.pop();
    else if (x && x !== '.') out.push(x);
  }
  return out.join('/') + (frag ? `#${frag}` : '');
}

export async function epubEngine({ app, zip, stage, item, startTicks, onChange, menu }) {
  const parseXml = t => new DOMParser().parseFromString(t, 'application/xml');
  const container = zip.find('META-INF/container.xml');
  if (!container) throw new Error('Not an EPUB (no container.xml)');
  const opfPath = parseXml(await zip.text(container)).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  const opfEntry = opfPath && zip.find(opfPath);
  if (!opfEntry) throw new Error('EPUB package file missing');
  const opf = parseXml(await zip.text(opfEntry));
  const opfDir = dir(opfPath);
  const manifest = new Map();
  for (const el of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(el.getAttribute('id'), { path: resolve(opfDir, el.getAttribute('href') || ''), type: el.getAttribute('media-type') || '', props: el.getAttribute('properties') || '' });
  }
  const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
  const spine = [...(spineEl?.getElementsByTagNameNS('*', 'itemref') || [])]
    .map(r => manifest.get(r.getAttribute('idref')))
    .filter(m => m && /x?html/.test(m.type) && zip.find(m.path))
    .map(m => ({ path: m.path, size: Math.max(1, zip.find(m.path).size) }));
  if (!spine.length) throw new Error('EPUB has no chapters');
  const rtl = spineEl?.getAttribute('page-progression-direction') === 'rtl';
  const before = [];
  let total = 0;
  for (const c of spine) { before.push(total); total += c.size; }
  const toc = await readToc();

  // ---- settings ---------------------------------------------------------------------------
  const s = { fs: 100, font: 'serif', theme: 'night', cols: 0, ...(app.us.local('reader.epub', {}) || {}) };
  const save = () => app.us.setLocal('reader.epub', s);

  // ---- resources --------------------------------------------------------------------------
  const blobs = new Map();
  function res(path) {
    let p = blobs.get(path);
    if (!p) {
      const e = zip.find(path);
      p = e ? zip.blob(e).then(b => URL.createObjectURL(b)).catch(() => null) : Promise.resolve(null);
      blobs.set(path, p);
    }
    return p;
  }
  const cssCache = new Map();
  function cssFile(path, depth = 0) {
    if (depth > 4) return Promise.resolve('');
    let p = cssCache.get(path);
    if (!p) {
      const e = zip.find(path);
      p = e ? zip.text(e).then(t => processCss(t, dir(path), depth)).catch(() => '') : Promise.resolve('');
      cssCache.set(path, p);
    }
    return p;
  }
  async function processCss(t, base, depth) {
    for (const m of [...t.matchAll(IMPORT_RE)]) t = t.replace(m[0], await cssFile(resolve(base, m[1]), depth + 1));
    const urls = new Map();
    for (const [, u] of t.matchAll(URL_RE)) {
      if (urls.has(u) || /^data:/i.test(u)) continue;
      const path = resolve(base, u);
      urls.set(u, IMAGE_RE.test(path) ? await res(path) : null);
    }
    // Images come from the book; fonts and anything remote are left out (CSP).
    return t.replace(URL_RE, (m, u) => (/^data:/i.test(u) ? m : `url("${urls.get(u) || 'data:,'}")`));
  }
  const sheets = new Map();
  function sheetFor(text) {
    if (!sheets.has(text)) { const sh = sheet(text); if (sh) scope(sh.cssRules); sheets.set(text, sh); }
    return sheets.get(text);
  }

  // ---- the page -----------------------------------------------------------------------------
  const host = h('div.r-book');
  const shadow = host.attachShadow({ mode: 'open' });
  const flow = h('div.flow');
  const viewEl = h('div.view', flow);
  shadow.append(viewEl);
  baseSheet ||= sheet(BASE_CSS);
  overrideSheet ||= sheet(OVERRIDE_CSS);
  stage.classList.add('book');
  stage.replaceChildren(host);

  let ci = 0;         // chapter (spine index)
  let page = 0;
  let pages = 1;
  let step = 1;
  let seq = 0;
  let solo = false;   // a picture-only section (cover, illustration): one centred page

  function cols() {
    const w = stage.clientWidth;
    if (s.cols) return s.cols;
    return w > 1100 && w > stage.clientHeight ? 2 : 1;
  }
  function applyTheme() {
    const t = THEMES[s.theme] || THEMES.night;
    stage.style.background = t.bg;
    host.style.setProperty('--fg', t.fg);
    host.style.setProperty('--link', t.link);
    host.style.setProperty('--fs', `${Math.round(19 * s.fs / 100)}px`);
  }
  function measure() {
    const c = solo ? 1 : cols();
    const w = stage.clientWidth;
    flow.classList.toggle('solo', solo);
    const width = Math.max(200, Math.min(w - 48, c === 2 ? 1760 : 820));
    viewEl.style.width = `${width}px`;
    viewEl.style.marginLeft = `${-width / 2}px`;
    flow.style.columnCount = String(c);
    flow.style.columnGap = `${GAP}px`;
    host.style.setProperty('--colh', `${viewEl.clientHeight}px`);
    step = width + GAP;
    pages = Math.max(1, Math.ceil((flow.scrollWidth + GAP) / step - 0.02));
  }
  function place() {
    page = Math.max(0, Math.min(pages - 1, page));
    flow.style.transform = `translateX(${-page * step}px)`;
    onChange();
  }
  function relayout() {
    const f = pages > 1 ? page / pages : 0;
    applyTheme();
    measure();
    page = Math.floor(f * pages + 0.001);
    place();
  }

  /** where: page number, 'last', {frac}, or {frag: element id}. */
  async function render(i, where = 0) {
    const my = ++seq;
    const path = spine[i].path;
    const src = await zip.text(zip.find(path));
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    const base = dir(path);

    const css = [];
    for (const el of doc.querySelectorAll('link, style')) {
      if (el.localName === 'style') css.push(processCss(el.textContent || '', base, 0));
      else if (/stylesheet/i.test(el.getAttribute('rel') || '') && el.getAttribute('href')) css.push(cssFile(resolve(base, el.getAttribute('href'))));
    }
    const bookSheets = (await Promise.all(css)).map(sheetFor).filter(Boolean);

    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    for (const el of body.querySelectorAll(DROP)) el.remove();
    const loads = [];
    for (const el of body.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on')) el.removeAttribute(a.name);
        else if (n === 'style') { el.setAttribute('data-x-style', a.value); el.removeAttribute(a.name); }
        else if ((n === 'href' || n === 'xlink:href' || n === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
      const ln = el.localName;
      if (ln === 'img' && el.getAttribute('src')) {
        const p = resolve(base, el.getAttribute('src'));
        el.removeAttribute('src');
        el.removeAttribute('srcset');
        loads.push(res(p).then(u => { if (u) el.setAttribute('src', u); }));
      } else if (ln === 'image') {
        const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href) {
          el.removeAttribute('href');
          el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
          loads.push(res(resolve(base, href)).then(u => { if (u) el.setAttribute('href', u); }));
        }
      }
    }
    await Promise.all(loads);
    if (my !== seq) return;

    const xh = h('div.x-html');
    const xb = h('div.x-body');
    const htmlEl = doc.documentElement;
    for (const [from, to] of [[htmlEl, xh], [body, xb]]) {
      if (from === body && from === htmlEl) break;
      for (const a of ['class', 'lang', 'dir', 'id']) if (from.getAttribute?.(a)) to.setAttribute(a, `${from.getAttribute(a)}`);
    }
    xh.classList.add('x-html');
    xb.classList.add('x-body');
    if (s.font !== 'book') xb.classList.add(`font-${s.font}`);
    xb.append(...[...body.childNodes].map(n => document.importNode(n, true)));
    for (const el of xb.querySelectorAll('[data-x-style]')) { el.style.cssText = el.dataset.xStyle; el.removeAttribute('data-x-style'); }
    xh.append(xb);
    solo = !xb.textContent.trim() && !!xb.querySelector('img, svg');
    shadow.adoptedStyleSheets = [baseSheet, ...bookSheets, overrideSheet].filter(Boolean);
    flow.replaceChildren(xh);
    flow.style.transform = '';
    applyTheme();

    // Lay out once the pictures have sizes (a page count before that would be wrong).
    const imgs = [...xb.querySelectorAll('img')];
    await Promise.race([Promise.all(imgs.map(im => im.decode().catch(() => {}))), new Promise(r => setTimeout(r, 2500))]);
    if (my !== seq) return;
    ci = i;
    measure();
    if (where === 'last') page = pages - 1;
    else if (typeof where === 'number') page = where;
    else if (where?.frac != null) page = Math.floor(where.frac * pages + 0.001);
    else if (where?.frag) page = pageOf(where.frag);
    place();
  }

  function pageOf(id) {
    const el = shadow.getElementById(id) || flow.querySelector(`[name="${CSS.escape(id)}"]`);
    if (!el) return 0;
    const x = el.getBoundingClientRect().left - flow.getBoundingClientRect().left;
    return Math.max(0, Math.floor((x + 2) / step));
  }

  async function goFraction(f) {
    const target = Math.max(0, Math.min(1, f)) * total;
    let i = 0;
    while (i + 1 < spine.length && before[i + 1] <= target) i++;
    await render(i, { frac: Math.min(0.999, (target - before[i]) / spine[i].size) });
  }

  async function goHref(path) {
    const [file, frag] = path.split('#');
    const i = file ? spine.findIndex(c => c.path === file) : ci;
    if (i < 0) return;
    if (i === ci && flow.firstChild) { page = frag ? pageOf(frag) : 0; place(); return; }
    await render(i, frag ? { frag } : 0);
  }

  // Links inside the book: chapters and notes move the reader, web links open a new tab.
  shadow.addEventListener('click', e => {
    const a = e.composedPath().find(n => n.localName === 'a' && n.getAttribute?.('href'));
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
    else if (!/^[a-z]+:/i.test(href)) goHref(href.startsWith('#') ? `${spine[ci].path}${href}` : resolve(dir(spine[ci].path), href));
  });

  const ro = new ResizeObserver(() => { if (flow.firstChild) relayout(); });
  ro.observe(stage);

  // ---- table of contents --------------------------------------------------------------------
  async function readToc() {
    const navItem = [...manifest.values()].find(m => m.props.split(/\s+/).includes('nav'));
    try {
      if (navItem && zip.find(navItem.path)) {
        const d = new DOMParser().parseFromString(await zip.text(zip.find(navItem.path)), 'application/xhtml+xml');
        const navs = [...d.getElementsByTagName('nav')];
        const nav = navs.find(n => (n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('epub:type')) === 'toc') || navs[0];
        if (nav) {
          const list = [...nav.getElementsByTagName('a')].filter(a => a.getAttribute('href')).map(a => {
            let depth = 0;
            for (let p = a.parentElement; p && p !== nav; p = p.parentElement) if (p.localName === 'ol' || p.localName === 'ul') depth++;
            return { label: a.textContent.replace(/\s+/g, ' ').trim(), path: resolve(dir(navItem.path), a.getAttribute('href')), depth: Math.max(0, depth - 1) };
          }).filter(t => t.label);
          if (list.length) return list;
        }
      }
      const ncxId = spineEl?.getAttribute('toc');
      const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find(m => m.type === 'application/x-dtbncx+xml');
      if (ncx && zip.find(ncx.path)) {
        const d = parseXml(await zip.text(zip.find(ncx.path)));
        return [...d.getElementsByTagNameNS('*', 'navPoint')].map(np => {
          let depth = 0;
          for (let p = np.parentElement; p; p = p.parentElement) if (p.localName === 'navPoint') depth++;
          const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent?.trim();
          const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
          return label && src ? { label, path: resolve(dir(ncx.path), src), depth } : null;
        }).filter(Boolean);
      }
    } catch { /* no contents */ }
    return [];
  }

  /** The contents entry for where we are: the last one at or before this chapter. */
  function chapterName() {
    let best = null;
    for (const t of toc) {
      const i = spine.findIndex(c => c.path === t.path.split('#')[0]);
      if (i >= 0 && i <= ci) best = t;
    }
    return best?.label || '';
  }

  function contents() {
    const here = chapterName();
    menu('Contents', toc.map(t => [`${'  '.repeat(t.depth)}${t.label}`, t.label === here, () => goHref(t.path)]), 'sky');
  }

  // ---- start ----------------------------------------------------------------------------------
  await goFraction((startTicks || 0) / BOOK_TICKS);

  const fraction = () => Math.min(1, (before[ci] + spine[ci].size * (pages > 1 ? page / (pages - 1) : 1)) / total);
  const restyle = () => { save(); render(ci, { frac: pages > 1 ? page / pages : 0 }); };
  const font = d => { s.fs = Math.max(60, Math.min(220, s.fs + d)); save(); relayout(); };
  const cycle = (obj, key) => { const ks = Object.keys(obj); s[key] = ks[(ks.indexOf(s[key]) + 1) % ks.length]; };

  return {
    kind: 'Book',
    info: () => ['EPUB', `${spine.length} sections`],
    rtl,
    readout: () => [[chapterName(), `Page ${page + 1} of ${pages}`].filter(Boolean).join(' · '), `${Math.round(fraction() * 100)}%`],
    fraction,
    // Where we are in the whole book (size-weighted), as the official reader stores it.
    ticks: () => Math.round(((before[ci] + spine[ci].size * (page / pages)) / total) * BOOK_TICKS),
    atEnd: () => ci === spine.length - 1 && page >= pages - 1,
    async next() {
      if (page + 1 < pages) { page++; place(); return null; }
      if (ci + 1 < spine.length) { await render(ci + 1, 0); return null; }
      return 'end';
    },
    async prev() {
      if (page > 0) { page--; place(); return null; }
      if (ci > 0) { await render(ci - 1, 'last'); return null; }
      return 'start';
    },
    goFraction,
    scrolls: () => false,
    buttons: () => [
      toc.length ? btn('Contents', contents, { color: 'sky', title: 'Contents (C)' }) : null,
      btn('A−', () => font(-10), { color: 'peach', title: 'Smaller text (−)' }),
      btn(`${s.fs}%`, () => { s.fs = 100; save(); relayout(); }, { color: 'peach', title: 'Reset text size' }),
      btn('A+', () => font(10), { color: 'peach', title: 'Larger text (+)' }),
      btn(FONTS[s.font], () => { cycle(FONTS, 'font'); restyle(); }, { color: 'lilac', title: 'Font' }),
      btn(THEMES[s.theme]?.label || 'Night', () => { cycle(THEMES, 'theme'); save(); relayout(); }, { color: 'lilac', title: 'Colours (T)' }),
      btn(cols() === 2 ? 'Two pages' : 'One page', () => { s.cols = cols() === 2 ? 1 : 2; save(); relayout(); }, { color: 'sky', title: 'Pages per view (2)' }),
    ],
    keys: {
      '+': () => font(10), '=': () => font(10), '-': () => font(-10),
      c: contents, C: contents,
      t: () => { cycle(THEMES, 'theme'); save(); relayout(); },
      2: () => { s.cols = cols() === 2 ? 1 : 2; save(); relayout(); },
    },
    destroy() {
      seq++;
      ro.disconnect();
      stage.classList.remove('book');
      stage.style.background = '';
      for (const p of blobs.values()) p.then(u => u && URL.revokeObjectURL(u));
      blobs.clear();
    },
  };
}
