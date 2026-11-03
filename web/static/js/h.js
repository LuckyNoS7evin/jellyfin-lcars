// Tiny DOM helpers: h() builds elements, morph() patches the live DOM to match a new tree so
// re-rendering keeps images, focus and CSS transitions intact.
//
// The page's CSP forbids inline style attributes, so styles always go through the CSSOM
// (el.style), never setAttribute('style').

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'rect', 'line', 'polyline', 'polygon', 'circle', 'g', 'defs', 'linearGradient', 'stop', 'text', 'title']);

/**
 * h('div.card.big', {key, style: {width: '40%'}, attrs, title, onclick}, ...children)
 * Children may be nodes, strings, numbers, arrays, or null/false (skipped).
 */
export function h(sel, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [tag, ...classes] = sel.split('.');
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag || 'div');
  if (classes.length) el.setAttribute('class', classes.join(' '));
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', [el.getAttribute('class'), v].filter(Boolean).join(' '));
    else if (k === 'style') for (const [p, val] of Object.entries(v)) { if (val != null) el.style.setProperty(p, String(val)); }
    else if (k === 'key') el.dataset.key = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'attrs') for (const [a, val] of Object.entries(v)) { if (val != null && val !== false) el.setAttribute(a, val === true ? '' : String(val)); }
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** morph patches `from` (live) to look like `to` (detached). Event listeners come from the first render. */
export function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName ||
      (from.nodeType === 1 && from.dataset.key !== to.dataset.key)) {
    from.replaceWith(to);
    return;
  }
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.data !== to.data) from.data = to.data;
    return;
  }
  for (const a of [...from.attributes]) {
    if (a.name !== 'style' && !to.hasAttribute(a.name)) from.removeAttribute(a.name);
  }
  for (const a of to.attributes) {
    if (a.name !== 'style' && from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  }
  if (from.style && from.style.cssText !== to.style.cssText) from.style.cssText = to.style.cssText;

  const fc = [...from.childNodes];
  const tc = [...to.childNodes];
  for (let i = 0; i < tc.length; i++) {
    if (i < fc.length) morph(fc[i], tc[i]);
    else from.appendChild(tc[i]);
  }
  for (let i = tc.length; i < fc.length; i++) fc[i].remove();
}

/** Replace the contents of `root` with `node`, morphing if there is already a rendered tree. */
export function render(root, node) {
  if (root.firstChild && root.childNodes.length === 1) morph(root.firstChild, node);
  else root.replaceChildren(node);
}

// ---- small SVG charts ------------------------------------------------------------------

/**
 * sparkline(values, {w, h, max, cls}) -> <svg> with a filled area and a line, scaled to fit.
 * Uses viewBox + preserveAspectRatio=none so CSS decides its size.
 */
export function sparkline(values, { w = 100, h: ht = 30, max, min = 0, cls = 'spark' } = {}) {
  const v = (values || []).filter(x => Number.isFinite(x));
  const svg = h('svg', { class: cls, attrs: { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' } });
  if (v.length < 2) return svg;
  const hi = Math.max(max ?? 0, ...v, min + 1e-9);
  const step = w / (v.length - 1);
  const pts = v.map((x, i) => [i * step, ht - ((x - min) / (hi - min)) * (ht - 2) - 1]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  svg.append(
    h('path.area', { d: `${line}L${w},${ht}L0,${ht}Z` }),
    h('path.line', { d: line, attrs: { 'vector-effect': 'non-scaling-stroke' } }),
  );
  return svg;
}

/** bars(series[], {w, h}) -> stacked column chart; series = [{values, cls}] bottom-up. */
export function bars(series, { w = 300, h: ht = 60, cls = 'bars', gap = 0.15 } = {}) {
  const n = Math.max(0, ...series.map(s => s.values.length));
  const svg = h('svg', { class: cls, attrs: { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' } });
  if (!n) return svg;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const hi = Math.max(1, ...totals);
  const bw = w / n;
  const base = new Array(n).fill(0);
  for (const s of series) {
    const g = h('g', { class: s.cls });
    s.values.forEach((v, i) => {
      if (!v) return;
      const bh = (v / hi) * ht;
      base[i] += bh;
      g.appendChild(h('rect', { x: (i * bw + bw * gap / 2).toFixed(2), width: (bw * (1 - gap)).toFixed(2), y: (ht - base[i]).toFixed(2), height: bh.toFixed(2) }));
    });
    svg.appendChild(g);
  }
  return svg;
}

/** el.replaceChildren(), skipping null/false and flattening arrays like h() does. */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
