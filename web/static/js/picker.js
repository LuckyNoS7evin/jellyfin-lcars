// Dropdown lists drawn by LCARS, where the browser's own don't open: Jellyfin Desktop's web view
// shows no <select> popups for LCARS, and LG's webOS browser has none that work either (official
// emby-select.js enableNativeMenu turns them off there too). The <select> stays in the page and
// keeps its value; clicking it (or Enter, Space, Alt+Down) opens this list instead, and picking
// an option sets the value and fires input and change as the browser's own list would.
import { h } from './h.js';

let open = null; // { el, select, off }

function close(focusSelect = true) {
  if (!open) return;
  const { el, select, off } = open;
  open = null;
  off();
  el.remove();
  if (focusSelect) select.focus();
}

function pick(select, value) {
  if (select.value !== value) {
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  close();
}

function show(select) {
  close(false);
  const r = select.getBoundingClientRect();
  const opts = [...select.options];
  const el = h('div.picker', { attrs: { role: 'listbox', 'aria-label': select.getAttribute('aria-label') || '' } },
    opts.map(o => h('button.picker-o', {
      type: 'button', class: o.selected ? 'on' : '', disabled: o.disabled,
      attrs: { role: 'option', 'aria-selected': String(o.selected) },
      onclick: e => { e.stopPropagation(); pick(select, o.value); },
    }, o.textContent)));
  // Inside a modal dialog the list must be in the dialog too, or it's under the dialog's layer.
  (select.closest('dialog[open]') || document.body).append(el);
  // Below the select, or above it when there's more room there; scrolls when long.
  const below = innerHeight - r.bottom - 8, above = r.top - 8;
  const up = below < 220 && above > below;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 200) - 8))}px`;
  el.style.minWidth = `${Math.max(r.width, 160)}px`;
  el.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
  if (up) el.style.bottom = `${innerHeight - r.top + 4}px`; else el.style.top = `${r.bottom + 4}px`;
  const cur = el.querySelector('.on') || el.querySelector('button:not([disabled])');
  cur?.scrollIntoView({ block: 'nearest' });
  cur?.focus();

  // A click on the select itself is left to its mousedown handler, which closes the list.
  const onDown = e => { if (!el.contains(e.target) && e.target !== select) close(false); };
  const onKey = e => {
    if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === 461) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const bs = [...el.querySelectorAll('button:not([disabled])')];
      const i = bs.indexOf(document.activeElement);
      bs[Math.max(0, Math.min(bs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      e.preventDefault(); e.stopPropagation();
    }
  };
  const onScroll = e => { if (!el.contains(e.target)) close(false); };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  addEventListener('resize', onScroll);
  open = { el, select, off: () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onScroll);
  } };
}

const ours = t => t instanceof HTMLSelectElement && !t.multiple && !t.disabled && t.size <= 1;

/** Use LCARS's lists for every single-choice <select> from now on. */
export function useLcarsPicker() {
  document.documentElement.classList.add('lcars-picker');
  // mousedown is what opens the browser's own list; stopping it there stops that list.
  document.addEventListener('mousedown', e => {
    if (!ours(e.target) || e.button !== 0) return;
    e.preventDefault();
    e.target.focus();
    if (open?.select === e.target) close(); else show(e.target);
  }, true);
  document.addEventListener('keydown', e => {
    if (open || !ours(e.target)) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); show(e.target); }
  }, true);
}
