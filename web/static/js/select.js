// Multi-select (the official multiSelect): pick cards, then act on all of them from a bar at the
// bottom of the screen. Each card has a select button (top left; shown on hover, and always
// while selecting). While anything is selected, clicking a card toggles it instead of opening
// it; Shift-click selects a range within the same row or grid; a long press starts selecting
// on touch screens; Esc or Clear ends it. Selection ends when you leave the page.
//
// Actions are registered with addSelectAction(), so later features (bulk actions, the admin
// dashboard's Group versions) plug in here without touching the cards.
import { h, fill } from './h.js';
import { btn, toast } from './ui.js';

const selected = new Map();      // item id -> item
const cardItem = new WeakMap();  // card element -> item
const actions = [];
let lastCard = null;             // anchor for Shift-click ranges
let bar = null;

/**
 * Register an action for the bar. def: {id, label, color, when(items) -> bool, run(items)}.
 * run may return a promise; the bar waits for it, then clears the selection unless run
 * returns {keep: true}.
 */
export function addSelectAction(def) {
  const i = actions.findIndex(a => a.id === def.id);
  if (i >= 0) actions[i] = def; else actions.push(def);
  if (selected.size) draw();
  // Returns a remover, for actions that belong to one page (Remove from collection).
  return () => { const j = actions.indexOf(def); if (j >= 0) actions.splice(j, 1); if (selected.size) draw(); };
}

export const isSelecting = () => selected.size > 0;
export const isSelected = id => selected.has(id);
export const selectedItems = () => [...selected.values()];

/** Called by card(): remember which item a card shows, and give it its select button. */
export function selectable(card, item) {
  cardItem.set(card, item);
  if (selected.has(item.Id)) card.classList.add('selected');
  return h('button.card-sel', {
    type: 'button', title: 'Select', attrs: { 'aria-label': `Select ${item.Name}`, 'aria-pressed': String(selected.has(item.Id)) },
    onclick: e => { e.preventDefault(); e.stopPropagation(); toggle(card, e.shiftKey); },
  });
}

function setCard(card, on) {
  const item = cardItem.get(card);
  if (!item) return;
  if (on) selected.set(item.Id, item); else selected.delete(item.Id);
  // The same item can be on the page twice (two shelves): keep every copy in step.
  for (const c of document.querySelectorAll(`.card[data-key="${CSS.escape(item.Id)}"]`)) {
    c.classList.toggle('selected', on);
    c.querySelector('.card-sel')?.setAttribute('aria-pressed', String(on));
  }
}

function toggle(card, range = false) {
  const item = cardItem.get(card);
  if (!item) return;
  if (range && lastCard && lastCard !== card && lastCard.parentElement === card.parentElement) {
    // Shift: everything between the last card picked and this one takes the last one's state.
    const cards = [...card.parentElement.children].filter(c => cardItem.has(c));
    const [a, b] = [cards.indexOf(lastCard), cards.indexOf(card)].sort((x, y) => x - y);
    const on = selected.has(cardItem.get(lastCard)?.Id);
    for (const c of cards.slice(a, b + 1)) setCard(c, on);
  } else {
    setCard(card, !selected.has(item.Id));
  }
  lastCard = card;
  draw();
}

export function clearSelection() {
  if (!selected.size) return;
  selected.clear();
  lastCard = null;
  for (const c of document.querySelectorAll('.card.selected')) {
    c.classList.remove('selected');
    c.querySelector('.card-sel')?.setAttribute('aria-pressed', 'false');
  }
  draw();
}

function draw() {
  document.body.classList.toggle('selecting', selected.size > 0);
  if (!selected.size) { bar?.remove(); bar = null; return; }
  if (!bar) { bar = h('div.selbar', { attrs: { role: 'toolbar', 'aria-label': 'Selected items' } }); document.body.append(bar); }
  const items = selectedItems();
  const usable = actions.filter(a => { try { return a.when ? a.when(items) : true; } catch { return false; } });
  fill(bar,
    h('span.cap'),
    h('b.sel-n', `${items.length} selected`),
    h('div.sel-acts', usable.map(a => btn(a.label, () => run(a, items), { color: a.color || 'sky', small: true }))),
    h('span.grow'),
    btn('Clear', clearSelection, { color: 'red', ghost: true, small: true, title: 'Clear the selection (Esc)' }),
    h('span.cap.r'));
}

async function run(action, items) {
  try {
    const r = await action.run(items);
    if (!r?.keep) clearSelection();
  } catch (e) {
    toast('Unable to comply', e.message, 'red');
  }
}

// While selecting, a click on a card picks it instead of opening it.
document.addEventListener('click', e => {
  if (!selected.size || e.target.closest('.selbar, dialog, .card-ov button, .card-sel')) return;
  const card = e.target.closest('.card');
  if (!card || !cardItem.has(card)) return;
  e.preventDefault();
  e.stopPropagation();
  toggle(card, e.shiftKey);
}, true);

// Touch: a long press on a card starts selecting.
let press = null;
document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  const card = e.target.closest('.card');
  if (!card || !cardItem.has(card)) return;
  const x = e.clientX, y = e.clientY;
  press = { card, x, y, t: setTimeout(() => { press = null; toggle(card); suppressClick(); navigator.vibrate?.(20); }, 550) };
});
document.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.t); press = null; } });
document.addEventListener('pointerup', () => { if (press) { clearTimeout(press.t); press = null; } });
function suppressClick() {
  const stop = e => { e.preventDefault(); e.stopPropagation(); document.removeEventListener('click', stop, true); };
  document.addEventListener('click', stop, true);
  setTimeout(() => document.removeEventListener('click', stop, true), 800);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && selected.size && !document.querySelector('dialog[open], .player')) { clearSelection(); e.preventDefault(); }
});
