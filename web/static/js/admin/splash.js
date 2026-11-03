// The LCARS splash screen: drawn on a canvas in the app's own font (Antonio), 1920×1080, so it
// can be uploaded as Jellyfin's splash screen (shown by the TV and phone apps while they start)
// without shipping an image file. A TNG-style frame: two elbows joined by a column of pills,
// bars along the top and bottom, and the system name in the middle.

const C = { orange: '#ff9900', peach: '#ffcc99', lilac: '#cc99cc', blue: '#9999ff', salmon: '#ff9966', red: '#cc6666', sky: '#99ccff', dim: '#5a5470' };

function rr(g, x, y, w, h, r) { // rounded rect, r: [tl, tr, br, bl]
  const [a, b, c, d] = Array.isArray(r) ? r : [r, r, r, r];
  g.beginPath();
  g.moveTo(x + a, y);
  g.lineTo(x + w - b, y); g.arcTo(x + w, y, x + w, y + b, b);
  g.lineTo(x + w, y + h - c); g.arcTo(x + w, y + h, x + w - c, y + h, c);
  g.lineTo(x + d, y + h); g.arcTo(x, y + h, x, y + h - d, d);
  g.lineTo(x, y + a); g.arcTo(x, y, x + a, y, a);
  g.closePath();
}

/** An elbow: a wide arm (the column) turning into a thin bar, as the frame's corners. */
function elbow(g, x, y, armW, barH, w, h, color, flip) {
  g.save();
  if (flip) { g.translate(0, y * 2 + h); g.scale(1, -1); }
  g.fillStyle = color;
  rr(g, x, y, w, h, [h * 0.8, 0, 0, 0]);
  g.fill();
  // the inner curve
  g.fillStyle = '#000';
  rr(g, x + armW, y + barH, w, h, [barH * 1.2, 0, 0, 0]);
  g.fill();
  g.restore();
}

/** Bars of different lengths and colours along a line, with gaps, the last with a rounded end. */
function bars(g, x, y, w, h, parts) {
  const gap = 10;
  const total = parts.reduce((s, [f]) => s + f, 0);
  let cx = x;
  parts.forEach(([frac, color], i) => {
    const bw = (w - gap * (parts.length - 1)) * (frac / total);
    g.fillStyle = color;
    rr(g, cx, y, bw, h, i === parts.length - 1 ? [0, h / 2, h / 2, 0] : 0);
    g.fill();
    cx += bw + gap;
  });
}

/** Draws the splash and resolves to a canvas. name: the server's name, shown under the title. */
export async function lcarsSplash(name = '') {
  await Promise.all([document.fonts.load('700 100px Antonio'), document.fonts.load('400 40px Antonio')]).catch(() => {});
  const W = 1920, H = 1080;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  const L = 90, ARM = 300, BAR = 70, EW = 560, EH = 230;
  elbow(g, L, 70, ARM, BAR, EW, EH, C.orange, false);
  elbow(g, L, H - 70 - EH, ARM, BAR, EW, EH, C.lilac, true);
  bars(g, L + EW + 10, 70, W - L - EW - 10 - 70, BAR, [[5, C.peach], [2, C.lilac], [4, C.blue], [1, C.salmon], [3, C.orange]]);
  bars(g, L + EW + 10, H - 70 - BAR, W - L - EW - 10 - 70, BAR, [[3, C.blue], [5, C.orange], [2, C.peach], [4, C.lilac]]);

  // The column between the elbows: pills with small codes.
  const top = 70 + EH + 10, bottom = H - 70 - EH - 10;
  const pills = [[2, C.peach, '01-47'], [3, C.blue, '02-1701'], [1.5, C.salmon, '03'], [2.5, C.sky, '04-D'], [2, C.red, '05-ENG']];
  const sum = pills.reduce((s, [f]) => s + f, 0);
  let y = top;
  for (const [frac, color, code] of pills) {
    const ph = (bottom - top - 10 * (pills.length - 1)) * (frac / sum);
    g.fillStyle = color;
    g.fillRect(L, y, ARM, ph);
    g.fillStyle = '#000';
    g.font = '400 30px Antonio, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(code, L + ARM - 18, y + ph - 10);
    y += ph + 10;
  }

  // Corner labels in the elbows.
  g.fillStyle = '#000';
  g.font = '700 44px Antonio, sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillText('LCARS', L + ARM - 20, 90);
  g.font = '400 30px Antonio, sans-serif';
  g.fillText('47-1701', L + ARM - 20, 142);
  g.textBaseline = 'bottom';
  g.fillText('ACCESS 0-0-0', L + ARM - 20, H - 90);

  // The title.
  const tx = L + ARM + 130;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.orange;
  g.font = '700 290px Antonio, sans-serif';
  g.fillText('LCARS', tx, 610);
  g.fillStyle = C.peach;
  g.font = '400 54px Antonio, sans-serif';
  g.fillText('LIBRARY COMPUTER ACCESS / RETRIEVAL SYSTEM', tx + 8, 700);
  if (name) {
    g.fillStyle = C.lilac;
    g.font = '700 64px Antonio, sans-serif';
    g.fillText(String(name).toUpperCase(), tx + 8, 800);
  }
  // A segmented meter under it, as on the panels.
  const segs = 28;
  for (let i = 0; i < segs; i++) {
    g.fillStyle = i < 19 ? C.sky : '#1b1a26';
    rr(g, tx + 8 + i * 34, 840, 28, 18, i === 0 ? [9, 0, 0, 9] : i === segs - 1 ? [0, 9, 9, 0] : 0);
    g.fill();
  }
  return c;
}

/** The splash as base64 JPEG, for /Branding/Splashscreen. */
export async function lcarsSplashData(name) {
  const c = await lcarsSplash(name);
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}
