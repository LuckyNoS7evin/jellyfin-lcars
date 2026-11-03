// The music queue: what's playing, repeat and shuffle, reordering (drag a row, or Alt+↑/↓),
// removing (✕ or Delete), saving it as a playlist, and the lyrics, highlighted in time when
// the server has synced lyrics.
import { h, fill } from '../h.js';
import { TICKS } from '../api.js';
import * as f from '../fmt.js';
import { deck, empty, btn, pickImage, image } from '../ui.js';
import { addToPlaylist } from '../menu.js';

export const REPEAT_LABEL = { RepeatNone: 'Repeat off', RepeatAll: 'Repeat all', RepeatOne: 'Repeat one' };

export async function queue(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Audio queue');
  const q = app.queue;
  const body = h('div');
  const lyricsBody = h('div');
  const lyricsDeck = deck('Lyrics', { color: 'sky' }, lyricsBody);
  lyricsDeck.hidden = true;
  let dragFrom = -1;

  function row(t, i) {
    const el = h('div.trk.qtrk', {
      class: i === q.index ? 'now' : '', key: t._qid || `${t.Id}-${i}`,
      attrs: { tabindex: 0, role: 'button', draggable: 'true', 'aria-label': `${t.Name}, track ${i + 1} of ${q.items.length}` },
      onclick: e => { if (!e.target.closest('button')) q.playAt(i); },
      onkeydown: e => {
        if (e.target !== el) return;
        if (e.key === 'Enter') { q.playAt(i); e.preventDefault(); }
        else if (e.key === 'Delete') { q.remove(i); focusRow(Math.min(i, q.items.length - 1)); e.preventDefault(); }
        else if (e.altKey && e.key === 'ArrowUp' && i > 0) { q.move(i, i - 1); focusRow(i - 1); e.preventDefault(); }
        else if (e.altKey && e.key === 'ArrowDown' && i < q.items.length - 1) { q.move(i, i + 1); focusRow(i + 1); e.preventDefault(); }
      },
      ondragstart: e => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
      ondragend: () => { dragFrom = -1; el.classList.remove('dragging'); body.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); },
      ondragover: e => { if (dragFrom < 0) return; e.preventDefault(); body.querySelectorAll('.drop').forEach(x => x !== el && x.classList.remove('drop')); el.classList.add('drop'); },
      ondragleave: () => el.classList.remove('drop'),
      ondrop: e => { e.preventDefault(); if (dragFrom >= 0) q.move(dragFrom, i); },
    },
    h('span.trk-n', i + 1),
    h('span.trk-t', t.Name),
    h('span.trk-a', t.AlbumArtist || t.Album || ''),
    h('span.trk-d', t.RunTimeTicks ? f.clock(t.RunTimeTicks / TICKS) : ''),
    h('span.trk-x',
      h('button.qb', { type: 'button', title: 'Move up (Alt+↑)', disabled: i === 0, onclick: () => q.move(i, i - 1) }, '▲'),
      h('button.qb', { type: 'button', title: 'Move down (Alt+↓)', disabled: i === q.items.length - 1, onclick: () => q.move(i, i + 1) }, '▼'),
      h('button.qb.x', { type: 'button', title: 'Remove (Delete)', onclick: () => q.remove(i) }, '✕')));
    return el;
  }

  function focusRow(i) {
    requestAnimationFrame(() => body.querySelectorAll('.qtrk')[i]?.focus());
  }

  function draw() {
    if (!q.active) { fill(body, empty('Queue empty')); lyricsDeck.hidden = true; return; }
    const cur = q.current;
    const focused = document.activeElement?.closest?.('.qtrk') ? [...body.querySelectorAll('.qtrk')].indexOf(document.activeElement) : -1;
    fill(body,
      h('div.np',
        h('div.np-img', image(api, pickImage(cur, 'square'), { shape: 'square' })),
        h('div.np-body',
          h('div.np-title', cur.Name),
          h('div.np-sub', [cur.AlbumArtist || (cur.Artists || []).join(', '), cur.Album].filter(Boolean).join(' · ')),
          h('div.np-meta', `Track ${q.index + 1} of ${q.items.length}${q.shuffle ? ' · shuffled' : ''}`))),
      h('div.actions',
        btn(q.paused ? 'Play' : 'Pause', () => q.toggle(), { color: 'orange' }),
        btn(q.shuffle ? 'Shuffle on' : 'Shuffle off', () => q.setShuffle(), { color: q.shuffle ? 'peach' : 'lilac', title: 'Shuffle the rest of the queue (S)' }),
        btn(REPEAT_LABEL[q.repeat], () => q.cycleRepeat(), { color: q.repeat === 'RepeatNone' ? 'lilac' : 'peach', title: 'Off, all, one (R)' }),
        btn('Save as playlist', () => addToPlaylist(ctx, q.items, { title: 'Save queue as a playlist', label: `${q.items.length} tracks` }), { color: 'sky' }),
        btn('Clear queue', () => q.stop(), { color: 'red', ghost: true })),
      h('div.tracks', q.items.map(row)));
    if (focused >= 0) focusRow(Math.min(focused, q.items.length - 1));
    loadLyrics(cur);
  }

  // ---- lyrics -------------------------------------------------------------------------------
  let lyricsFor = null;
  let lines = [];
  let synced = false;
  let lit = -1;
  async function loadLyrics(cur) {
    const key = cur._qid || cur.Id;
    if (key === lyricsFor) return;
    lyricsFor = key;
    lines = [];
    lit = -1;
    lyricsDeck.hidden = true;
    if (cur.HasLyrics === false) return;
    try {
      const r = await api.get(`/Audio/${cur.Id}/Lyrics`, undefined, { signal });
      if (lyricsFor !== key) return;
      lines = r?.Lyrics || [];
    } catch { return; } // no lyrics (404)
    if (!lines.length) return;
    synced = lines.some(l => l.Start != null);
    fill(lyricsBody, h('div.lyrics', { class: synced ? 'synced' : '' }, lines.map(l => h('p', {
      onclick: synced && l.Start != null ? () => q.seekTo(l.Start / TICKS) : undefined,
    }, l.Text || ' '))));
    lyricsDeck.hidden = false;
    highlight();
  }
  function highlight() {
    if (!synced || !lines.length) return;
    const t = q.position * TICKS;
    let i = -1;
    for (let k = 0; k < lines.length; k++) { if (lines[k].Start != null && lines[k].Start <= t) i = k; else if (lines[k].Start > t) break; }
    if (i === lit) return;
    const ps = lyricsBody.querySelectorAll('p');
    ps[lit]?.classList.remove('on');
    lit = i;
    if (ps[i]) { ps[i].classList.add('on'); ps[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  // S and R on this page toggle shuffle and repeat.
  const onKey = e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea, dialog') || !q.active) return;
    if (e.key === 's' || e.key === 'S') { q.setShuffle(); e.preventDefault(); }
    if (e.key === 'r' || e.key === 'R') { q.cycleRepeat(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  draw();
  const off = q.on(w => { if (w === 'state') draw(); else if (w === 'time') highlight(); });
  signal.addEventListener('abort', () => { off(); document.removeEventListener('keydown', onKey); });
  return [deck('Audio queue', { color: 'orange' }, body), lyricsDeck];
}
