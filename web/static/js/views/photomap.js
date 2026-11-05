// A photo library's Map tab: every photo with a GPS position on an OpenStreetMap map, nearby
// ones gathered into one marker that shows the first photo and how many there are. A marker
// zooms in until its photos are in one place, then opens them in the photo viewer; "View" opens
// every photo in sight. A small map of our own (Web Mercator tiles, drag, wheel, pinch, keys)
// rather than a mapping library: the page may only run its own scripts.
import { h, fill } from '../h.js';
import { btn, errorBox } from '../ui.js';

const TILE = 256;
const MIN_Z = 2;
const MAX_Z = 18;
const CELL = 72; // markers closer than this (pixels) share one
const PAGE = 2000;
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

// Located photos per library, kept for the session: 50,000 photos take a while to list.
const cache = new Map(); // library id -> {items, scanned, total, at}
const FRESH = 10 * 60 * 1000;

// Web Mercator: world pixels at zoom z.
const worldX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const worldY = (lat, z) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

/** Photos with a position, a page at a time (four at once); onPage(state) after each. */
async function located(api, view, signal, onPage) {
  const hit = cache.get(view.Id);
  if (hit && Date.now() - hit.at < FRESH) { onPage(hit); return hit; }
  const state = { items: [], scanned: 0, total: 0, at: 0 };
  const query = start => api.get('/Items', {
    userId: api.userId, parentId: view.Id, recursive: true, includeItemTypes: 'Photo',
    sortBy: 'PremiereDate,DateCreated,SortName', sortOrder: 'Descending',
    enableUserData: false, enableImageTypes: 'Primary', imageTypeLimit: 1, fields: 'ParentId',
    startIndex: start, limit: PAGE,
  }, { signal });
  const keep = r => {
    for (const i of r.Items) {
      if (i.Latitude == null || i.Longitude == null || (!i.Latitude && !i.Longitude)) continue;
      state.items.push({ Id: i.Id, Name: i.Name, Type: i.Type, Album: i.Album, AlbumId: i.AlbumId, ParentId: i.ParentId, ImageTags: i.ImageTags, Latitude: i.Latitude, Longitude: i.Longitude });
    }
    state.scanned += r.Items.length;
  };
  const first = await query(0);
  state.total = first.TotalRecordCount;
  keep(first);
  onPage(state);
  const starts = [];
  for (let s = PAGE; s < state.total; s += PAGE) starts.push(s);
  // Pages finish out of order; the list is put back in date order at the end.
  const order = new Map();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (starts.length) {
      const s = starts.shift();
      const r = await query(s);
      order.set(s, r.Items.map(i => i.Id));
      keep(r);
      onPage(state);
    }
  }));
  const rank = new Map();
  let n = 0;
  for (const id of first.Items.map(i => i.Id)) rank.set(id, n++);
  for (const s of [...order.keys()].sort((a, b) => a - b)) for (const id of order.get(s)) rank.set(id, n++);
  state.items.sort((a, b) => rank.get(a.Id) - rank.get(b.Id));
  state.at = Date.now();
  cache.set(view.Id, state);
  onPage(state);
  return state;
}

export function photoMap(ctx, view) {
  const { api, app, signal } = ctx;
  let points = [];       // located photos
  let z = 3;
  let cx = 0, cy = 0;    // the centre, in world pixels at zoom z
  let clusters = [];     // at zoom z: {x, y, items, s, n, w, e}
  let fitted = false;

  const tiles = h('div.pm-tiles');
  const pins = h('div.pm-pins');
  const status = h('div.pm-status', 'Accessing photo records…');
  const count = h('span.pm-count');
  const surface = h('div.pm-map', { attrs: { tabindex: '0', role: 'application', 'aria-label': 'Photo map: arrow keys move, plus and minus zoom' } },
    tiles, pins, status,
    h('div.pm-attr', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, '© OpenStreetMap contributors')));
  const bar = h('div.pm-bar',
    zoomBtn('plus', 1, 'Zoom in (+)'),
    zoomBtn('minus', -1, 'Zoom out (−)'),
    btn('All', () => fit(points), { color: 'lilac', small: true, title: 'Show every photo' }),
    btn('View', () => viewInSight(), { color: 'orange', small: true, title: 'Open the photos in sight in the viewer' }),
    h('span.grow'), count);
  const root = h('div.photo-map', bar, surface);
  // + and − drawn in CSS: the font's are small and sit low.
  function zoomBtn(sym, dz, title) {
    const b = btn(h('span.pm-sym', { class: sym, attrs: { 'aria-hidden': 'true' } }), () => zoomBy(dz), { color: 'sky', small: true, title });
    b.classList.add('pm-z');
    b.setAttribute('aria-label', title);
    return b;
  }

  const size = () => ({ w: surface.clientWidth || 800, h: surface.clientHeight || 500 });
  const world = () => TILE * 2 ** z;

  // ---- drawing --------------------------------------------------------------------------------

  const tileEls = new Map(); // "z/x/y" -> img
  function drawTiles() {
    const { w, h: ht } = size();
    const left = cx - w / 2, top = cy - ht / 2;
    const n = 2 ** z;
    const want = new Set();
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + ht) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
        const key = `${z}/${tx}/${ty}`;
        want.add(key);
        let el = tileEls.get(key);
        if (!el) {
          const wx = ((tx % n) + n) % n; // round the world east and west
          el = h('img', { src: tileUrl(z, wx, ty), alt: '', attrs: { draggable: 'false', decoding: 'async' } });
          el.addEventListener('error', () => el.classList.add('gone'));
          tileEls.set(key, el);
          tiles.append(el);
        }
        el.style.transform = `translate(${Math.round(tx * TILE - left)}px, ${Math.round(ty * TILE - top)}px)`;
      }
    }
    for (const [key, el] of tileEls) if (!want.has(key)) { el.remove(); tileEls.delete(key); }
  }

  // Greedy grid clustering in world pixels: photos in one CELL square share a marker, placed at
  // their average. Recomputed when the zoom or the photos change; panning only moves them.
  function cluster() {
    const cells = new Map();
    for (const p of points) {
      const x = worldX(p.Longitude, z), y = worldY(p.Latitude, z);
      const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      let c = cells.get(key);
      if (!c) cells.set(key, c = { sx: 0, sy: 0, items: [], s: 90, n: -90, w: 180, e: -180 });
      c.sx += x; c.sy += y;
      c.items.push(p);
      c.s = Math.min(c.s, p.Latitude); c.n = Math.max(c.n, p.Latitude);
      c.w = Math.min(c.w, p.Longitude); c.e = Math.max(c.e, p.Longitude);
    }
    // Squares that meet can put two markers on top of each other: the bigger takes in any whose
    // centre is within a marker's width (looked up in the neighbouring squares).
    const list = [...cells.values()].map(c => ({ ...c, x: c.sx / c.items.length, y: c.sy / c.items.length }))
      .sort((a, b) => b.items.length - a.items.length);
    const near = new Map();
    const at = c => `${Math.floor(c.x / CELL)},${Math.floor(c.y / CELL)}`;
    for (const c of list) { const k = at(c); if (!near.has(k)) near.set(k, []); near.get(k).push(c); }
    for (const c of list) {
      if (c.gone) continue;
      const gx = Math.floor(c.x / CELL), gy = Math.floor(c.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const o of near.get(`${gx + dx},${gy + dy}`) || []) {
          if (o === c || o.gone || Math.hypot(o.x - c.x, o.y - c.y) > 56) continue;
          o.gone = true;
          c.sx += o.sx; c.sy += o.sy;
          c.items = c.items.concat(o.items);
          c.s = Math.min(c.s, o.s); c.n = Math.max(c.n, o.n); c.w = Math.min(c.w, o.w); c.e = Math.max(c.e, o.e);
        }
      }
      c.x = c.sx / c.items.length; c.y = c.sy / c.items.length;
    }
    clusters = list.filter(c => !c.gone);
  }

  const pinEls = new Map(); // first photo id -> element (kept while it stays the same cluster)
  function drawPins() {
    const { w, h: ht } = size();
    const left = cx - w / 2, top = cy - ht / 2;
    const seen = new Set();
    for (const c of clusters) {
      const x = c.x - left, y = c.y - top;
      if (x < -60 || y < -60 || x > w + 60 || y > ht + 60) continue;
      const first = c.items[0];
      const key = `${first.Id}:${c.items.length}`;
      seen.add(key);
      let el = pinEls.get(key);
      if (!el) {
        const tag = first.ImageTags?.Primary;
        el = h('button.pm-pin', {
          type: 'button',
          title: c.items.length > 1 ? `${c.items.length} photos` : first.Name,
          onclick: e => { e.stopPropagation(); open(c); },
        },
        tag ? h('img', { src: api.img(first.Id, 'Primary', { tag, w: 96, h: 96, quality: 80 }), alt: '', attrs: { loading: 'lazy', draggable: 'false' } }) : null,
        c.items.length > 1 ? h('span.pm-n', c.items.length > 999 ? `${Math.round(c.items.length / 100) / 10}k` : String(c.items.length)) : null);
        pinEls.set(key, el);
        pins.append(el);
      }
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    for (const [key, el] of pinEls) if (!seen.has(key)) { el.remove(); pinEls.delete(key); }
  }

  let frame = 0;
  function draw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawTiles();
      drawPins();
      const inSight = sight().length;
      count.textContent = points.length ? `${inSight.toLocaleString()} in sight · ${points.length.toLocaleString()} located` : '';
    });
  }

  // ---- moving ---------------------------------------------------------------------------------

  const clampY = () => { const { h: ht } = size(); cy = Math.max(ht / 2 - 40, Math.min(world() - ht / 2 + 40, cy)); };
  const wrapX = () => { cx = ((cx % world()) + world()) % world(); };

  /** Zoom by dz levels keeping the point (ox, oy) from the centre where it is. */
  function zoomBy(dz, ox = 0, oy = 0) {
    const to = Math.max(MIN_Z, Math.min(MAX_Z, z + dz));
    if (to === z) return;
    const f = 2 ** (to - z);
    cx = (cx + ox) * f - ox;
    cy = (cy + oy) * f - oy;
    z = to;
    wrapX(); clampY();
    cluster();
    draw();
  }

  function panBy(dx, dy) {
    cx += dx; cy += dy;
    wrapX(); clampY();
    draw();
  }

  /** Show photos' whole spread. */
  function fit(list) {
    if (!list.length) return;
    const lats = list.map(p => p.Latitude), lons = list.map(p => p.Longitude);
    const s = Math.min(...lats), n = Math.max(...lats), w = Math.min(...lons), e = Math.max(...lons);
    const { w: vw, h: vh } = size();
    let to = MAX_Z;
    while (to > MIN_Z && (worldX(e, to) - worldX(w, to) > vw - 120 || worldY(s, to) - worldY(n, to) > vh - 120)) to--;
    z = Math.min(to, 16);
    cx = (worldX(w, z) + worldX(e, z)) / 2;
    cy = (worldY(n, z) + worldY(s, z)) / 2;
    wrapX(); clampY();
    cluster();
    draw();
  }

  // A marker: zoom in while its photos are spread out; once together (or as far in as the map
  // goes) open them in the viewer.
  function open(c) {
    const spread = worldX(c.e, MAX_Z) - worldX(c.w, MAX_Z) > CELL || worldY(c.s, MAX_Z) - worldY(c.n, MAX_Z) > CELL;
    if (c.items.length > 1 && z < MAX_Z && spread) {
      const before = z;
      fit(c.items);
      if (z <= before) zoomBy(2); // fit() has centred on them
      return;
    }
    app.viewPhotos(c.items, 0);
  }

  const sight = () => {
    const { w, h: ht } = size();
    const left = cx - w / 2, top = cy - ht / 2;
    return clusters.filter(c => c.x >= left && c.x <= left + w && c.y >= top && c.y <= top + ht).flatMap(c => c.items);
  };
  function viewInSight() {
    const list = sight();
    if (list.length) app.viewPhotos(list, 0);
  }

  // Drag to pan; two fingers pinch and pan; wheel zooms at the pointer.
  const ptrs = new Map();
  let pinch = null;
  let dragged = false;
  surface.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged = false;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  });
  surface.addEventListener('pointermove', e => {
    const was = ptrs.get(e.pointerId);
    if (!was) return;
    const dx = e.clientX - was.x, dy = e.clientY - was.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) { dragged = true; surface.setPointerCapture?.(e.pointerId); surface.classList.add('drag'); }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { panBy(-dx, -dy); return; }
    // Two pointers: move with their midpoint (each one's move counts half), zoom by the spread.
    panBy(-dx / 2, -dy / 2);
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch && (d / pinch.d > 1.6 || d / pinch.d < 0.62)) {
      const r = surface.getBoundingClientRect();
      zoomBy(d > pinch.d ? 1 : -1, (a.x + b.x) / 2 - r.left - r.width / 2, (a.y + b.y) / 2 - r.top - r.height / 2);
      pinch.d = d;
    }
  });
  const up = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) surface.classList.remove('drag');
  };
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  // A drag that ends on a marker isn't a click on it.
  surface.addEventListener('click', e => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
  let wheel = 0, wheelAt = 0;
  surface.addEventListener('wheel', e => {
    e.preventDefault();
    if (Date.now() - wheelAt > 250) wheel = 0;
    wheelAt = Date.now();
    wheel += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(wheel) < 60) return; // trackpads send many small steps
    const r = surface.getBoundingClientRect();
    zoomBy(wheel < 0 ? 1 : -1, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    wheel = 0;
  }, { passive: false });
  surface.addEventListener('dblclick', e => {
    if (e.target.closest('.pm-pin')) return;
    const r = surface.getBoundingClientRect();
    zoomBy(e.shiftKey ? -1 : 1, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  });
  surface.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 120;
    const act = {
      ArrowLeft: () => panBy(-step, 0), ArrowRight: () => panBy(step, 0),
      ArrowUp: () => panBy(0, -step), ArrowDown: () => panBy(0, step),
      '+': () => zoomBy(1), '=': () => zoomBy(1), '-': () => zoomBy(-1), _: () => zoomBy(-1),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  });

  const resize = new ResizeObserver(() => { clampY(); draw(); });
  resize.observe(surface);
  signal.addEventListener('abort', () => { resize.disconnect(); cancelAnimationFrame(frame); });

  // ---- loading --------------------------------------------------------------------------------

  // Draw as pages arrive, at most a few times a second; fit the map to the photos once enough
  // are in, and again when all are, unless it has been moved since.
  let moved = false;
  surface.addEventListener('pointerdown', () => { moved = true; }, { once: true });
  surface.addEventListener('wheel', () => { moved = true; }, { once: true, passive: true });
  let last = 0;
  const update = (state, done) => {
    if (signal.aborted) return;
    points = state.items;
    if (!done && Date.now() - last < 400) return;
    last = Date.now();
    if (!done) status.textContent = `Accessing photo records: ${state.scanned.toLocaleString()} of ${state.total.toLocaleString()}`;
    if ((!fitted || (done && !moved)) && points.length) { fitted = true; fit(points); } else { cluster(); draw(); }
  };
  located(api, view, signal, s => update(s, false)).then(state => {
    update(state, true);
    status.hidden = !!state.items.length;
    if (!state.items.length) status.textContent = state.total ? 'No photos here have a location' : 'No photos';
  }).catch(e => {
    if (signal.aborted) return;
    fill(status, errorBox(e));
  });

  // Until the photos are in: the whole world.
  requestAnimationFrame(() => { cx = world() / 2; cy = world() / 2 - 60; clampY(); draw(); });
  return root;
}
